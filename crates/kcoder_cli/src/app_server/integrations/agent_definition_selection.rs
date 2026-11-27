//! Shared immutable Agent definition resolution for ordinary tasks and channels.
use super::agent_resources::AgentResources;
use anyhow::{Context, Result, ensure};
use kcoder_types::agent_definition::*;
use kcoder_types::integrations::core::*;
use sha2::{Digest, Sha256};

const HASH_MARKER: &str = "@sha256:";
fn validate_reference(reference: &IntegrationEntityRef) -> Result<()> {
    IntegrationRevisionRef {
        id: reference.id.clone(),
        revision: reference
            .revision
            .clone()
            .context("CHANNEL_ASSISTANT_IMMUTABLE_REVISION_REQUIRED")?,
    }
    .validate()?;
    Ok(())
}

pub(in crate::app_server) struct AgentDefinitionSelection {
    resources: AgentResources,
    saved: AgentDefinitionVersion,
}
impl AgentDefinitionSelection {
    pub(in crate::app_server) fn read(
        resources: AgentResources,
        reference: &IntegrationEntityRef,
    ) -> Result<Self> {
        resources.authorize("agent.definition.read", "agent-definition-read")?;
        validate_reference(reference)?;
        ensure!(
            reference.kind == IntegrationEntityKind::Assistant,
            "CHANNEL_ASSISTANT_SELECTION_REQUIRED"
        );
        let (version, expected_sha) = reference
            .revision
            .as_deref()
            .and_then(|revision| revision.rsplit_once(HASH_MARKER))
            .context("CHANNEL_ASSISTANT_IMMUTABLE_REVISION_REQUIRED")?;
        ensure!(
            !version.is_empty()
                && expected_sha.len() == 64
                && expected_sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "CHANNEL_ASSISTANT_IMMUTABLE_REVISION_REQUIRED"
        );
        let (_guard, store) = resources
            .store(None)?
            .context("CHANNEL_ASSISTANT_STORE_UNAVAILABLE")?;
        let saved = store
            .read_version(&reference.id, version)?
            .context("CHANNEL_ASSISTANT_VERSION_UNAVAILABLE")?;
        saved.definition.validate()?;
        ensure!(
            saved.owner == IntegrationOwner::from(resources.scope())
                && !saved.archived
                && saved.definition.id == reference.id
                && saved.version == version
                && saved.definition_sha256 == expected_sha
                && format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&saved.definition)?)
                ) == expected_sha,
            "CHANNEL_ASSISTANT_VERSION_CHANGED"
        );
        Ok(Self { resources, saved })
    }
    pub(in crate::app_server) fn definition(&self) -> &AgentDefinition {
        &self.saved.definition
    }

    /// Saved personalization is read for each new turn; immutable version fields stay pinned.
    pub(in crate::app_server) fn personalized_definition(
        &self,
    ) -> Result<(AgentDefinition, Option<u64>)> {
        let (definition, revision, _) = self.resolve_personalized_definition()?;
        Ok((definition, revision))
    }

    /// Resolve the same authoritative draft projection used for a new selection and reject it
    /// when the owner has disabled this expert template.
    pub(in crate::app_server) fn definition_for_new_binding(&self) -> Result<AgentDefinition> {
        let (definition, _, enabled) = self.resolve_personalized_definition()?;
        ensure!(enabled, "AGENT_DEFINITION_DISABLED");
        Ok(definition)
    }

    fn resolve_personalized_definition(&self) -> Result<(AgentDefinition, Option<u64>, bool)> {
        self.verify_current()?;
        let (_guard, store) = self
            .resources
            .store(None)?
            .context("AGENT_PERSONALIZATION_UNAVAILABLE")?;
        let Some(draft) = store.read_draft(&self.saved.definition.id)? else {
            return Ok((self.saved.definition.clone(), None, true));
        };
        ensure!(
            draft.owner == self.saved.owner && draft.definition.id == self.saved.definition.id,
            "AGENT_PERSONALIZATION_OWNER_CHANGED"
        );
        draft.definition.validate()?;
        let enabled = draft
            .definition
            .input_schema
            .get("x-kcoder-expert")
            .and_then(|metadata| metadata.get("enabled"))
            .and_then(serde_json::Value::as_bool)
            != Some(false);
        let mut definition = self.saved.definition.clone();
        definition.instructions = draft.definition.instructions;
        definition.skills = draft.definition.skills;
        definition.allowed_tools = draft.definition.allowed_tools;
        definition.validate()?;
        Ok((definition, Some(draft.revision), enabled))
    }
    pub(in crate::app_server) fn prepare_resources(
        &self,
        definition: &AgentDefinition,
        draft_revision: Option<u64>,
        restored: Option<&kcoder_state::integrations::resources::AgentResourceSnapshot>,
    ) -> Result<(
        kcoder_state::integrations::resources::AgentResourceSnapshot,
        std::path::PathBuf,
    )> {
        self.verify_current()?;
        let (_guard, store) = self
            .resources
            .store(None)?
            .context("AGENT_RESOURCE_STORE_UNAVAILABLE")?;
        let snapshot = match restored {
            Some(snapshot) => {
                ensure!(
                    snapshot.expert_id == definition.id,
                    "AGENT_RESOURCE_DEFINITION_MISMATCH"
                );
                snapshot.clone()
            }
            None => store.capture_expert_resources(definition, draft_revision)?,
        };
        let path = self.resources.data_path()?;
        let root = store.materialize_expert_resources(&snapshot, &path)?;
        Ok((snapshot, root))
    }
    pub(in crate::app_server) fn verify_current(&self) -> Result<()> {
        self.resources
            .authorize("agent.definition.read", "agent-definition-read")?;
        let (_guard, store) = self
            .resources
            .store(None)?
            .context("CHANNEL_ASSISTANT_STORE_UNAVAILABLE")?;
        let current = store
            .read_version(&self.saved.definition.id, &self.saved.version)?
            .context("CHANNEL_ASSISTANT_VERSION_UNAVAILABLE")?;
        ensure!(current == self.saved, "CHANNEL_ASSISTANT_VERSION_CHANGED");
        Ok(())
    }
}
