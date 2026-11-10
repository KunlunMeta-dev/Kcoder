//! Backward-compatible private plan input. Received material is never a fake local config.
use super::{
    model::*,
    target::{ReceivedPrivateCredentialBinding, ReceivedPrivateCredentialLease},
};
use anyhow::{Context, Result};
use kcoder_config::CredentialBackend;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// Borrowed native-only source and ciphertext authorities; never an RPC path.
pub struct ReceivedCredentialInput<'a> {
    pub source: &'a crate::source_transfer::TransferredConfigurationBinding,
    pub material: &'a ReceivedPrivateCredentialBinding,
    pub execution: Option<&'a ReceivedPrivateCredentialLease>,
    pub policy: kcoder_config::CredentialStoreMode,
    pub backend: &'a dyn CredentialBackend,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CredentialSourceBinding {
    Local(Box<crate::discovery::ConfigurationBinding>),
    Received(Box<ReceivedPrivateCredentialBinding>),
}
impl CredentialSourceBinding {
    pub(crate) fn received_offer(&self) -> Option<&ReceivedPrivateCredentialBinding> {
        match self {
            Self::Local(_) => None,
            Self::Received(binding) => Some(binding),
        }
    }
    pub(crate) fn provider_key(
        &self,
        profile_identity: &str,
        backend: &dyn CredentialBackend,
        source_name: &str,
        target_name: &str,
        selector: &crate::credentials::ApiKeySelector,
    ) -> Result<Zeroizing<String>> {
        match self {
            Self::Local(binding) => crate::credentials::read_key(binding, selector, source_name),
            Self::Received(binding) => binding.provider_key(
                profile_identity,
                backend,
                source_name,
                target_name,
                selector,
                None,
            ),
        }
    }
    pub(crate) fn mcp_values(
        &self,
        profile_identity: &str,
        backend: &dyn CredentialBackend,
        source_name: &str,
        target_name: &str,
        fields: &[kcoder_types::migration::MigrationMcpPrivateField],
    ) -> Result<Zeroizing<String>> {
        match self {
            Self::Local(binding) => {
                crate::mcp_credentials::read_private_literals(binding, source_name, fields)
            }
            Self::Received(binding) => binding.mcp_values(
                profile_identity,
                backend,
                source_name,
                target_name,
                fields,
                None,
            ),
        }
    }
}

impl ReceivedPrivateCredentialBinding {
    pub(crate) fn provider_key(
        &self,
        profile_identity: &str,
        backend: &dyn CredentialBackend,
        source_name: &str,
        target_name: &str,
        selector: &crate::credentials::ApiKeySelector,
        execution: Option<&ReceivedPrivateCredentialLease>,
    ) -> Result<Zeroizing<String>> {
        let index=self.selections().iter().position(|selection|matches!(selection,PrivateCredentialSelection::Provider{source_name:s,target_name:t,selector:v,..} if s==source_name && t==target_name && v==selector)).context("private_credentials_binding_changed")?;
        let values = match execution {
            Some(lease) => lease.values(self, profile_identity, backend)?,
            None => self.values_for_identity(profile_identity, backend)?,
        };
        Ok(Zeroizing::new(values.0[index].as_str().to_owned()))
    }
    pub(crate) fn mcp_values(
        &self,
        profile_identity: &str,
        backend: &dyn CredentialBackend,
        source_name: &str,
        target_name: &str,
        fields: &[kcoder_types::migration::MigrationMcpPrivateField],
        execution: Option<&ReceivedPrivateCredentialLease>,
    ) -> Result<Zeroizing<String>> {
        let index=self.selections().iter().position(|selection|matches!(selection,PrivateCredentialSelection::Mcp{source_name:s,target_name:t,fields:f,..} if s==source_name && t==target_name && f==fields)).context("private_credentials_binding_changed")?;
        let values = match execution {
            Some(lease) => lease.values(self, profile_identity, backend)?,
            None => self.values_for_identity(profile_identity, backend)?,
        };
        Ok(Zeroizing::new(values.0[index].as_str().to_owned()))
    }
}
