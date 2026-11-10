use super::*;
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use sqlite_vfs::{DatabaseHandle, LockKind, OpenAccess, OpenKind, OpenOptions, Vfs, WalDisabled};
use std::borrow::Cow;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
mod resource;
pub(crate) use resource::resource_for_database;
#[cfg(windows)]
mod windows_lock;

fn try_catalog_lock(file: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        windows_lock::try_lock_exclusive(file)
    }
    #[cfg(not(windows))]
    {
        FileExt::try_lock_exclusive(file)
    }
}

fn unlock_catalog(file: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        windows_lock::unlock(file)
    }
    #[cfg(not(windows))]
    {
        FileExt::unlock(file)
    }
}

const DATABASE: &str = "catalog.sqlite3";
const JOURNAL: &str = "catalog.sqlite3-journal";
const OWNER: &str = "owner.json";
const MAX_OWNER_BYTES: usize = 32 * 1024;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
// Thirty-two independent migration writers plus current observations and derived readers.
// This bounds concurrent private VFS registrations; payload/file/space quotas remain separate.
const SLOT_COUNT: usize = 128;

/// The bounded process VFS table has no free connection; this is not a valid empty catalog.
#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("history_catalog_capacity_reached")]
pub struct HistoryCatalogCapacityReached;

/// A read-only SQLite observation found a hot rollback journal. Only an explicitly
/// authorized writer may let SQLite recover it; ordinary read-only errors are distinct.
#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("history_catalog_recovery_required")]
pub struct HistoryCatalogRecoveryRequired;

/// A competing SQLite owner temporarily prevents an observation; no checkpoint is fabricated.
#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("history_catalog_busy")]
pub struct HistoryCatalogBusy;

impl HistoryCatalogBusy {
    pub fn from_error(error: &anyhow::Error) -> Option<Self> {
        error.chain().any(|cause| {
            cause.is::<Self>()
                || matches!(cause.downcast_ref::<rusqlite::Error>(),
                    Some(rusqlite::Error::SqliteFailure(code, _))
                        if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
        }).then_some(Self)
    }
}

impl HistoryCatalogRecoveryRequired {
    /// Recognize the exact native extended code, including failures raised after open.
    /// Error text, generic read-only failures and corrupt databases are not evidence.
    pub fn from_error(error: &anyhow::Error) -> Option<Self> {
        error
            .chain()
            .any(|cause| {
                cause.is::<Self>()
                    || matches!(cause.downcast_ref::<rusqlite::Error>(),
                    Some(rusqlite::Error::SqliteFailure(code, _))
                        if code.extended_code == rusqlite::ffi::SQLITE_READONLY_ROLLBACK)
            })
            .then_some(Self)
    }
}

#[cfg(test)]
thread_local! {
    pub(super) static READ_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

struct Root {
    directory: PrivateDirectory,
    writable: bool,
    max_file_bytes: u64,
    resource: Option<Arc<crate::external_history::lifecycle::resource_budget::ResourceStream>>,
    recovery: Option<crate::external_history::lifecycle::SealedCacheRecovery>,
    recovery_active: AtomicBool,
    #[cfg(windows)]
    legacy_data_lock_conflict: AtomicBool,
}

struct Slot {
    name: String,
    active: AtomicBool,
    root: Mutex<Option<Arc<Root>>>,
}

// sqlite-vfs registrations live for the process. A bounded slot has only one connection at a time.
static SLOTS: OnceLock<std::result::Result<Vec<Arc<Slot>>, String>> = OnceLock::new();

pub(crate) struct Lease(Arc<Slot>);
impl Lease {
    fn finish_sealed_recovery(&self, connection: &Connection) -> Result<()> {
        let root = self
            .0
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("catalog file lease unavailable"))?
            .clone()
            .context("catalog file lease released")?;
        let Some(checkpoint) = &root.recovery else {
            return Ok(());
        };
        // A read forces SQLite's native rollback while VFS writes remain bound
        // to the original sealed DB extent. No SQL mutation is accepted here.
        connection.pragma_update(None, "query_only", true)?;
        connection.query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))?;
        checkpoint.verify_restored(&root.directory)?;
        root.recovery_active.store(false, Ordering::Release);
        Ok(())
    }

    pub(crate) fn with_directory<T>(
        &self,
        action: impl FnOnce(&PrivateDirectory) -> Result<T>,
    ) -> Result<T> {
        let root = self
            .0
            .root
            .lock()
            .map_err(|_| anyhow::anyhow!("catalog file lease unavailable"))?
            .clone()
            .context("catalog file lease released")?;
        action(&root.directory)
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        *self
            .0
            .root
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        self.0.active.store(false, Ordering::Release);
    }
}

fn acquire(root: Root) -> Result<Lease> {
    let slots = SLOTS
        .get_or_init(|| {
            (0..SLOT_COUNT)
                .map(|index| {
                    let slot = Arc::new(Slot {
                        name: format!("kcoder-history-{index}"),
                        active: AtomicBool::new(false),
                        root: Mutex::new(None),
                    });
                    sqlite_vfs::register(&slot.name, Backend(Arc::clone(&slot)), false)
                        .map_err(|error| error.to_string())?;
                    Ok(slot)
                })
                .collect()
        })
        .as_ref()
        .map_err(|error| anyhow::anyhow!("catalog VFS registration failed: {error}"))?;
    for slot in slots {
        if slot
            .active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            let lease = Lease(Arc::clone(slot));
            *slot
                .root
                .lock()
                .map_err(|_| anyhow::anyhow!("catalog VFS slot unavailable"))? =
                Some(Arc::new(root));
            return Ok(lease);
        }
    }
    Err(HistoryCatalogCapacityReached.into())
}

fn io_error(error: anyhow::Error) -> io::Error {
    let kind = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<io::Error>())
        .map_or(io::ErrorKind::Other, io::Error::kind);
    io::Error::new(kind, "private catalog file access failed")
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
    })
}

