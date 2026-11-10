//! Optional in-process Goal metadata lineage. No value here is an authorization.
use super::*;
use crate::{AppState, AppStateIdentity, AppStateLifecycleIdentity, CapturedSessionMetadata};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const MAX_TRACKERS: usize = 16;
const MAX_STEPS: usize = 256;
const MAX_APPENDED_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 128 * 1024;
static ACTIVE_TRACKERS: AtomicUsize = AtomicUsize::new(0);
static TRACKER_REGISTRY: LazyLock<Mutex<Vec<std::sync::Weak<Slot>>>> =
    LazyLock::new(|| Mutex::new(Vec::with_capacity(MAX_TRACKERS)));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeGoalMetadataLineageStatus {
    Armed,
    Tracking,
    Unknown,
}

struct Permit(AtomicBool);

impl Permit {
    fn acquire() -> Option<Self> {
        ACTIVE_TRACKERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                (value < MAX_TRACKERS).then_some(value + 1)
            })
            .ok()
            .map(|_| Self(AtomicBool::new(true)))
    }

    fn release(&self) {
        if self.0.swap(false, Ordering::AcqRel) {
            ACTIVE_TRACKERS.fetch_sub(1, Ordering::AcqRel);
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.release();
    }
}

pub(super) struct Slot {
    invalid: AtomicBool,
    observing: AtomicBool,
    retire_armed: AtomicBool,
    phase: Mutex<Phase>,
    permit: Permit,
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoalMetadataLineageSlot")
            .finish_non_exhaustive()
    }
}

enum Phase {
    Armed,
    Tracking(Arc<Evidence>),
    InFlight,
    Revoked,
}

impl Slot {
    fn retire_requested_armed(&self) -> bool {
        if !self.retire_armed.load(Ordering::Acquire) || self.observing.load(Ordering::Acquire) {
            return false;
        }
        let Ok(mut phase) = self.phase.try_lock() else {
            return false;
        };
        if !matches!(*phase, Phase::Armed) || self.observing.load(Ordering::Acquire) {
            return false;
        }
        self.invalid.store(true, Ordering::Release);
        *phase = Phase::Revoked;
        self.permit.release();
        true
    }

    fn retire_if_possible(&self) -> bool {
        if !self.invalid.load(Ordering::Acquire) || self.observing.load(Ordering::Acquire) {
            return false;
        }
        let Ok(mut phase) = self.phase.try_lock() else {
            return false;
        };
        if matches!(*phase, Phase::InFlight) || self.observing.load(Ordering::Acquire) {
            return false;
        }
        *phase = Phase::Revoked;
        self.permit.release();
        true
    }
}

struct ObserverGuard(Arc<Slot>);
impl Drop for ObserverGuard {
    fn drop(&mut self) {
        self.0.observing.store(false, Ordering::Release);
        self.0.retire_requested_armed();
        self.0.retire_if_possible();
    }
}

/// The original owner keeps this reservation; dropping it revokes all observers.
pub struct NativeGoalMetadataLineage {
    observer: NativeGoalMetadataObserver,
}

/// Copyable weak observer. It never owns a session, writer, lease or evidence.
#[derive(Clone)]
pub struct NativeGoalMetadataObserver {
    owner: AppStateLifecycleIdentity,
    state: AppStateIdentity,
    source: std::sync::Weak<Mutex<SourceBinding>>,
    slot: std::sync::Weak<Slot>,
    path: Arc<PathBuf>,
}

/// A turn owner's weak settlement handle. It cannot observe or retain a source.
pub struct NativeGoalMetadataSettlement {
    observer: NativeGoalMetadataObserver,
}

impl Drop for NativeGoalMetadataLineage {
    fn drop(&mut self) {
        if let Some(slot) = self.observer.slot.upgrade() {
            slot.invalid.store(true, Ordering::Release);
            slot.retire_if_possible();
        }
    }
}

