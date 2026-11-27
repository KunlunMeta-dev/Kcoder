//! `<scope-root>/evolution/` handle: format marker, cross-process lock,
//! JSON documents and journals.
//!
//! Layout (plan section 6):
//!
//! ```text
//! <scope-root>/evolution/
//!   format.json       {"format":"kcoder.evolution","version":1}
//!   .lock             cross-process scope lock (advisory, exclusive)
//!   locks/            per-job leases
//!   usages.jsonl      append-only usage records
//!   outcomes.jsonl    append-only outcome observations
//!   usage-amendments.jsonl  append-only post-turn facts merged into usages
//!   usage-tool-calls.jsonl  call identities associated with compatible usage rows
//!   evidence/         <id>.json redacted snippets with expiry
//!   stats.json        cache rebuilt from the journals
//!   proposals/        <id>.json
//!   overlays/         <target-component>/overlay.json + revisions/<n>/
//!   state.json        job cursors and monthly model usage
//!   stats-baseline.json  statistics folded out of the journals by compaction
//!   rollout.json      approvals, awaiting promotions, eval attempts, archived targets
//!   classify-queue.json  pending conversation classifications (redacted)
//! ```

use crate::error::{EvolutionError, Result};
use crate::journal::{
    self, AMENDMENTS_FILE, JournalRead, OUTCOMES_FILE, USAGES_FILE, is_not_found,
};
use crate::paths::EVOLUTION_DIR_NAME;
use kcoder_config::{PrivateDirectory, PrivateFileLock};
use kcoder_types::evolution::{OutcomeObservation, TargetKey, UsageAmendment, UsageRecord};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Storage format version of the evolution directory.
pub const FORMAT_VERSION: u32 = 1;
const FORMAT_FILE: &str = "format.json";
const FORMAT_NAME: &str = "kcoder.evolution";
const LOCK_FILE: &str = ".lock";
const LOCKS_DIR: &str = "locks";
const DEFAULT_LOCK_WAIT: Duration = Duration::from_secs(5);
/// Largest JSON document this crate reads.
pub(crate) const DOCUMENT_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Open evolution storage for one scope root.
pub struct EvolutionStore {
    path: PathBuf,
    directory: PrivateDirectory,
    lock_wait: Duration,
}

/// Exclusive scope lock; released on drop.
pub struct ScopeLock {
    _file: std::fs::File,
}

/// Exclusive lease for one background job (for example one distill job per
/// target); released on drop.
pub struct JobLease {
    _lock: PrivateFileLock,
}

impl EvolutionStore {
    /// Open or create `<scope_root>/evolution/` as a private directory.
    /// A newer format marker fails closed without writing anything.
    pub fn open(scope_root: &Path) -> Result<Self> {
        let path = scope_root.join(EVOLUTION_DIR_NAME);
        let directory = PrivateDirectory::open_or_create(&path)?;
        let store = Self {
            path,
            directory,
            lock_wait: DEFAULT_LOCK_WAIT,
        };
        store.ensure_format()?;
        Ok(store)
    }

    /// How long mutating calls wait for the scope lock before
    /// [`EvolutionError::LockBusy`].
    pub fn with_lock_wait(mut self, wait: Duration) -> Self {
        self.lock_wait = wait;
        self
    }

