//! Integration configuration domains; no credentials or implicit activation.
pub mod connectivity;
pub mod core;
pub mod knowledge;
pub mod office;
pub mod remotes;
pub mod services;

use serde::{Deserialize, Serialize};

/// Target-owned feature configuration. Enabling a feature does not grant its
/// tools, external account access, publishing rights or background execution.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IntegrationSettings {
    pub core: core::CoreIntegrationSettings,
    pub office: office::OfficeSettings,
    pub remotes: remotes::RemoteIntegrationSettings,
    pub connectivity: connectivity::ConnectivitySettings,
    pub knowledge: knowledge::KnowledgeIntegrationSettings,
    #[serde(skip_serializing_if = "services::NativeServiceSettings::is_default")]
    pub services: services::NativeServiceSettings,
}

impl IntegrationSettings {
    pub fn validate(&self) -> anyhow::Result<()> {
        self.core.validate()?;
        self.office.validate()?;
        self.remotes.validate()?;
        self.connectivity
            .validate()
            .map_err(|_| anyhow::anyhow!("INTEGRATION_CONNECTIVITY_INVALID_SETTINGS"))?;
        self.knowledge
            .validate()
            .map_err(|_| anyhow::anyhow!("INTEGRATION_KNOWLEDGE_INVALID_SETTINGS"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