impl AppState {
    /// Reserve before an actual metadata write. Busy, unavailable, or full
    /// returns None without waiting or changing the ordinary writer.
    pub fn try_reserve_native_goal_metadata_lineage(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> Result<Option<NativeGoalMetadataLineage>> {
        let inner = match self.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => anyhow::bail!("history State is poisoned"),
        };
        anyhow::ensure!(
            owner.matches_locked(self, &inner),
            "history lifecycle changed"
        );
        let Some(source) = inner.history_source.as_ref() else {
            return Ok(None);
        };
        if source.path.as_os_str().len() > MAX_PATH_BYTES {
            return Ok(None);
        }
        let mut binding = match source.binding.try_lock() {
            Ok(binding) => binding,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("history source binding is poisoned")
            }
        };
        if !binding.initialized {
            return Ok(None);
        }
        if let Some(existing) = binding.metadata_lineage.as_ref() {
            existing.retire_requested_armed();
            if !existing.retire_if_possible() {
                return Ok(None);
            }
            binding.metadata_lineage = None;
        }
        let mut registry = match TRACKER_REGISTRY.try_lock() {
            Ok(registry) => registry,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("goal metadata tracker registry is poisoned")
            }
        };
        registry.retain(|weak| {
            let Some(slot) = weak.upgrade() else {
                return false;
            };
            slot.retire_requested_armed();
            slot.permit.0.load(Ordering::Acquire)
        });
        let Some(permit) = Permit::acquire() else {
            return Ok(None);
        };
        let slot = Arc::new(Slot {
            invalid: AtomicBool::new(false),
            observing: AtomicBool::new(false),
            retire_armed: AtomicBool::new(false),
            phase: Mutex::new(Phase::Armed),
            permit,
        });
        registry.push(Arc::downgrade(&slot));
        binding.metadata_lineage = Some(Arc::clone(&slot));
        Ok(Some(NativeGoalMetadataLineage {
            observer: NativeGoalMetadataObserver {
                owner: owner.clone(),
                state: self.inspection_identity(),
                source: Arc::downgrade(&source.binding),
                slot: Arc::downgrade(&slot),
                path: Arc::new(source.path.clone()),
            },
        }))
    }
}

impl NativeGoalMetadataLineage {
    /// Obtain a weak observer without transferring the original reservation.
    pub fn observer(&self) -> NativeGoalMetadataObserver {
        self.observer.clone()
    }

    /// Create the owning turn's settlement handle without retaining its source.
    pub fn settlement(&self) -> NativeGoalMetadataSettlement {
        NativeGoalMetadataSettlement {
            observer: self.observer.clone(),
        }
    }

    /// True only when this original reservation can no longer become current.
    /// A temporarily busy or poisoned State is not evidence of revocation.
    pub fn is_definitively_revoked(&self) -> bool {
        let Some(slot) = self.observer.slot.upgrade() else {
            return true;
        };
        if slot.invalid.load(Ordering::Acquire) {
            return true;
        }
        let Some(state) = self.observer.state.0.upgrade() else {
            return true;
        };
        let Ok(inner) = state.try_read() else {
            return false;
        };
        if !self
            .observer
            .owner
            .matches_identity_locked(&self.observer.state, &inner)
        {
            return true;
        }
        let Some(original_source) = self.observer.source.upgrade() else {
            return true;
        };
        inner.history_source.as_ref().is_none_or(|source| {
            source.path.as_path() != self.observer.path.as_path()
                || !Arc::ptr_eq(&source.binding, &original_source)
        })
    }

    pub fn status(&self) -> NativeGoalMetadataLineageStatus {
        self.observer.status()
    }

    pub fn try_capture(
        &self,
        max_bytes: u64,
        check: impl FnMut() -> Result<()>,
    ) -> Result<Option<CapturedSessionMetadata>> {
        self.observer.try_capture(max_bytes, check)
    }
}

impl NativeGoalMetadataObserver {
    /// Compare only the opaque in-process lifecycle; this grants no execution authority.
    pub fn matches_lifecycle(&self, owner: &AppStateLifecycleIdentity) -> bool {
        self.owner.same_lifecycle(owner)
    }
}

