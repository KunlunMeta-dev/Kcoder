//! Reviewed metadata from the original received inventory, never source credential values.
use super::super::{IncomingTransfers, TransferAuthority, TransferReceipt};
use super::{PrivateCredentialSelection, model};
use crate::credentials::ApiKeySelector;
use anyhow::{Result, ensure};
use kcoder_types::migration::{MigrationMcpPrivateField as Field, MigrationSourceKind};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrivateCredentialCandidate {
    Provider {
        item_id: String,
        source_name: Option<String>,
        endpoint: Option<String>,
        api_format: String,
        selectors: Vec<ApiKeySelector>,
        issue_code: Option<&'static str>,
        source_verification_required: bool,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        targets: Vec<super::candidate_targets::PrivateCredentialCandidateTarget>,
    },
    Mcp {
        item_id: String,
        source_name: Option<String>,
        definition_sha256: Option<String>,
        fields: Vec<Field>,
        declared_fields: u32,
        issue_code: Option<&'static str>,
        source_verification_required: bool,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        targets: Vec<super::candidate_targets::PrivateCredentialCandidateTarget>,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCredentialCandidatePage {
    pub request_id: String,
    pub manifest_sha256: String,
    pub entry_id: String,
    pub source_binding_revision: String,
    pub source: MigrationSourceKind,
    pub project_scoped: bool,
    pub items: Vec<PrivateCredentialCandidate>,
    pub total_items: u32,
    pub next_page: Option<u32>,
    #[serde(skip)]
    pub(super) page_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<super::candidate_targets::PrivateCredentialCandidatePlan>,
}

pub fn private_credential_candidates(
    target: &IncomingTransfers,
    authenticated_source: &TransferAuthority,
    request: &str,
    receipt: &TransferReceipt,
    entry: &str,
    page: u32,
) -> Result<PrivateCredentialCandidatePage> {
    ensure!(page <= 1024, "private_credentials_invalid_page");
    let (_, binding, manifest) =
        target.private_credential_scope(request, authenticated_source, receipt, entry)?;
    let selected = manifest
        .entries
        .iter()
        .find(|value| value.id == entry)
        .ok_or_else(|| anyhow::anyhow!("private_credentials_source_not_selected"))?;
    let super::super::TransferContent::ConfigurationInventory {
        source_binding_revision,
        ..
    } = &selected.content
    else {
        anyhow::bail!("private_credentials_source_not_selected");
    };
    let project = binding.source_scope()?.starts_with("project");
    let inventory = binding.inventory()?;
    ensure!(
        inventory.items.len() <= 10240,
        "private_credentials_budget_exceeded"
    );
    let mut candidates = Vec::new();
    for item in &inventory.items {
        if let Some(provider) = &item.provider {
            let endpoint = provider.endpoint.clone().or_else(|| {
                (inventory.source == MigrationSourceKind::ClaudeCode)
                    .then(|| "https://api.anthropic.com".to_string())
            });
            let mut selectors = Vec::new();
            if inventory.source == MigrationSourceKind::ClaudeCode {
                selectors.push(ApiKeySelector::ClaudeConfiguration);
            }
            if let Some(variable) = &provider.credential_environment {
                selectors.push(ApiKeySelector::Environment(variable.clone()));
            }
            let valid = !selectors.is_empty()
                && selectors.iter().all(|selector| {
                    PrivateCredentialSelection::Provider {
                        source_name: item.preview.source_name.clone(),
                        selector: selector.clone(),
                        target_name: "candidate".into(),
                        endpoint: endpoint.clone().unwrap_or_default(),
                        api_format: provider.api_format.clone(),
                    }
                    .validate()
                    .is_ok()
                });
            let issue = if project {
                Some("private_credentials_project_scope_unsupported")
            } else if !valid {
                Some("private_credentials_selector_unavailable")
            } else {
                None
            };
            candidates.push(PrivateCredentialCandidate::Provider {
                item_id: item.preview.id.clone(),
                source_name: valid.then(|| item.preview.source_name.clone()),
                endpoint: if valid { endpoint } else { None },
                api_format: if valid {
                    provider.api_format.clone()
                } else {
                    String::new()
                },
                selectors: if issue.is_none() {
                    selectors
                } else {
                    Vec::new()
                },
                issue_code: issue,
                source_verification_required: true,
                targets: Vec::new(),
            });
        } else if let Some(mcp) = &item.mcp {
            let fields = mcp
                .config
                .env
                .keys()
                .chain(&mcp.config.policy.required_env)
                .map(|name| Field::Environment(name.clone()))
                .chain(
                    mcp.config
                        .headers
                        .keys()
                        .chain(&mcp.config.policy.required_headers)
                        .map(|name| Field::Header(name.to_ascii_lowercase())),
                )
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let definition = super::super::model::digest(&mcp.config)?;
            let valid = PrivateCredentialSelection::Mcp {
                source_name: item.preview.source_name.clone(),
                target_name: "candidate".into(),
                fields: fields.clone(),
                definition_sha256: definition.clone(),
            }
            .validate()
            .is_ok();
            let issue = if project {
                Some("private_credentials_project_scope_unsupported")
            } else if fields.len() > 32 {
                Some("private_credentials_budget_exceeded")
            } else if !valid {
                Some("private_credentials_selector_unavailable")
            } else {
                None
            };
            candidates.push(PrivateCredentialCandidate::Mcp {
                item_id: item.preview.id.clone(),
                source_name: valid.then(|| item.preview.source_name.clone()),
                definition_sha256: valid.then_some(definition),
                declared_fields: fields.len() as u32,
                fields: if issue.is_none() { fields } else { Vec::new() },
                issue_code: issue,
                source_verification_required: true,
                targets: Vec::new(),
            });
        }
        ensure!(
            candidates.len() <= model::MAX_PRIVATE_SLOTS * 16,
            "private_credentials_budget_exceeded"
        );
    }
    let total_items = candidates.len() as u32;
    let start = page as usize * 10;
    ensure!(
        start < candidates.len() || start == 0,
        "private_credentials_invalid_page"
    );
    Ok(PrivateCredentialCandidatePage {
        request_id: request.into(),
        manifest_sha256: manifest.digest()?,
        entry_id: entry.into(),
        source_binding_revision: source_binding_revision.clone(),
        source: inventory.source,
        project_scoped: project,
        items: candidates.into_iter().skip(start).take(10).collect(),
        total_items,
        next_page: (start + 10 < total_items as usize).then_some(page + 1),
        page_index: page,
        plan: None,
    })
}
