//! Trusted private lane only. Public RPC never accepts keys, envelopes or Native bindings.
use super::super::{MigrationHost, MigrationStore};
use super::*;
use kcoder_migration::source_transfer::private_credentials::*;
use std::sync::Arc;

use kcoder_app_protocol::{
    MigrationSourceCredentialAcceptParamsV1 as Accept,
    MigrationSourceCredentialCancelParamsV1 as Cancel, MigrationSourceCredentialConsent,
    MigrationSourceCredentialCustodyV1, MigrationSourceCredentialOfferParamsV1 as Offer,
    MigrationSourceCredentialPrepareParamsV1 as Prepare,
    MigrationSourceCredentialReadParamsV1 as Locator,
    MigrationSourceCredentialReleaseParamsV1 as Release,
    MigrationSourceCredentialResumeParamsV1 as Resume,
    MigrationSourceCredentialSealParamsV1 as Seal,
};
fn consent(value: &MigrationSourceCredentialConsent) -> PrivateCredentialConsent {
    PrivateCredentialConsent {
        api_keys: value.api_keys,
        mcp_private_fields: value.mcp_private_fields,
    }
}
fn convert<T: DeserializeOwned>(value: &impl serde::Serialize) -> Result<T> {
    serde_json::from_value(serde_json::to_value(value)?)
        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_metadata"))
}
fn view(value: PrivateCredentialObservation) -> Result<Value> {
    let result = MigrationSourceCredentialCustodyV1 {
        offer: convert(&value.offer)?,
        envelope: value.envelope.as_ref().map(convert).transpose()?,
        control: convert(&value.control)?,
        writer_running: value.writer_running,
        received: value.received.is_some(),
        key_released: value.key_released,
    };
    Ok(serde_json::to_value(result)?)
}

fn read(peer: &AuthorizedMigrationPeer, offer_id: &str) -> Result<PrivateCredentialObservation> {
    if peer.role() == "source" {
        read_source_private_credentials(
            &source(peer)?,
            peer.target_authority(),
            peer.request_id(),
            offer_id,
        )
    } else {
        read_target_private_credentials(
            &target(peer)?,
            peer.source_authority(),
            peer.request_id(),
            offer_id,
            &kcoder_config::OsCredentialBackend::new(),
        )
    }
}
fn controller(
    peer: &AuthorizedMigrationPeer,
    offer_id: &str,
) -> Result<PrivateCredentialWatermarkControl> {
    if peer.role() == "source" {
        source_private_credential_watermark(
            &source(peer)?,
            peer.target_authority(),
            peer.request_id(),
            offer_id,
        )
    } else {
        target_private_credential_watermark(
            &target(peer)?,
            peer.source_authority(),
            peer.request_id(),
            offer_id,
        )
    }
}
fn receipt(peer: &AuthorizedMigrationPeer, target: &IncomingTransfers) -> Result<TransferReceipt> {
    target
        .receipt(peer.request_id(), peer.source_authority())?
        .context("source_transfer_not_ready")
}