impl NativeGoalMetadataSettlement {
    /// Retire an unused reservation after its owning turn settles. Busy,
    /// in-flight, or already-published observations are left untouched.
    pub fn try_revoke_if_armed(&self) -> bool {
        let Some(slot) = self.observer.slot.upgrade() else {
            return false;
        };
        slot.retire_armed.store(true, Ordering::Release);
        slot.retire_requested_armed()
    }
}

impl Drop for NativeGoalMetadataSettlement {
    fn drop(&mut self) {
        self.try_revoke_if_armed();
    }
}

impl NativeGoalMetadataObserver {
    fn current_slot(&self) -> Option<Arc<Slot>> {
        let state = self.state.0.upgrade()?;
        let inner = state.try_read().ok()?;
        if !self.owner.matches_identity_locked(&self.state, &inner)
            || inner.history_write_fault.is_some()
        {
            return None;
        }
        let source = inner.history_source.as_ref()?;
        let expected = self.source.upgrade()?;
        if source.path.as_path() != self.path.as_path() || !Arc::ptr_eq(&source.binding, &expected)
        {
            return None;
        }
        let slot = self.slot.upgrade()?;
        if slot.invalid.load(Ordering::Acquire) {
            return None;
        }
        Some(slot)
    }

    /// In-memory state only; a later source-fenced capture must verify handles.
    pub fn status(&self) -> NativeGoalMetadataLineageStatus {
        let Some(slot) = self.current_slot() else {
            return NativeGoalMetadataLineageStatus::Unknown;
        };
        let Ok(phase) = slot.phase.try_lock() else {
            return NativeGoalMetadataLineageStatus::Unknown;
        };
        match &*phase {
            Phase::Armed => NativeGoalMetadataLineageStatus::Armed,
            Phase::Tracking(_) => NativeGoalMetadataLineageStatus::Tracking,
            Phase::InFlight | Phase::Revoked => NativeGoalMetadataLineageStatus::Unknown,
        }
    }

    /// Read-only observation on an owned bounded worker; None means unknown.
    /// The actual sidecar copy occurs outside the history mutation fence.
    pub fn try_capture(
        &self,
        max_bytes: u64,
        mut check: impl FnMut() -> Result<()>,
    ) -> Result<Option<CapturedSessionMetadata>> {
        let Some(slot) = self.current_slot() else {
            return Ok(None);
        };
        if slot
            .observing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(None);
        }
        let guard = ObserverGuard(Arc::clone(&slot));
        let evidence = {
            let Ok(phase) = slot.phase.try_lock() else {
                return Ok(None);
            };
            match &*phase {
                Phase::Tracking(evidence) => Arc::clone(evidence),
                _ => return Ok(None),
            }
        };
        let mut caller_stopped = false;
        let captured = super::goal_observation::try_capture_goal_metadata_with_lineage(
            self.path.as_path(),
            max_bytes,
            &evidence,
            || match check() {
                Ok(()) => Ok(()),
                Err(error) => {
                    caller_stopped = true;
                    Err(error)
                }
            },
        );
        let same = self
            .current_slot()
            .is_some_and(|current| Arc::ptr_eq(&current, &slot))
            && slot
                .phase
                .try_lock()
                .ok()
                .is_some_and(|phase| match &*phase {
                    Phase::Tracking(current) => Arc::ptr_eq(&current.revision, &evidence.revision),
                    _ => false,
                });
        if same && let Err(error) = &captured {
            let busy = error.chain().any(|cause| {
                cause.downcast_ref::<std::io::Error>().is_some_and(|error| {
                    error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error().is_some_and(|code| {
                            Some(code) == fs2::lock_contended_error().raw_os_error()
                        })
                })
            });
            if !caller_stopped && !busy {
                slot.invalid.store(true, Ordering::Release);
            }
        }
        drop(evidence);
        drop(guard);
        if !same {
            return Ok(None);
        }
        match captured {
            Ok(value) => Ok(Some(value)),
            Err(_) => Ok(None),
        }
    }
}

