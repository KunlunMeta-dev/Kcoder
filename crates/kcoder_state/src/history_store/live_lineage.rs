//! Opt-in, process-local evidence for a bounded uninterrupted append chain.
//! This does not grant execution, cross-restart identity, or a source lease.
use super::*;
use crate::{
    AppState, AppStateLifecycleIdentity, CurrentHistoryObservation, CurrentHistoryPresence,
    HistoryEntry, Message, NativeHistoryRowReceipt,
};
use anyhow::{Context, ensure};
use kcoder_types::MessageOrigin;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};

const MAX_PREFIX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SUFFIX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ROW_BYTES: u64 = 4 * 1024 * 1024;
const MAX_STEPS: usize = 256;
const MAX_PREFIX_UUIDS: usize = 131_072;
const MAX_TRACKERS: usize = 16;
const ARMED: u8 = 0;
const TRACKING: u8 = 1;
const IN_FLIGHT: u8 = 2;
static ACTIVE_TRACKERS: AtomicUsize = AtomicUsize::new(0);

/// Observation only: a tracking value is not an execution or lease grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHistoryLineageStatus {
    Armed,
    Tracking,
    Unknown,
}

struct TrackerPermit;

impl TrackerPermit {
    fn acquire() -> Option<Self> {
        ACTIVE_TRACKERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < MAX_TRACKERS).then_some(value + 1)
            })
            .ok()
            .map(|_| Self)
    }
}

impl Drop for TrackerPermit {
    fn drop(&mut self) {
        ACTIVE_TRACKERS.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) struct LineageSlot {
    invalid: AtomicBool,
    phase_tag: AtomicU8,
    phase: Mutex<Phase>,
    _permit: TrackerPermit,
}

impl std::fmt::Debug for LineageSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LineageSlot").finish_non_exhaustive()
    }
}

enum Phase {
    Armed { session_id: String },
    Tracking(Box<Tracking>),
    InFlight,
}

struct Tracking {
    original: HistoryEntry,
    original_receipt: LiveAppendReceipt,
    head: Option<LiveAppendReceipt>,
    original_start: u64,
    original_end: u64,
    prefix_digest: [u8; 32],
    suffix_digest: Sha256,
    suffix_bytes: u64,
    last_uuid: String,
    seen: HashSet<String>,
    steps: usize,
}

impl Tracking {
    fn head_mut(&mut self) -> &mut LiveAppendReceipt {
        self.head.as_mut().unwrap_or(&mut self.original_receipt)
    }
}

/// A bounded, process-local reservation for a single native source binding.
/// It must be created before the witnessed input is written. Dropping it
/// revokes observation; it does not cancel or replay any history mutation.
pub struct NativeHistoryLineageReservation {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    source: HistorySource,
    slot: Arc<LineageSlot>,
}

impl Drop for NativeHistoryLineageReservation {
    fn drop(&mut self) {
        self.slot.invalid.store(true, Ordering::Release);
    }
}

impl NativeHistoryLineageReservation {
    /// A busy State observation is unknown. Tracking does not recheck the
    /// physical source and is never permission to act.
    pub fn status(&self) -> NativeHistoryLineageStatus {
        if self.slot.invalid.load(Ordering::Acquire) {
            return NativeHistoryLineageStatus::Unknown;
        }
        let Ok(inner) = self.state.inner.try_read() else {
            return NativeHistoryLineageStatus::Unknown;
        };
        if !self.owner.matches_locked(&self.state, &inner)
            || !inner
                .history_source
                .as_ref()
                .is_some_and(|source| source.shares_binding(&self.source))
        {
            self.slot.invalid.store(true, Ordering::Release);
            return NativeHistoryLineageStatus::Unknown;
        }
        drop(inner);
        match self.slot.phase_tag.load(Ordering::Acquire) {
            ARMED => NativeHistoryLineageStatus::Armed,
            TRACKING => NativeHistoryLineageStatus::Tracking,
            _ => NativeHistoryLineageStatus::Unknown,
        }
    }
}