pub(in super::super) fn execute(
    _processor: &MigrationProcessor,
    peer: &AuthorizedMigrationPeer,
    factory: Arc<dyn MigrationHost>,
    operation: &str,
    value: Value,
) -> Result<Value> {
    peer.validate()?;
    ensure!(peer.permits(operation), "source_transfer_recovery_scope");
    ensure!(
        operation.split('/').next() == Some(peer.role()),
        "source_transfer_role_mismatch"
    );
    let backend = kcoder_config::OsCredentialBackend::new();
    let result = match operation {
        "target/private/candidates" => {
            let value: kcoder_app_protocol::MigrationSourceCredentialCandidatesParamsV1 =
                params(peer, value)?;
            let target = target(peer)?;
            let receipt = receipt(peer, &target)?;
            ensure!(
                receipt.manifest_sha256 == value.manifest_sha256,
                "source_transfer_manifest_changed"
            );
            let mut page = private_credential_candidates(
                &target,
                peer.source_authority(),
                peer.request_id(),
                &receipt,
                &value.entry_id,
                value.page_index,
            )?;
            match (&value.job_id, &value.expected_plan_id) {
                (Some(job), Some(plan)) => private_credential_candidates_for_plan(
                    &target,
                    peer.source_authority(),
                    &receipt,
                    &mut page,
                    job,
                    plan,
                )?,
                (None, None) => {}
                _ => anyhow::bail!("private_credentials_invalid_request"),
            }
            serde_json::to_value(convert::<
                kcoder_app_protocol::MigrationSourceCredentialCandidatesResult,
            >(&page)?)?
        }
        "target/private/offer" => {
            let value: Offer = params(peer, value)?;
            let target = target(peer)?;
            let receipt = receipt(peer, &target)?;
            ensure!(
                receipt.manifest_sha256 == value.manifest_sha256,
                "source_transfer_manifest_changed"
            );
            prepare_private_credential_offer(
                &target,
                PrivateCredentialOfferInput {
                    request: peer.request_id(),
                    authenticated_source: peer.source_authority(),
                    receipt: &receipt,
                    entry: &value.entry_id,
                    offer_id: &value.offer_id,
                    selections: convert(&value.selections)?,
                    consent: consent(&value.consent),
                    policy: factory.current_settings()?.credential_store,
                },
                &backend,
            )?;
            view(read(peer, &value.offer_id)?)?
        }
        "source/private/seal" => {
            let value: Seal = params(peer, value)?;
            let offer: PrivateCredentialOffer = convert(&value.offer)?;
            ensure!(
                offer.context.request_id == peer.request_id(),
                "source_transfer_request_changed"
            );
            seal_private_credentials(
                &source(peer)?,
                peer.target_authority(),
                &offer,
                consent(&value.consent),
            )?;
            view(read(peer, &offer.context.offer_id)?)?
        }
        "target/private/accept" => {
            let value: Accept = params(peer, value)?;
            let original = read(peer, &value.offer_id)?;
            let target = target(peer)?;
            let receipt = receipt(peer, &target)?;
            accept_private_credential_envelope(
                &target,
                peer.source_authority(),
                &receipt,
                &original.offer,
                &convert(&value.envelope)?,
                consent(&value.consent),
                &backend,
            )?;
            view(read(peer, &value.offer_id)?)?
        }
        "source/private/read" | "target/private/read" => {
            let value: Locator = params(peer, value)?;
            view(read(peer, &value.offer_id)?)?
        }
        "source/private/cancel" | "target/private/cancel" => {
            let value: Cancel = params(peer, value)?;
            let controller = controller(peer, &value.offer_id)?;
            let control = controller.cancel(&value.command_id)?;
            json!({"control":control,"writerRunning":controller.writer_running()?})
        }
        "source/private/resume" | "target/private/resume" => {
            let value: Resume = params(peer, value)?;
            let controller = controller(peer, &value.offer_id)?;
            let control = controller.resume(value.expected_sequence, value.cancel_watermark)?;
            json!({"control":control,"writerRunning":controller.writer_running()?})
        }
        "target/private/prepare-status" => {
            let value: kcoder_app_protocol::MigrationSourceCredentialPreparationReadParamsV1 =
                params(peer, value)?;
            let store = MigrationStore::open_existing(peer.profile())?;
            let status = store.received_credential_preparation_status(
                &value.job_id,
                peer.request_id(),
                peer.source_authority(),
                peer.target_authority(),
            )?;
            let mut result = serde_json::to_value(status)?;
            result["requestId"] = json!(peer.request_id());
            let typed: kcoder_app_protocol::MigrationSourceCredentialPreparationResult =
                convert(&result)?;
            serde_json::to_value(typed)?
        }
        "target/private/prepare" => {
            let value: Prepare = params(peer, value)?;
            let mut offer_ids = vec![value.offer_id.clone()];
            if let Some(additional) = &value.additional_offers {
                ensure!(
                    !additional.contains(&value.offer_id),
                    "private_credentials_duplicate_selection"
                );
                offer_ids.extend(additional.iter().cloned());
            }
            offer_ids.sort();
            let received = offer_ids
                .iter()
                .map(|id| {
                    read(peer, id)?
                        .received
                        .context("private_credentials_receive_unconfirmed")
                })
                .collect::<Result<Vec<_>>>()?;
            let store = MigrationStore::open_existing(peer.profile())?;
            let job = store.read(&value.job_id)?;
            ensure!(
                job.project_target().is_none(),
                "private_credentials_project_scope_unsupported"
            );
            // Preserve the normal Host override checks before entering its existing writers.
            factory.migration_user_settings_path()?;
            factory.migration_mcp_settings_path()?;
            let provider = kcoder_migration::providers::ProviderTarget::open(peer.profile())?;
            let mcp = kcoder_migration::mcp::McpTarget::open(peer.profile())?;
            let assets = kcoder_migration::assets::AssetTarget::open(peer.profile())?;
            let credential_target =
                kcoder_migration::credentials::CredentialTarget::open(peer.profile())?;
            let targets = kcoder_migration::store::BatchTargets {
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                history: None,
                credentials: Some(kcoder_migration::store::CredentialTargets {
                    target: &credential_target,
                    backend: &backend,
                    policy: factory.current_settings()?.credential_store,
                }),
            };
            let job = store.prepare_received_batch_credentials_bundle(
                &value.job_id,
                value.expected_sequence,
                &received,
                consent(&value.consent),
                &targets,
            )?;
            let mut result = json!({"job":super::super::read_result(&job)});
            if value.additional_offers.is_some() {
                let actual = job.received_private_credential_offer_ids()?;
                ensure!(
                    actual == offer_ids,
                    "private_credentials_publication_binding_changed"
                );
                result["offerIds"] = json!(actual);
            }
            result
        }
        "target/private/release" => {
            let value: Release = params(peer, value)?;
            let original = read(peer, &value.offer_id)?;
            if let Some(job_id) = value.job_id {
                let received = original
                    .received
                    .context("private_credentials_receive_unconfirmed")?;
                let store = MigrationStore::open_existing(peer.profile())?;
                let target = kcoder_migration::credentials::CredentialTarget::open(peer.profile())?;
                store.release_received_batch_key(&job_id, &received, &target, &backend)?;
            } else {
                if let Some(received) = original.received {
                    received.release_unpublished_key(peer.profile(), &backend)?;
                } else {
                    let target = target(peer)?;
                    let receipt = receipt(peer, &target)?;
                    release_private_credential_offer_key(
                        &target,
                        peer.source_authority(),
                        &receipt,
                        &original.offer,
                        &backend,
                    )?;
                }
            }
            view(read(peer, &value.offer_id)?)?
        }
        _ => anyhow::bail!("source_transfer_method_unavailable"),
    };
    peer.validate()?;
    Ok(result)
}