fn existing(directory: &PrivateDirectory, name: &str) -> Result<Option<File>> {
    match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => Ok(Some(file)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn update_file(directory: &PrivateDirectory, name: &str, create: bool) -> Result<File> {
    match directory.open_read_write_file(OsStr::new(name), false) {
        Ok(file) => Ok(file),
        Err(error) if create && missing(&error) => {
            match directory.open_read_write_file(OsStr::new(name), true) {
                Ok(file) => Ok(file),
                Err(error)
                    if error.chain().any(|cause| {
                        cause
                            .downcast_ref::<io::Error>()
                            .is_some_and(|error| error.kind() == io::ErrorKind::AlreadyExists)
                    }) =>
                {
                    directory.open_read_write_file(OsStr::new(name), false)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    schema: u32,
    scope: String,
}

/// Compare two JSON-encoded catalog scopes after simplifying every string
/// element as a path. Legacy catalogs (written before path normalization was
/// unified) embed verbatim (`\\?\`) roots where the current code writes
/// simplified ones; an equivalent scope must keep the catalog usable instead
/// of failing the whole open. Non-string elements are compared as written.
pub(super) fn scopes_match_after_normalization(stored: &str, current: &str) -> bool {
    fn normalized_elements(scope: &str) -> Option<Vec<String>> {
        let value: serde_json::Value = serde_json::from_str(scope).ok()?;
        let array = value.as_array()?;
        Some(
            array
                .iter()
                .map(|element| match element.as_str() {
                    Some(text) => dunce::simplified(Path::new(text))
                        .to_string_lossy()
                        .into_owned(),
                    None => element.to_string(),
                })
                .collect(),
        )
    }
    match (normalized_elements(stored), normalized_elements(current)) {
        (Some(stored), Some(current)) => stored == current,
        _ => false,
    }
}

/// Scope component for paths: always the simplified (namespace-free) form so
/// the scope string is stable regardless of caller-provided path shape.
pub(super) fn scope_path_component(path: &Path) -> String {
    dunce::simplified(path).to_string_lossy().into_owned()
}

pub(super) fn open(root: &Path, scope: &str, writable: bool) -> Result<Option<HistoryCatalog>> {
    let Some(database) = open_database(root, "history-index", scope, writable)? else {
        return Ok(None);
    };
    let mut catalog = if writable {
        HistoryCatalog::attach(database.connection, scope)?
    } else {
        HistoryCatalog::attach_read_only(database.connection, scope)?
    };
    catalog.file_lease = Some(database.lease);
    Ok(Some(catalog))
}

#[cfg(all(test, windows))]
impl HistoryCatalog {
    /// Test-only seam: write an arbitrary owner scope through the real
    /// directory acquisition and atomic replacement, then take the normal open
    /// path so legacy-owner acceptance and migration are exercised end to end.
    /// Windows-only because the only caller is the verbatim-scope migration test;
    /// dunce is the identity elsewhere, so no legacy form can be constructed.
    pub(super) fn open_with_owner_scope(
        root: &Path,
        scope: &str,
        owner_scope: &str,
        writable: bool,
    ) -> Result<Option<Self>> {
        let owner = serde_json::to_vec(&Owner {
            schema: 1,
            scope: owner_scope.to_owned(),
        })?;
        ensure!(
            owner.len() <= MAX_OWNER_BYTES,
            "catalog owner record exceeds budget"
        );
        let directory =
            PrivateDirectory::open_existing(root)?.open_child(OsStr::new("history-index"), true)?;
        directory.atomic_replace(OsStr::new(OWNER), &owner)?;
        HistoryCatalog::open(root, scope, writable)
    }
}

// Connection ownership must end before the VFS lease and setup lock are released.
pub(crate) struct OpenedDatabase {
    pub(crate) connection: Connection,
    pub(crate) lease: Lease,
    _setup: Option<File>,
}

/// Share private-file mechanics, not table schemas, between independent derived databases.
pub(super) fn open_database(
    root: &Path,
    child: &str,
    scope: &str,
    writable: bool,
) -> Result<Option<OpenedDatabase>> {
    ensure!(
        !scope.is_empty() && scope.len() <= 16 * 1024,
        "invalid catalog scope"
    );
    let owner_bytes = serde_json::to_vec(&Owner {
        schema: 1,
        scope: scope.to_owned(),
    })?;
    ensure!(
        owner_bytes.len() <= MAX_OWNER_BYTES,
        "catalog owner record exceeds budget"
    );
    let directory = match PrivateDirectory::open_existing(root)
        .and_then(|root| root.open_child(OsStr::new(child), writable))
    {
        Ok(directory) => directory,
        Err(error) if !writable && missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    open_database_in(directory, scope, writable, MAX_FILE_BYTES)
}

/// Reuse descriptor-relative SQLite I/O for another explicitly bounded derived store.
/// Existing catalog callers retain their original 512 MiB ceiling.
pub(crate) fn open_database_in(
    directory: PrivateDirectory,
    scope: &str,
    writable: bool,
    max_file_bytes: u64,
) -> Result<Option<OpenedDatabase>> {
    open_database_in_with_resource(directory, scope, writable, max_file_bytes, None)
}
pub(crate) fn open_database_in_with_resource(
    directory: PrivateDirectory,
    scope: &str,
    writable: bool,
    max_file_bytes: u64,
    resource: Option<crate::external_history::lifecycle::resource_budget::ResourceStream>,
) -> Result<Option<OpenedDatabase>> {
    open_database_in_with_recovery(directory, scope, writable, max_file_bytes, resource, None)
}

pub(crate) fn open_database_in_with_recovery(
    directory: PrivateDirectory,
    scope: &str,
    writable: bool,
    max_file_bytes: u64,
    resource: Option<crate::external_history::lifecycle::resource_budget::ResourceStream>,
    recovery: Option<crate::external_history::lifecycle::SealedCacheRecovery>,
) -> Result<Option<OpenedDatabase>> {
    ensure!(
        recovery.is_none()
            || (writable && resource.as_ref().is_some_and(|value| value.is_committed())),
        "history_projection_recovery_authority_required"
    );
    ensure!(
        (1..=4 * 1024 * 1024 * 1024).contains(&max_file_bytes),
        "invalid private database budget"
    );
    #[cfg(windows)]
    ensure!(
        max_file_bytes < windows_lock::LOCK_OFFSET,
        "invalid private database lock boundary"
    );
    ensure!(
        !scope.is_empty() && scope.len() <= 16 * 1024,
        "invalid catalog scope"
    );
    let owner_bytes = serde_json::to_vec(&Owner {
        schema: 1,
        scope: scope.to_owned(),
    })?;
    ensure!(
        owner_bytes.len() <= MAX_OWNER_BYTES,
        "catalog owner record exceeds budget"
    );
    let _setup = if writable {
        let lock = update_file(&directory, "setup.lock", true)?;
        FileExt::try_lock_exclusive(&lock)
            .context("catalog initialization is busy; retry later")?;
        Some(lock)
    } else {
        None
    };
    for name in ["catalog.sqlite3-wal", "catalog.sqlite3-shm"] {
        ensure!(
            existing(&directory, name)?.is_none(),
            "WAL catalog is unsupported by this file backend"
        );
    }
    match existing(&directory, OWNER)? {
        Some(file) => {
            let mut bytes = Vec::new();
            file.take((MAX_OWNER_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= MAX_OWNER_BYTES,
                "catalog owner record exceeds budget"
            );
            let owner: Owner = serde_json::from_slice(&bytes)?;
            let exact = owner.schema == 1 && owner.scope == scope;
            let compatible = !exact
                && owner.schema == 1
                && scopes_match_after_normalization(&owner.scope, scope);
            ensure!(
                exact || compatible,
                "catalog directory belongs to another scope or version"
            );
            if compatible && writable {
                // Migrate the owner record to the simplified scope form so
                // later opens take the fast equality path. Runs under the
                // setup.lock taken above when writable.
                directory.atomic_replace(OsStr::new(OWNER), &owner_bytes)?;
            }
        }
        None => {
            ensure!(
                existing(&directory, DATABASE)?.is_none()
                    && existing(&directory, JOURNAL)?.is_none(),
                "unrecognized catalog directory; explicit recovery is required"
            );
            if !writable {
                return Ok(None);
            }
            directory.atomic_replace(OsStr::new(OWNER), &owner_bytes)?;
        }
    }
    for name in [DATABASE, JOURNAL] {
        if let Some(file) = existing(&directory, name)? {
            ensure!(
                file.metadata()?.len() <= max_file_bytes,
                "catalog file exceeds byte budget"
            );
        } else if name == DATABASE && !writable {
            return Ok(None);
        }
    }
    let lease = acquire(Root {
        directory,
        writable,
        max_file_bytes,
        resource: resource.map(Arc::new),
        recovery_active: AtomicBool::new(recovery.is_some()),
        recovery,
        #[cfg(windows)]
        legacy_data_lock_conflict: AtomicBool::new(false),
    })?;
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
        | rusqlite::OpenFlags::SQLITE_OPEN_PRIVATE_CACHE
        | if writable {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
        } else {
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        };
    let connection = Connection::open_with_flags_and_vfs(DATABASE, flags, &lease.0.name)
        .map_err(|error| catalog_open_error(&lease, error))?;
    ensure!(
        !writable || !connection.is_readonly(rusqlite::DatabaseName::Main)?,
        "catalog writer opened read-only"
    );
    connection
        .execute_batch("PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0;")
        .map_err(|error| catalog_open_error(&lease, error))?;
    lease.finish_sealed_recovery(&connection)?;
    Ok(Some(OpenedDatabase {
        connection,
        lease,
        _setup,
    }))
}

fn catalog_open_error(lease: &Lease, error: rusqlite::Error) -> anyhow::Error {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if matches!(code.code,
        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
    {
        return anyhow::Error::new(error).context(HistoryCatalogBusy);
    }
    #[cfg(windows)]
    if lease.0.root.lock().is_ok_and(|root| {
        root.as_ref()
            .is_some_and(|root| root.legacy_data_lock_conflict.load(Ordering::Acquire))
    }) {
        return anyhow::Error::new(error).context(HistoryCatalogBusy);
    }
    #[cfg(not(windows))]
    let _ = lease;
    let error = anyhow::Error::new(error);
    match HistoryCatalogRecoveryRequired::from_error(&error) {
        Some(recovery) => error.context(recovery),
        None => error,
    }
}

struct Backend(Arc<Slot>);

impl Backend {
    fn root(&self) -> io::Result<Arc<Root>> {
        self.0
            .root
            .lock()
            .map_err(|_| io::Error::other("catalog slot unavailable"))?
            .clone()
            .ok_or_else(|| io::Error::other("catalog slot is closed"))
    }
}

impl Vfs for Backend {
    type Handle = Handle;

    fn open(&self, db: &str, options: OpenOptions) -> io::Result<Handle> {
        let root = self.root()?;
        if !matches!(
            (db, options.kind),
            (DATABASE, OpenKind::MainDb) | (JOURNAL, OpenKind::MainJournal)
        ) {
            return Err(io::Error::other("unsupported catalog file kind"));
        }
        if options.access != OpenAccess::Read && !root.writable {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "catalog is read-only",
            ));
        }
        if root
            .resource
            .as_ref()
            .is_some_and(|resource| resource.is_committed())
            && db == JOURNAL
            && options.access != OpenAccess::Read
            && (!root.recovery_active.load(Ordering::Acquire)
                || matches!(options.access, OpenAccess::CreateNew))
        {
            return Err(io::Error::other("history_resource_already_committed"));
        }
        let file = if root.recovery_active.load(Ordering::Acquire) {
            // Existing objects only: rollback cannot allocate a new journal or DB.
            match options.access {
                OpenAccess::Read => root.directory.open_regular_file(OsStr::new(db)),
                OpenAccess::CreateNew => {
                    Err(anyhow::anyhow!("history_projection_recovery_file_denied"))
                }
                _ => update_file(&root.directory, db, false),
            }
        } else {
            match options.access {
                OpenAccess::Read => root.directory.open_regular_file(OsStr::new(db)),
                OpenAccess::Write => update_file(&root.directory, db, false),
                OpenAccess::Create => update_file(&root.directory, db, true),
                OpenAccess::CreateNew => root.directory.open_read_write_file(OsStr::new(db), true),
            }
        }
        .map_err(io_error)?;
        if let Some(checkpoint) = &root.recovery
            && root.recovery_active.load(Ordering::Acquire)
        {
            checkpoint
                .verify_file(&root.directory, db, &file)
                .map_err(io_error)?;
        }
        Ok(Handle {
            file,
            root,
            name: db.to_owned(),
            lock: LockKind::None,
        })
    }

    fn delete(&self, db: &str) -> io::Result<()> {
        let root = self.root()?;
        if db != JOURNAL || !root.writable {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "unsupported catalog deletion",
            ));
        }
        if root.recovery_active.load(Ordering::Acquire) {
            let checkpoint = root.recovery.as_ref().ok_or_else(|| {
                io::Error::other("history_projection_recovery_authority_required")
            })?;
            let held = root
                .directory
                .open_single_link_regular_file(OsStr::new(db))
                .map_err(io_error)?;
            checkpoint
                .verify_file(&root.directory, db, &held)
                .map_err(io_error)?;
        }
        match root.directory.remove_regular_file(OsStr::new(db)) {
            Ok(()) => Ok(()),
            Err(error) if missing(&error) => Ok(()),
            Err(error) => Err(io_error(error)),
        }
    }

    fn exists(&self, db: &str) -> io::Result<bool> {
        if matches!(db, "catalog.sqlite3-wal" | "catalog.sqlite3-shm") {
            return Ok(false);
        }
        if !matches!(db, DATABASE | JOURNAL) {
            return Err(io::Error::other("unsupported catalog file"));
        }
        existing(&self.root()?.directory, db)
            .map(|file| file.is_some())
            .map_err(io_error)
    }

    fn access(&self, db: &str, write: bool) -> io::Result<bool> {
        Ok((!write || self.root()?.writable) && self.exists(db)?)
    }

    fn full_pathname<'a>(&self, db: &'a str) -> io::Result<Cow<'a, str>> {
        if db != DATABASE {
            return Err(io::Error::other("unsupported catalog database"));
        }
        Ok(Cow::Borrowed(db))
    }

    fn temporary_name(&self) -> String {
        "unsupported-temp".into()
    }

    fn random(&self, output: &mut [i8]) {
        for chunk in output.chunks_mut(16) {
            let random = uuid::Uuid::new_v4();
            for (target, byte) in chunk.iter_mut().zip(random.as_bytes()) {
                *target = *byte as i8;
            }
        }
    }

    fn sleep(&self, duration: std::time::Duration) -> std::time::Duration {
        let start = std::time::Instant::now();
        std::thread::sleep(duration);
        start.elapsed()
    }
}

struct Handle {
    file: File,
    root: Arc<Root>,
    name: String,
    lock: LockKind,
}

#[cfg(unix)]
pub(super) fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
pub(super) fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    // SAFETY: a zeroed POD output is valid and the owned file handle remains live.
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the buffer has the exact size expected by this API.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        information.dwVolumeSerialNumber as u64,
        ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    ))
}

