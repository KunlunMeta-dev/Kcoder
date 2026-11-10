//! Expert snapshots share the original attempt store and its cross-process lock.
use super::*;
use crate::integrations::office::OfficeExpertResourceSnapshotExt;
use kcoder_types::agent_definition::AgentTurnConfiguration;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    version: u8,
    identity: TurnAttemptIdentity,
    configuration: AgentTurnConfiguration,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resources: Option<crate::integrations::office::OfficeExpertResourceSnapshot>,
}

fn validate(snapshot: &AgentTurnConfiguration) -> Result<()> {
    match (&snapshot.binding, &snapshot.effective_definition) {
        (Some(binding), Some(definition)) => {
            definition.validate()?;
            ensure!(
                binding.definition.is_valid() && binding.definition.id == definition.id,
                "AGENT_SNAPSHOT_DEFINITION_MISMATCH"
            );
            ensure!(
                snapshot.expert_tool_selection.is_none()
                    || binding.source == kcoder_types::agent_definition::AgentTaskSource::Expert,
                "AGENT_SNAPSHOT_INVALID"
            );
        }
        (None, None) => ensure!(
            snapshot.personalization_revision.is_none() && snapshot.expert_tool_selection.is_none(),
            "AGENT_SNAPSHOT_INVALID"
        ),
        _ => anyhow::bail!("AGENT_SNAPSHOT_INVALID"),
    }
    Ok(())
}

impl TurnAttemptStore {
    /// Write before Accepted. Retrying an unknown write must compare the exact snapshot.
    pub fn save_agent_snapshot(
        &self,
        identity: &TurnAttemptIdentity,
        configuration: &AgentTurnConfiguration,
    ) -> Result<()> {
        self.save_agent_snapshot_with_resources(identity, configuration, None)
    }

