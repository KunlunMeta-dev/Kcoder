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
            && expected.session_id.len() == 5
            && expected
                .session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric()),
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
impl SeedUndoFence {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let (directory, name) = open_parent_with_create(path, false)?;
        let lock = open_mutation_lock(&directory)?;
        FileExt::try_lock_exclusive(&lock).context("historical_undo_history_busy")?;
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
        anyhow::ensure!(
            intent.version == 1
                && intent.directory == self.directory.directory_identity()?
                && intent.undo_id == undo_id
                && intent.source_operation_id == expected.operation_id
                && intent.session_id == expected.session_id
                && intent.seal_sha256 == expected.seal_sha256
                && intent.quarantine
                    == format!(".{}.history-undo-{}.bin", expected.session_id, undo_id),
            "historical_undo_intent_changed"
        );
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
        let proposed = Retirement {
            version: 1,
            directory: self.directory.directory_identity()?,
            undo_id: undo_id.into(),
            source_operation_id: binding.operation_id.clone(),
            session_id: binding.session_id.clone(),
            seal_sha256: expected.seal_sha256.clone(),
            live_record_sha256: current.clone(),
            deleted_record_sha256: digest(&deleted_bytes),
            history: history.clone(),
            quarantine: format!(".{}.history-undo-{}.bin", binding.session_id, undo_id),
        };
        let control = self.control_directory()?;
        if let Some(previous) = self.retirement(expected, undo_id)? {
            anyhow::ensure!(
                previous.live_record_sha256 == current
                    && previous.history == *history
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
            file_proof(&self.directory, &self.name, &mut |_| true)? == *history,
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
                file_proof(directory, name, &mut |_| true)? == intent.history,
                "historical_undo_history_changed"
            );
            directory.rename_no_replace(name, OsStr::new(&intent.quarantine))?;
        }
        anyhow::ensure!(
            file_proof(directory, OsStr::new(&intent.quarantine), &mut |_| { true })?
                == intent.history,
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
