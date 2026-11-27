use super::*;
use std::io::Write;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Document<T> {
    version: u32,
    profile_identity: String,
    record_identity: PortableLeaseIdentity,
    pub(super) value: T,
}

pub(super) struct HeldDocument<T> {
    pub(super) value: Document<T>,
    pub(super) bytes: Vec<u8>,
    anchor: File,
    stamp: MetadataStamp,
}

impl<T> HeldDocument<T> {
    pub(super) fn verify_anchor(&self) -> Result<()> {
        let bytes = read_bytes(&self.anchor, self.bytes.len() as u64)?;
        #[cfg(test)]
        note_read::<T>(&bytes);
        ensure!(
            PortableLeaseIdentity::from_private_regular_handle(&self.anchor)?
                == self.value.record_identity
                && bytes == self.bytes,
            "WORKSPACE_IDENTITY_RECORD_CHANGED"
        );
        Ok(())
    }

    pub(super) fn verify_named_stamp(&self, profile: &PrivateDirectory, name: &str) -> Result<()> {
        let current = profile.open_single_link_regular_file(OsStr::new(name))?;
        ensure!(
            PortableLeaseIdentity::from_private_regular_handle(&current)?
                == self.value.record_identity
                && PortableLeaseIdentity::from_private_regular_handle(&self.anchor)?
                    == self.value.record_identity
                && MetadataStamp::read(&current)? == self.stamp
                && MetadataStamp::read(&self.anchor)? == self.stamp,
            "WORKSPACE_IDENTITY_RECORD_CHANGED"
        );
        Ok(())
    }
}

#[derive(PartialEq, Eq)]
struct MetadataStamp {
    length: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
}
impl MetadataStamp {
    fn read(file: &File) -> Result<Self> {
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
            let mut info = FILE_BASIC_INFO::default();
            // SAFETY: the held file and correctly sized output remain live.
            ensure!(
                unsafe {
                    GetFileInformationByHandleEx(
                        file.as_raw_handle().cast(),
                        FileBasicInfo,
                        (&mut info as *mut FILE_BASIC_INFO).cast(),
                        std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                    )
                } != 0,
                "WORKSPACE_IDENTITY_METADATA_UNAVAILABLE"
            );
            info.ChangeTime
        };
        Ok(Self {
            length: metadata.len(),
            modified: metadata.modified()?,
            #[cfg(any(unix, windows))]
            changed,
        })
    }
}

fn read_bytes(file: &File, max: u64) -> Result<Vec<u8>> {
    let size = file.metadata()?.len();
    ensure!(size <= max, "WORKSPACE_IDENTITY_BUDGET_EXCEEDED");
    let mut bytes = vec![0; size as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        #[cfg(unix)]
        let count = {
            use std::os::unix::fs::FileExt;
            file.read_at(&mut bytes[offset..], offset as u64)?
        };
        #[cfg(windows)]
        let count = {
            use std::os::windows::fs::FileExt;
            file.seek_read(&mut bytes[offset..], offset as u64)?
        };
        #[cfg(not(any(unix, windows)))]
        let count: usize = anyhow::bail!("WORKSPACE_IDENTITY_READ_UNAVAILABLE");
        ensure!(count > 0, "WORKSPACE_IDENTITY_RECORD_CHANGED");
        offset += count;
    }
    ensure!(
        file.metadata()?.len() == size,
        "WORKSPACE_IDENTITY_RECORD_CHANGED"
    );
    Ok(bytes)
}

pub(super) fn raw<T: DeserializeOwned>(
    profile: &PrivateDirectory,
    name: &str,
    max: u64,
) -> Result<Option<HeldDocument<T>>> {
    profile.verify_config_root_directory()?;
    let anchor = match profile.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let stamp = MetadataStamp::read(&anchor)?;
    let bytes = read_bytes(&anchor, max)?;
    #[cfg(test)]
    note_read::<T>(&bytes);
    ensure!(
        MetadataStamp::read(&anchor)? == stamp,
        "WORKSPACE_IDENTITY_RECORD_CHANGED"
    );
    let value = serde_json::from_slice(&bytes).context("WORKSPACE_IDENTITY_RECORD_INVALID")?;
    Ok(Some(HeldDocument {
        value,
        bytes,
        anchor,
        stamp,
    }))
}

pub(super) fn read<T: DeserializeOwned>(
    profile: &PrivateDirectory,
    name: &str,
    max: u64,
) -> Result<Option<HeldDocument<T>>> {
    let result = raw::<T>(profile, name, max)?;
    if let Some(document) = &result {
        validate(profile, document)?;
    }
    Ok(result)
}

fn validate<T>(profile: &PrivateDirectory, document: &HeldDocument<T>) -> Result<()> {
    ensure!(
        document.value.version == 1
            && document.value.profile_identity == profile.directory_identity()?
            && document.value.record_identity
                == PortableLeaseIdentity::from_private_regular_handle(&document.anchor)?,
        "WORKSPACE_IDENTITY_BINDING_CHANGED"
    );
    Ok(())
}