pub(super) struct Evidence {
    record: SourceRecord,
    root: Arc<PrivateDirectory>,
    body: Arc<File>,
    control_dir: Arc<PrivateDirectory>,
    control: Arc<File>,
    metadata_dir: Arc<PrivateDirectory>,
    metadata: Arc<File>,
    relative_path: Vec<String>,
    metadata_length: u64,
    metadata_sha256: String,
    steps: usize,
    appended_bytes: u64,
    revision: Arc<()>,
}

impl Evidence {
    pub(super) fn metadata_receipt(&self) -> (&[String], u64, &str) {
        (
            &self.relative_path,
            self.metadata_length,
            &self.metadata_sha256,
        )
    }

    pub(super) fn verify_sidecar(
        &self,
        sidecar: &crate::history_metadata::HeldGoalMetadata,
    ) -> Result<()> {
        anyhow::ensure!(
            sidecar.matches_publisher(&self.metadata_dir, &self.metadata)?,
            "original metadata publisher changed"
        );
        Ok(())
    }

    pub(super) fn verify(
        &self,
        source_path: &Path,
        directory: &PrivateDirectory,
        name: &OsStr,
        record: &SourceRecord,
    ) -> Result<()> {
        anyhow::ensure!(
            record == &self.record && !record.deleted && record.deletion.is_none(),
            "metadata lineage source changed"
        );
        let commit = record
            .commit
            .as_ref()
            .context("metadata lineage commit missing")?;
        commit.check_ready()?;
        let expected_length = commit
            .committed_bytes
            .context("history watermark unavailable")?;
        anyhow::ensure!(
            self.body.metadata()?.len() == expected_length,
            "history length changed"
        );
        anyhow::ensure!(
            self.root.directory_identity()? == directory.directory_identity()?,
            "history parent changed"
        );
        let current_parent = PrivateDirectory::open_existing(
            source_path.parent().context("history parent missing")?,
        )?;
        anyhow::ensure!(
            current_parent.directory_identity()? == self.root.directory_identity()?,
            "history parent detached"
        );
        same_leaf(directory, name, &self.body)?;
        let control_name = source_directory_name(name)?;
        let current_control = directory.open_child(&control_name, false)?;
        anyhow::ensure!(
            current_control.directory_identity()? == self.control_dir.directory_identity()?,
            "history control parent changed"
        );
        same_leaf(
            &current_control,
            OsStr::new(SOURCE_RECORD_FILE),
            &self.control,
        )?;
        let (metadata_dir, metadata_name) =
            commit::metadata_target(source_path, directory, &self.relative_path, false)?;
        anyhow::ensure!(
            metadata_dir.directory_identity()? == self.metadata_dir.directory_identity()?,
            "metadata parent changed"
        );
        same_leaf(&metadata_dir, &metadata_name, &self.metadata)?;
        Ok(())
    }
}

fn same_leaf(directory: &PrivateDirectory, name: &OsStr, original: &File) -> Result<()> {
    let original = directory.portable_regular_handle_identity(original)?;
    let current = directory.open_single_link_regular_file(name)?;
    anyhow::ensure!(
        directory.portable_regular_handle_identity(&current)? == original,
        "metadata lineage object changed"
    );
    Ok(())
}

#[derive(Default)]
pub(super) struct ObservationMode {
    pub metadata_publisher: bool,
    pub control_publisher: bool,
}

pub(super) struct Publication {
    pub record: SourceRecord,
    pub metadata: Option<File>,
    pub control: Option<File>,
}

enum Candidate {
    Metadata,
    Append { previous: Arc<Evidence>, bytes: u64 },
}

/// Exists only inside one writer's original source binding and history lock.
pub(super) struct Advance {
    slot: Arc<Slot>,
    candidate: Option<Candidate>,
    settled: bool,
}

impl Advance {
    pub(super) fn new(slot: Arc<Slot>) -> Self {
        Self {
            slot,
            candidate: None,
            settled: false,
        }
    }

