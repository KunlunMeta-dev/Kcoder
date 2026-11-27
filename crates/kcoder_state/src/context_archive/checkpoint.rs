//! References to the exact archived source of a private subagent checkpoint.
use super::inheritance::ContextHistoryAnchor;
use super::*;
use crate::history_store::HistorySource;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextHistoryCheckpoint {
    version: u32,
    history_id: String,
    root_id: String,
    incarnation: uuid::Uuid,
    generation: uuid::Uuid,
    committed_bytes: u64,
    summary_sha256: String,
    messages_sha256: String,
}

fn digest(messages: &(impl Serialize + ?Sized)) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(messages)?)
    ))
}

impl ContextHistoryCheckpoint {
    pub fn validate_messages(&self, messages: &[Message]) -> Result<()> {
        ensure!(self.version == 1, "unsupported context history checkpoint");
        ensure!(
            self.messages_sha256 == digest(messages)?,
            "context history checkpoint payload changed"
        );
        self.validate_summary(messages)?;
        ensure!(
            !self.root_id.is_empty()
                && self.root_id.len() <= 256
                && !self.root_id.chars().any(char::is_control),
            "invalid checkpoint context root"
        );
        ensure!(
            crate::artifact_id_path_component(&self.history_id) == self.history_id,
            "invalid checkpoint history identity"
        );
        Ok(())
    }

    fn validate_summary(&self, messages: &[Message]) -> Result<()> {
        let summary = messages
            .first()
            .filter(|m| m.origin() == MessageOrigin::Compaction)
            .context("checkpoint has no original compression summary")?;
        ensure!(
            format!("{:x}", Sha256::digest(serde_json::to_vec(summary)?)) == self.summary_sha256,
            "checkpoint compression summary changed"
        );
        Ok(())
    }

    /// Host-side transcript repairs or delivery appends retain the same archive
    /// only while the canonical summary still has its captured identity.
    pub fn with_messages(&self, messages: &[Message]) -> Result<Self> {
        self.validate_summary(messages)?;
        let mut reference = self.clone();
        reference.messages_sha256 = digest(messages)?;
        Ok(reference)
    }
}

impl AppState {
    /// A subagent owns a separate append-only context log under its registered
    /// transcript directory. Its public artifact routing stays explicit.
    pub fn with_subagent_context_history(&self, checkpoint: &Path) -> Result<()> {
        let directory = PrivateDirectory::open_or_create(
            checkpoint.parent().context("checkpoint has no directory")?,
        )?
        .open_child(std::ffi::OsStr::new("context-history"), true)?;
        let path = checkpoint
            .parent()
            .unwrap()
            .join("context-history")
            .join(format!(
                "{}.jsonl",
                crate::artifact_id_path_component(&self.session_id())
            ));
        drop(directory);
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        ensure!(
            inner.history_path.is_none(),
            "subagent context history is already configured"
        );
        Self::install_history_path(&mut inner, path);
        if let Some(location) = inner.session_artifact_override.as_mut() {
            location.prefer_over_history = true;
        }
        Ok(())
    }

    /// Call after the owned history flush and before publishing the checkpoint.
    pub fn context_history_checkpoint(
        &self,
        checkpoint: &Path,
        messages: &kcoder_types::SharedMessages,
    ) -> Result<Option<ContextHistoryCheckpoint>> {
        let inner = self.read_inner();
        let Some(summary) = messages
            .first()
            .filter(|m| m.origin() == MessageOrigin::Compaction)
        else {
            return Ok(None);
        };
        ensure!(
            inner.messages.len() == messages.len() && inner.messages.iter().eq(messages.iter()),
            "context changed before checkpoint capture"
        );
        let Some(root_id) = inner.message_history_ids.first().cloned().flatten() else {
            return Ok(None);
        };
        let Some(path) = inner.history_path.clone() else {
            return Ok(None);
        };
        let source = inner
            .history_source
            .clone()
            .context("checkpoint history source unavailable")?;
        let owner = crate::history_append_context::lifecycle_identity_locked(self, &inner);
        let history_id = path
            .file_stem()
            .and_then(std::ffi::OsStr::to_str)
            .context("invalid context history filename")?
            .to_owned();
        ensure!(
            path == checkpoint
                .parent()
                .context("checkpoint has no directory")?
                .join("context-history")
                .join(format!("{history_id}.jsonl")),
            "checkpoint history is outside its owned directory"
        );
        let summary_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(summary)?));
        drop(inner);
        source.check_read_binding()?;
        let stamp = committed_source_stamp(&path)?;
        let (incarnation, generation, committed_bytes) = stamp.committed_body_key()?;
        let reference = ContextHistoryCheckpoint {
            version: 1,
            history_id,
            root_id,
            incarnation,
            generation,
            committed_bytes,
            summary_sha256,
            messages_sha256: digest(messages)?,
        };
        ensure!(
            owner.matches(self),
            "context lifecycle changed before checkpoint capture"
        );
        source.check_read_binding()?;
        Ok(Some(reference))
    }

    /// Load only the archive selected by this task's published checkpoint.
    /// The existing source is read, while this new run receives its own copy.
    pub fn inherit_checkpoint_context_history(
        &self,
        checkpoint: &Path,
        reference: &ContextHistoryCheckpoint,
        checkpoint_messages: &[Message],
        cancelled: impl Fn() -> bool,
    ) -> Result<bool> {
        reference.validate_messages(checkpoint_messages)?;
        let current = self.messages();
        reference.validate_summary(&current)?;
        let path = checkpoint
            .parent()
            .context("checkpoint has no directory")?
            .join("context-history")
            .join(format!("{}.jsonl", reference.history_id));
        let stamp = committed_source_stamp(&path)?;
        let (incarnation, generation, bytes) = stamp.committed_body_key()?;
        ensure!(
            incarnation == reference.incarnation
                && generation == reference.generation
                && bytes >= reference.committed_bytes,
            "checkpoint context history was replaced or truncated"
        );
        let source = HistorySource::bind(&path)?;
        let reader = AppState::with_messages(self.cwd(), vec![current[0].clone()]);
        {
            let mut inner = reader.write_inner();
            inner.history_path = Some(path.clone());
            inner.history_source = Some(source);
            inner.message_history_ids = vec![Some(reference.root_id.clone())].into();
        }
        let anchor = ContextHistoryAnchor {
            owner: reader.inspection_lifecycle_identity(),
            path,
            root: reference.root_id.clone(),
            summary_digest: Sha256::digest(serde_json::to_vec(&current[0])?).into(),
            checkpoint_body: Some((
                reference.incarnation,
                reference.generation,
                reference.committed_bytes,
            )),
        };
        self.inherit_compacted_history_from(&reader, &anchor, cancelled)
    }
}
