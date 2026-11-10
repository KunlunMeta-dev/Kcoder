//! Existing SQLite source handles and compatible native lock ranges. No source mutation API.
use super::{PortableLeaseIdentity, PrivateDirectory, validate_single_name};
use anyhow::{Context, Result, ensure};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io,
    sync::Arc,
};
#[path = "sqlite_source/locks.rs"]
mod locks;

const PENDING_BYTE: u64 = 0x4000_0000;
const DATABASE_LOCK_BYTES: u64 = 512;
const SHM_LOCK_BASE: u64 = 120;
const SHM_DEAD_MAN: u64 = 128;
const MAX_SHM_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SqliteSourcePart {
    Database,
    Wal,
    SharedMemory,
}

#[derive(Clone, PartialEq, Eq, serde::Serialize)]
pub struct SqliteSourceFileFact {
    pub identity: PortableLeaseIdentity,
    pub bytes: u64,
}

#[derive(PartialEq, Eq, serde::Serialize)]
pub(super) struct MutationStamp {
    #[serde(serialize_with = "serialize_time")]
    modified: std::time::SystemTime,
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    changed: i64,
}
fn serialize_time<S: serde::Serializer>(
    time: &std::time::SystemTime,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    use serde::Serialize;
    let (before_epoch, duration) = match time.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => (false, duration),
        Err(error) => (true, error.duration()),
    };
    (before_epoch, duration.as_secs(), duration.subsec_nanos()).serialize(serializer)
}
pub(super) fn mutation_stamp(file: &File) -> Result<MutationStamp> {
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
        // SAFETY: this is synchronous handle metadata with correctly sized output storage.
        let mut info: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        ensure!(
            unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle().cast(),
                    FileBasicInfo,
                    (&mut info as *mut FILE_BASIC_INFO).cast(),
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                )
            } != 0,
            "source_sqlite_metadata_unavailable"
        );
        info.ChangeTime
    };
    Ok(MutationStamp {
        modified: metadata.modified()?,
        #[cfg(any(unix, windows))]
        changed,
    })
}
struct Part {
    stamp: MutationStamp,
    name: OsString,
    file: Arc<File>,
    fact: SqliteSourceFileFact,
}
struct Inner {
    // Locks are dropped before their descriptors. Clones share this one guard.
    _locks: Vec<locks::RangeLease>,
    directory: PrivateDirectory,
    database: Part,
    wal: Option<Part>,
    shm: Option<Part>,
    journal: OsString,
}

/// Clones retain the same native locks, not a newly opened pathname or independent lease.
#[derive(Clone)]
pub struct SqliteSourceReadLease(Arc<Inner>);

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|cause| cause.kind() == io::ErrorKind::NotFound)
    })
}
pub(super) fn safe_leaf(file: &File) -> Result<PortableLeaseIdentity> {
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "source_sqlite_unsafe_file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid only reads the identity of this process.
        ensure!(
            metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o7022 == 0,
            "source_sqlite_unsafe_ownership"
        );
    }
    #[cfg(windows)]
    crate::file_permissions::verify_windows_user_only_file_handle(file)?;
    PortableLeaseIdentity::from_regular_handle(file)
}
fn open(directory: &PrivateDirectory, name: OsString) -> Result<Option<Part>> {
    let file = match directory.open_single_link_regular_file(&name) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let identity = safe_leaf(&file)?;
    let bytes = file.metadata()?.len();
    Ok(Some(Part {
        stamp: mutation_stamp(&file)?,
        name,
        file: Arc::new(file),
        fact: SqliteSourceFileFact { identity, bytes },
    }))
}
fn suffix(name: &OsStr, suffix: &str) -> OsString {
    let mut result = name.to_owned();
    result.push(suffix);
    result
}
fn verify_part(directory: &PrivateDirectory, part: &Part, content_stable: bool) -> Result<()> {
    ensure!(
        safe_leaf(&part.file)? == part.fact.identity
            && part.file.metadata()?.len() == part.fact.bytes,
        "source_sqlite_changed"
    );
    if content_stable {
        ensure!(
            mutation_stamp(&part.file)? == part.stamp,
            "source_sqlite_changed"
        );
    }
    let current = directory.open_single_link_regular_file(&part.name)?;
    ensure!(
        safe_leaf(&current)? == part.fact.identity && current.metadata()?.len() == part.fact.bytes,
        "source_sqlite_changed"
    );
    Ok(())
}

fn verify_set(
    directory: &PrivateDirectory,
    database: &Part,
    wal: Option<&Part>,
    shm: Option<&Part>,
    journal: &OsStr,
) -> Result<()> {
    directory.verify_trusted_config_directory()?;
    verify_part(directory, database, true)?;
    for (part, suffix_) in [(wal, "-wal"), (shm, "-shm")] {
        if let Some(part) = part {
            verify_part(directory, part, suffix_ == "-wal")?;
        } else {
            ensure!(
                open(directory, suffix(&database.name, suffix_))?.is_none(),
                "source_sqlite_changed"
            );
        }
    }
    ensure!(
        open(directory, journal.to_owned())?.is_none(),
        "source_sqlite_recovery_required"
    );
    Ok(())
}