    pub fn save_agent_snapshot_with_resources(
        &self,
        identity: &TurnAttemptIdentity,
        configuration: &AgentTurnConfiguration,
        resources: Option<&crate::integrations::office::OfficeExpertResourceSnapshot>,
    ) -> Result<()> {
        self.check_identity(identity)?;
        validate(configuration)?;
        if let Some(resources) = resources {
            resources.validate_definition(
                configuration
                    .effective_definition
                    .as_ref()
                    .context("AGENT_RESOURCE_DEFINITION_MISMATCH")?,
            )?;
            ensure!(
                configuration
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding.owner == resources.owner
                        && binding.definition.id == resources.expert_id),
                "AGENT_RESOURCE_OWNER_MISMATCH"
            );
        }
        let _lock = self.lock()?;
        if let Some(existing) = self.load_agent_snapshot(identity)? {
            if existing == *configuration
                && self.load_agent_resource_snapshot(identity)?.as_ref() == resources
            {
                return Ok(());
            }
            // An interrupted preparation has no execution authority without Accepted.
            ensure!(
                self.load(identity)?.is_none(),
                "AGENT_ATTEMPT_SNAPSHOT_IMMUTABLE"
            );
        }
        ensure!(
            self.load(identity)?.is_none(),
            "AGENT_SNAPSHOT_REQUIRES_NEW_ATTEMPT"
        );
        let bytes = serde_json::to_vec(&Artifact {
            version: if resources.is_some() { 2 } else { 1 },
            identity: identity.clone(),
            configuration: configuration.clone(),
            resources: resources.cloned(),
        })?;
        ensure!(bytes.len() <= MAX_RECORD_BYTES, "AGENT_SNAPSHOT_TOO_LARGE");
        self.directory
            .atomic_replace(&leaf(identity, "expert"), &bytes)
    }

    pub fn load_agent_snapshot(
        &self,
        identity: &TurnAttemptIdentity,
    ) -> Result<Option<AgentTurnConfiguration>> {
        self.check_identity(identity)?;
        let Some(bytes) = self.read_bytes(&leaf(identity, "expert"), MAX_RECORD_BYTES)? else {
            return Ok(None);
        };
        let artifact: Artifact = serde_json::from_slice(&bytes)?;
        ensure!(
            matches!(artifact.version, 1 | 2) && artifact.identity == *identity,
            "AGENT_SNAPSHOT_IDENTITY_MISMATCH"
        );
        validate(&artifact.configuration)?;
        Ok(Some(artifact.configuration))
    }

    pub fn load_agent_resource_snapshot(
        &self,
        identity: &TurnAttemptIdentity,
    ) -> Result<Option<crate::integrations::office::OfficeExpertResourceSnapshot>> {
        self.check_identity(identity)?;
        let Some(bytes) = self.read_bytes(&leaf(identity, "expert"), MAX_RECORD_BYTES)? else {
            return Ok(None);
        };
        let artifact: Artifact = serde_json::from_slice(&bytes)?;
        ensure!(
            matches!(artifact.version, 1 | 2) && artifact.identity == *identity,
            "AGENT_SNAPSHOT_IDENTITY_MISMATCH"
        );
        validate(&artifact.configuration)?;
        if let Some(resources) = &artifact.resources {
            resources.validate_definition(
                artifact
                    .configuration
                    .effective_definition
                    .as_ref()
                    .context("AGENT_RESOURCE_DEFINITION_MISMATCH")?,
            )?;
            ensure!(
                artifact
                    .configuration
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding.owner == resources.owner
                        && binding.definition.id == resources.expert_id),
                "AGENT_RESOURCE_OWNER_MISMATCH"
            );
        }
        Ok(artifact.resources)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expert_resources_are_pinned_with_the_accepted_attempt_and_restore_without_local_paths()
    -> Result<()> {
        use serde_json::json;
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir()?;
        let directory = root.path().join("task");
        let store = TurnAttemptStore::open(&directory, "task")?;
        let identity = TurnAttemptIdentity {
            thread_id: "task".into(),
            turn_id: "turn".into(),
            attempt_id: "attempt".into(),
        };
        let content = "Read references/routing.md";
        let owner = json!({"accountId":"owner","targetId":"target","workspaceId":null});
        let definition = json!({
            "schemaVersion":1,"id":"expert","scope":"personal","title":"Expert","description":"Fixture",
            "language":"en","inputSchema":{"type":"object"},"instructions":"Expert role",
            "skills":[{"slug":"demo","title":"Demo","description":"","content":content,"enabled":true}],
            "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny"
        });
        let configuration: AgentTurnConfiguration = serde_json::from_value(json!({
            "selectionRevision":1,"personalizationRevision":2,
            "expertToolSelection":["read","skill"],
            "binding":{"owner":owner,"definition":{"id":"expert","version":"1","definitionSha256":"a".repeat(64)},
                "title":"Expert","source":"expert"},"effectiveDefinition":definition
        }))?;
        let resources = serde_json::from_value(json!({
            "owner":owner,"expertId":"expert","skills":{"demo":[
                {"path":"SKILL.md","sha256":format!("{:x}",Sha256::digest(content.as_bytes())),"bytes":content.len()},
                {"path":"references/routing.md","sha256":"b".repeat(64),"bytes":10}
            ]}
        }))?;
        store.save_agent_snapshot_with_resources(&identity, &configuration, Some(&resources))?;
        store.begin(TurnAttemptRecord {
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "c".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })?;
        drop(store);
        let reopened = TurnAttemptStore::open_existing(&directory, "task")?.unwrap();
        assert_eq!(
            reopened.load_agent_snapshot(&identity)?,
            Some(configuration.clone())
        );
        assert_eq!(
            reopened.load_agent_resource_snapshot(&identity)?,
            Some(resources.clone())
        );
        let mut changed = resources;
        changed.skills.get_mut("demo").unwrap()[1].sha256 = "d".repeat(64);
        assert!(
            reopened
                .save_agent_snapshot_with_resources(&identity, &configuration, Some(&changed))
                .is_err()
        );
        assert!(
            reopened
                .save_agent_snapshot(&identity, &configuration)
                .is_err()
        );
        Ok(())
    }
    #[test]
    fn accepted_expert_snapshot_cannot_be_replaced_or_read_as_another_attempt() -> Result<()> {
        let root = tempfile::tempdir()?;
        let directory = root.path().join("task");
        let store = TurnAttemptStore::open(&directory, "task")?;
        let identity = TurnAttemptIdentity {
            thread_id: "task".into(),
            turn_id: "turn-1".into(),
            attempt_id: "turn-1".into(),
        };
        let snapshot = AgentTurnConfiguration {
            selection_revision: 1,
            binding: None,
            personalization_revision: None,
            effective_definition: None,
            expert_tool_selection: None,
        };
        store.save_agent_snapshot(&identity, &snapshot)?;
        store.begin(TurnAttemptRecord {
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })?;
        let reopened = TurnAttemptStore::open_existing(&directory, "task")?.unwrap();
        assert_eq!(
            reopened.load_agent_snapshot(&identity)?,
            Some(snapshot.clone())
        );
        let mut changed = snapshot;
        changed.selection_revision = 2;
        assert!(reopened.save_agent_snapshot(&identity, &changed).is_err());
        let other = TurnAttemptIdentity {
            attempt_id: "turn-2".into(),
            ..identity.clone()
        };
        assert!(reopened.load_agent_snapshot(&other)?.is_none());
        let foreign = TurnAttemptIdentity {
            thread_id: "another".into(),
            ..identity
        };
        assert!(reopened.load_agent_snapshot(&foreign).is_err());
        Ok(())
    }

    #[test]
    fn failed_preparation_without_accepted_may_capture_a_new_selection() -> Result<()> {
        let root = tempfile::tempdir()?;
        let store = TurnAttemptStore::open(&root.path().join("task"), "task")?;
        let identity = TurnAttemptIdentity {
            thread_id: "task".into(),
            turn_id: "turn-1".into(),
            attempt_id: "turn-1".into(),
        };
        let mut snapshot = AgentTurnConfiguration {
            selection_revision: 1,
            binding: None,
            personalization_revision: None,
            effective_definition: None,
            expert_tool_selection: None,
        };
        store.save_agent_snapshot(&identity, &snapshot)?;
        snapshot.selection_revision = 2;
        store.save_agent_snapshot(&identity, &snapshot)?;
        assert_eq!(store.load_agent_snapshot(&identity)?, Some(snapshot));
        assert!(store.list()?.is_empty());
        Ok(())
    }
}
