//! Private-channel metadata. None of these types grant an authenticated peer identity.
use super::super::model::{TransferAuthority, TransferDestination, valid_sha, valid_uuid};
use crate::credentials::ApiKeySelector;
use anyhow::{Result, ensure};
use kcoder_types::migration::MigrationMcpPrivateField;
use serde::{Deserialize, Serialize};

pub const MAX_PRIVATE_BYTES: usize = 512 * 1024;
pub const MAX_PRIVATE_SLOTS: usize = 64;
pub const MAX_PRIVATE_OFFERS: usize = 16;
pub const PRIVATE_SUITE: &str = "hpke-x25519-hkdf-sha256-aes256gcm-v1";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum PrivateCredentialSelection {
    Provider {
        source_name: String,
        selector: ApiKeySelector,
        target_name: String,
        endpoint: String,
        api_format: String,
    },
    Mcp {
        source_name: String,
        fields: Vec<MigrationMcpPrivateField>,
        target_name: String,
        definition_sha256: String,
    },
}

impl PrivateCredentialSelection {
    pub(super) fn validate(&self) -> Result<()> {
        let (source, target) = match self {
            Self::Provider {
                source_name,
                target_name,
                endpoint,
                api_format,
                selector,
            } => {
                ensure!(
                    endpoint.len() <= 8192
                        && !endpoint.is_empty()
                        && !endpoint.chars().any(char::is_control),
                    "private_credentials_invalid_selection"
                );
                ensure!(
                    api_format.len() <= 64 && !api_format.is_empty(),
                    "private_credentials_invalid_selection"
                );
                if let ApiKeySelector::Environment(name) = selector {
                    ensure!(environment(name), "private_credentials_invalid_selection");
                }
                (source_name, target_name)
            }
            Self::Mcp {
                source_name,
                fields,
                target_name,
                definition_sha256,
            } => {
                ensure!(
                    valid_sha(definition_sha256) && !fields.is_empty() && fields.len() <= 32,
                    "private_credentials_invalid_selection"
                );
                ensure!(
                    fields.windows(2).all(|p| p[0] < p[1]),
                    "private_credentials_noncanonical_fields"
                );
                for field in fields {
                    match field {
                        MigrationMcpPrivateField::Environment(name) => {
                            ensure!(environment(name), "private_credentials_invalid_selection")
                        }
                        MigrationMcpPrivateField::Header(name) => ensure!(
                            !name.is_empty()
                                && name.len() <= 128
                                && name.bytes().all(|b| b.is_ascii_lowercase()
                                    || b.is_ascii_digit()
                                    || b"!#$%&'*+-.^_`|~".contains(&b)),
                            "private_credentials_invalid_selection"
                        ),
                    }
                }
                (source_name, target_name)
            }
        };
        ensure!(
            [source, target]
                .iter()
                .all(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)),
            "private_credentials_invalid_selection"
        );
        Ok(())
    }
    pub(crate) fn identity(&self) -> (&'static str, &str, &str) {
        match self {
            Self::Provider {
                source_name,
                target_name,
                ..
            } => ("provider", source_name, target_name),
            Self::Mcp {
                source_name,
                target_name,
                ..
            } => ("mcp", source_name, target_name),
        }
    }
}

fn environment(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit())
}

/// The host verifies the native receipt, peer and destination before constructing this header.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateCredentialContext {
    pub version: u32,
    pub request_id: String,
    pub offer_id: String,
    pub source: TransferAuthority,
    pub destination: TransferDestination,
    pub manifest_sha256: String,
    pub entry_id: String,
    pub source_identity: String,
    pub source_binding_revision: String,
    pub target_profile_identity: String,
    pub target_policy: kcoder_config::CredentialStoreMode,
    pub selections: Vec<PrivateCredentialSelection>,
}
impl PrivateCredentialContext {
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(self.version == 1, "private_credentials_version_unsupported");
        valid_uuid(&self.request_id)?;
        valid_uuid(&self.offer_id)?;
        self.source.validate()?;
        self.destination.authority.validate()?;
        ensure!(
            self.destination.grant_id == self.request_id && valid_sha(&self.destination.scope),
            "private_credentials_invalid_destination"
        );
        ensure!(
            valid_sha(&self.manifest_sha256)
                && valid_sha(&self.source_identity)
                && valid_sha(&self.source_binding_revision),
            "private_credentials_invalid_source"
        );
        super::super::model::valid_id(&self.entry_id)?;
        ensure!(
            !self.target_profile_identity.is_empty()
                && self.target_profile_identity.len() <= 1024
                && !self.target_profile_identity.chars().any(char::is_control)
                && self.destination.scope
                    == super::super::model::digest(&(
                        "source-transfer.target/1",
                        &self.target_profile_identity,
                        &self.destination.authority,
                    ))?,
            "private_credentials_invalid_destination"
        );
        ensure!(
            !self.selections.is_empty() && self.selections.len() <= MAX_PRIVATE_SLOTS,
            "private_credentials_budget_exceeded"
        );
        let mut ids = std::collections::BTreeSet::new();
        let mut targets = std::collections::BTreeSet::new();
        for selection in &self.selections {
            selection.validate()?;
            ensure!(
                ids.insert(selection.identity())
                    && targets.insert((selection.identity().0, selection.identity().2)),
                "private_credentials_duplicate_selection"
            );
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateCredentialOffer {
    pub context: PrivateCredentialContext,
    pub suite: String,
    pub public_key: String,
}
impl std::fmt::Debug for PrivateCredentialOffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrivateCredentialOffer")
            .field("offer_id", &self.context.offer_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateCredentialEnvelope {
    pub version: u32,
    pub offer_id: String,
    pub offer_sha256: String,
    pub encapsulated_key: String,
    pub ciphertext: String,
}
impl std::fmt::Debug for PrivateCredentialEnvelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrivateCredentialEnvelope")
            .field("offer_id", &self.offer_id)
            .field("encoded_bytes", &self.ciphertext.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy)]
pub struct PrivateCredentialConsent {
    pub api_keys: bool,
    pub mcp_private_fields: bool,
}
impl PrivateCredentialConsent {
    pub(crate) fn require(self, selections: &[PrivateCredentialSelection]) -> Result<()> {
        for selection in selections {
            ensure!(
                match selection {
                    PrivateCredentialSelection::Provider { .. } => self.api_keys,
                    PrivateCredentialSelection::Mcp { .. } => self.mcp_private_fields,
                },
                "private_credentials_explicit_consent_required"
            );
        }
        Ok(())
    }
}
