//! Read-only mapping from the original received entry to an explicitly saved normal batch plan.
use super::super::{IncomingTransfers, TransferAuthority, TransferReceipt};
use super::candidates::{PrivateCredentialCandidate, PrivateCredentialCandidatePage};
use crate::{
    batch::{BatchActionKind, BatchSource, settings::SettingsStep},
    store::MigrationStore,
};
use anyhow::{Context, Result, ensure};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCredentialCandidatePlan {
    pub job_id: String,
    pub plan_id: String,
    pub sequence: u64,
}
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrivateCredentialCandidateTarget {
    Provider {
        batch_item_id: String,
        target_name: String,
        endpoint: String,
        api_format: String,
    },
    Mcp {
        batch_item_id: String,
        target_name: String,
        target_definition_sha256: String,
    },
}

pub fn private_credential_candidates_for_plan(
    target: &IncomingTransfers,
    authenticated_source: &TransferAuthority,
    receipt: &TransferReceipt,
    page: &mut PrivateCredentialCandidatePage,
    job_id: &str,
    expected_plan_id: &str,
) -> Result<()> {
    // Treat a prior projection as display data, never as an original source grant.
    // Rebuild from its sealed entry and validate all metadata before adding targets.
    let canonical = super::candidates::private_credential_candidates(
        target,
        authenticated_source,
        &page.request_id,
        receipt,
        &page.entry_id,
        page.page_index,
    )?;
    let mut previous = serde_json::to_value(&*page)?;
    previous.as_object_mut().unwrap().remove("plan");
    for row in previous["items"].as_array_mut().unwrap() {
        row.as_object_mut().unwrap().remove("targets");
    }
    ensure!(
        previous == serde_json::to_value(&canonical)?,
        "private_credentials_binding_changed"
    );
    *page = canonical;
    let binding = target.configuration_binding(
        &page.request_id,
        authenticated_source,
        &page.entry_id,
        receipt,
    )?;
    let store =
        MigrationStore::open_existing(&target.private_credential_existing_store()?.profile)?;
    let job = store.read(job_id)?;
    ensure!(
        job.credential_plans.is_empty() && job.mcp_credential_plans.is_empty(),
        "private_credentials_plan_already_bound"
    );
    ensure!(
        job.status == kcoder_types::migration::MigrationJobStatus::Ready,
        "private_credentials_publication_unsettled"
    );
    let batch = job
        .batch
        .as_ref()
        .context("private_credentials_saved_plan_required")?;
    let actual_plan = batch
        .plan_id
        .as_deref()
        .context("private_credentials_saved_plan_required")?;
    ensure!(
        actual_plan == expected_plan_id && !expected_plan_id.is_empty(),
        "private_credentials_plan_changed"
    );
    ensure!(batch.sources.iter().any(|source| matches!(source, BatchSource::TransferredConfiguration(original) if **original == binding)), "private_credentials_source_not_selected");
    for action in &batch.actions {
        let BatchActionKind::Settings { plan } = &action.action else {
            continue;
        };
        ensure!(
            action.status == kcoder_types::migration::MigrationItemStatus::Staged,
            "private_credentials_publication_unsettled"
        );
        for step in &plan.steps {
            let BatchSource::TransferredConfiguration(original) =
                batch.source_for(&step.item().preview.id)?
            else {
                continue;
            };
            if **original != binding {
                continue;
            }
            let matched =
                page.items
                    .iter_mut()
                    .filter(|candidate| match (&**candidate, step) {
                        (
                            PrivateCredentialCandidate::Provider { source_name, .. },
                            SettingsStep::Provider(_),
                        )
                        | (
                            PrivateCredentialCandidate::Mcp { source_name, .. },
                            SettingsStep::Mcp(_),
                        ) => {
                            source_name.as_deref() == Some(step.item().preview.source_name.as_str())
                        }
                        _ => false,
                    })
                    .collect::<Vec<_>>();
            // Each original entry has unique normalized names within a category.
            // Never resolve a malformed same-entry ambiguity by choosing one row.
            ensure!(matched.len() <= 1, "private_credentials_source_ambiguous");
            for candidate in matched {
                let mapped = match step {
                    SettingsStep::Provider(plan) => PrivateCredentialCandidateTarget::Provider {
                        batch_item_id: step.item().preview.id.clone(),
                        target_name: plan.target_name().into(),
                        endpoint: plan.provider().endpoint.clone(),
                        api_format: plan.provider().api_format.as_str().into(),
                    },
                    SettingsStep::Mcp(plan) => PrivateCredentialCandidateTarget::Mcp {
                        batch_item_id: step.item().preview.id.clone(),
                        target_name: plan.config().name.clone(),
                        target_definition_sha256: super::super::model::digest(plan.config())?,
                    },
                };
                match candidate {
                    PrivateCredentialCandidate::Provider { targets, .. }
                    | PrivateCredentialCandidate::Mcp { targets, .. } => {
                        ensure!(targets.is_empty(), "private_credentials_source_ambiguous");
                        targets.push(mapped);
                    }
                }
            }
        }
    }
    page.plan = Some(PrivateCredentialCandidatePlan {
        job_id: job.job_id,
        plan_id: expected_plan_id.into(),
        sequence: job.sequence,
    });
    Ok(())
}