    /// The `evolution/` directory.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn directory(&self) -> &PrivateDirectory {
        &self.directory
    }

    fn ensure_format(&self) -> Result<()> {
        fn usage_rows_compatible(format: &serde_json::Value) -> bool {
            format
                .get("usageToolCallsV1")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        }
        let current = self.read_supported_format()?;
        if current.as_ref().is_some_and(usage_rows_compatible) {
            return Ok(());
        }
        let _lock = if current.is_none() {
            self.lock()?
        } else if let Some(lock) = self.try_lock_within(Duration::ZERO)? {
            lock
        } else {
            // Readers may still observe existing inline rows while another
            // process owns the scope lock.
            return Ok(());
        };
        let current = self.read_supported_format()?;
        if current.as_ref().is_some_and(usage_rows_compatible) {
            return Ok(());
        }
        let create = current.is_none();
        let mut format = current.unwrap_or_else(
            || serde_json::json!({"format": FORMAT_NAME, "version": FORMAT_VERSION}),
        );
        match crate::usage_tool_calls::normalize_inline_usages(&self.directory) {
            Ok(()) => {
                // The old v1 format reader checks format/version and ignores this
                // additional marker. Set it only after both files are durable.
                format["usageToolCallsV1"] = true.into();
                self.write_json(FORMAT_FILE, &format)?;
            }
            Err(EvolutionError::RecordTooLarge { .. }) => {
                // Preserve access to existing large logs. The migration checks
                // sizes before reading and retries from normal compaction.
                if create {
                    self.write_json(FORMAT_FILE, &format)?;
                }
            }
            Err(error) => return Err(error),
        }
        Ok(())
    }

    fn read_supported_format(&self) -> Result<Option<serde_json::Value>> {
        let Some(value) = self.read_json::<serde_json::Value>(FORMAT_FILE)? else {
            return Ok(None);
        };
        let version = value
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(u64::MAX);
        let name = value.get("format").and_then(serde_json::Value::as_str);
        if name != Some(FORMAT_NAME) || version > u64::from(FORMAT_VERSION) {
            return Err(EvolutionError::UnsupportedFormat(
                u32::try_from(version).unwrap_or(u32::MAX),
            ));
        }
        Ok(Some(value))
    }

    /// Acquire the exclusive scope lock, waiting up to the configured time.
    pub fn lock(&self) -> Result<ScopeLock> {
        match self
            .directory
            .exclusive_lock_within(OsStr::new(LOCK_FILE), self.lock_wait)?
        {
            Some(file) => Ok(ScopeLock { _file: file }),
            None => Err(EvolutionError::LockBusy),
        }
    }

    pub(crate) fn try_lock_within(&self, wait: Duration) -> Result<Option<ScopeLock>> {
        Ok(self
            .directory
            .exclusive_lock_within(OsStr::new(LOCK_FILE), wait)?
            .map(|file| ScopeLock { _file: file }))
    }

    /// Try to take the lease for `job` (optionally per target) without
    /// waiting. `None` means another process or handle owns it.
    pub fn try_job_lease(&self, job: &str, target: Option<&TargetKey>) -> Result<Option<JobLease>> {
        kcoder_types::evolution::validate_evolution_id("job", job)?;
        let locks = self.directory.open_child(OsStr::new(LOCKS_DIR), true)?;
        let name = match target {
            Some(target) => {
                let digest = Sha256::digest(target.to_string().as_bytes());
                let hash: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
                format!("{job}.{hash}.lock")
            }
            None => format!("{job}.lock"),
        };
        Ok(locks
            .try_exclusive_lock_guard(OsStr::new(&name))?
            .map(|lock| JobLease { _lock: lock }))
    }

    /// Append a usage record. Duplicate `usageId`s are tolerated and
    /// ignored on read, so a retried append after a lost receipt is safe.
    pub fn append_usage(&self, record: &UsageRecord) -> Result<()> {
        let _lock = self.lock()?;
        crate::usage_tool_calls::append_usage(&self.directory, record)
    }

    /// Append an outcome observation (deduplicated by `observationId` on read).
    pub fn append_outcome(&self, observation: &OutcomeObservation) -> Result<()> {
        let _lock = self.lock()?;
        journal::append(&self.directory, OUTCOMES_FILE, observation)
    }

    /// Read the outcome journal and append what `decide` returns for it,
    /// both under the scope lock, so concurrent writers never decide on
    /// the same journal state (for example two ratings of one usage
    /// choosing the same revision). `None` appends nothing. Returns the
    /// appended observation.
    pub fn append_outcome_with(
        &self,
        decide: impl FnOnce(&[OutcomeObservation]) -> Option<OutcomeObservation>,
    ) -> Result<Option<OutcomeObservation>> {
        let _lock = self.lock()?;
        let existing: JournalRead<OutcomeObservation> =
            journal::read(&self.directory, OUTCOMES_FILE)?;
        let Some(observation) = decide(&existing.records) else {
            return Ok(None);
        };
        journal::append(&self.directory, OUTCOMES_FILE, &observation)?;
        Ok(Some(observation))
    }

    pub fn read_usages(&self) -> Result<JournalRead<UsageRecord>> {
        let mut usages: JournalRead<UsageRecord> = journal::read(&self.directory, USAGES_FILE)?;
        crate::usage_tool_calls::restore_tool_calls(&self.directory, &mut usages.records)?;
        Ok(usages)
    }

    /// Append facts learned after a usage's turn settled (deduplicated by
    /// `amendmentId` on read).
    pub fn append_usage_amendment(&self, amendment: &UsageAmendment) -> Result<()> {
        let _lock = self.lock()?;
        journal::append(&self.directory, AMENDMENTS_FILE, amendment)
    }

    pub fn read_usage_amendments(&self) -> Result<JournalRead<UsageAmendment>> {
        journal::read(&self.directory, AMENDMENTS_FILE)
    }

    /// Usage records with their amendments merged in journal order.
    /// Amendments for unknown usages are ignored.
    pub fn read_amended_usages(&self) -> Result<JournalRead<UsageRecord>> {
        let mut usages = self.read_usages()?;
        let amendments = self.read_usage_amendments()?;
        if amendments.records.is_empty() {
            return Ok(usages);
        }
        let index: std::collections::HashMap<String, usize> = usages
            .records
            .iter()
            .enumerate()
            .map(|(position, usage)| (usage.usage_id.clone(), position))
            .collect();
        for amendment in &amendments.records {
            if let Some(position) = index.get(&amendment.usage_id) {
                usages.records[*position].apply_amendment(amendment);
            }
        }
        Ok(usages)
    }

    pub fn read_outcomes(&self) -> Result<JournalRead<OutcomeObservation>> {
        journal::read(&self.directory, OUTCOMES_FILE)
    }

    /// Remove all evolution data of this scope (usages, outcomes, evidence,
    /// stats, proposals, overlays and state). The format marker and lock
    /// files stay. Callers cancel running jobs first.
    pub fn clear_all(&self) -> Result<()> {
        let _lock = self.lock()?;
        for name in self.directory.entry_names_bounded(64)? {
            let Some(text) = name.to_str() else { continue };
            if matches!(text, FORMAT_FILE | LOCK_FILE | LOCKS_DIR) {
                continue;
            }
            let metadata = self.directory.entry_metadata(&name)?;
            if metadata.is_dir() {
                self.directory.remove_child_tree(&name)?;
            } else {
                self.directory.remove_regular_file(&name)?;
            }
        }
        Ok(())
    }

    pub(crate) fn read_json<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        read_json_in(&self.directory, name)
    }

    pub(crate) fn write_json<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        write_json_in(&self.directory, name, value)
    }
}

