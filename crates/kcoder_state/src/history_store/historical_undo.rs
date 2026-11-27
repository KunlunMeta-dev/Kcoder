//! Exact initial-generation retirement under the same fence as ordinary history/metadata writes.
use super::*;
use crate::historical_undo::{
    HistoricalSessionUndoReceipt, digest,
    manifest::{FileProof, file_proof},
    publish, read,
};
use kcoder_types::{
    historical_context::HistoricalSessionSeedBinding, historical_undo::HistoricalUndoSealReceipt,
};
use serde::{Deserialize, Serialize};

pub(crate) struct SeedUndoFence {
    path: PathBuf,
    directory: PrivateDirectory,
    name: OsString,
    record: SourceRecord,
    journal: JournalFence,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Retirement {
    version: u8,
    directory: String,
    undo_id: String,
    source_operation_id: String,
    session_id: String,
    seal_sha256: String,
    live_record_sha256: String,
    deleted_record_sha256: String,
    history: FileProof,
    quarantine: String,
}
fn ids(expected: &HistoricalUndoSealReceipt, undo_id: &str) -> Result<()> {
    anyhow::ensure!(
        uuid::Uuid::parse_str(undo_id).is_ok_and(|id| id.to_string() == undo_id)
            && uuid::Uuid::parse_str(&expected.operation_id).is_ok()
            && crate::short_id::is_registry_short_id(&expected.session_id),
        "historical_undo_invalid_operation"
    );
    Ok(())
}
fn intent_name(undo_id: &str) -> String {
    format!("historical-undo-{undo_id}.intent.json")
}
fn receipt_name(undo_id: &str) -> String {
    format!("historical-undo-{undo_id}.receipt.json")
}

fn validate_retirement(
    directory: &PrivateDirectory,
    intent: &Retirement,
    expected: &HistoricalUndoSealReceipt,
    undo_id: &str,
) -> Result<()> {
    anyhow::ensure!(
        matches!(intent.version, 1 | 2)
            && directory.history_matches_directory(&intent.directory)?
            && intent.undo_id == undo_id
            && intent.source_operation_id == expected.operation_id
            && intent.session_id == expected.session_id
            && intent.seal_sha256 == expected.seal_sha256
            && intent.quarantine
                == format!(".{}.history-undo-{}.bin", expected.session_id, undo_id),
        "historical_undo_intent_changed"
    );
    Ok(())
}
impl SeedUndoFence {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        Self::open_with_create(path, true)
    }

    fn open_existing(path: &Path) -> Result<Self> {
        Self::open_with_create(path, false)
    }

