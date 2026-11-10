//! Prepared immutable objects retain the original OS identity across a short
//! durable intent transaction. Identity is evidence, never authorization.
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use kcoder_types::PrivateFileIdentityV1;
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
    time::SystemTime,
};

mod verify_content;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "platform",
    content = "identity",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(crate) enum PreparedImmutableIdentity {
    Linux(PrivateFileIdentityV1),
    Windows(PortableLeaseIdentity),
}

pub(crate) struct PreparedImmutable {
    identity: PreparedImmutableIdentity,
    directory: PrivateDirectory,
    directory_identity: String,
    name: OsString,
    inner: PreparedInner,
    byte_len: u64,
}

enum PreparedInner {
    #[cfg(target_os = "linux")]
    Linux(kcoder_config::AnonymousPrivateEntry),
    #[cfg(windows)]
    Windows(kcoder_config::PreparedWindowsImmutableStream),
}

/// Process-local evidence retaining the exact native file and parent handles.
/// This value cannot be reconstructed from a serialized inode/FileID after a
/// crash, even if another file later has matching identifiers and bytes.
pub(crate) struct PublishedImmutable {
    identity: PreparedImmutableIdentity,
    directory: PrivateDirectory,
    directory_identity: String,
    name: OsString,
    byte_len: u64,
    inner: PublishedInner,
}
enum PublishedInner {
    #[cfg(target_os = "linux")]
    Linux(kcoder_config::VerifiedPrivateEntry),
    #[cfg(windows)]
    Windows(kcoder_config::PublishedWindowsImmutableStream),
}

