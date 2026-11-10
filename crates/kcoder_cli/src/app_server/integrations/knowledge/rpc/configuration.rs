use crate::app_server::integrations::core::NativeIntegrationContext;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, integrations::knowledge::KnowledgeIntegrationSettings};
use kcoder_engine::QueryEngine;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub(in crate::app_server::integrations::knowledge) struct EngineSnapshot {
    path: Option<PathBuf>,
    cwd: PathBuf,
    pub(in crate::app_server::integrations::knowledge) settings: KnowledgeIntegrationSettings,
    pub(in crate::app_server::integrations::knowledge) revision: String,
    pub(in crate::app_server::integrations::knowledge) fingerprint: String,
}
impl EngineSnapshot {
    pub(in crate::app_server::integrations::knowledge) fn capture(
        engine: &QueryEngine,
    ) -> Result<Self> {
        let revision = engine.active_model_configuration_summary()?.revision;
        let settings = engine
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE"))?
            .integrations
            .knowledge
            .clone();
        settings.validate().map_err(anyhow::Error::msg)?;
        let path = engine.settings_persistence_path();
        let cwd = engine.state.cwd().canonicalize()?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&path, &cwd, &revision, &settings))?)
        );
        ensure!(
            engine.active_model_configuration_summary()?.revision == revision,
            "KNOWLEDGE_RPC_CONFIGURATION_CHANGED"
        );
        Ok(Self {
            path,
            cwd,
            settings,
            revision,
            fingerprint,
        })
    }
    pub(in crate::app_server::integrations::knowledge) fn path(&self) -> Result<&std::path::Path> {
        self.path
            .as_deref()
            .context("KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE")
    }
    pub(in crate::app_server::integrations::knowledge) fn verify_binding(
        &self,
        engine: &QueryEngine,
        context: &NativeIntegrationContext,
    ) -> Result<()> {
        context.verify()?;
        let path = self.path()?;
        ensure!(
            path.is_absolute(),
            "KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE"
        );
        let profile = PrivateDirectory::open_existing(
            path.parent()
                .context("KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE")?,
        )?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? == context.profile()?.directory_identity()?,
            "KNOWLEDGE_CALLER_SCOPE_MISMATCH"
        );
        let workspace = PrivateDirectory::open_existing(&self.cwd)?;
        ensure!(
            workspace.directory_identity()? == context.workspace_directory_identity()?,
            "KNOWLEDGE_CALLER_SCOPE_MISMATCH"
        );
        ensure!(
            engine.state.cwd().canonicalize()? == self.cwd
                && engine.settings_persistence_path() == self.path,
            "KNOWLEDGE_RPC_CONFIGURATION_CHANGED"
        );
        context.verify()
    }
}