    /// An observer failure revokes only evidence. The source write proceeds.
    pub(super) fn prepare(
        &mut self,
        path: &Path,
        directory: &PrivateDirectory,
        name: &OsStr,
        record: &SourceRecord,
        mutation: &Mutation<'_>,
    ) -> ObservationMode {
        self.prepare_inner(path, directory, name, record, mutation)
            .unwrap_or_default()
    }

    fn prepare_inner(
        &mut self,
        path: &Path,
        directory: &PrivateDirectory,
        name: &OsStr,
        record: &SourceRecord,
        mutation: &Mutation<'_>,
    ) -> Result<ObservationMode> {
        anyhow::ensure!(
            !self.slot.invalid.load(Ordering::Acquire),
            "metadata lineage revoked"
        );
        let mut phase = self
            .slot
            .phase
            .try_lock()
            .map_err(|_| anyhow::anyhow!("metadata lineage busy"))?;
        let previous = std::mem::replace(&mut *phase, Phase::InFlight);
        drop(phase);
        match (previous, mutation) {
            (Phase::Armed, Mutation::Metadata { .. }) => {
                self.candidate = Some(Candidate::Metadata);
                Ok(ObservationMode {
                    metadata_publisher: true,
                    control_publisher: true,
                })
            }
            (Phase::Armed, Mutation::Append(_) | Mutation::AppendWitnessed(_)) => {
                let mut phase = self
                    .slot
                    .phase
                    .try_lock()
                    .map_err(|_| anyhow::anyhow!("metadata lineage busy"))?;
                *phase = Phase::Armed;
                self.settled = true;
                Ok(ObservationMode::default())
            }
            (Phase::Tracking(previous), Mutation::Metadata { .. }) => {
                previous.verify(path, directory, name, record)?;
                self.candidate = Some(Candidate::Metadata);
                Ok(ObservationMode {
                    metadata_publisher: true,
                    control_publisher: true,
                })
            }
            (
                Phase::Tracking(previous),
                Mutation::Append(bytes) | Mutation::AppendWitnessed(bytes),
            ) => {
                previous.verify(path, directory, name, record)?;
                let length = u64::try_from(bytes.len())?;
                anyhow::ensure!(
                    length != 0 && previous.steps < MAX_STEPS,
                    "metadata lineage append limit reached"
                );
                anyhow::ensure!(
                    previous
                        .appended_bytes
                        .checked_add(length)
                        .is_some_and(|sum| sum <= MAX_APPENDED_BYTES),
                    "metadata lineage byte limit reached"
                );
                self.candidate = Some(Candidate::Append {
                    previous,
                    bytes: length,
                });
                Ok(ObservationMode {
                    metadata_publisher: false,
                    control_publisher: true,
                })
            }
            _ => anyhow::bail!("metadata lineage mutation is unsupported"),
        }
    }

    pub(super) fn finish(
        mut self,
        path: &Path,
        directory: &PrivateDirectory,
        name: &OsStr,
        publication: Option<Publication>,
    ) {
        if self.candidate.is_none() {
            return;
        }
        if self
            .finish_inner(path, directory, name, publication)
            .is_ok()
        {
            self.settled = true;
        }
    }