impl PreparedImmutable {
    /// The caller must bound and authenticate the original input and retain
    /// its own operation lease before committing an intent for this object.
    pub(crate) fn prepare(
        directory: &PrivateDirectory,
        name: &OsStr,
        reader: &mut impl Read,
        max_bytes: u64,
    ) -> Result<Self> {
        ensure!(max_bytes < u64::MAX, "immutable stream size limit invalid");
        let name_text = name.to_str().context("immutable name must be ASCII")?;
        ensure!(
            !name_text.is_empty()
                && name_text.len() <= 160
                && name_text != "."
                && name_text != ".."
                && name_text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')),
            "invalid immutable object name"
        );
        directory.verify_private_directory()?;
        #[cfg(target_os = "linux")]
        {
            let directory_identity = directory.directory_identity()?;
            let entry = directory.create_anonymous_private_entry()?;
            let bytes = std::io::copy(&mut reader.take(max_bytes + 1), &mut entry.file())?;
            ensure!(bytes <= max_bytes, "immutable stream exceeds size limit");
            entry.file().sync_all()?;
            directory.verify_private_directory()?;
            ensure!(
                directory.directory_identity()? == directory_identity,
                "immutable parent changed"
            );
            Ok(Self {
                identity: PreparedImmutableIdentity::Linux(entry.identity().clone()),
                directory: directory.duplicate_handle()?,
                directory_identity,
                name: name.to_os_string(),
                inner: PreparedInner::Linux(entry),
                byte_len: bytes,
            })
        }
        #[cfg(windows)]
        {
            let prepared = directory
                .prepare_crash_safe_immutable_stream(name, &mut reader.take(max_bytes + 1))?;
            let bytes = prepared.byte_len();
            ensure!(bytes <= max_bytes, "immutable stream exceeds size limit");
            Ok(Self {
                identity: PreparedImmutableIdentity::Windows(prepared.identity().clone()),
                directory: directory.duplicate_handle()?,
                directory_identity: directory.directory_identity()?,
                name: name.to_os_string(),
                inner: PreparedInner::Windows(prepared),
                byte_len: bytes,
            })
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        {
            let _ = (name, reader);
            anyhow::bail!("IMMUTABLE_PUBLICATION_UNSUPPORTED")
        }
    }

    pub(crate) fn identity(&self) -> &PreparedImmutableIdentity {
        &self.identity
    }
    pub(crate) fn byte_len(&self) -> u64 {
        self.byte_len
    }
    pub(crate) fn target_name(&self) -> &OsStr {
        &self.name
    }

    /// Observe the still-unpublished original object without creating a final
    /// name. Windows remains unavailable until its temporary leaf can be
    /// revalidated against the held parent and file handles.
    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn verify_unpublished(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        ensure!(
            self.directory.directory_identity()? == self.directory_identity,
            "immutable parent changed"
        );
        match (&self.inner, &self.identity) {
            #[cfg(target_os = "linux")]
            (PreparedInner::Linux(entry), PreparedImmutableIdentity::Linux(expected)) => {
                use std::os::unix::fs::MetadataExt;
                let metadata = entry.file().metadata()?;
                ensure!(
                    expected.version == 1
                        && expected.kind == kcoder_types::PrivateFileKind::RegularFile
                        && matches!(&expected.native, kcoder_types::PrivateNativeFileIdentity::Linux { device, inode }
                            if *device == metadata.dev() && *inode == metadata.ino())
                        && entry.identity() == expected
                        && metadata.is_file()
                        && metadata.nlink() == 0
                        && metadata.uid() == unsafe { libc::geteuid() }
                        && metadata.mode() & 0o7777 == 0o600
                        && metadata.len() == self.byte_len,
                    "unpublished immutable object changed"
                );
                Ok(())
            }
            #[cfg(windows)]
            (PreparedInner::Windows(_), PreparedImmutableIdentity::Windows(_)) => {
                anyhow::bail!("UNPUBLISHED_IMMUTABLE_REVALIDATION_UNAVAILABLE")
            }
            _ => anyhow::bail!("immutable identity platform mismatch"),
        }
    }

    /// Call only after the caller persisted an intent containing this exact
    /// identity, original operation, digest and owner lease. On uncertain
    /// outcome, inspect that same intent and original identity before retrying.
    pub(crate) fn publish(self) -> Result<PublishedImmutable> {
        let Self {
            identity,
            directory,
            directory_identity,
            name,
            inner,
            byte_len,
        } = self;
        directory.verify_private_directory()?;
        ensure!(
            directory.directory_identity()? == directory_identity,
            "immutable parent changed"
        );
        let held = match inner {
            #[cfg(target_os = "linux")]
            PreparedInner::Linux(entry) => {
                let held = directory.publish_anonymous_private_entry(&entry, &name)?;
                directory.sync()?;
                PublishedInner::Linux(held)
            }
            #[cfg(windows)]
            PreparedInner::Windows(prepared) => PublishedInner::Windows(prepared.publish_held()?),
        };
        let published = PublishedImmutable {
            identity,
            directory,
            directory_identity,
            name,
            byte_len,
            inner: held,
        };
        published.revalidate()?;
        Ok(published)
    }
}

impl PublishedImmutable {
    pub(crate) fn identity(&self) -> &PreparedImmutableIdentity {
        &self.identity
    }
    pub(crate) fn byte_len(&self) -> u64 {
        self.byte_len
    }
    pub(crate) fn target_name(&self) -> &OsStr {
        &self.name
    }
    pub(crate) fn directory_identity(&self) -> &str {
        &self.directory_identity
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        ensure!(
            self.directory.directory_identity()? == self.directory_identity,
            "immutable parent changed"
        );
        match (&self.inner, &self.identity) {
            #[cfg(target_os = "linux")]
            (PublishedInner::Linux(held), PreparedImmutableIdentity::Linux(expected)) => ensure!(
                held.identity() == expected
                    && self
                        .directory
                        .retention_regular_handle_identity(held.file())?
                        == *expected
                    && self.directory.retention_regular_identity(&self.name)? == *expected,
                "immutable original identity mismatch"
            ),
            #[cfg(windows)]
            (PublishedInner::Windows(held), PreparedImmutableIdentity::Windows(expected)) => {
                ensure!(
                    held.identity() == expected,
                    "immutable original identity mismatch"
                );
                held.revalidate()?;
            }
            _ => anyhow::bail!("immutable identity platform mismatch"),
        }
        Ok(())
    }
    /// Only a live held publication can mint this process-local content witness.
    pub(crate) fn read_verified(&self, max_bytes: u64) -> Result<VerifiedImmutableRead> {
        self.revalidate()?;
        read_verified_immutable(self, max_bytes)
    }
}

/// After the original process/handle is lost, a name alone cannot establish
/// object birth: inode/FileID and bytes may be reused. The caller must retain
/// the original operation lease before treating Absent as a retry precondition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(test)]
pub(crate) enum UnprovenObjectState {
    Absent,
    PresentUnknown,
}
#[cfg(test)]
pub(crate) fn observe_unproven_object(
    directory: &PrivateDirectory,
    name: &OsStr,
) -> Result<UnprovenObjectState> {
    directory.verify_private_directory()?;
    match directory.open_entry_handle(name) {
        Ok(_) => Ok(UnprovenObjectState::PresentUnknown),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(UnprovenObjectState::Absent)
        }
        Err(error) => Err(error),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MutationStamp {
    len: u64,
    modified: SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
}
fn mutation_stamp(file: &File) -> Result<MutationStamp> {
    let metadata = file.metadata()?;
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (metadata.ctime(), metadata.ctime_nsec())
    };
    #[cfg(windows)]
    let changed = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandleEx,
        };
        let mut info: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: the file handle remains open and the output buffer has the exact structure size.
        ensure!(
            unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle().cast(),
                    FileBasicInfo,
                    (&mut info as *mut FILE_BASIC_INFO).cast(),
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                )
            } != 0,
            "immutable file metadata unavailable"
        );
        info.ChangeTime
    };
    Ok(MutationStamp {
        len: metadata.len(),
        modified: metadata.modified()?,
        #[cfg(any(unix, windows))]
        changed,
    })
}

