//! Only pinned source descriptors are readable. All coordination pages are private RAM.
use super::super::{ProjectReadCancellation, ProjectReadLimits, ProjectReadProof};
use anyhow::{Result, ensure};
use kcoder_config::{SqliteSourcePart, SqliteSourceReadLease};
use sha2::{Digest, Sha256};
use sqlite_vfs::{
    DatabaseHandle, LockKind, OpenKind, OpenOptions, Vfs,
    wip::{WalIndex, WalIndexLock},
};
use std::{
    borrow::Cow,
    collections::BTreeMap,
    io,
    ops::Range,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const DB: &str = "registry.sqlite";
const WAL: &str = "registry.sqlite-wal";
const SLOTS: usize = 4;
const MAX_INDEX_REGIONS: u32 = 512;
pub(crate) struct Context {
    source: SqliteSourceReadLease,
    cancel: ProjectReadCancellation,
    limits: ProjectReadLimits,
    started: Instant,
    bytes: AtomicU64,
    actual: AtomicU64,
    reads: AtomicU64,
    failure: AtomicU8,
    writes: AtomicU64,
    digest: Mutex<Sha256>,
    index: Mutex<BTreeMap<u32, [u8; 32768]>>,
    empty_wal: Mutex<Vec<u8>>,
}
impl Context {
    pub(super) fn check(&self, bytes: usize) -> io::Result<()> {
        let code = if self.cancel.is_cancelled() {
            1
        } else if self.started.elapsed() > self.limits.elapsed {
            2
        } else if self
            .bytes
            .fetch_add(bytes as u64, Ordering::Relaxed)
            .checked_add(bytes as u64)
            .is_none_or(|count| count > self.limits.read_bytes)
        {
            3
        } else {
            0
        };
        if code != 0 {
            let _ = self
                .failure
                .compare_exchange(0, code, Ordering::AcqRel, Ordering::Acquire);
            return Err(io::Error::other("project source read stopped"));
        }
        Ok(())
    }
    fn denied(&self) -> io::Error {
        self.writes.fetch_add(1, Ordering::Relaxed);
        let _ = self
            .failure
            .compare_exchange(0, 4, Ordering::AcqRel, Ordering::Acquire);
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "source mutation is forbidden",
        )
    }
    pub(super) fn failure(&self) -> Option<&'static str> {
        match self.failure.load(Ordering::Acquire) {
            0 => None,
            1 => Some("migration_project_source_cancelled"),
            2 | 3 => Some("migration_project_source_budget_exceeded"),
            _ => Some("migration_project_source_mutation_refused"),
        }
    }
    pub(super) fn proof(&self) -> Result<ProjectReadProof> {
        self.source.verify()?;
        ensure!(
            self.failure().is_none() && self.writes.load(Ordering::Relaxed) == 0,
            "migration_project_source_read_failed"
        );
        Ok(ProjectReadProof {
            source_identity_sha256: self.source.identity_sha256()?,
            database_bytes: self.source.fact(SqliteSourcePart::Database).unwrap().bytes,
            wal_bytes: self
                .source
                .fact(SqliteSourcePart::Wal)
                .map_or(0, |file| file.bytes),
            actual_read_bytes: self.actual.load(Ordering::Relaxed),
            actual_reads: self.reads.load(Ordering::Relaxed),
            input_digest: format!(
                "{:x}",
                self.digest
                    .lock()
                    .map_err(|_| anyhow::anyhow!("migration_project_source_read_failed"))?
                    .clone()
                    .finalize()
            ),
            elapsed_ms: self
                .started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            source_write_attempts: 0,
        })
    }
}
struct Slot {
    active: AtomicBool,
    current: Mutex<Option<Arc<Context>>>,
    name: String,
}
pub(super) struct Lease {
    slot: Arc<Slot>,
    pub context: Arc<Context>,
}
impl Lease {
    pub(super) fn name(&self) -> &str {
        &self.slot.name
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
    source: SqliteSourceReadLease,
    cancel: ProjectReadCancellation,
    limits: ProjectReadLimits,
) -> Result<Lease> {
    static POOL: OnceLock<Result<Vec<Arc<Slot>>, String>> = OnceLock::new();
    let pool = POOL
        .get_or_init(|| {
            (0..SLOTS)
                .map(|index| {
                    let slot = Arc::new(Slot {
                        active: AtomicBool::new(false),
                        current: Mutex::new(None),
                        name: format!("kcoder-source-projects-{index}"),
                    });
                    sqlite_vfs::register(&slot.name, Backend(Arc::clone(&slot)), false)
                        .map_err(|_| "source VFS registration failed".to_string())?;
                    Ok(slot)
                })
                .collect()
        })
        .as_ref()
        .map_err(|_| anyhow::anyhow!("migration_project_source_vfs_unavailable"))?;
    for slot in pool {
        if slot
            .active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_ok()
        {
            let context = Arc::new(Context {
                source,
                cancel,
                limits,
                started: Instant::now(),
                bytes: AtomicU64::new(0),
                actual: AtomicU64::new(0),
                reads: AtomicU64::new(0),
                failure: AtomicU8::new(0),
                writes: AtomicU64::new(0),
                digest: Mutex::new(Sha256::new()),
                index: Mutex::new(BTreeMap::new()),
                empty_wal: Mutex::new(Vec::new()),
            });
            let lease = Lease {
                slot: Arc::clone(slot),
                context,
            };
            *slot
                .current
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_project_source_vfs_unavailable"))? =
                Some(Arc::clone(&lease.context));
            return Ok(lease);
        }
    }
    anyhow::bail!("migration_project_source_busy")
}
struct Backend(Arc<Slot>);
impl Backend {
    fn current(&self) -> io::Result<Arc<Context>> {
        self.0
            .current
            .lock()
            .map_err(|_| io::Error::other("source VFS slot unavailable"))?
            .clone()
            .ok_or_else(|| io::Error::other("source VFS slot closed"))
    }
}
#[derive(Clone, Copy)]
enum Part {
    Database,
    Wal,
    EmptyWal,
}
struct Handle {
    context: Arc<Context>,
    part: Part,
    lock: LockKind,
}
impl Vfs for Backend {
    type Handle = Handle;
    fn open(&self, name: &str, options: OpenOptions) -> io::Result<Handle> {
        let context = self.current()?;
        context.check(0)?;
        let part = match (name, options.kind) {
            (DB, OpenKind::MainDb) => Part::Database,
            (WAL, OpenKind::Wal) => {
                if context.source.fact(SqliteSourcePart::Wal).is_some() {
                    Part::Wal
                } else {
                    Part::EmptyWal
                }
            }
            _ => return Err(context.denied()),
        };
        Ok(Handle {
            context,
            part,
            lock: LockKind::None,
        })
    }
    fn delete(&self, name: &str) -> io::Result<()> {
        let context = self.current()?;
        if name == WAL && context.source.fact(SqliteSourcePart::Wal).is_none() {
            context
                .empty_wal
                .lock()
                .map_err(|_| io::Error::other("private index unavailable"))?
                .clear();
            Ok(())
        } else {
            Err(context.denied())
        }
    }
    fn exists(&self, name: &str) -> io::Result<bool> {
        let context = self.current()?;
        match name {
            DB => Ok(true),
            WAL => Ok(context.source.fact(SqliteSourcePart::Wal).is_some()),
            "registry.sqlite-journal" | "registry.sqlite-shm" => Ok(false),
            _ => Err(io::Error::other("unknown source VFS name")),
        }
    }
    fn full_pathname<'a>(&self, name: &'a str) -> io::Result<Cow<'a, str>> {
        if name == DB {
            Ok(Cow::Borrowed(name))
        } else {
            Err(io::Error::other("unknown source VFS name"))
        }
    }
    fn access(&self, name: &str, _write: bool) -> io::Result<bool> {
        self.exists(name)
    }
    fn temporary_name(&self) -> String {
        "forbidden-project-temporary".into()
    }
    fn random(&self, bytes: &mut [i8]) {
        for byte in bytes {
            *byte = 0;
        }
    }
    fn sleep(&self, _duration: Duration) -> Duration {
        Duration::ZERO
    }
}
impl DatabaseHandle for Handle {
    type WalIndex = PrivateIndex;
    fn size(&self) -> io::Result<u64> {
        Ok(match self.part {
            Part::Database => {
                self.context
                    .source
                    .fact(SqliteSourcePart::Database)
                    .unwrap()
                    .bytes
            }
            Part::Wal => {
                self.context
                    .source
                    .fact(SqliteSourcePart::Wal)
                    .unwrap()
                    .bytes
            }
            Part::EmptyWal => self
                .context
                .empty_wal
                .lock()
                .map_err(|_| io::Error::other("private index unavailable"))?
                .len() as u64,
        })
    }
    fn read_exact_at(&mut self, bytes: &mut [u8], offset: u64) -> io::Result<()> {
        self.context.check(bytes.len())?;
        if let Part::EmptyWal = self.part {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "empty private WAL",
            ));
        }
        let part = if matches!(self.part, Part::Database) {
            SqliteSourcePart::Database
        } else {
            SqliteSourcePart::Wal
        };
        let mut read = 0;
        while read < bytes.len() {
            self.context.check(0)?;
            let count = self.context.source.read_at(
                part,
                offset
                    .checked_add(read as u64)
                    .ok_or_else(|| io::Error::other("source offset overflow"))?,
                &mut bytes[read..],
            )?;
            if count == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "source ended"));
            }
            self.context
                .actual
                .fetch_add(count as u64, Ordering::Relaxed);
            read += count;
        }
        let mut digest = self
            .context
            .digest
            .lock()
            .map_err(|_| io::Error::other("source proof unavailable"))?;
        digest.update([if matches!(self.part, Part::Database) {
            0
        } else {
            1
        }]);
        digest.update(offset.to_le_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(Sha256::digest(bytes));
        self.context.reads.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
    fn write_all_at(&mut self, bytes: &[u8], offset: u64) -> io::Result<()> {
        if !matches!(self.part, Part::EmptyWal) {
            return Err(self.context.denied());
        }
        let end = usize::try_from(offset)
            .ok()
            .and_then(|offset| offset.checked_add(bytes.len()))
            .filter(|end| *end <= 32768)
            .ok_or_else(|| io::Error::other("private WAL budget"))?;
        let mut wal = self
            .context
            .empty_wal
            .lock()
            .map_err(|_| io::Error::other("private index unavailable"))?;
        let size = end.max(wal.len());
        wal.resize(size, 0);
        wal[end - bytes.len()..end].copy_from_slice(bytes);
        Ok(())
    }
    fn sync(&mut self, _data_only: bool) -> io::Result<()> {
        Ok(())
    }
    fn set_len(&mut self, bytes: u64) -> io::Result<()> {
        if !matches!(self.part, Part::EmptyWal) {
            return Err(self.context.denied());
        }
        let bytes = usize::try_from(bytes)
            .ok()
            .filter(|bytes| *bytes <= 32768)
            .ok_or_else(|| io::Error::other("private WAL budget"))?;
        self.context
            .empty_wal
            .lock()
            .map_err(|_| io::Error::other("private index unavailable"))?
            .resize(bytes, 0);
        Ok(())
    }
    fn lock(&mut self, kind: LockKind) -> io::Result<bool> {
        self.lock = kind;
        Ok(true)
    }
    fn current_lock(&self) -> io::Result<LockKind> {
        Ok(self.lock)
    }
    fn reserved(&mut self) -> io::Result<bool> {
        Ok(false)
    }
    fn moved(&self) -> io::Result<bool> {
        Ok(self.context.source.verify().is_err())
    }
    fn wal_index(&self, _readonly: bool) -> io::Result<PrivateIndex> {
        Ok(PrivateIndex(Arc::clone(&self.context)))
    }
}
struct PrivateIndex(Arc<Context>);
impl WalIndex for PrivateIndex {
    fn map(&mut self, region: u32) -> io::Result<[u8; 32768]> {
        self.0.check(0)?;
        if region >= MAX_INDEX_REGIONS {
            return Err(io::Error::other("private WAL index budget"));
        }
        Ok(*self
            .0
            .index
            .lock()
            .map_err(|_| io::Error::other("private index unavailable"))?
            .entry(region)
            .or_insert([0; 32768]))
    }
    fn lock(&mut self, _range: Range<u8>, _lock: WalIndexLock) -> io::Result<bool> {
        self.0.check(0)?;
        Ok(true)
    }
    fn delete(self) -> io::Result<()> {
        Ok(())
    }
    fn pull(&mut self, region: u32, bytes: &mut [u8; 32768]) -> io::Result<()> {
        *bytes = self.map(region)?;
        Ok(())
    }
    fn push(&mut self, region: u32, bytes: &[u8; 32768]) -> io::Result<()> {
        if region >= MAX_INDEX_REGIONS {
            return Err(io::Error::other("private WAL index budget"));
        }
        self.0
            .index
            .lock()
            .map_err(|_| io::Error::other("private index unavailable"))?
            .insert(region, *bytes);
        Ok(())
    }
}