/// Read a JSON document; `None` when absent. Documents carrying a newer
/// `version` fail with [`EvolutionError::FutureVersion`] and are not touched.
pub(crate) fn read_json_in<T: DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<T>> {
    let Some(bytes) = read_bytes_in(directory, name, DOCUMENT_MAX_BYTES)? else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    Ok(Some(serde_json::from_value(value)?))
}

/// Read a versioned document: fails closed on a version newer than `supported`.
pub(crate) fn read_versioned_in<T: DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    supported: u32,
) -> Result<Option<T>> {
    let Some(value) = read_json_in::<serde_json::Value>(directory, name)? else {
        return Ok(None);
    };
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if version > u64::from(supported) {
        return Err(EvolutionError::FutureVersion {
            file: name.to_string(),
            version: u32::try_from(version).unwrap_or(u32::MAX),
        });
    }
    Ok(Some(serde_json::from_value(value)?))
}

pub(crate) fn write_json_in<T: Serialize>(
    directory: &PrivateDirectory,
    name: &str,
    value: &T,
) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    directory.atomic_replace(OsStr::new(name), &bytes)?;
    Ok(())
}

pub(crate) fn read_bytes_in(
    directory: &PrivateDirectory,
    name: &str,
    limit: u64,
) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if is_not_found(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(EvolutionError::RecordTooLarge {
            limit: limit as usize,
            actual: bytes.len(),
        });
    }
    Ok(Some(bytes))
}

pub(crate) fn open_child_if_exists(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<PrivateDirectory>> {
    match directory.open_child(OsStr::new(name), false) {
        Ok(child) => Ok(Some(child)),
        Err(error) if is_not_found(&error) => Ok(None),
        Err(error) => Err(error.into()),
    }
}
