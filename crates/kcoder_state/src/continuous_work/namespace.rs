//! Private namespace and short, verified transactions for continuous work.
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

mod publication_lease;
pub(super) use publication_lease::PublicationLease;

#[cfg(test)]
mod v2_tests;
#[cfg(all(test, windows))]
mod windows_publication_tests;

const DIRECTORY: &str = "continuous-work.v1";
const HEADER: &str = "owner.json";
const LOCK: &str = "store.lock";
const DATA: &str = "state.json";
const HEADER_LIMIT: u64 = 16 * 1024;
pub(super) const DATA_LIMIT: u64 = 64 * 1024 * 1024;
const LOCK_WAIT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    profile: String,
    directory: String,
    lock: PortableLeaseIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile_lock: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile_lock_identity: Option<String>,
}

impl Header {
    /// Version 1 keeps its lock inside the namespace. Windows version 2 keeps
    /// a private, uniquely named lock beside it so its held handle does not
    /// prevent atomic publication of the staging directory.
    fn lock_location(&self) -> Result<(bool, &str)> {
        match (
            self.version,
            self.profile_lock.as_deref(),
            self.profile_lock_identity.as_deref(),
        ) {
            (1, None, None) => Ok((false, LOCK)),
            (2, Some(name), Some(directory_identity)) => {
                let id = name
                    .strip_prefix(".continuous-work-")
                    .and_then(|rest| rest.strip_suffix(".locks"));
                ensure!(
                    id.and_then(|value| uuid::Uuid::parse_str(value).ok())
                        .is_some()
                        && !directory_identity.is_empty(),
                    "CONTINUOUS_WORK_LOCK_NAME_INVALID"
                );
                Ok((true, name))
            }
            _ => anyhow::bail!("CONTINUOUS_WORK_HEADER_INVALID"),
        }
    }
}

fn read_file(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= limit,
        "CONTINUOUS_WORK_DATA_LIMIT"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "CONTINUOUS_WORK_DATA_LIMIT");
    Ok(bytes)
}

fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

fn redacted_io_chain(error: &anyhow::Error) -> String {
    let entries: Vec<String> = error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .map(|cause| format!("{:?}/os={:?}", cause.kind(), cause.raw_os_error()))
        .collect();
    if entries.is_empty() {
        "non-io".into()
    } else {
        entries.join(",")
    }
}

/// This handle is bound to the original profile, child, header and lock inodes.
pub(super) struct Namespace {
    profile_path: PathBuf,
    profile: PrivateDirectory,
    directory: PrivateDirectory,
    header: Header,
    header_identity: PortableLeaseIdentity,
    header_anchor: File,
    lock_anchor: File,
    profile_lock_directory: Option<PrivateDirectory>,
}