    fn open_with_create(path: &Path, create: bool) -> Result<Self> {
        let (directory, name) = open_parent_with_create(path, false)?;
        let lock = if create {
            open_mutation_lock(&directory)?
        } else {
            directory.open_read_write_file(OsStr::new(MUTATION_LOCK), false)?
        };
        FileExt::try_lock_exclusive(&lock).context("historical_undo_history_busy")?;
        // Every early return below releases the lock explicitly, not only by close.
        let lock = PrivateFileLock::from_locked(lock);
        let journal = JournalFence::from_locked_history(
            path.parent().context("historical_undo_missing_parent")?,
            lock,
        )?;
        let record =
            read_source_record(&directory, &name)?.context("historical_undo_source_missing")?;
        Ok(Self {
            path: path.into(),
            directory,
            name,
            record,
            journal,
        })
    }
    pub(crate) fn control_directory(&self) -> Result<PrivateDirectory> {
        self.directory
            .open_child(&source_directory_name(&self.name)?, false)
    }
    pub(crate) fn assert_generation(&self, generation: uuid::Uuid) -> Result<()> {
        anyhow::ensure!(!self.record.deleted, "historical_undo_source_deleted");
        anyhow::ensure!(
            self.record.body_generation() == generation,
            "historical_undo_generation_changed"
        );
        if let Some(commit) = &self.record.commit {
            commit.check_ready()?;
        }
        Ok(())
    }
    fn deleted(&self) -> SourceRecord {
        SourceRecord {
            schema_version: 1,
            incarnation: self.record.incarnation,
            deleted: true,
            commit: None,
            deletion: None,
        }
    }
    fn retirement(
        &self,
        expected: &HistoricalUndoSealReceipt,
        undo_id: &str,
    ) -> Result<Option<Retirement>> {
        ids(expected, undo_id)?;
        let Some(bytes) = read(&self.control_directory()?, &intent_name(undo_id))? else {
            return Ok(None);
        };
        let intent: Retirement = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("historical_undo_invalid_intent"))?;
        validate_retirement(&self.directory, &intent, expected, undo_id)?;
        Ok(Some(intent))
    }
    pub(crate) fn observe_retirement(
        &self,
        expected: &HistoricalUndoSealReceipt,
        undo_id: &str,
    ) -> Result<Option<HistoricalSessionUndoReceipt>> {
        let Some(intent) = self.retirement(expected, undo_id)? else {
            return Ok(None);
        };
        let Some(bytes) = read(&self.control_directory()?, &receipt_name(undo_id))? else {
            return Ok(None);
        };
        let receipt: HistoricalSessionUndoReceipt = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("historical_undo_invalid_receipt"))?;
        anyhow::ensure!(
            self.record.deleted
                && digest(&serde_json::to_vec(&self.record)?) == intent.deleted_record_sha256
                && receipt.undo_id == undo_id
                && receipt.source_operation_id == expected.operation_id
                && receipt.session_id == expected.session_id
                && receipt.seal_sha256 == expected.seal_sha256
                && receipt.tombstone_sha256 == intent.deleted_record_sha256
                && receipt.quarantined_file == intent.quarantine,
            "historical_undo_receipt_changed"
        );
        Ok(Some(receipt))
    }
    pub(crate) fn reconcile_retirement(
        &mut self,
        expected: &HistoricalUndoSealReceipt,
        undo_id: &str,
    ) -> Result<Option<HistoricalSessionUndoReceipt>> {
        if let Some(receipt) = self.observe_retirement(expected, undo_id)? {
            return Ok(Some(receipt));
        }
        let Some(intent) = self.retirement(expected, undo_id)? else {
            return Ok(None);
        };
        if !self.record.deleted {
            return Ok(None);
        }
        anyhow::ensure!(
            digest(&serde_json::to_vec(&self.record)?) == intent.deleted_record_sha256,
            "historical_undo_source_changed"
        );
        Self::finish(
            &self.directory,
            &self.name,
            &self.control_directory()?,
            &intent,
        )
        .map(Some)
    }
    pub(crate) fn retire(
        &mut self,
        binding: &HistoricalSessionSeedBinding,
        expected: &HistoricalUndoSealReceipt,
        undo_id: &str,
        history: &FileProof,
    ) -> Result<HistoricalSessionUndoReceipt> {
        ids(expected, undo_id)?;
        anyhow::ensure!(
            !self.record.deleted
                && expected.operation_id == binding.operation_id
                && expected.session_id == binding.session_id,
            "historical_undo_source_changed"
        );
        let current = digest(&serde_json::to_vec(&self.record)?);
        let deleted = self.deleted();
        let deleted_bytes = serde_json::to_vec(&deleted)?;
        let current_history = file_proof(&self.directory, &self.name, &mut |_| true)?;
        anyhow::ensure!(
            history.same_content(&current_history),
            "historical_undo_history_changed"
        );
        let mut proposed = Retirement {
            version: 2,
            directory: self.directory.history_owner_seed()?,
            undo_id: undo_id.into(),
            source_operation_id: binding.operation_id.clone(),
            session_id: binding.session_id.clone(),
            seal_sha256: expected.seal_sha256.clone(),
            live_record_sha256: current.clone(),
            deleted_record_sha256: digest(&deleted_bytes),
            history: current_history.clone(),
            quarantine: format!(".{}.history-undo-{}.bin", binding.session_id, undo_id),
        };
        let control = self.control_directory()?;
        if let Some(previous) = self.retirement(expected, undo_id)? {
            proposed.version = previous.version;
            proposed.directory.clone_from(&previous.directory);
            anyhow::ensure!(
                previous.live_record_sha256 == current
                    && previous.history.matches_exact(&current_history)
                    && serde_json::to_vec(&previous)? == serde_json::to_vec(&proposed)?,
                "historical_undo_intent_changed"
            );
        } else {
            publish(
                &control,
                &intent_name(undo_id),
                &serde_json::to_vec(&proposed)?,
            )?;
        }
        anyhow::ensure!(
            proposed
                .history
                .matches_exact(&file_proof(&self.directory, &self.name, &mut |_| true)?),
            "historical_undo_history_changed"
        );
        let mutation = self.journal.begin_history_source(&self.path)?;
        control.atomic_replace(OsStr::new(SOURCE_RECORD_FILE), &deleted_bytes)?;
        self.record = deleted;
        // A failed rename or receipt is an uncertain cleanup; only this exact intent can reconcile it.
        let result = Self::finish(&self.directory, &self.name, &control, &proposed);
        finish_source_journal(mutation);
        result
    }
    fn finish(
        directory: &PrivateDirectory,
        name: &OsStr,
        control: &PrivateDirectory,
        intent: &Retirement,
    ) -> Result<HistoricalSessionUndoReceipt> {
        let active = match directory.open_single_link_regular_file(name) {
            Ok(_) => true,
            Err(error) if missing(&error) => false,
            Err(error) => return Err(error),
        };
        let held = match directory.open_single_link_regular_file(OsStr::new(&intent.quarantine)) {
            Ok(_) => true,
            Err(error) if missing(&error) => false,
            Err(error) => return Err(error),
        };
        anyhow::ensure!(!(active && held), "historical_undo_conflicting_history");
        if active {
            anyhow::ensure!(
                intent
                    .history
                    .matches_exact(&file_proof(directory, name, &mut |_| true)?),
                "historical_undo_history_changed"
            );
            directory.rename_no_replace(name, OsStr::new(&intent.quarantine))?;
        }
        anyhow::ensure!(
            intent.history.matches_exact(&file_proof(
                directory,
                OsStr::new(&intent.quarantine),
                &mut |_| true
            )?),
            "historical_undo_retained_history_changed"
        );
        let receipt = HistoricalSessionUndoReceipt {
            undo_id: intent.undo_id.clone(),
            source_operation_id: intent.source_operation_id.clone(),
            session_id: intent.session_id.clone(),
            seal_sha256: intent.seal_sha256.clone(),
            quarantined_file: intent.quarantine.clone(),
            tombstone_sha256: intent.deleted_record_sha256.clone(),
        };
        publish(
            control,
            &receipt_name(&intent.undo_id),
            &serde_json::to_vec(&receipt)?,
        )?;
        Ok(receipt)
    }
}