impl AppState {
    /// Reserve before admitting the original input. This method performs no
    /// filesystem I/O and never waits for State or source locks. None means
    /// unsupported, busy, or at capacity; the ordinary writer is unchanged.
    /// Only an existing Linux source can currently produce a live chain.
    pub fn try_reserve_native_history_lineage(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<Option<NativeHistoryLineageReservation>> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = owner;
            return Ok(None);
        }
        #[cfg(target_os = "linux")]
        {
            let inner = match self.inner.try_read() {
                Ok(inner) => inner,
                Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    anyhow::bail!("history State is poisoned")
                }
            };
            ensure!(
                owner.matches_locked(self, &inner),
                "history lifecycle changed"
            );
            let Some(source) = inner.history_source.clone() else {
                return Ok(None);
            };
            let session_id = inner.session_id.clone();
            let mut binding = match source.binding.try_lock() {
                Ok(binding) => binding,
                Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    anyhow::bail!("history source binding is poisoned")
                }
            };
            if !binding.initialized
                || binding
                    .lineage
                    .as_ref()
                    .and_then(std::sync::Weak::upgrade)
                    .is_some()
            {
                return Ok(None);
            }
            let Some(permit) = TrackerPermit::acquire() else {
                return Ok(None);
            };
            let slot = Arc::new(LineageSlot {
                invalid: AtomicBool::new(false),
                phase_tag: AtomicU8::new(ARMED),
                phase: Mutex::new(Phase::Armed { session_id }),
                _permit: permit,
            });
            binding.lineage = Some(Arc::downgrade(&slot));
            drop(binding);
            drop(inner);
            Ok(Some(NativeHistoryLineageReservation {
                state: self.clone(),
                owner: owner.clone(),
                source,
                slot,
            }))
        }
    }
}

#[derive(Default)]
struct InitialAudit {
    digest: Sha256,
    seen: HashSet<String>,
    anchor: Option<File>,
    stamp: Option<live_append_receipt::BodyStamp>,
}

impl InitialAudit {
    /// Scan the original prefix once, before writing the new original row.
    fn capture(
        &mut self,
        file: File,
        session_id: &str,
        origin_uuid: &str,
        origin_parent: Option<&str>,
        new_len: usize,
    ) -> Result<()> {
        use std::io::BufRead;
        let before = live_append_receipt::stamp(&file)?;
        let length = file.metadata()?.len();
        ensure!(
            length
                .checked_add(u64::try_from(new_len)?)
                .is_some_and(|total| total <= MAX_PREFIX_BYTES),
            "native lineage prefix exceeds budget"
        );
        let mut reader = std::io::BufReader::new(file);
        let mut line = Vec::new();
        let mut consumed = 0_u64;
        let mut last_uuid = None;
        loop {
            line.clear();
            let read = (&mut reader)
                .take(length - consumed)
                .read_until(b'\n', &mut line)?;
            if read == 0 {
                break;
            }
            consumed = consumed
                .checked_add(u64::try_from(read)?)
                .context("native lineage prefix overflow")?;
            ensure!(
                line.ends_with(b"\n"),
                "native lineage prefix has an incomplete row"
            );
            self.digest.update(&line);
            let value: serde_json::Value = serde_json::from_slice(&line)?;
            ensure!(
                value.get("session_id").and_then(serde_json::Value::as_str) == Some(session_id),
                "native lineage prefix session differs or is unknown"
            );
            let uuid = value
                .get("uuid")
                .and_then(serde_json::Value::as_str)
                .context("native lineage prefix UUID missing or invalid")?;
            ensure!(
                !uuid.is_empty() && uuid.len() <= 256,
                "native lineage prefix UUID invalid"
            );
            ensure!(
                self.seen.len() < MAX_PREFIX_UUIDS,
                "native lineage prefix UUID budget exceeded"
            );
            ensure!(
                self.seen.insert(uuid.to_owned()),
                "native lineage prefix UUID is ambiguous"
            );
            last_uuid = Some(uuid.to_owned());
        }
        ensure!(
            consumed == length
                && reader.get_ref().metadata()?.len() == length
                && live_append_receipt::stamp(reader.get_ref())? == before,
            "native lineage prefix changed during observation"
        );
        ensure!(
            !self.seen.contains(origin_uuid),
            "native lineage origin UUID already exists"
        );
        ensure!(
            last_uuid.as_deref() == origin_parent,
            "native lineage origin parent differs"
        );
        self.anchor = Some(reader.into_inner());
        self.stamp = Some(before);
        Ok(())
    }
}

fn supported_filesystem(file: &File) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: file is a live descriptor and info is valid writable storage.
        ensure!(
            unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } == 0,
            "native lineage filesystem observation failed"
        );
        // SAFETY: successful fstatfs initialized the structure.
        let kind = unsafe { info.assume_init() }.f_type as u64;
        // 0xef53 is shared by ext2, ext3 and ext4; this is a family
        // filter, not a source identity or proof of crash recovery.
        ensure!(
            matches!(kind, 0xef53 | 0x0102_1994),
            "native lineage filesystem is unsupported"
        );
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = file;
        anyhow::bail!("controlled lineage is unavailable on this platform")
    }
}

