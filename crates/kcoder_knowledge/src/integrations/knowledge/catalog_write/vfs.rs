//! Only one native-owned DB and its rollback journal are reachable through this VFS.
//! The host holds an exclusive namespace lease, shared by every native reader/writer.
use anyhow::{Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use sqlite_vfs::{
    DatabaseHandle, LockKind, OpenAccess, OpenKind, OpenOptions, Vfs,
    wip::{WalIndex, WalIndexLock},
};
use std::{
    borrow::Cow,
    collections::BTreeMap,
    ffi::OsStr,
    fs::File,
    io,
    ops::Range,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const DB: &str = "catalog.sqlite";
const JOURNAL: &str = "catalog.sqlite-journal";
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
struct OwnedFile {
    file: File,
    identity: PortableLeaseIdentity,
}
struct Context {
    directory: PrivateDirectory,
    directory_identity: String,
    files: Mutex<BTreeMap<String, Arc<OwnedFile>>>,
    started: Instant,
    failed: AtomicBool,
}
impl Context {
    fn check(&self) -> io::Result<()> {
        let result = (|| -> Result<()> {
            ensure!(
                self.started.elapsed() <= Duration::from_secs(30),
                "KNOWLEDGE_NATIVE_WRITE_TIMEOUT"
            );
            self.directory.verify_private_directory()?;
            ensure!(
                self.directory.directory_identity()? == self.directory_identity,
                "KNOWLEDGE_NATIVE_NAMESPACE_CHANGED"
            );
            Ok(())
        })();
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result.map_err(|_| io::Error::other("owned catalog unavailable"))
    }
    fn verify_file(&self, name: &str, file: &OwnedFile) -> io::Result<()> {
        self.check()?;
        let result = (|| -> Result<()> {
            ensure!(
                self.directory
                    .portable_regular_handle_identity(&file.file)?
                    == file.identity
                    && self.directory.portable_regular_identity(OsStr::new(name))? == file.identity,
                "KNOWLEDGE_NATIVE_DATABASE_CHANGED"
            );
            Ok(())
        })();
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result.map_err(|_| io::Error::other("owned catalog object changed"))
    }
    fn denied(&self) -> io::Error {
        self.failed.store(true, Ordering::Release);
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "owned catalog operation unavailable",
        )
    }
}
struct Slot {
    active: AtomicBool,
    current: Mutex<Option<Arc<Context>>>,
    name: String,
}
pub(super) struct Lease {
    slot: Arc<Slot>,
    context: Arc<Context>,
}
impl Lease {
    pub(super) fn name(&self) -> &str {
        &self.slot.name
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.context.check()?;
        ensure!(
            !self.context.failed.load(Ordering::Acquire),
            "KNOWLEDGE_NATIVE_WRITE_UNCONFIRMED"
        );
        let main = self
            .context
            .files
            .lock()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_NATIVE_WRITE_UNCONFIRMED"))?
            .get(DB)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_DATABASE_CHANGED"))?;
        self.context.verify_file(DB, &main)?;
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut current) = self.slot.current.lock() {
            *current = None;
        }
        self.slot.active.store(false, Ordering::Release);
    }
}
pub(super) fn acquire(
    directory: &PrivateDirectory,
    expected: &PortableLeaseIdentity,
) -> Result<Lease> {
    directory.verify_private_directory()?;
    let file = directory.open_read_write_file(OsStr::new(DB), false)?;
    ensure!(
        directory.portable_regular_handle_identity(&file)? == *expected,
        "KNOWLEDGE_NATIVE_DATABASE_CHANGED"
    );
    let mut files = BTreeMap::new();
    files.insert(
        DB.into(),
        Arc::new(OwnedFile {
            file,
            identity: expected.clone(),
        }),
    );
    static POOL: OnceLock<Result<Vec<Arc<Slot>>, String>> = OnceLock::new();
    let slots = POOL
        .get_or_init(|| {
            (0..4)
                .map(|index| {
                    let slot = Arc::new(Slot {
                        active: AtomicBool::new(false),
                        current: Mutex::new(None),
                        name: format!("kcoder-owned-publications-{index}"),
                    });
                    sqlite_vfs::register(&slot.name, Backend(slot.clone()), false)
                        .map_err(|_| "owned catalog VFS unavailable".to_owned())?;
                    Ok(slot)
                })
                .collect()
        })
        .as_ref()
        .map_err(|_| anyhow::anyhow!("KNOWLEDGE_NATIVE_VFS_UNAVAILABLE"))?;
    for slot in slots {
        if slot
            .active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            let context = Arc::new(Context {
                directory: directory.duplicate_handle()?,
                directory_identity: directory.directory_identity()?,
                files: Mutex::new(files),
                started: Instant::now(),
                failed: AtomicBool::new(false),
            });
            let lease = Lease {
                slot: slot.clone(),
                context,
            };
            *slot
                .current
                .lock()
                .map_err(|_| anyhow::anyhow!("KNOWLEDGE_NATIVE_VFS_UNAVAILABLE"))? =
                Some(lease.context.clone());
            return Ok(lease);
        }
    }
    anyhow::bail!("KNOWLEDGE_NATIVE_STORE_BUSY")
}
struct Backend(Arc<Slot>);
impl Backend {
    fn context(&self) -> io::Result<Arc<Context>> {
        self.0
            .current
            .lock()
            .map_err(|_| io::Error::other("owned VFS slot unavailable"))?
            .clone()
            .ok_or_else(|| io::Error::other("owned VFS slot closed"))
    }
}
struct Handle {
    context: Arc<Context>,
    name: String,
    file: Arc<OwnedFile>,
    lock: LockKind,
}
impl Vfs for Backend {
    type Handle = Handle;
    fn open(&self, name: &str, options: OpenOptions) -> io::Result<Handle> {
        let context = self.context()?;
        context.check()?;
        if !matches!(
            (name, options.kind),
            (DB, OpenKind::MainDb) | (JOURNAL, OpenKind::MainJournal)
        ) {
            return Err(context.denied());
        }
        let mut files = context
            .files
            .lock()
            .map_err(|_| io::Error::other("owned VFS unavailable"))?;
        let owned = if let Some(file) = files.get(name) {
            file.clone()
        } else {
            if name != JOURNAL {
                return Err(context.denied());
            }
            let current = context
                .directory
                .open_read_write_file(OsStr::new(name), false);
            let file = match current {
                Ok(file) => file,
                Err(error)
                    if error.chain().any(|cause| {
                        cause
                            .downcast_ref::<io::Error>()
                            .is_some_and(|cause| cause.kind() == io::ErrorKind::NotFound)
                    }) && matches!(
                        options.access,
                        OpenAccess::Create | OpenAccess::CreateNew
                    ) =>
                {
                    let file = context
                        .directory
                        .open_read_write_file(OsStr::new(name), true)
                        .map_err(|_| context.denied())?;
                    context.directory.sync().map_err(|_| context.denied())?;
                    file
                }
                Err(_) => return Err(context.denied()),
            };
            let identity = context
                .directory
                .portable_regular_handle_identity(&file)
                .map_err(|_| context.denied())?;
            let file = Arc::new(OwnedFile { file, identity });
            files.insert(name.into(), file.clone());
            file
        };
        context.verify_file(name, &owned)?;
        drop(files);
        Ok(Handle {
            context,
            name: name.into(),
            file: owned,
            lock: LockKind::None,
        })
    }
    fn delete(&self, name: &str) -> io::Result<()> {
        let context = self.context()?;
        context.check()?;
        if name != JOURNAL {
            return Err(context.denied());
        }
        let mut files = context.files.lock().map_err(|_| context.denied())?;
        let file = files.get(name).cloned().ok_or_else(|| context.denied())?;
        context.verify_file(name, &file)?;
        context
            .directory
            .remove_regular_file(OsStr::new(name))
            .map_err(|_| context.denied())?;
        context.directory.sync().map_err(|_| context.denied())?;
        files.remove(name);
        Ok(())
    }
    fn exists(&self, name: &str) -> io::Result<bool> {
        let context = self.context()?;
        context.check()?;
        match name {
            DB => Ok(true),
            JOURNAL => match context.directory.entry_metadata(OsStr::new(name)) {
                Ok(_) => Ok(true),
                Err(error)
                    if error.chain().any(|cause| {
                        cause
                            .downcast_ref::<io::Error>()
                            .is_some_and(|cause| cause.kind() == io::ErrorKind::NotFound)
                    }) =>
                {
                    Ok(false)
                }
                Err(_) => Err(context.denied()),
            },
            "catalog.sqlite-wal" | "catalog.sqlite-shm" => Ok(false),
            _ => Err(context.denied()),
        }
    }
    fn full_pathname<'a>(&self, name: &'a str) -> io::Result<Cow<'a, str>> {
        if name == DB {
            Ok(Cow::Borrowed(name))
        } else {
            Err(io::Error::other("owned catalog name unavailable"))
        }
    }
    fn temporary_name(&self) -> String {
        "forbidden-owned-catalog-temporary".into()
    }
    fn random(&self, bytes: &mut [i8]) {
        for chunk in bytes.chunks_mut(16) {
            let value = uuid::Uuid::new_v4();
            for (out, input) in chunk.iter_mut().zip(value.as_bytes()) {
                *out = *input as i8;
            }
        }
    }
    fn sleep(&self, _duration: Duration) -> Duration {
        Duration::ZERO
    }
    fn access(&self, name: &str, _write: bool) -> io::Result<bool> {
        self.exists(name)
    }
}
impl DatabaseHandle for Handle {
    type WalIndex = NoWal;
    fn size(&self) -> io::Result<u64> {
        self.context.verify_file(&self.name, &self.file)?;
        Ok(self.file.file.metadata()?.len())
    }
    fn read_exact_at(&mut self, bytes: &mut [u8], offset: u64) -> io::Result<()> {
        self.context.verify_file(&self.name, &self.file)?;
        let mut read = 0;
        while read < bytes.len() {
            let offset = offset
                .checked_add(read as u64)
                .ok_or_else(|| self.context.denied())?;
            #[cfg(unix)]
            let count = {
                use std::os::unix::fs::FileExt;
                self.file.file.read_at(&mut bytes[read..], offset)?
            };
            #[cfg(windows)]
            let count = {
                use std::os::windows::fs::FileExt;
                self.file.file.seek_read(&mut bytes[read..], offset)?
            };
            #[cfg(not(any(unix, windows)))]
            let count = {
                let _ = offset;
                return Err(self.context.denied());
            };
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "owned catalog ended",
                ));
            }
            read += count;
        }
        Ok(())
    }
    fn write_all_at(&mut self, bytes: &[u8], offset: u64) -> io::Result<()> {
        self.context.verify_file(&self.name, &self.file)?;
        if offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > MAX_BYTES)
        {
            return Err(self.context.denied());
        }
        let mut written = 0;
        while written < bytes.len() {
            let offset = offset
                .checked_add(written as u64)
                .ok_or_else(|| self.context.denied())?;
            #[cfg(unix)]
            let count = {
                use std::os::unix::fs::FileExt;
                self.file.file.write_at(&bytes[written..], offset)?
            };
            #[cfg(windows)]
            let count = {
                use std::os::windows::fs::FileExt;
                self.file.file.seek_write(&bytes[written..], offset)?
            };
            #[cfg(not(any(unix, windows)))]
            let count = {
                let _ = offset;
                return Err(self.context.denied());
            };
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "owned catalog write incomplete",
                ));
            }
            written += count;
        }
        Ok(())
    }
    fn sync(&mut self, _data_only: bool) -> io::Result<()> {
        self.context.verify_file(&self.name, &self.file)?;
        self.file.file.sync_all()
    }
    fn set_len(&mut self, bytes: u64) -> io::Result<()> {
        self.context.verify_file(&self.name, &self.file)?;
        if bytes > MAX_BYTES {
            return Err(self.context.denied());
        }
        self.file.file.set_len(bytes)
    }
    fn lock(&mut self, lock: LockKind) -> io::Result<bool> {
        self.context.verify_file(&self.name, &self.file)?;
        self.lock = lock;
        Ok(true)
    }
    fn current_lock(&self) -> io::Result<LockKind> {
        Ok(self.lock)
    }
    fn reserved(&mut self) -> io::Result<bool> {
        Ok(false)
    }
    fn moved(&self) -> io::Result<bool> {
        Ok(self.context.verify_file(&self.name, &self.file).is_err())
    }
    fn wal_index(&self, _readonly: bool) -> io::Result<NoWal> {
        Err(self.context.denied())
    }
}
struct NoWal;
impl WalIndex for NoWal {
    fn enabled() -> bool {
        false
    }
    fn map(&mut self, _region: u32) -> io::Result<[u8; 32768]> {
        Err(io::Error::other("owned catalog WAL unavailable"))
    }
    fn lock(&mut self, _range: Range<u8>, _lock: WalIndexLock) -> io::Result<bool> {
        Err(io::Error::other("owned catalog WAL unavailable"))
    }
    fn delete(self) -> io::Result<()> {
        Err(io::Error::other("owned catalog WAL unavailable"))
    }
}