pub(crate) fn collect_relocation_intents(
    history_path: &Path,
    history_relative: &[String],
    control_relative: &[String],
    expected: &HistoricalUndoSealReceipt,
    graph: &mut crate::history_storage_relocation::graph::OwnerGraph,
) -> Result<()> {
    let fence = SeedUndoFence::open_existing(history_path)?;
    let control = fence.control_directory()?;
    control.visit_entry_names_bounded(8192, |name| {
        let Some(name) = name.to_str() else {
            return Ok(());
        };
        let Some(undo_id) = name
            .strip_prefix("historical-undo-")
            .and_then(|name| name.strip_suffix(".intent.json"))
        else {
            return Ok(());
        };
        let intent = fence
            .retirement(expected, undo_id)?
            .context("historical_undo_invalid_intent")?;
        fence.observe_retirement(expected, undo_id)?;
        graph.add(control_relative, &control, &[name, &receipt_name(undo_id)])?;
        graph.add(history_relative, &fence.directory, &[&intent.quarantine])?;
        if intent.version == 1 && intent.directory == fence.directory.directory_identity()? {
            // This is receipt provenance only. Native retirement still requires
            // the intent's exact file identity and never uses this mapping.
            graph.retain_current_directory(history_relative);
        }
        Ok(())
    })?;
    Ok(())
}

pub(crate) fn verify_relocation_metadata<'a>(
    source: &PrivateDirectory,
    target: &PrivateDirectory,
    control: &PrivateDirectory,
    expected: &HistoricalUndoSealReceipt,
    known_files: impl Iterator<Item = &'a str>,
) -> Result<()> {
    for name in known_files {
        let Some(undo_id) = name
            .strip_prefix("historical-undo-")
            .and_then(|name| name.strip_suffix(".intent.json"))
        else {
            continue;
        };
        ids(expected, undo_id)?;
        let bytes = read(control, name)?.context("historical_undo_invalid_intent")?;
        let intent: Retirement =
            serde_json::from_slice(&bytes).context("historical_undo_invalid_intent")?;
        validate_retirement(source, &intent, expected, undo_id)?;
        validate_retirement(target, &intent, expected, undo_id)?;
        crate::historical_undo::manifest::verify_relocation_entry_metadata(
            source,
            target,
            OsStr::new(&intent.quarantine),
        )?;
    }
    Ok(())
}