/// The caller supplies the exact known previous document, including a verified
/// source copy. Unknown current or prepared documents are never overwritten.
pub(super) fn publish<T: Clone + PartialEq + Serialize + DeserializeOwned>(
    profile: &PrivateDirectory,
    name: &str,
    value: &T,
    operation_id: &str,
    expected: Option<&HeldDocument<T>>,
    max: u64,
) -> Result<HeldDocument<T>> {
    check_budget(value, max)?;
    let current = raw::<T>(profile, name, max)?;
    if let Some(current) = &current {
        if validate(profile, current).is_ok() && current.value.value == *value {
            return read(profile, name, max)?.context("WORKSPACE_IDENTITY_RECORD_REQUIRED");
        }
    }
    compare_current(&current, expected)?;
    let temporary_name = format!(
        ".workspace-mapping-{}.prepared",
        digest(&serde_json::to_vec(&(
            operation_id,
            profile.directory_identity()?,
            name
        ))?)
    );
    let temporary = match profile.open_read_write_file(OsStr::new(&temporary_name), true) {
        Ok(file) => {
            let document = Document {
                version: 1,
                profile_identity: profile.directory_identity()?,
                record_identity: PortableLeaseIdentity::from_private_regular_handle(&file)?,
                value: value.clone(),
            };
            let bytes = serde_json::to_vec(&document)?;
            ensure!(
                bytes.len() as u64 + 1 <= max,
                "WORKSPACE_IDENTITY_BUDGET_EXCEEDED"
            );
            (&file).write_all(&bytes)?;
            (&file).write_all(b"\n")?;
            file.sync_all()?;
            file
        }
        Err(error) if exists(&error) => {
            profile.open_read_write_file(OsStr::new(&temporary_name), false)?
        }
        Err(error) => return Err(error),
    };
    let candidate = read::<T>(profile, &temporary_name, max)?
        .context("WORKSPACE_IDENTITY_RELOCATION_UNCONFIRMED")?;
    ensure!(
        candidate.value.value == *value
            && PortableLeaseIdentity::from_private_regular_handle(&temporary)?
                == candidate.value.record_identity,
        "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
    );
    let latest = raw::<T>(profile, name, max)?;
    compare_current(&latest, expected)?;
    match expected {
        Some(_) => profile.publish_prepared(
            OsStr::new(&temporary_name),
            OsStr::new(name),
            &PrivateDirectory::identity_of_file(&temporary)?,
        )?,
        None => profile.rename_no_replace(OsStr::new(&temporary_name), OsStr::new(name))?,
    }
    let result = read::<T>(profile, name, max)?.context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
    ensure!(
        result.value.value == *value,
        "WORKSPACE_IDENTITY_RELOCATION_UNCONFIRMED"
    );
    Ok(result)
}

pub(super) fn check_budget(value: &impl Serialize, max: u64) -> Result<()> {
    // Reserve a bounded envelope for the actual profile and portable file IDs
    // before creating any prepared file. No fabricated identity is serialized.
    ensure!(
        serde_json::to_vec(value)?.len() as u64 + 1024 <= max,
        "WORKSPACE_IDENTITY_BUDGET_EXCEEDED"
    );
    Ok(())
}

fn compare_current<T>(
    current: &Option<HeldDocument<T>>,
    expected: Option<&HeldDocument<T>>,
) -> Result<()> {
    match (current, expected) {
        (None, None) => Ok(()),
        (Some(current), Some(expected)) => {
            ensure!(
                current.bytes == expected.bytes
                    && PortableLeaseIdentity::from_private_regular_handle(&current.anchor)?
                        == PortableLeaseIdentity::from_private_regular_handle(&expected.anchor)?,
                "WORKSPACE_IDENTITY_RELOCATION_CONFLICT"
            );
            Ok(())
        }
        _ => anyhow::bail!("WORKSPACE_IDENTITY_RELOCATION_CONFLICT"),
    }
}

pub(super) fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

#[cfg(test)]
std::thread_local! {
    static INDEX_IO: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}
#[cfg(test)]
fn note_read<T>(bytes: &[u8]) {
    if std::any::type_name::<T>() == std::any::type_name::<AddressIndex>() {
        INDEX_IO.with(|count| {
            let (reads, length) = count.get();
            count.set((reads + 1, length + bytes.len()));
        });
    }
}
#[cfg(test)]
pub(super) fn reset_index_io() {
    INDEX_IO.with(|count| count.set((0, 0)));
}
#[cfg(test)]
pub(super) fn index_io() -> (usize, usize) {
    INDEX_IO.with(|count| count.get())
}
fn exists(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
    })
}
