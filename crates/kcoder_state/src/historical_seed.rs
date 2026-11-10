//! One atomic initial runtime context. No source task, approval, hook or tool is restored.
use super::*;
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::{MessageOrigin, historical_context::*};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, io::Read};
const META: u64 = 128 * 1024;
pub const MAX_HISTORICAL_SEED_BYTES: u64 = 16 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    directory: String,
    generation: uuid::Uuid,
    created_at_ms: u64,
    receipt: HistoricalSessionSeedReceipt,
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn optional(directory: &PrivateDirectory, name: &str, maximum: u64) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= maximum,
        "historical_seed_byte_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= maximum,
        "historical_seed_byte_budget_exceeded"
    );
    Ok(Some(bytes))
}
fn exact(directory: &PrivateDirectory, name: &str, bytes: &[u8]) -> Result<()> {
    if let Some(previous) = optional(directory, name, bytes.len() as u64)? {
        ensure!(previous == bytes, "historical_seed_receipt_changed");
        return Ok(());
    }
    directory.atomic_publish_from_reader(
        OsStr::new(name),
        &mut std::io::Cursor::new(bytes),
        false,
        || Ok(None),
    )?;
    Ok(())
}
fn prefix(directory: &PrivateDirectory, name: &str, bytes: u64) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    ensure!(
        bytes <= MAX_HISTORICAL_SEED_BYTES && file.metadata()?.len() >= bytes,
        "historical_seed_history_changed"
    );
    let mut value = Vec::new();
    file.take(bytes).read_to_end(&mut value)?;
    ensure!(
        value.len() as u64 == bytes,
        "historical_seed_history_changed"
    );
    Ok(Some(value))
}
fn fresh(inner: &AppStateInner) -> Result<()> {
    ensure!(
        inner.messages.is_empty()
            && inner.session_mode == SessionMode::Default
            && inner.workflow_definition_id.is_none()
            && !inner.conversation_started
            && inner.tasks.is_empty()
            && inner.todos.is_empty()
            && inner.goal.is_none()
            && inner.goal_history.is_empty()
            && inner.plan_mode.is_none()
            && inner.session_memory.is_none(),
        "historical_seed_requires_new_session"
    );
    Ok(())
}
fn encoded(value: &impl Serialize, maximum: u64) -> Result<Vec<u8>> {
    struct Bounded {
        bytes: Vec<u8>,
        maximum: u64,
    }
    impl std::io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() as u64 > self.maximum.saturating_sub(self.bytes.len() as u64) {
                return Err(std::io::Error::other(
                    "historical_seed_byte_budget_exceeded",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Bounded {
        bytes: Vec::new(),
        maximum,
    };
    serde_json::to_writer(&mut writer, value)
        .map_err(|_| anyhow::anyhow!("historical_seed_byte_budget_exceeded"))?;
    Ok(writer.bytes)
}
fn entry(intent: &Intent, message: Message) -> HistoryEntry {
    HistoryEntry {
        web_sources: Vec::new(),
        history_attempt: None,
        session_id: intent.receipt.binding.session_id.clone(),
        timestamp_ms: intent.created_at_ms,
        uuid: Some(intent.receipt.history_uuid.clone()),
        parent_uuid: None,
        message,
    }
}
fn body(intent: &Intent, message: Message) -> Result<Vec<u8>> {
    let mut bytes = encoded(&entry(intent, message), MAX_HISTORICAL_SEED_BYTES - 1)?;
    bytes.push(b'\n');
    Ok(bytes)
}
fn validate(binding: &HistoricalSessionSeedBinding, message: &Message) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(&binding.operation_id).is_ok()
            && uuid::Uuid::parse_str(&binding.source_job_id).is_ok()
            && uuid::Uuid::parse_str(&binding.preparation.preparation_id).is_ok()
            && !binding.view_id.is_empty()
            && binding.view_id.len() <= 128,
        "historical_seed_invalid_identity"
    );
    ensure!(
        [
            &binding.model_snapshot_sha256,
            &binding.projection_sha256,
            &binding.preparation.document_sha256,
            &binding.preparation.binding_sha256
        ]
        .into_iter()
        .all(|value| digest(value)),
        "historical_seed_invalid_digest"
    );
    ensure!(
        matches!(message,Message::User{origin:MessageOrigin::Runtime,content} if !content.is_empty()&&content.iter().all(|block|matches!(block,ContentBlock::Text{..}|ContentBlock::Image{..}))),
        "historical_seed_executable_or_visible_message"
    );
    ensure!(
        hash(&encoded(message, MAX_HISTORICAL_SEED_BYTES)?) == binding.projection_sha256,
        "historical_seed_projection_changed"
    );
    Ok(())
}

impl AppState {
    /// Read durable presentation provenance, not proof that the initial context still exists.
    /// Native compaction/rewind may legitimately replace the model-history generation.
    pub fn historical_source_for_path(
        path: &Path,
        session: &str,
    ) -> Result<Option<kcoder_types::historical_continuation::HistoricalContinuationSource>> {
        ensure!(
            path.file_name().and_then(OsStr::to_str) == Some(&format!("{session}.jsonl")),
            "historical_seed_invalid_history_path"
        );
        let parent = PrivateDirectory::open_existing(
            path.parent()
                .context("historical_seed_missing_history_parent")?,
        )?;
        parent.open_single_link_regular_file(path.file_name().unwrap())?;
        let directory = match parent.open_child(
            OsStr::new(&crate::artifact_id_path_component(session)),
            false,
        ) {
            Ok(value) => value,
            Err(error) if absent(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let Some(bytes) = optional(&directory, "historical-seed.receipt.json", META)? else {
            ensure!(
                optional(&directory, "historical-seed.intent.json", META)?.is_none(),
                "historical_seed_publication_unconfirmed"
            );
            return Ok(None);
        };
        let receipt: HistoricalSessionSeedReceipt = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("historical_seed_invalid_receipt"))?;
        let intent: Intent = serde_json::from_slice(
            &optional(&directory, "historical-seed.intent.json", META)?
                .context("historical_seed_intent_missing")?,
        )
        .map_err(|_| anyhow::anyhow!("historical_seed_invalid_intent"))?;
        ensure!(
            intent.version == 1
                && intent.directory == directory.directory_identity()?
                && intent.receipt == receipt
                && receipt.binding.session_id == session
                && receipt.history_bytes > 0
                && uuid::Uuid::parse_str(&receipt.history_uuid).is_ok()
                && digest(&receipt.history_sha256),
            "historical_seed_receipt_changed"
        );
        let binding = receipt.binding;
        Ok(Some(
            kcoder_types::historical_continuation::HistoricalContinuationSource {
                operation_id: binding.operation_id,
                source_job_id: binding.source_job_id,
                view_id: binding.view_id,
            },
        ))
    }

    /// The host first validates its operation-owned durable reservation; this does not allocate or reuse a free ID.
    pub fn for_reserved_historical_session(
        cwd: impl Into<PathBuf>,
        registry: &Path,
        id: &str,
    ) -> Result<Self> {
        ensure!(
            id.len() == 5 && id.bytes().all(|byte| byte.is_ascii_alphanumeric()),
            "historical_seed_invalid_reservation"
        );
        PrivateDirectory::open_existing(registry)?
            .open_single_link_regular_file(OsStr::new(&id.to_ascii_lowercase()))?;
        let state = Self::new(cwd);
        state.write_inner().session_id = id.into();
        state.set_short_id_registry(registry);
        Ok(state)
    }
    /// Recover a recorded publication using its actual native prefix, never regenerated source input.
    pub fn reconcile_historical_seed(
        &self,
        expected: &HistoricalSessionSeedBinding,
    ) -> Result<HistoricalSessionSeedReceipt> {
        let (path, session) = {
            let inner = self.read_inner();
            (
                inner
                    .history_path
                    .clone()
                    .context("historical_seed_requires_durable_history")?,
                inner.session_id.clone(),
            )
        };
        ensure!(
            session == expected.session_id,
            "historical_seed_session_changed"
        );
        let parent = PrivateDirectory::open_existing(
            path.parent()
                .context("historical_seed_missing_history_parent")?,
        )?;
        let directory = parent.open_child(
            OsStr::new(&crate::artifact_id_path_component(&session)),
            false,
        )?;
        let intent: Intent = serde_json::from_slice(
            &optional(&directory, "historical-seed.intent.json", META)?
                .context("historical_seed_intent_missing")?,
        )
        .map_err(|_| anyhow::anyhow!("historical_seed_invalid_intent"))?;
        ensure!(
            intent.receipt.binding == *expected
                && intent.directory == directory.directory_identity()?,
            "historical_seed_binding_changed"
        );
        let bytes = prefix(
            &parent,
            path.file_name()
                .and_then(OsStr::to_str)
                .context("historical_seed_invalid_history_path")?,
            intent.receipt.history_bytes,
        )?
        .context("historical_seed_publication_unconfirmed")?;
        ensure!(
            hash(&bytes) == intent.receipt.history_sha256,
            "historical_seed_history_changed"
        );
        let entry: HistoryEntry = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("historical_seed_invalid_body"))?;
        self.publish_historical_seed(expected.clone(), entry.message)
    }
    /// Missing completion is unknown, not permission to repeat publication or create another session.
    pub fn historical_seed_receipt(&self) -> Result<Option<HistoricalSessionSeedReceipt>> {
        let inner = self.read_inner();
        let Some(path) = inner.history_path.as_ref() else {
            return Ok(None);
        };
        let parent = match PrivateDirectory::open_existing(
            path.parent()
                .context("historical_seed_missing_history_parent")?,
        ) {
            Ok(value) => value,
            Err(error) if absent(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let directory = match parent.open_child(
            OsStr::new(&crate::artifact_id_path_component(&inner.session_id)),
            false,
        ) {
            Ok(value) => value,
            Err(error) if absent(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let Some(bytes) = optional(&directory, "historical-seed.receipt.json", META)? else {
            return Ok(None);
        };
        let receipt: HistoricalSessionSeedReceipt = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("historical_seed_invalid_receipt"))?;
        let intent: Intent = serde_json::from_slice(
            &optional(&directory, "historical-seed.intent.json", META)?
                .context("historical_seed_intent_missing")?,
        )
        .map_err(|_| anyhow::anyhow!("historical_seed_invalid_intent"))?;
        ensure!(
            intent.version == 1
                && intent.directory == directory.directory_identity()?
                && intent.receipt == receipt
                && receipt.binding.session_id == inner.session_id,
            "historical_seed_receipt_changed"
        );
        ensure!(
            receipt.history_bytes > 0
                && uuid::Uuid::parse_str(&receipt.history_uuid).is_ok()
                && digest(&receipt.history_sha256),
            "historical_seed_invalid_receipt"
        );
        require_history_source(&inner)?.check_generation(intent.generation)?;
        let body = prefix(
            &parent,
            path.file_name()
                .and_then(OsStr::to_str)
                .context("historical_seed_invalid_history_path")?,
            receipt.history_bytes,
        )?
        .context("historical_seed_history_missing")?;
        ensure!(
            hash(&body) == receipt.history_sha256,
            "historical_seed_history_changed"
        );
        Ok(Some(receipt))
    }
    /// The host must first validate the current model and own the idle execution gate.
    /// Runtime-only content is persisted; nothing is enqueued as a new user turn.
    pub fn publish_historical_seed(
        &self,
        binding: HistoricalSessionSeedBinding,
        message: Message,
    ) -> Result<HistoricalSessionSeedReceipt> {
        validate(&binding, &message)?;
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        ensure!(
            inner.session_id == binding.session_id,
            "historical_seed_session_changed"
        );
        let path = inner
            .history_path
            .clone()
            .context("historical_seed_requires_durable_history")?;
        ensure!(
            crate::session_persistence::session_id_from_history_path(&path)? == binding.session_id,
            "historical_seed_history_identity_changed"
        );
        let source = require_history_source(&inner)?.clone();
        let parent = PrivateDirectory::open_existing(
            path.parent()
                .context("historical_seed_missing_history_parent")?,
        )?;
        let directory = parent.open_child(
            OsStr::new(&crate::artifact_id_path_component(&binding.session_id)),
            true,
        )?;
        directory.verify_private_directory()?;
        let _writer = directory
            .try_exclusive_lock(OsStr::new("historical-seed.lock"))?
            .context("historical_seed_busy")?;
        let stored = optional(&directory, "historical-seed.intent.json", META)?;
        let intent = if let Some(stored) = stored {
            let intent: Intent = serde_json::from_slice(&stored)
                .map_err(|_| anyhow::anyhow!("historical_seed_invalid_intent"))?;
            ensure!(
                intent.version == 1
                    && intent.directory == directory.directory_identity()?
                    && intent.receipt.binding == binding,
                "historical_seed_binding_changed"
            );
            intent
        } else {
            check_direct_history_fault(&inner)?;
            fresh(&inner)?;
            ensure!(
                optional(
                    &parent,
                    path.file_name()
                        .and_then(OsStr::to_str)
                        .context("historical_seed_invalid_history_path")?,
                    0
                )?
                .is_none(),
                "historical_seed_history_exists"
            );
            let mut intent = Intent {
                version: 1,
                directory: directory.directory_identity()?,
                generation: uuid::Uuid::new_v4(),
                created_at_ms: inner.session_created_at_ms,
                receipt: HistoricalSessionSeedReceipt {
                    binding: binding.clone(),
                    history_uuid: generate_transcript_uuid(),
                    history_bytes: 0,
                    history_sha256: String::new(),
                },
            };
            let bytes = body(&intent, message.clone())?;
            intent.receipt.history_bytes = bytes.len() as u64;
            intent.receipt.history_sha256 = hash(&bytes);
            exact(
                &directory,
                "historical-seed.intent.json",
                &encoded(&intent, META)?,
            )?;
            intent
        };
        let bytes = body(&intent, message.clone())?;
        ensure!(
            bytes.len() as u64 == intent.receipt.history_bytes
                && hash(&bytes) == intent.receipt.history_sha256,
            "historical_seed_body_changed"
        );
        let name = path
            .file_name()
            .and_then(OsStr::to_str)
            .context("historical_seed_invalid_history_path")?;
        if let Some(existing) = prefix(&parent, name, bytes.len() as u64)? {
            ensure!(existing == bytes, "historical_seed_history_changed");
            source.reconcile_initialization(
                intent.generation,
                bytes.len() as u64,
                &intent.receipt.history_sha256,
            )?;
            // Reconcile a lost commit receipt through the normal authoritative source fence.
            if inner.messages.is_empty() {
                fresh(&inner)?;
                ensure!(
                    parent
                        .open_single_link_regular_file(OsStr::new(name))?
                        .metadata()?
                        .len()
                        == bytes.len() as u64,
                    "historical_seed_existing_session_requires_resume"
                );
                install(&mut inner, &intent, message.clone());
            }
            source.check()?;
        } else {
            fresh(&inner)?;
            check_direct_history_fault(&inner)?;
            if let Err(error) = source.initialize(&bytes, intent.generation) {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(error.to_string())
                }
                return Err(error);
            }
            install(&mut inner, &intent, message);
        }
        exact(
            &directory,
            "historical-seed.receipt.json",
            &encoded(&intent.receipt, META)?,
        )?;
        Ok(intent.receipt)
    }
}

fn absent(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

pub(crate) fn undo_witness(
    history_path: &Path,
    binding: &HistoricalSessionSeedBinding,
) -> Result<(uuid::Uuid, HistoricalSessionSeedReceipt)> {
    ensure!(
        history_path.file_name().and_then(OsStr::to_str)
            == Some(&format!("{}.jsonl", binding.session_id)),
        "historical_undo_invalid_history_path"
    );
    let parent = PrivateDirectory::open_existing(
        history_path
            .parent()
            .context("historical_undo_missing_parent")?,
    )?;
    let directory = parent.open_child(
        OsStr::new(&crate::artifact_id_path_component(&binding.session_id)),
        false,
    )?;
    directory.verify_private_directory()?;
    let intent: Intent = serde_json::from_slice(
        &optional(&directory, "historical-seed.intent.json", META)?
            .context("historical_undo_seed_intent_missing")?,
    )
    .map_err(|_| anyhow::anyhow!("historical_undo_invalid_seed_intent"))?;
    let receipt: HistoricalSessionSeedReceipt = serde_json::from_slice(
        &optional(&directory, "historical-seed.receipt.json", META)?
            .context("historical_undo_seed_receipt_missing")?,
    )
    .map_err(|_| anyhow::anyhow!("historical_undo_invalid_seed_receipt"))?;
    ensure!(
        intent.version == 1
            && intent.directory == directory.directory_identity()?
            && intent.receipt == receipt
            && receipt.binding == *binding,
        "historical_undo_seed_binding_changed"
    );
    ensure!(
        receipt.history_bytes > 0
            && receipt.history_bytes <= MAX_HISTORICAL_SEED_BYTES
            && digest(&receipt.history_sha256),
        "historical_undo_invalid_seed_receipt"
    );
    Ok((intent.generation, receipt))
}

fn install(inner: &mut AppStateInner, intent: &Intent, message: Message) {
    inner.history_write_fault = None;
    inner.messages.push(message);
    inner
        .message_history_ids
        .push(Some(intent.receipt.history_uuid.clone()));
    inner.last_history_uuid = Some(intent.receipt.history_uuid.clone());
    inner.message_revision = crate::MessageRevision::default();
    inner.conversation_started = true;
    inner.session_updated_at_ms = inner.session_updated_at_ms.max(intent.created_at_ms);
}