/// Retains the exact original file and parent handles. The caller must also
/// retain its operation lease and verify the saved content digest.
pub(crate) struct VerifiedImmutableRead {
    directory: PrivateDirectory,
    directory_identity: String,
    name: OsString,
    file: File,
    identity: PreparedImmutableIdentity,
    stamp: MutationStamp,
    bytes: Vec<u8>,
    contents_verified: bool,
}
impl VerifiedImmutableRead {
    pub(crate) fn identity(&self) -> &PreparedImmutableIdentity {
        &self.identity
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Local handle, name and change-stamp checks only. Hold this witness and
    /// its original lease until after the associated State commit finishes.
    pub(crate) fn revalidate(&self) -> Result<()> {
        ensure!(
            self.contents_verified,
            "immutable original contents not rechecked"
        );
        self.check_identity_and_stamp()
    }

    fn check_identity_and_stamp(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        ensure!(
            self.directory.directory_identity()? == self.directory_identity,
            "immutable parent changed"
        );
        #[cfg(target_os = "linux")]
        match &self.identity {
            PreparedImmutableIdentity::Linux(identity) => ensure!(
                self.directory
                    .retention_regular_handle_identity(&self.file)?
                    == *identity
                    && self.directory.retention_regular_identity(&self.name)? == *identity,
                "immutable original identity mismatch"
            ),
            _ => anyhow::bail!("immutable identity platform mismatch"),
        }
        #[cfg(windows)]
        match &self.identity {
            PreparedImmutableIdentity::Windows(identity) => ensure!(
                self.directory
                    .portable_regular_handle_identity(&self.file)?
                    == *identity
                    && self.directory.portable_regular_identity(&self.name)? == *identity,
                "immutable original identity mismatch"
            ),
            _ => anyhow::bail!("immutable identity platform mismatch"),
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        anyhow::bail!("IMMUTABLE_PUBLICATION_UNSUPPORTED");
        ensure!(
            mutation_stamp(&self.file)? == self.stamp,
            "immutable object changed"
        );
        Ok(())
    }
}

/// A live original publication must remain held while opening and validating
/// its named file. Persisted dev/inode/FileID alone cannot recreate this proof.
fn read_verified_immutable(
    published: &PublishedImmutable,
    max_bytes: u64,
) -> Result<VerifiedImmutableRead> {
    let witness = read_named_observation(
        &published.directory,
        &published.name,
        Some(&published.identity),
        max_bytes,
    )?;
    published.revalidate()?;
    Ok(witness)
}

/// A stable within-read handle observation. This type deliberately does not
/// prove the file is the one published by a past process or authorize input.
pub(crate) struct UnverifiedCommittedRead(VerifiedImmutableRead);
impl UnverifiedCommittedRead {
    pub(crate) fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        self.0.revalidate()
    }
}

/// Read an already committed name without claiming cross-process birth
/// identity. The caller separately verifies original history and authority.
pub(crate) fn observe_committed_unverified(
    directory: &PrivateDirectory,
    name: &OsStr,
    expected: Option<&PreparedImmutableIdentity>,
    max_bytes: u64,
) -> Result<UnverifiedCommittedRead> {
    let mut witness = read_named_observation(directory, name, expected, max_bytes)?;
    witness.verify_contents()?;
    Ok(UnverifiedCommittedRead(witness))
}

fn read_named_observation(
    directory: &PrivateDirectory,
    name: &OsStr,
    expected: Option<&PreparedImmutableIdentity>,
    max_bytes: u64,
) -> Result<VerifiedImmutableRead> {
    directory.verify_private_directory()?;
    let file = directory.open_single_link_regular_file(name)?;
    #[cfg(target_os = "linux")]
    let actual =
        PreparedImmutableIdentity::Linux(directory.retention_regular_handle_identity(&file)?);
    #[cfg(windows)]
    let actual =
        PreparedImmutableIdentity::Windows(directory.portable_regular_handle_identity(&file)?);
    #[cfg(not(any(target_os = "linux", windows)))]
    let actual: PreparedImmutableIdentity = anyhow::bail!("IMMUTABLE_PUBLICATION_UNSUPPORTED");
    ensure!(
        expected.is_none_or(|identity| *identity == actual),
        "immutable original identity mismatch"
    );
    let stamp = mutation_stamp(&file)?;
    ensure!(
        stamp.len <= max_bytes,
        "immutable stream exceeds size limit"
    );
    let mut bytes = Vec::new();
    (&file)
        .take(
            max_bytes
                .checked_add(1)
                .context("immutable size overflow")?,
        )
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == stamp.len && mutation_stamp(&file)? == stamp,
        "immutable object changed during read"
    );
    let witness = VerifiedImmutableRead {
        directory: directory.duplicate_handle()?,
        directory_identity: directory.directory_identity()?,
        name: name.to_os_string(),
        file,
        identity: actual,
        stamp,
        bytes,
        contents_verified: false,
    };
    witness.check_identity_and_stamp()?;
    Ok(witness)
}