impl Namespace {
    /// Pure observation: no directory, lock, ACL, or data file is created.
    pub(super) fn open_existing(profile_path: &Path) -> Result<Option<Self>> {
        let profile_path = std::path::absolute(profile_path)?;
        let profile = match PrivateDirectory::open_existing(&profile_path) {
            Ok(profile) => profile,
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        Self::open_in(&profile_path, &profile)
    }

    fn open_in(profile_path: &Path, profile: &PrivateDirectory) -> Result<Option<Self>> {
        profile.verify_trusted_config_directory()?;
        let entry = match profile.open_entry_handle(OsStr::new(DIRECTORY)) {
            Ok(entry) => entry,
            Err(error) if is_not_found(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let directory = entry.open_child_directory()?;
        Self::bind(profile_path, profile, directory).map(Some)
    }

    /// Initialize in a new private staging directory, then publish without
    /// replacing an existing namespace. A crash leaves only an unclaimed stage.
    pub(super) fn open_or_create(profile_path: &Path, initial: &[u8]) -> Result<Self> {
        ensure!(
            initial.len() as u64 <= DATA_LIMIT,
            "CONTINUOUS_WORK_DATA_LIMIT"
        );
        // The trusted host owns the already-existing profile; this method never
        // creates a missing profile or repairs its permissions.
        let profile_path = std::path::absolute(profile_path)?;
        let profile = PrivateDirectory::open_existing(&profile_path)?;
        profile.verify_trusted_config_directory()?;
        if let Some(namespace) = Self::open_in(&profile_path, &profile)? {
            return Ok(namespace);
        }
        let operation_id = uuid::Uuid::new_v4();
        let stage = format!(".continuous-work-{operation_id}.pending");
        let directory = profile.create_private_child(OsStr::new(&stage))?;
        #[cfg(not(windows))]
        let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        #[cfg(windows)]
        let profile_lock = format!(".continuous-work-{operation_id}.locks");
        #[cfg(windows)]
        let lock_directory = profile.create_private_child(OsStr::new(&profile_lock))?;
        #[cfg(windows)]
        let lock = lock_directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let header = Header {
            #[cfg(not(windows))]
            version: 1,
            #[cfg(windows)]
            version: 2,
            profile: profile.directory_identity()?,
            directory: directory.directory_identity()?,
            #[cfg(not(windows))]
            lock: directory.portable_regular_handle_identity(&lock)?,
            #[cfg(windows)]
            lock: lock_directory.portable_regular_handle_identity(&lock)?,
            #[cfg(not(windows))]
            profile_lock: None,
            #[cfg(windows)]
            profile_lock: Some(profile_lock),
            #[cfg(not(windows))]
            profile_lock_identity: None,
            #[cfg(windows)]
            profile_lock_identity: Some(lock_directory.directory_identity()?),
        };
        directory.atomic_replace(OsStr::new(DATA), initial)?;
        directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
        directory.sync()?;
        profile.verify_trusted_config_directory()?;
        #[cfg(all(test, windows))]
        windows_publication_tests::before_publication()?;
        match profile.rename_no_replace(OsStr::new(&stage), OsStr::new(DIRECTORY)) {
            Ok(()) => Self::bind(&profile_path, &profile, directory),
            Err(error) => {
                // Publication may have won or another initializer may have won;
                // inspect the existing namespace instead of replaying the write.
                let rename_failure = redacted_io_chain(&error);
                match Self::open_in(&profile_path, &profile) {
                    Ok(Some(existing)) => Ok(existing),
                    Ok(None) => anyhow::bail!(
                        "CONTINUOUS_WORK_PUBLISH_UNCONFIRMED: rename={rename_failure}, final=absent"
                    ),
                    Err(observation) => anyhow::bail!(
                        "CONTINUOUS_WORK_PUBLISH_UNCONFIRMED: rename={rename_failure}, final={}",
                        redacted_io_chain(&observation)
                    ),
                }
            }
        }
    }

    fn bind(
        profile_path: &Path,
        profile: &PrivateDirectory,
        directory: PrivateDirectory,
    ) -> Result<Self> {
        directory.verify_private_directory()?;
        let header: Header = serde_json::from_slice(&read_file(&directory, HEADER, HEADER_LIMIT)?)
            .context("CONTINUOUS_WORK_HEADER_INVALID")?;
        let header_anchor = directory.open_single_link_regular_file(OsStr::new(HEADER))?;
        let header_identity = directory.portable_regular_handle_identity(&header_anchor)?;
        let (profile_lock, name) = header.lock_location()?;
        let profile_lock_directory = if profile_lock {
            let lock_directory = profile
                .open_entry_handle(OsStr::new(name))?
                .open_child_directory()?;
            lock_directory.verify_private_directory()?;
            Some(lock_directory)
        } else {
            None
        };
        let lock_directory = profile_lock_directory.as_ref().unwrap_or(&directory);
        let lock_anchor = lock_directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let namespace = Self {
            profile_path: profile_path.to_owned(),
            profile: profile.duplicate_handle()?,
            directory,
            header,
            header_identity,
            header_anchor,
            lock_anchor,
            profile_lock_directory,
        };
        namespace.verify()?;
        // A missing or malformed state file must never look like an empty store.
        namespace.read(|_| Ok(()))?;
        Ok(namespace)
    }

    fn verify(&self) -> Result<()> {
        self.profile.verify_trusted_config_directory()?;
        let current_profile = PrivateDirectory::open_existing(&self.profile_path)?;
        current_profile.verify_trusted_config_directory()?;
        self.directory.verify_private_directory()?;
        let current = self
            .profile
            .open_entry_handle(OsStr::new(DIRECTORY))?
            .open_child_directory()?;
        let header: Header =
            serde_json::from_slice(&read_file(&self.directory, HEADER, HEADER_LIMIT)?)?;
        let (profile_lock, name) = header.lock_location()?;
        let lock_directory = if profile_lock {
            let current_lock_directory = self
                .profile
                .open_entry_handle(OsStr::new(name))?
                .open_child_directory()?;
            current_lock_directory.verify_private_directory()?;
            let held = self
                .profile_lock_directory
                .as_ref()
                .context("CONTINUOUS_WORK_LOCK_DIRECTORY_MISSING")?;
            held.verify_private_directory()?;
            let expected = header
                .profile_lock_identity
                .as_deref()
                .context("CONTINUOUS_WORK_LOCK_DIRECTORY_MISSING")?;
            ensure!(
                held.directory_identity()? == expected
                    && current_lock_directory.directory_identity()? == expected,
                "CONTINUOUS_WORK_LOCK_DIRECTORY_CHANGED"
            );
            held
        } else {
            ensure!(
                self.profile_lock_directory.is_none(),
                "CONTINUOUS_WORK_HEADER_INVALID"
            );
            &self.directory
        };
        ensure!(
            header == self.header
                && self.profile.directory_identity()? == header.profile
                && current_profile.directory_identity()? == header.profile
                && self.directory.directory_identity()? == header.directory
                && current.directory_identity()? == header.directory
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(HEADER))?
                    == self.header_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.header_anchor)?
                    == self.header_identity
                && lock_directory.portable_regular_identity(OsStr::new(LOCK))? == header.lock
                && lock_directory.portable_regular_handle_identity(&self.lock_anchor)?
                    == header.lock,
            "CONTINUOUS_WORK_NAMESPACE_CHANGED"
        );
        Ok(())
    }

    fn lease(&self, exclusive: bool) -> Result<VerifiedPrivateLease> {
        let start = std::time::Instant::now();
        loop {
            self.verify()?;
            let (lock_directory, lock_name) = self.lock_directory()?;
            if let Some(lease) = lock_directory.try_existing_portable_lock(
                OsStr::new(lock_name),
                &self.header.lock,
                if exclusive {
                    PrivateLeaseMode::Exclusive
                } else {
                    PrivateLeaseMode::Shared
                },
            )? {
                self.verify()?;
                return Ok(lease);
            }
            ensure!(start.elapsed() < LOCK_WAIT, "CONTINUOUS_WORK_BUSY");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn lock_directory(&self) -> Result<(&PrivateDirectory, &str)> {
        let (profile_lock, _) = self.header.lock_location()?;
        let directory = if profile_lock {
            self.profile_lock_directory
                .as_ref()
                .context("CONTINUOUS_WORK_LOCK_DIRECTORY_MISSING")?
        } else {
            &self.directory
        };
        Ok((directory, LOCK))
    }

    pub(super) fn read<T>(&self, action: impl FnOnce(&[u8]) -> Result<T>) -> Result<T> {
        let _lease = self.lease(false)?;
        let bytes = read_file(&self.directory, DATA, DATA_LIMIT)?;
        let result = action(&bytes)?;
        self.verify()?;
        Ok(result)
    }

    /// This pins a current file during the read but never upgrades a persisted
    /// inode/FileID into cross-process provenance or execution authority.
    pub(super) fn observe_committed_payload(
        &self,
        name: &str,
        size: u64,
        expected: Option<&crate::prepared_immutable::PreparedImmutableIdentity>,
    ) -> Result<crate::prepared_immutable::UnverifiedCommittedRead> {
        self.verify()?;
        let observed = crate::prepared_immutable::observe_committed_unverified(
            &self.directory,
            OsStr::new(name),
            expected,
            size,
        )?;
        self.verify()?;
        Ok(observed)
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    /// Called while the namespace lease is held; ordinary listing never calls it.
    pub(super) fn read_payload(&self, name: &str, size: u64) -> Result<Vec<u8>> {
        self.verify()?;
        let bytes = read_file(&self.directory, name, size)?;
        ensure!(
            bytes.len() as u64 == size,
            "CONTINUOUS_WORK_PAYLOAD_SIZE_CHANGED"
        );
        self.verify()?;
        Ok(bytes)
    }

    /// The action performs only bounded in-memory validation and serialization.
    /// No model, tool, process, network, or other store may be awaited here.
    pub(super) fn update<T>(
        &self,
        action: impl FnOnce(&[u8]) -> Result<(Option<Vec<u8>>, T)>,
    ) -> Result<T> {
        let _lease = self.lease(true)?;
        let bytes = read_file(&self.directory, DATA, DATA_LIMIT)?;
        let (replacement, result) = action(&bytes)?;
        self.verify()?;
        if let Some(replacement) = replacement {
            ensure!(
                replacement.len() as u64 <= DATA_LIMIT,
                "CONTINUOUS_WORK_DATA_LIMIT"
            );
            self.directory
                .atomic_replace(OsStr::new(DATA), &replacement)
                .map_err(|_| anyhow::anyhow!("CONTINUOUS_WORK_WRITE_UNCONFIRMED"))?;
            self.verify()
                .map_err(|_| anyhow::anyhow!("CONTINUOUS_WORK_WRITE_UNCONFIRMED"))?;
        }
        Ok(result)
    }
}