    fn finish_inner(
        &mut self,
        path: &Path,
        directory: &PrivateDirectory,
        name: &OsStr,
        publication: Option<Publication>,
    ) -> Result<()> {
        anyhow::ensure!(
            !self.slot.invalid.load(Ordering::Acquire),
            "metadata lineage revoked"
        );
        let Publication {
            record,
            metadata,
            control,
        } = publication.context("metadata publication unavailable")?;
        let control = Arc::new(control.context("control publisher unavailable")?);
        let commit = record.commit.as_ref().context("history commit missing")?;
        commit.check_ready()?;
        let evidence = match self
            .candidate
            .take()
            .context("metadata candidate missing")?
        {
            Candidate::Metadata => {
                let commit::MutationPlan::Metadata {
                    relative_path,
                    length,
                    sha256,
                } = commit
                    .last_operation
                    .as_ref()
                    .context("metadata receipt missing")?
                else {
                    anyhow::bail!("latest operation is not metadata")
                };
                let (metadata_dir, metadata_name) =
                    commit::metadata_target(path, directory, relative_path, false)?;
                let metadata = Arc::new(metadata.context("metadata publisher unavailable")?);
                same_leaf(&metadata_dir, &metadata_name, &metadata)?;
                anyhow::ensure!(
                    metadata.metadata()?.len() == *length,
                    "metadata publisher length changed"
                );
                let body = Arc::new(directory.open_single_link_regular_file(name)?);
                let control_dir =
                    Arc::new(directory.open_child(&source_directory_name(name)?, false)?);
                Evidence {
                    record: record.clone(),
                    root: Arc::new(directory.duplicate_handle()?),
                    body,
                    control_dir,
                    control,
                    metadata_dir: Arc::new(metadata_dir),
                    metadata,
                    relative_path: relative_path.clone(),
                    metadata_length: *length,
                    metadata_sha256: sha256.clone(),
                    steps: 0,
                    appended_bytes: 0,
                    revision: Arc::new(()),
                }
            }
            Candidate::Append { previous, bytes } => {
                let old = previous
                    .record
                    .commit
                    .as_ref()
                    .context("previous commit missing")?;
                let commit::MutationPlan::Append { start, end, .. } = commit
                    .last_operation
                    .as_ref()
                    .context("append receipt missing")?
                else {
                    anyhow::bail!("latest operation is not append")
                };
                anyhow::ensure!(
                    record.incarnation == previous.record.incarnation
                        && commit.generation == old.generation
                        && old.revision.checked_add(1) == Some(commit.revision)
                        && old.committed_bytes == Some(*start)
                        && start.checked_add(bytes) == Some(*end)
                        && commit.committed_bytes == Some(*end),
                    "append did not extend the witnessed source"
                );
                Evidence {
                    record: record.clone(),
                    root: Arc::clone(&previous.root),
                    body: Arc::clone(&previous.body),
                    control_dir: Arc::clone(&previous.control_dir),
                    control,
                    metadata_dir: Arc::clone(&previous.metadata_dir),
                    metadata: Arc::clone(&previous.metadata),
                    relative_path: previous.relative_path.clone(),
                    metadata_length: previous.metadata_length,
                    metadata_sha256: previous.metadata_sha256.clone(),
                    steps: previous.steps + 1,
                    appended_bytes: previous.appended_bytes + bytes,
                    revision: Arc::new(()),
                }
            }
        };
        anyhow::ensure!(
            read_source_record(directory, name)?.as_ref() == Some(&record),
            "history control changed after publication"
        );
        evidence.verify(path, directory, name, &record)?;
        let mut phase = self
            .slot
            .phase
            .try_lock()
            .map_err(|_| anyhow::anyhow!("metadata lineage busy"))?;
        anyhow::ensure!(
            matches!(*phase, Phase::InFlight) && !self.slot.invalid.load(Ordering::Acquire),
            "metadata lineage changed"
        );
        *phase = Phase::Tracking(Arc::new(evidence));
        Ok(())
    }
}

impl Drop for Advance {
    fn drop(&mut self) {
        if !self.settled {
            self.slot.invalid.store(true, Ordering::Release);
        }
        // A failed in-flight transaction can never be adopted or retried.
        if self.slot.invalid.load(Ordering::Acquire) {
            // Do not free capacity while this writer still owns the previous
            // evidence handles through its in-flight candidate.
            drop(self.candidate.take());
            if let Ok(mut phase) = self.slot.phase.try_lock()
                && matches!(*phase, Phase::InFlight)
            {
                *phase = Phase::Revoked;
            }
            self.slot.retire_if_possible();
        } else {
            self.slot.retire_requested_armed();
        }
    }
}

#[cfg(test)]
#[path = "metadata_lineage/tests.rs"]
mod tests;