#[cfg(target_os = "linux")]
enum Candidate {
    First {
        entry: HistoryEntry,
        audit: InitialAudit,
    },
    Next {
        tracking: Box<Tracking>,
        entry: HistoryEntry,
        bytes_hash: Sha256,
        bytes_len: u64,
    },
}

/// Exists only while the original source binding and mutation lock are held.
/// Any early exit or unwind makes the evidence unknown without changing the
/// outcome of the source operation.
#[cfg(target_os = "linux")]
pub(super) struct Advance {
    slot: Arc<LineageSlot>,
    candidate: Option<Candidate>,
    complete: bool,
}

#[cfg(target_os = "linux")]
impl Drop for Advance {
    fn drop(&mut self) {
        if !self.complete {
            self.slot.invalid.store(true, Ordering::Release);
        }
    }
}

#[cfg(target_os = "linux")]
impl Advance {
    pub(super) fn new(slot: Arc<LineageSlot>) -> Self {
        Self {
            slot,
            candidate: None,
            complete: false,
        }
    }

    pub(super) fn prepare(
        &mut self,
        source: &HistorySource,
        directory: &PrivateDirectory,
        name: &OsStr,
        mutation: &Mutation<'_>,
        witnessed: Option<&live_append_receipt::PreparedLiveAppend>,
    ) -> Option<(bool, Option<live_append_receipt::PreparedLiveAppend>)> {
        self.prepare_inner(source, directory, name, mutation, witnessed)
            .ok()
    }

    fn prepare_inner(
        &mut self,
        source: &HistorySource,
        directory: &PrivateDirectory,
        name: &OsStr,
        mutation: &Mutation<'_>,
        witnessed: Option<&live_append_receipt::PreparedLiveAppend>,
    ) -> Result<(bool, Option<live_append_receipt::PreparedLiveAppend>)> {
        ensure!(
            !self.slot.invalid.load(Ordering::Acquire),
            "lineage revoked"
        );
        let mut phase = self
            .slot
            .phase
            .try_lock()
            .map_err(|_| anyhow::anyhow!("lineage observer busy"))?;
        let previous = std::mem::replace(&mut *phase, Phase::InFlight);
        self.slot.phase_tag.store(IN_FLIGHT, Ordering::Release);
        drop(phase);
        let bytes = match mutation {
            Mutation::AppendWitnessed(bytes) | Mutation::Append(bytes) => *bytes,
            _ => anyhow::bail!("lineage mutation is not an append"),
        };
        ensure!(
            !bytes.is_empty() && bytes.len() as u64 <= MAX_ROW_BYTES && bytes.ends_with(b"\n"),
            "lineage append is outside its bounded row format"
        );
        let entry: HistoryEntry = serde_json::from_slice(bytes)?;
        let uuid = entry
            .uuid
            .as_deref()
            .filter(|v| !v.is_empty() && v.len() <= 256)
            .context("lineage row UUID missing")?;
        if let Some(attempt) = &entry.history_attempt {
            ensure!(
                attempt.thread_id == entry.session_id,
                "lineage attempt differs"
            );
        }
        match previous {
            Phase::Armed { session_id } => {
                ensure!(
                    matches!(mutation, Mutation::AppendWitnessed(_)),
                    "original append has no native row receipt"
                );
                ensure!(
                    entry.session_id == session_id
                        && matches!(
                            &entry.message,
                            Message::User {
                                origin: MessageOrigin::User,
                                ..
                            }
                        ),
                    "lineage original input differs"
                );
                let file = directory.open_single_link_regular_file(name)?;
                supported_filesystem(&file)?;
                let mut audit = InitialAudit::default();
                audit.capture(
                    file,
                    &session_id,
                    uuid,
                    entry.parent_uuid.as_deref(),
                    bytes.len(),
                )?;
                let prefix = audit
                    .anchor
                    .as_ref()
                    .context("lineage prefix handle missing")?;
                witnessed
                    .context("original writer preparation missing")?
                    .lineage_matches_prefix(prefix)?;
                ensure!(
                    audit.stamp.as_ref() == Some(&live_append_receipt::stamp(prefix)?),
                    "history prefix changed after observation"
                );
                audit.digest.update(bytes);
                self.candidate = Some(Candidate::First { entry, audit });
                Ok((true, None))
            }
            Phase::Tracking(mut tracking) => {
                ensure!(
                    matches!(mutation, Mutation::Append(_)) && witnessed.is_none(),
                    "lineage continuation is not an ordinary append"
                );
                ensure!(
                    tracking.steps < MAX_STEPS && entry.session_id == tracking.original.session_id,
                    "lineage session or step budget differs"
                );
                ensure!(
                    matches!(
                        &entry.message,
                        Message::Assistant { .. }
                            | Message::User {
                                origin: MessageOrigin::Runtime,
                                ..
                            }
                    ),
                    "unsupported lineage row"
                );
                ensure!(
                    !tracking.seen.contains(uuid)
                        && entry.parent_uuid.as_deref() == Some(tracking.last_uuid.as_str()),
                    "lineage row identity or parent differs"
                );
                let bytes_len = tracking
                    .suffix_bytes
                    .checked_add(bytes.len() as u64)
                    .context("lineage size overflow")?;
                ensure!(
                    bytes_len <= MAX_SUFFIX_BYTES,
                    "lineage suffix budget exceeded"
                );
                let head = tracking.head_mut();
                head.verify_contents()?;
                let prepared =
                    live_append_receipt::PreparedLiveAppend::open(directory, name, &source.path)?;
                head.lineage_matches_prepared(&prepared)?;
                let mut bytes_hash = tracking.suffix_digest.clone();
                bytes_hash.update(bytes);
                self.candidate = Some(Candidate::Next {
                    tracking,
                    entry,
                    bytes_hash,
                    bytes_len,
                });
                Ok((true, Some(prepared)))
            }
            _ => anyhow::bail!("lineage is not available"),
        }
    }