impl DatabaseHandle for Handle {
    type WalIndex = WalDisabled;
    fn size(&self) -> io::Result<u64> {
        Ok(self.file.metadata()?.len())
    }
    fn read_exact_at(&mut self, bytes: &mut [u8], offset: u64) -> io::Result<()> {
        self.file.seek(SeekFrom::Start(offset))?;
        let mut filled = 0;
        while filled < bytes.len() {
            match self.file.read(&mut bytes[filled..]) {
                Ok(0) => {
                    bytes[filled..].fill(0);
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "catalog short read",
                    ));
                }
                Ok(count) => {
                    #[cfg(test)]
                    READ_BYTES.with(|bytes| bytes.set(bytes.get().saturating_add(count as u64)));
                    filled += count;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    #[cfg(windows)]
                    if error.raw_os_error()
                        == Some(windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32)
                    {
                        self.root
                            .legacy_data_lock_conflict
                            .store(true, Ordering::Release);
                    }
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    fn write_all_at(&mut self, bytes: &[u8], offset: u64) -> io::Result<()> {
        if !self.root.writable
            || offset.saturating_add(bytes.len() as u64) > self.root.max_file_bytes
        {
            return Err(io::Error::other(
                "catalog write exceeds access or byte budget",
            ));
        }
        if !bytes.is_empty() {
            self.root
                .resource_extent(
                    &self.name,
                    &self.file,
                    offset
                        .checked_add(bytes.len() as u64)
                        .ok_or_else(|| io::Error::other("history_resource_budget_exceeded"))?,
                )
                .map_err(io_error)?;
        }
        self.file.seek(SeekFrom::Start(offset))?;
        self.file.write_all(bytes)
    }
    fn sync(&mut self, data_only: bool) -> io::Result<()> {
        if data_only {
            self.file.sync_data()?;
        } else {
            self.file.sync_all()?;
        }
        self.root.directory.sync().map_err(io_error)
    }
    fn set_len(&mut self, length: u64) -> io::Result<()> {
        if !self.root.writable || length > self.root.max_file_bytes {
            return Err(io::Error::other(
                "catalog truncate exceeds access or byte budget",
            ));
        }
        if self.root.recovery_active.load(Ordering::Acquire) {
            let checkpoint = self.root.recovery.as_ref().ok_or_else(|| {
                io::Error::other("history_projection_recovery_authority_required")
            })?;
            if self.name != DATABASE || length != checkpoint.database_bytes() {
                return Err(io::Error::other(
                    "history_projection_recovery_extent_denied",
                ));
            }
        }
        if length != self.file.metadata()?.len() {
            self.root
                .resource_extent(&self.name, &self.file, length)
                .map_err(io_error)?;
        }
        self.file.set_len(length)
    }
    fn lock(&mut self, requested: LockKind) -> io::Result<bool> {
        if requested == LockKind::None {
            if self.lock != LockKind::None {
                unlock_catalog(&self.file)?;
            }
            self.lock = requested;
            return Ok(true);
        }
        if self.lock == LockKind::None {
            // Short catalog transactions serialize readers too; no platform-specific lock upgrade.
            match try_catalog_lock(&self.file) {
                Ok(()) => {}
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    return Ok(false);
                }
                Err(error) => return Err(error),
            }
        }
        match self.moved() {
            Ok(false) => {}
            result => {
                unlock_catalog(&self.file)?;
                self.lock = LockKind::None;
                return Err(result
                    .err()
                    .unwrap_or_else(|| io::Error::other("catalog file identity changed")));
            }
        }
        self.lock = requested;
        Ok(true)
    }
    fn reserved(&mut self) -> io::Result<bool> {
        if self.lock != LockKind::None {
            return Ok(self.lock >= LockKind::Reserved);
        }
        let probe = self
            .root
            .directory
            .open_regular_file(OsStr::new(&self.name))
            .map_err(io_error)?;
        match try_catalog_lock(&probe) {
            Ok(()) => {
                unlock_catalog(&probe)?;
                Ok(false)
            }
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                Ok(true)
            }
            Err(error) => Err(error),
        }
    }
    fn current_lock(&self) -> io::Result<LockKind> {
        Ok(self.lock)
    }
    fn moved(&self) -> io::Result<bool> {
        match self
            .root
            .directory
            .open_regular_file(OsStr::new(&self.name))
        {
            Ok(current) => Ok(file_identity(&current)? != file_identity(&self.file)?),
            Err(error) if missing(&error) => Ok(true),
            Err(error) => Err(io_error(error)),
        }
    }
    fn wal_index(&self, _readonly: bool) -> io::Result<WalDisabled> {
        Ok(WalDisabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_contention_is_distinct_from_readonly_recovery_or_corruption() {
        for code in [
            rusqlite::ffi::SQLITE_BUSY,
            rusqlite::ffi::SQLITE_BUSY_RECOVERY,
            rusqlite::ffi::SQLITE_LOCKED,
        ] {
            let error = anyhow::Error::new(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                None,
            ));
            assert!(HistoryCatalogBusy::from_error(&error).is_some());
            assert!(HistoryCatalogRecoveryRequired::from_error(&error).is_none());
        }
        for code in [
            rusqlite::ffi::SQLITE_READONLY,
            rusqlite::ffi::SQLITE_READONLY_ROLLBACK,
            rusqlite::ffi::SQLITE_CORRUPT,
            rusqlite::ffi::SQLITE_NOTADB,
        ] {
            let error = anyhow::Error::new(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("history_catalog_busy".into()),
            ));
            assert!(HistoryCatalogBusy::from_error(&error).is_none());
        }
        assert!(HistoryCatalogBusy::from_error(&anyhow::anyhow!("history_catalog_busy")).is_none());
    }

