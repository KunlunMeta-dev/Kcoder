//! Shared immutable Agent definition resolution for ordinary tasks and channels.
use crate::app_server::integrations::core::{
    NativeDomain, NativeDomainGuard, NativeIntegrationContext,
};
use anyhow::{Context, Result, ensure};
use kcoder_state::integrations::office::OfficeStore;
use kcoder_tools::ToolRegistry;
use kcoder_types::integrations::{core::*, office::*};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;

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

/// Version and definition hash are both part of the resource that the owner selects.
/// The returned reference is only lookup data; the actual native signer must approve it.
#[cfg(test)]
pub(in crate::app_server) fn version_reference(
    saved: &OfficeAssistantVersion,
) -> Result<IntegrationEntityRef> {
    saved.definition.validate()?;
    let reference = IntegrationEntityRef {
        kind: IntegrationEntityKind::Assistant,
        id: saved.definition.id.clone(),
        revision: Some(format!(
            "{}{}{}",
            saved.version, HASH_MARKER, saved.definition_sha256
        )),
    };
    validate_reference(&reference)?;
    Ok(reference)
}

pub(in crate::app_server) struct AgentDefinitionSelection {
    native: NativeIntegrationContext,
    reference: IntegrationEntityRef,
    saved: OfficeAssistantVersion,
}
impl AgentDefinitionSelection {
    pub(in crate::app_server) fn read(
        native: &NativeIntegrationContext,
        reference: &IntegrationEntityRef,
    ) -> Result<Self> {
        native.verify()?;
        super::office::authorize_agent_definition_action(
            native,
            "office.assistant.read",
            "agent-definition-read",
        )?;
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
        let guard =
            NativeDomainGuard::observe(native.profile()?, native.scope(), NativeDomain::Office)?
                .context("CHANNEL_ASSISTANT_STORE_UNAVAILABLE")?;
        let store = OfficeStore::open_in(
            &guard.directory(native.profile()?)?,
            OsStr::new("data"),
            IntegrationOwner::from(native.scope()),
        )?
        .context("CHANNEL_ASSISTANT_STORE_UNAVAILABLE")?;
        let saved = store
            .read_version(&reference.id, version)?
            .context("CHANNEL_ASSISTANT_VERSION_UNAVAILABLE")?;
        saved.definition.validate()?;
        ensure!(
            saved.owner == IntegrationOwner::from(native.scope())
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
        native.verify()?;
        Ok(Self {
            native: native.recapture_for_owned_service()?,
            reference: reference.clone(),
            saved,
        })
    }
    pub(in crate::app_server) fn definition(&self) -> &OfficeAssistantDefinition {
        &self.saved.definition
    }

    /// Saved personalization is read for each new turn; immutable version fields stay pinned.
    pub(in crate::app_server) fn personalized_definition(
        &self,
    ) -> Result<(OfficeAssistantDefinition, Option<u64>)> {
        self.verify_current()?;
        let guard = NativeDomainGuard::observe(
            self.native.profile()?,
            self.native.scope(),
            NativeDomain::Office,
        )?
        .context("AGENT_PERSONALIZATION_UNAVAILABLE")?;
        let store = OfficeStore::open_in(
            &guard.directory(self.native.profile()?)?,
            OsStr::new("data"),
            IntegrationOwner::from(self.native.scope()),
        )?
        .context("AGENT_PERSONALIZATION_UNAVAILABLE")?;
        let Some(draft) = store.read_draft(&self.saved.definition.id)? else {
            return Ok((self.saved.definition.clone(), None));
        };
        ensure!(
            draft.owner == self.saved.owner && draft.definition.id == self.saved.definition.id,
            "AGENT_PERSONALIZATION_OWNER_CHANGED"
        );
        draft.definition.validate()?;
        let mut definition = self.saved.definition.clone();
        definition.instructions = draft.definition.instructions;
        definition.skills = draft.definition.skills;
        definition.allowed_tools = draft.definition.allowed_tools;
        definition.validate()?;
        self.native.verify()?;
        Ok((definition, Some(draft.revision)))
    }
    pub(in crate::app_server) fn reference(&self) -> &IntegrationEntityRef {
        &self.reference
    }

    pub(in crate::app_server) fn prepare_resources(
        &self,
        definition: &OfficeAssistantDefinition,
        draft_revision: Option<u64>,
        restored: Option<&kcoder_state::integrations::office::OfficeExpertResourceSnapshot>,
    ) -> Result<(
        kcoder_state::integrations::office::OfficeExpertResourceSnapshot,
        std::path::PathBuf,
    )> {
        self.verify_current()?;
        let guard = NativeDomainGuard::observe(
            self.native.profile()?,
            self.native.scope(),
            NativeDomain::Office,
        )?
        .context("AGENT_RESOURCE_STORE_UNAVAILABLE")?;
        let store = OfficeStore::open_in(
            &guard.directory(self.native.profile()?)?,
            OsStr::new("data"),
            IntegrationOwner::from(self.native.scope()),
        )?
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
        let namespace =
            NativeDomainGuard::expected_namespace_id(self.native.scope(), NativeDomain::Office)?;
        let path = self.native.profile_path()?.join(namespace).join("data");
        let root = store.materialize_expert_resources(&snapshot, &path)?;
        self.native.verify()?;
        Ok((snapshot, root))
    }
    pub(in crate::app_server) fn verify_current(&self) -> Result<()> {
        let current = Self::read(&self.native, &self.reference)?;
        ensure!(
            current.saved == self.saved,
            "CHANNEL_ASSISTANT_VERSION_CHANGED"
        );
        Ok(())
    }
    /// Intersect actual registered objects from the already permitted profile.
    /// This does not grant files, accounts, effects or any resource capability.
    pub(in crate::app_server) fn intersect_registry(
        &self,
        permitted: &ToolRegistry,
    ) -> Result<ToolRegistry> {
        self.verify_current()?;
        let allowed = kcoder_engine::agent_tool_policy::resolve_agent_tool_names(
            &self.saved.definition,
            &permitted.names(),
        )?;
        let tools = permitted.filtered_to_names(&allowed);
        Ok(tools)
    }
}