    pub(super) fn finish(mut self, receipt: Option<LiveAppendReceipt>) {
        let result = self.finish_inner(receipt);
        if result.is_ok() {
            self.complete = true;
        }
    }

    fn finish_inner(&mut self, receipt: Option<LiveAppendReceipt>) -> Result<()> {
        ensure!(
            !self.slot.invalid.load(Ordering::Acquire),
            "lineage revoked"
        );
        let receipt = receipt.context("native lineage receipt unavailable")?;
        let commit = receipt
            .committed
            .as_ref()
            .context("lineage control missing")?;
        ensure!(
            commit.publisher_observed,
            "lineage control publisher missing"
        );
        let next = match self.candidate.take().context("lineage candidate missing")? {
            Candidate::First { entry, audit } => {
                let uuid = entry.uuid.clone().context("original UUID missing")?;
                let (start, end) = receipt.range();
                let mut seen = audit.seen;
                ensure!(seen.insert(uuid.clone()), "original UUID already seen");
                Box::new(Tracking {
                    original: entry,
                    original_receipt: receipt,
                    head: None,
                    original_start: start,
                    original_end: end,
                    prefix_digest: audit.digest.finalize().into(),
                    suffix_digest: Sha256::new(),
                    suffix_bytes: 0,
                    last_uuid: uuid,
                    seen,
                    steps: 0,
                })
            }
            Candidate::Next {
                mut tracking,
                entry,
                bytes_hash,
                bytes_len,
            } => {
                let head = tracking.head_mut();
                head.lineage_same_body(&receipt)?;
                let old = head
                    .committed
                    .as_ref()
                    .context("previous lineage control missing")?;
                ensure!(
                    old.publisher_observed
                        && old.incarnation == commit.incarnation
                        && old.generation == commit.generation
                        && old.revision.checked_add(1) == Some(commit.revision)
                        && head.end == receipt.start,
                    "lineage sequence changed"
                );
                let uuid = entry.uuid.context("lineage UUID missing")?;
                ensure!(tracking.seen.insert(uuid.clone()), "lineage UUID repeated");
                tracking.last_uuid = uuid;
                tracking.suffix_digest = bytes_hash;
                tracking.suffix_bytes = bytes_len;
                tracking.steps += 1;
                tracking.head = Some(receipt);
                tracking
            }
        };
        let mut phase = self
            .slot
            .phase
            .try_lock()
            .map_err(|_| anyhow::anyhow!("lineage observer busy"))?;
        ensure!(
            matches!(*phase, Phase::InFlight) && !self.slot.invalid.load(Ordering::Acquire),
            "lineage observation was revoked"
        );
        *phase = Phase::Tracking(next);
        self.slot.phase_tag.store(TRACKING, Ordering::Release);
        Ok(())
    }
}

impl NativeHistoryLineageReservation {
    fn check_current(&self, observation: &CurrentHistoryObservation) -> Result<()> {
        ensure!(
            observation.try_is_current(&self.state) == Some(true),
            "current history is unavailable or changed"
        );
        let inner = self
            .state
            .inner
            .try_read()
            .map_err(|_| anyhow::anyhow!("history State busy or unavailable"))?;
        ensure!(
            self.owner.matches_locked(&self.state, &inner)
                && inner
                    .history_source
                    .as_ref()
                    .is_some_and(|source| source.shares_binding(&self.source)),
            "original history lifecycle or source changed"
        );
        Ok(())
    }