    #[test]
    fn only_native_readonly_rollback_requires_writer_recovery() {
        let rollback = anyhow::Error::new(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_READONLY_ROLLBACK),
            None,
        ))
        .context("projection query failed");
        assert!(HistoryCatalogRecoveryRequired::from_error(&rollback).is_some());
        let typed = anyhow::Error::new(HistoryCatalogRecoveryRequired);
        assert!(HistoryCatalogRecoveryRequired::from_error(&typed).is_some());
        for code in [
            rusqlite::ffi::SQLITE_READONLY,
            rusqlite::ffi::SQLITE_READONLY_RECOVERY,
            rusqlite::ffi::SQLITE_READONLY_CANTLOCK,
            rusqlite::ffi::SQLITE_CORRUPT,
            rusqlite::ffi::SQLITE_NOTADB,
            rusqlite::ffi::SQLITE_IOERR,
        ] {
            let other = anyhow::Error::new(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("history_catalog_recovery_required".into()),
            ));
            assert!(
                HistoryCatalogRecoveryRequired::from_error(&other).is_none(),
                "{code}"
            );
        }
        assert!(
            HistoryCatalogRecoveryRequired::from_error(&anyhow::anyhow!(
                "Database has hot journal that must be rolled back (requires write access)"
            ))
            .is_none()
        );
    }

    #[cfg(windows)]
    #[test]
    fn private_catalog_windows_vfs_upgrades_preserve_competing_reader_exclusion() {
        let temp = tempfile::tempdir().unwrap();
        drop(
            HistoryCatalog::open(temp.path(), "project", true)
                .unwrap()
                .unwrap(),
        );
        let directory =
            PrivateDirectory::open_existing(&temp.path().join("history-index")).unwrap();
        let first_file = update_file(&directory, DATABASE, false).unwrap();
        let second_file = update_file(&directory, DATABASE, false).unwrap();
        let root = Arc::new(Root {
            directory,
            writable: true,
            max_file_bytes: MAX_FILE_BYTES,
            resource: None,
            recovery: None,
            recovery_active: AtomicBool::new(false),
            legacy_data_lock_conflict: AtomicBool::new(false),
        });
        let mut first = Handle {
            file: first_file,
            root: root.clone(),
            name: DATABASE.into(),
            lock: LockKind::None,
        };
        let mut second = Handle {
            file: second_file,
            root,
            name: DATABASE.into(),
            lock: LockKind::None,
        };
        assert!(first.lock(LockKind::Shared).unwrap());
        second.read_exact_at(&mut [0; 16], 0).unwrap();
        assert!(first.lock(LockKind::Reserved).unwrap());
        assert!(first.lock(LockKind::Exclusive).unwrap());
        assert!(!second.lock(LockKind::Shared).unwrap());
        assert!(first.lock(LockKind::None).unwrap());
        assert!(first.lock(LockKind::None).unwrap());
        assert!(second.lock(LockKind::Shared).unwrap());
        assert!(second.lock(LockKind::None).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn private_catalog_windows_legacy_mandatory_read_lock_is_reported_as_busy() {
        let temp = tempfile::tempdir().unwrap();
        drop(
            HistoryCatalog::open(temp.path(), "project", true)
                .unwrap()
                .unwrap(),
        );
        let legacy = File::open(temp.path().join("history-index").join(DATABASE)).unwrap();
        FileExt::try_lock_exclusive(&legacy).unwrap();
        let error = HistoryCatalog::open(temp.path(), "project", false)
            .err()
            .unwrap();
        assert!(
            error
                .chain()
                .any(|cause| cause.to_string() == "history_catalog_busy"),
            "{error:?}"
        );
        FileExt::unlock(&legacy).unwrap();
        assert!(
            HistoryCatalog::open(temp.path(), "project", false)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn private_catalog_files_process_child() {
        let Some(root) = std::env::var_os("KCODER_TEST_CATALOG_ROOT") else {
            return;
        };
        let mut catalog = HistoryCatalog::open(Path::new(&root), "project", true)
            .unwrap()
            .unwrap();
        if std::env::var("KCODER_TEST_CATALOG_CRASH").as_deref() == Ok("1") {
            catalog
                .connection
                .execute_batch("PRAGMA main.cache_size=4; PRAGMA cache_spill=ON;")
                .unwrap();
            let transaction = catalog
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            transaction
                .execute("UPDATE main.catalog_header SET revision=revision+1", [])
                .unwrap();
            transaction
                .execute_batch("CREATE TABLE main.spill_fixture(value BLOB);")
                .unwrap();
            for _ in 0..100 {
                transaction
                    .execute("INSERT INTO main.spill_fixture VALUES(zeroblob(4096))", [])
                    .unwrap();
            }
            std::process::exit(73);
        }
        let transaction = catalog
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        transaction
            .execute("UPDATE main.catalog_header SET revision=revision+1", [])
            .unwrap();
        println!("CATALOG_WRITER_READY");
        std::io::stdout().flush().unwrap();
        let mut command = String::new();
        std::io::stdin().read_line(&mut command).unwrap();
        assert_eq!(command.trim(), "commit");
        transaction.commit().unwrap();
    }

    #[test]
    fn private_catalog_files_crash_recovery_preserves_last_committed_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let writer = HistoryCatalog::open(temp.path(), "project", true)
            .unwrap()
            .unwrap();
        let revision = writer.revision().unwrap();
        let database = temp.path().join("history-index").join(DATABASE);
        let before = std::fs::read(&database).unwrap();
        drop(writer);
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "history_index::files::tests::private_catalog_files_process_child",
            ])
            .env("KCODER_TEST_CATALOG_ROOT", temp.path())
            .env("KCODER_TEST_CATALOG_CRASH", "1")
            .output()
            .unwrap();
        assert_eq!(
            child.status.code(),
            Some(73),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        let dirty = std::fs::read(&database).unwrap();
        assert_ne!(
            dirty, before,
            "fixture did not spill dirty pages to the database"
        );
        assert!(HistoryCatalog::open(temp.path(), "other", true).is_err());
        assert!(HistoryCatalog::open(temp.path(), "project", false).is_err());
        assert_eq!(
            std::fs::read(&database).unwrap(),
            dirty,
            "readonly or wrong-scope open repaired the database"
        );
        let mut recovered = HistoryCatalog::open(temp.path(), "project", true)
            .unwrap()
            .unwrap();
        let snapshot = recovered.snapshot(None, 10).unwrap();
        assert_eq!(snapshot.revision, revision);
        assert!(snapshot.sessions.is_empty());
        assert_eq!(std::fs::read(&database).unwrap(), before);
    }

    #[test]
    fn private_catalog_files_do_not_claim_unrecognized_sidecars() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("history-index");
        std::fs::create_dir(&path).unwrap();
        let wal = path.join("catalog.sqlite3-wal");
        std::fs::write(&wal, b"foreign WAL").unwrap();
        assert!(HistoryCatalog::open(temp.path(), "project", true).is_err());
        assert!(
            !path.join(OWNER).exists(),
            "claimed a directory with an unrecognized WAL"
        );
        assert_eq!(std::fs::read(wal).unwrap(), b"foreign WAL");
    }

    #[test]
    fn private_catalog_files_cross_process_lock_and_stale_publication() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let mut catalog = HistoryCatalog::open(temp.path(), "project", true)
            .unwrap()
            .unwrap();
        let before = catalog.revision().unwrap();
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "history_index::files::tests::private_catalog_files_process_child",
                    "--nocapture",
                ])
                .env("KCODER_TEST_CATALOG_ROOT", temp.path())
                .env_remove("KCODER_TEST_CATALOG_CRASH")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap() == "CATALOG_WRITER_READY" {
                    let _ = sender.send(());
                }
            }
        });
        receiver.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(
            catalog.snapshot(None, 10).is_err(),
            "read through another process's uncommitted writer"
        );
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"commit\n")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "catalog child did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
        reader.join().unwrap();
        assert_ne!(catalog.revision().unwrap(), before);
        assert!(catalog.publish(&before, &[], &[]).is_err());
        assert!(catalog.snapshot(None, 10).unwrap().sessions.is_empty());
    }

    #[test]
    #[ignore = "runs slot-capacity check without concurrent catalog tests"]
    fn private_catalog_pool_capacity_and_reuse() {
        let temp = tempfile::tempdir().unwrap();
        let mut catalogs = Vec::new();
        for _ in 0..SLOT_COUNT {
            catalogs.push(
                HistoryCatalog::open(temp.path(), "project", true)
                    .unwrap()
                    .unwrap(),
            );
        }
        let error = HistoryCatalog::open(temp.path(), "project", true)
            .err()
            .unwrap();
        assert!(
            error
                .downcast_ref::<HistoryCatalogCapacityReached>()
                .is_some()
        );
        drop(catalogs.pop());
        let replacement = HistoryCatalog::open(temp.path(), "project", true)
            .unwrap()
            .unwrap();
        // Reusing the released VFS slot must bind a different profile's real root.
        let first_slot = Arc::clone(&replacement.file_lease.as_ref().unwrap().0);
        let first_revision = replacement.revision().unwrap();
        drop(replacement);
        let other = tempfile::tempdir().unwrap();
        let mut replacement = HistoryCatalog::open(other.path(), "other-profile", true)
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(
            &first_slot,
            &replacement.file_lease.as_ref().unwrap().0
        ));
        assert!(replacement.publish(&first_revision, &[], &[]).is_err());
        assert!(replacement.snapshot(None, 10).unwrap().sessions.is_empty());
        drop(replacement);
        // A corrupt SQLite file fails after acquiring the only free VFS slot.
        std::fs::write(
            other.path().join("history-index/catalog.sqlite3"),
            b"not sqlite",
        )
        .unwrap();
        for _ in 0..SLOT_COUNT + 1 {
            let error = HistoryCatalog::open(other.path(), "other-profile", false)
                .err()
                .unwrap();
            assert!(
                error
                    .downcast_ref::<HistoryCatalogCapacityReached>()
                    .is_none()
            );
        }
        drop(catalogs);
        for _ in 0..SLOT_COUNT + 1 {
            drop(
                HistoryCatalog::open(temp.path(), "project", false)
                    .unwrap()
                    .unwrap(),
            );
        }
    }

    #[test]
    fn private_catalog_files_reject_oversized_encoded_owner_before_creation() {
        let temp = tempfile::tempdir().unwrap();
        let scope = "\"".repeat(16 * 1024);
        assert!(
            HistoryCatalog::open(temp.path(), &scope, true).is_err(),
            "created an owner record that cannot be reopened"
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn private_database_budget_is_specific_to_its_owned_directory() {
        let temp = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(temp.path()).unwrap();
        let opened = open_database_in(directory, "bounded-derived-store", true, 16 * 1024)
            .unwrap()
            .unwrap();
        opened
            .connection
            .execute_batch("CREATE TABLE payload(value BLOB)")
            .unwrap();
        assert!(
            opened
                .connection
                .execute("INSERT INTO payload VALUES(zeroblob(65536))", [])
                .is_err()
        );
        let count: u64 = opened
            .connection
            .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "quota failure must not publish a partial row");
        assert!(temp.path().join(DATABASE).metadata().unwrap().len() <= 16 * 1024);
        drop(opened);
        let directory = PrivateDirectory::open_existing(temp.path()).unwrap();
        let reopened = open_database_in(directory, "bounded-derived-store", false, 16 * 1024)
            .unwrap()
            .unwrap();
        let count: u64 = reopened
            .connection
            .query_row("SELECT count(*) FROM payload", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn private_catalog_files_short_reads_zero_only_the_unread_tail() {
        let temp = tempfile::tempdir().unwrap();
        let directory = PrivateDirectory::open_existing(temp.path()).unwrap();
        let mut file = directory
            .open_read_write_file(OsStr::new(DATABASE), true)
            .unwrap();
        file.write_all(b"abc").unwrap();
        let mut handle = Handle {
            file,
            root: Arc::new(Root {
                directory,
                writable: true,
                max_file_bytes: MAX_FILE_BYTES,
                resource: None,
                recovery: None,
                recovery_active: AtomicBool::new(false),
                #[cfg(windows)]
                legacy_data_lock_conflict: AtomicBool::new(false),
            }),
            name: DATABASE.into(),
            lock: LockKind::None,
        };
        for (offset, prefix) in [
            (0, b"abc".as_slice()),
            (2, b"c".as_slice()),
            (3, b"".as_slice()),
            (100, b"".as_slice()),
        ] {
            let mut bytes = [0xa5; 8];
            let error = handle.read_exact_at(&mut bytes, offset).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
            assert_eq!(&bytes[..prefix.len()], prefix);
            assert!(
                bytes[prefix.len()..].iter().all(|byte| *byte == 0),
                "short read left uninitialized tail bytes"
            );
        }
    }

    #[test]
    fn private_catalog_files_reject_replaced_database_with_live_handle() {
        let temp = tempfile::tempdir().unwrap();
        let mut old = HistoryCatalog::open(temp.path(), "project", true)
            .unwrap()
            .unwrap();
        let revision = old.revision().unwrap();
        let database = temp.path().join("history-index").join(DATABASE);
        std::fs::rename(&database, temp.path().join("parked.sqlite3")).unwrap();
        let fresh = HistoryCatalog::open(temp.path(), "project", true)
            .unwrap()
            .unwrap();
        let before = std::fs::read(&database).unwrap();
        let row = IndexedSession {
            session_id: "stale".into(),
            updated_at_ms: 1,
            archived: false,
            metadata: serde_json::json!({"title":"stale"}),
            source_proof: vec![1],
            metadata_proof: vec![2],
        };
        assert!(
            old.publish(&revision, &[row], &[]).is_err(),
            "old file handle accepted a stale write after replacement"
        );
        assert!(old.snapshot(None, 10).is_err());
        assert_eq!(std::fs::read(&database).unwrap(), before);
        assert_ne!(fresh.revision().unwrap(), revision);
    }

    #[cfg(unix)]
    #[test]
    fn private_catalog_files_keep_parent_capability_after_path_swap() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let active = temp.path().join("active");
        let parked = temp.path().join("parked");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&active).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let mut catalog = HistoryCatalog::open(&active, "project", true)
            .unwrap()
            .unwrap();
        std::fs::rename(&active, &parked).unwrap();
        symlink(&outside, &active).unwrap();
        let row = IndexedSession {
            session_id: "one".into(),
            updated_at_ms: 1,
            archived: false,
            metadata: serde_json::json!({}),
            source_proof: vec![1],
            metadata_proof: vec![2],
        };
        catalog
            .publish(
                &catalog.revision().unwrap(),
                std::slice::from_ref(&row),
                &[],
            )
            .unwrap();
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        drop(catalog);
        assert_eq!(
            HistoryCatalog::open(&parked, "project", false)
                .unwrap()
                .unwrap()
                .snapshot(None, 10)
                .unwrap()
                .sessions,
            vec![row]
        );
        assert!(HistoryCatalog::open(&active, "project", true).is_err());
    }

    #[test]
    fn private_catalog_files_round_trip_without_creating_on_read() {
        let temp = tempfile::tempdir().unwrap();
        assert!(
            HistoryCatalog::open(temp.path(), "project", false)
                .unwrap()
                .is_none()
        );
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        let mut writer = HistoryCatalog::open(temp.path(), "project", true)
            .unwrap()
            .unwrap();
        let row = IndexedSession {
            session_id: "one".into(),
            updated_at_ms: 1,
            archived: false,
            metadata: serde_json::json!({"title":"你好"}),
            source_proof: vec![1],
            metadata_proof: vec![2],
        };
        writer
            .publish(&writer.revision().unwrap(), std::slice::from_ref(&row), &[])
            .unwrap();
        drop(writer);
        let mut reader = HistoryCatalog::open(temp.path(), "project", false)
            .unwrap()
            .unwrap();
        assert_eq!(reader.snapshot(None, 10).unwrap().sessions, vec![row]);
        assert!(
            reader
                .publish(&reader.revision().unwrap(), &[], &["one"])
                .is_err()
        );
        assert!(HistoryCatalog::open(temp.path(), "other", true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn private_catalog_files_cannot_follow_database_or_journal_links() {
        use std::os::unix::fs::symlink;
        for leaf in ["catalog.sqlite3", "catalog.sqlite3-journal"] {
            let temp = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            drop(HistoryCatalog::open(temp.path(), "project", true).unwrap());
            let target = outside.path().join("keep");
            std::fs::write(&target, b"untouched").unwrap();
            let path = temp.path().join("history-index").join(leaf);
            if path.exists() {
                std::fs::remove_file(&path).unwrap();
            }
            symlink(&target, path).unwrap();
            assert!(HistoryCatalog::open(temp.path(), "project", true).is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
        }
    }

    #[test]
    fn legacy_verbatim_scope_is_accepted_and_migrated() {
        let scope = serde_json::to_string(&(
            "kcoder.tracked-list.v1",
            "ws",
            r"C:\p\history",
            r"C:\p\client",
        ))
        .unwrap();
        let legacy = serde_json::to_string(&(
            "kcoder.tracked-list.v1",
            "ws",
            r"\\?\C:\p\history",
            r"\\?\C:\p\client",
        ))
        .unwrap();
        // The stored scope is the legacy form; the current scope is the clean
        // form. On Windows the simplified comparison must consider them equal;
        // elsewhere dunce is the identity, so the forms stay distinct and the
        // comparison must reject the mismatch.
        #[cfg(windows)]
        assert!(scopes_match_after_normalization(&legacy, &scope));
        #[cfg(not(windows))]
        assert!(
            !scopes_match_after_normalization(&legacy, &scope),
            "an unsimplified legacy form must not compare equal off Windows"
        );
        assert!(scopes_match_after_normalization(&scope, &scope));
        let other = serde_json::to_string(&(
            "kcoder.tracked-list.v1",
            "other",
            r"C:\p\history",
            r"C:\p\client",
        ))
        .unwrap();
        assert!(
            !scopes_match_after_normalization(&other, &scope),
            "a genuinely different workspace must still be rejected"
        );
    }

    #[cfg(windows)]
    #[test]
    fn owner_record_is_migrated_to_the_clean_scope() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = serde_json::to_string(&(
            "kcoder.tracked-list.v1",
            "ws",
            r"\\?\C:\p\history",
            r"\\?\C:\p\client",
        ))
        .unwrap();
        let current = serde_json::to_string(&(
            "kcoder.tracked-list.v1",
            "ws",
            r"C:\p\history",
            r"C:\p\client",
        ))
        .unwrap();
        HistoryCatalog::open_with_owner_scope(temp.path(), &current, &legacy, true).unwrap();
        let reread = HistoryCatalog::open(temp.path(), &current, false).unwrap();
        assert!(
            reread.is_some(),
            "the migrated owner must pass the fast equality path"
        );
    }

    #[test]
    fn scope_components_are_namespace_free_by_construction() {
        let component = super::scope_path_component(Path::new(r"\\?\C:\Users\x\proj"));
        assert!(
            !component.contains(r"\\?\") || cfg!(not(windows)),
            "scope components must drop the namespace on Windows: {component}"
        );
    }
}