impl PrivateDirectory {
    /// The caller already authorizes this actual source directory and a known SQLite basename.
    /// None means native lock contention. Missing/unsafe/unsupported sources are never created.
    /// Main/sidecar content is read only; the WAL-absent gate may open the existing main file
    /// read/write solely because POSIX requires that access for an exclusive byte-range lock.
    pub fn try_sqlite_source_read_lease(
        &self,
        name: &OsStr,
        max_total_bytes: u64,
    ) -> Result<Option<SqliteSourceReadLease>> {
        validate_single_name(name)?;
        ensure!(max_total_bytes > 0, "source_sqlite_invalid_budget");
        self.verify_trusted_config_directory()?;
        let mut database = open(self, name.to_owned())?.context("source_sqlite_missing")?;
        let wal = open(self, suffix(name, "-wal"))?;
        let shm = open(self, suffix(name, "-shm"))?;
        let journal = suffix(name, "-journal");
        ensure!(
            open(self, journal.clone())?.is_none(),
            "source_sqlite_recovery_required"
        );
        let total = database
            .fact
            .bytes
            .checked_add(wal.as_ref().map_or(0, |p| p.fact.bytes))
            .and_then(|bytes| bytes.checked_add(shm.as_ref().map_or(0, |p| p.fact.bytes)))
            .context("source_sqlite_budget_exceeded")?;
        ensure!(
            total <= max_total_bytes && shm.as_ref().is_none_or(|p| p.fact.bytes <= MAX_SHM_BYTES),
            "source_sqlite_budget_exceeded"
        );
        let mut leases = Vec::new();
        if let Some(shm_file) = &shm {
            let Some(main) = locks::RangeLease::try_acquire(
                &database.file,
                PENDING_BYTE,
                DATABASE_LOCK_BYTES,
                false,
            )?
            else {
                verify_set(self, &database, wal.as_ref(), shm.as_ref(), &journal)?;
                return Ok(None);
            };
            leases.push(main);
            // SQLite WRITE, CHECKPOINT and RECOVER locks. Existing readers use separate slots.
            let Some(writers) =
                locks::RangeLease::try_acquire(&shm_file.file, SHM_LOCK_BASE, 3, false)?
            else {
                verify_set(self, &database, wal.as_ref(), shm.as_ref(), &journal)?;
                return Ok(None);
            };
            leases.push(writers);
            let Some(lifetime) =
                locks::RangeLease::try_acquire(&shm_file.file, SHM_DEAD_MAN, 1, false)?
            else {
                verify_set(self, &database, wal.as_ref(), shm.as_ref(), &journal)?;
                return Ok(None);
            };
            leases.push(lifetime);
        } else {
            let existing = self.open_read_write_file(name, false)?;
            ensure!(
                safe_leaf(&existing)? == database.fact.identity,
                "source_sqlite_changed"
            );
            database.file = Arc::new(existing);
            // Without an existing SHM fence, exclude new readers that could create a new WAL.
            let Some(main) = locks::RangeLease::try_acquire(
                &database.file,
                PENDING_BYTE,
                DATABASE_LOCK_BYTES,
                true,
            )?
            else {
                verify_set(self, &database, wal.as_ref(), shm.as_ref(), &journal)?;
                return Ok(None);
            };
            leases.push(main);
        }
        let lease = SqliteSourceReadLease(Arc::new(Inner {
            _locks: leases,
            directory: self.duplicate_handle()?,
            database,
            wal,
            shm,
            journal,
        }));
        lease.verify()?;
        Ok(Some(lease))
    }
}

impl SqliteSourceReadLease {
    /// A private binding to the actual contributing set. Volatile SHM reader marks are excluded.
    pub fn identity_sha256(&self) -> Result<String> {
        use sha2::{Digest, Sha256};
        self.verify()?;
        let body = serde_json::to_vec(&(
            "kcoder-project-sqlite-set/1",
            self.0.directory.directory_identity()?,
            (&self.0.database.fact, &self.0.database.stamp),
            self.0.wal.as_ref().map(|part| (&part.fact, &part.stamp)),
            self.0.shm.as_ref().map(|part| &part.fact),
        ))?;
        Ok(format!("{:x}", Sha256::digest(body)))
    }
    fn part(&self, part: SqliteSourcePart) -> Option<&Part> {
        match part {
            SqliteSourcePart::Database => Some(&self.0.database),
            SqliteSourcePart::Wal => self.0.wal.as_ref(),
            SqliteSourcePart::SharedMemory => self.0.shm.as_ref(),
        }
    }
    pub fn fact(&self, part: SqliteSourcePart) -> Option<&SqliteSourceFileFact> {
        self.part(part).map(|part| &part.fact)
    }
    /// Positional reads are the only data operation exposed by this lease.
    pub fn read_at(
        &self,
        part: SqliteSourcePart,
        offset: u64,
        bytes: &mut [u8],
    ) -> io::Result<usize> {
        let part = self.part(part).ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "source sqlite part is absent")
        })?;
        if offset >= part.fact.bytes {
            return Ok(0);
        }
        let limit = usize::try_from((part.fact.bytes - offset).min(bytes.len() as u64))
            .map_err(|_| io::Error::other("source sqlite read budget"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileExt;
            part.file.read_at(&mut bytes[..limit], offset)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileExt;
            part.file.seek_read(&mut bytes[..limit], offset)
        }
        #[cfg(not(any(unix, windows)))]
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "source sqlite platform unsupported",
        ))
    }
    pub fn verify(&self) -> Result<()> {
        verify_set(
            &self.0.directory,
            &self.0.database,
            self.0.wal.as_ref(),
            self.0.shm.as_ref(),
            &self.0.journal,
        )
    }
}

#[cfg(test)]
#[path = "sqlite_source/tests.rs"]
mod tests;