    /// Verify a real original row receipt against the uninterrupted bounded
    /// live chain and a current State observation. Run this on an owned bounded
    /// blocking worker without holding a State or activity lock. This is an
    /// observation, not a SessionLease, consumption proof, or dispatch grant;
    /// the host must recheck its own native gate after this method returns.
    pub fn verify_original(
        &self,
        receipt: &NativeHistoryRowReceipt,
        observation: &CurrentHistoryObservation,
        entry_index: usize,
    ) -> Result<()> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (receipt, observation, entry_index);
            anyhow::bail!("native lineage unavailable on this platform")
        }
        #[cfg(target_os = "linux")]
        {
            self.check_current(observation)?;
            ensure!(
                !self.slot.invalid.load(Ordering::Acquire),
                "native lineage unknown"
            );
            let binding = self
                .source
                .binding
                .lock()
                .map_err(|_| anyhow::anyhow!("history source poisoned"))?;
            let current = binding
                .lineage
                .as_ref()
                .and_then(std::sync::Weak::upgrade)
                .context("native lineage owner expired")?;
            ensure!(
                Arc::ptr_eq(&current, &self.slot),
                "native lineage owner changed"
            );
            let (directory, name) = open_parent_with_create(&self.source.path, false)?;
            let lock = existing_file(&directory, OsStr::new(MUTATION_LOCK))?
                .context("history source lock missing")?;
            FileExt::lock_exclusive(&lock).context("lock native lineage observation")?;
            let result = (|| -> Result<()> {
                let record = read_source_record(&directory, &name)?
                    .context("history source control missing")?;
                binding.verify(Some(&record))?;
                if let Some(commit) = &record.commit {
                    commit.check_ready()?;
                }
                let mut phase = self
                    .slot
                    .phase
                    .try_lock()
                    .map_err(|_| anyhow::anyhow!("native lineage busy"))?;
                let Phase::Tracking(tracking) = &mut *phase else {
                    anyhow::bail!("native lineage not tracking")
                };
                let selected = observation
                    .entries()
                    .get(entry_index)
                    .context("history observation missing")?;
                ensure!(
                    selected.presence == CurrentHistoryPresence::Present
                        && selected.locator.history_uuid
                            == tracking.original.uuid.as_deref().unwrap_or_default()
                        && Some(&selected.locator.attempt)
                            == tracking.original.history_attempt.as_ref()
                        && observation.session_id() == tracking.original.session_id
                        && observation
                            .matches_original_message(entry_index, &tracking.original.message),
                    "current original input differs"
                );
                receipt.verify_lineage_identity(&tracking.original, &tracking.original_receipt)?;
                if let Some(head) = &tracking.head {
                    tracking.original_receipt.lineage_same_body(head)?;
                }
                let original = tracking.original.clone();
                let original_start = tracking.original_start;
                let original_end = tracking.original_end;
                let prefix = tracking.prefix_digest;
                let suffix: [u8; 32] = tracking.suffix_digest.clone().finalize().into();
                let suffix_bytes = tracking.suffix_bytes;
                let head = tracking.head_mut();
                head.verify_contents()?;
                let (_, end) = head.range();
                ensure!(
                    end.checked_sub(original_end) == Some(suffix_bytes),
                    "native lineage length changed"
                );
                ensure!(
                    head.lineage_hash_range(0, original_end, MAX_PREFIX_BYTES)? == prefix,
                    "native lineage prefix changed"
                );
                ensure!(
                    head.lineage_hash_range(original_end, end, MAX_SUFFIX_BYTES)? == suffix,
                    "native lineage suffix changed"
                );
                let bytes = head.lineage_read_range(original_start, original_end, MAX_ROW_BYTES)?;
                let actual: HistoryEntry = serde_json::from_slice(&bytes)?;
                ensure!(
                    actual.session_id == original.session_id
                        && actual.uuid == original.uuid
                        && actual.history_attempt == original.history_attempt
                        && actual.message == original.message,
                    "native lineage original row changed"
                );
                head.verify_contents()?;
                ensure!(
                    !self.slot.invalid.load(Ordering::Acquire),
                    "native lineage revoked"
                );
                Ok(())
            })();
            drop(lock);
            drop(binding);
            if result.is_err() {
                self.slot.invalid.store(true, Ordering::Release);
            }
            result?;
            self.check_current(observation)?;
            ensure!(
                !self.slot.invalid.load(Ordering::Acquire),
                "native lineage revoked"
            );
            Ok(())
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "live_lineage/tests.rs"]
mod tests;