#[cfg(all(test, any(target_os = "linux", windows)))]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn unpublished_revalidation_detects_original_handle_mutation() -> Result<()> {
        use std::io::Write;
        let temp = kcoder_config::create_private_temp_dir("prepared-unpublished-check")?;
        let directory = PrivateDirectory::open_existing(temp.path())?;
        let prepared = PreparedImmutable::prepare(
            &directory,
            OsStr::new("payload"),
            &mut std::io::empty(),
            0,
        )?;
        prepared.verify_unpublished()?;
        let PreparedInner::Linux(entry) = &prepared.inner;
        let mut file = entry.file();
        file.write_all(b"changed")?;
        assert!(prepared.verify_unpublished().is_err());
        assert!(!temp.path().join("payload").exists());
        Ok(())
    }

    #[test]
    fn same_content_different_object_is_not_original_identity() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("prepared-immutable-identity")?;
        let directory = PrivateDirectory::open_existing(temp.path())?;
        let payload = b"original bytes";
        let prepared =
            PreparedImmutable::prepare(&directory, OsStr::new("payload"), &mut &payload[..], 1024)?;
        let identity = prepared.identity().clone();
        assert_eq!(prepared.byte_len(), payload.len() as u64);
        assert!(!temp.path().join("payload").exists());
        directory.atomic_replace(OsStr::new("intent.json"), &serde_json::to_vec(&identity)?)?;
        let published = prepared.publish()?;
        assert_eq!(published.identity(), &identity);
        let mut pinned = published.read_verified(1024)?;
        assert_eq!(pinned.bytes(), payload);
        pinned.verify_contents()?;
        pinned.revalidate()?;
        let saved: PreparedImmutableIdentity =
            serde_json::from_slice(&std::fs::read(temp.path().join("intent.json"))?)?;
        assert_eq!(saved, identity);
        let duplicate =
            PreparedImmutable::prepare(&directory, OsStr::new("payload"), &mut &payload[..], 1024)?;
        assert!(duplicate.publish().is_err());
        assert_eq!(published.read_verified(1024)?.bytes(), payload);
        std::fs::rename(
            temp.path().join("payload"),
            temp.path().join("original-held"),
        )?;
        std::fs::write(temp.path().join("payload"), payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                temp.path().join("payload"),
                std::fs::Permissions::from_mode(0o600),
            )?;
        }
        assert!(published.read_verified(1024).is_err());
        assert!(pinned.revalidate().is_err());
        Ok(())
    }

    #[test]
    fn uncommitted_prepared_object_never_leaves_final_name() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("prepared-immutable-drop")?;
        let directory = PrivateDirectory::open_existing(temp.path())?;
        std::fs::write(temp.path().join("unowned"), b"preserve")?;
        let prepared = PreparedImmutable::prepare(
            &directory,
            OsStr::new("payload"),
            &mut &b"bytes"[..],
            1024,
        )?;
        drop(prepared);
        assert_eq!(
            observe_unproven_object(&directory, OsStr::new("payload"))?,
            UnprovenObjectState::Absent
        );
        assert_eq!(std::fs::read(temp.path().join("unowned"))?, b"preserve");
        Ok(())
    }

    #[test]
    fn witness_detects_same_length_change_before_commit() -> Result<()> {
        let temp = kcoder_config::create_private_temp_dir("prepared-immutable-mutation")?;
        let directory = PrivateDirectory::open_existing(temp.path())?;
        let prepared =
            PreparedImmutable::prepare(&directory, OsStr::new("payload"), &mut &b"first"[..], 32)?;
        let identity = prepared.identity().clone();
        let published = prepared.publish()?;
        assert_eq!(published.identity(), &identity);
        let mut witness = published.read_verified(32)?;
        assert_eq!(witness.bytes(), b"first");
        witness.verify_contents()?;
        witness.revalidate()?;
        let modified = std::fs::metadata(temp.path().join("payload"))?.modified()?;
        std::fs::write(temp.path().join("payload"), b"other")?;
        std::fs::OpenOptions::new()
            .write(true)
            .open(temp.path().join("payload"))?
            .set_times(std::fs::FileTimes::new().set_modified(modified))?;
        assert!(witness.verify_contents().is_err());
        assert!(witness.revalidate().is_err());
        Ok(())
    }

    #[test]
    fn process_exit_before_and_after_publish_retains_only_original_identity_evidence() -> Result<()>
    {
        if let Some(profile) = std::env::var_os("KCODER_TEST_PREPARED_IDENTITY_PROFILE") {
            let directory = PrivateDirectory::open_existing(std::path::Path::new(&profile))?;
            let prepared = PreparedImmutable::prepare(
                &directory,
                OsStr::new("payload"),
                &mut &b"exact-original"[..],
                64,
            )?;
            directory.atomic_replace(
                OsStr::new("intent.json"),
                &serde_json::to_vec(prepared.identity())?,
            )?;
            if std::env::var("KCODER_TEST_PREPARED_IDENTITY_AFTER")? == "0" {
                std::process::exit(90);
            }
            prepared.publish()?;
            std::process::exit(91);
        }
        for after in [false, true] {
            let temp = kcoder_config::create_private_temp_dir("prepared-immutable-crash")?;
            let directory = PrivateDirectory::open_existing(temp.path())?;
            std::fs::write(temp.path().join("unowned"), b"preserve")?;
            let output = std::process::Command::new(std::env::current_exe()?)
                .args(["--exact", "prepared_immutable::tests::process_exit_before_and_after_publish_retains_only_original_identity_evidence", "--nocapture"])
                .env("KCODER_TEST_PREPARED_IDENTITY_PROFILE", temp.path())
                .env("KCODER_TEST_PREPARED_IDENTITY_AFTER", if after {"1"} else {"0"})
                .output()?;
            assert_eq!(
                output.status.code(),
                Some(if after { 91 } else { 90 }),
                "stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let _identity: PreparedImmutableIdentity =
                serde_json::from_slice(&std::fs::read(temp.path().join("intent.json"))?)?;
            let found = observe_unproven_object(&directory, OsStr::new("payload"))?;
            if after {
                assert_eq!(found, UnprovenObjectState::PresentUnknown);
            } else {
                assert_eq!(found, UnprovenObjectState::Absent);
                std::fs::write(temp.path().join("payload"), b"exact-original")?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(
                        temp.path().join("payload"),
                        std::fs::Permissions::from_mode(0o600),
                    )?;
                }
                assert_eq!(
                    observe_unproven_object(&directory, OsStr::new("payload"))?,
                    UnprovenObjectState::PresentUnknown
                );
            }
            assert_eq!(std::fs::read(temp.path().join("unowned"))?, b"preserve");
        }
        Ok(())
    }
}
