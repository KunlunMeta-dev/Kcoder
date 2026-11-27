//! Trusted-parent execution only. Public selectors never deserialize Native grants.
use super::MigrationProcessor;
use crate::migration_source_authority::AuthorizedMigrationPeer;
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use kcoder_migration::source_transfer::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
pub(super) mod adoption;
mod attempts;
pub(super) mod private_credentials;
mod worker;
pub(super) use adoption::AdoptionWorkers;
pub(super) use attempts::AttemptOwners;
pub(super) use worker::SourceTransferWorkers;
#[cfg(test)]
mod tests;

fn params<T: DeserializeOwned>(peer: &AuthorizedMigrationPeer, mut value: Value) -> Result<T> {
    peer.validate()?;
    let object = value
        .as_object_mut()
        .context("source_transfer_invalid_request")?;
    ensure!(
        object
            .remove("requestId")
            .and_then(|v| v.as_str().map(str::to_owned))
            .as_deref()
            == Some(peer.request_id()),
        "source_transfer_request_changed"
    );
    let peer_ref = object
        .remove("peerRef")
        .context("source_transfer_invalid_request")?;
    ensure!(
        peer_ref
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 256),
        "source_transfer_invalid_request"
    );
    serde_json::from_value(value).map_err(|_| anyhow::anyhow!("source_transfer_invalid_request"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    destination: TransferDestination,
    selections: Vec<TransferSelector>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin {
    manifest: TransferManifest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartRead {
    entry_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChunkRead {
    entry_id: String,
    index: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartWrite {
    manifest_sha256: String,
    entry_id: String,
    index: u32,
    sha256: String,
    data_base64: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cancel {
    command_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resume {
    expected_sequence: u64,
    expected_cancel_watermark: u64,
    expected_snapshot_control: Option<TransferState>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetResume {
    expected_admission_control: TransferState,
    expected_operation_control: Option<TransferState>,
}

fn source(peer: &AuthorizedMigrationPeer) -> Result<SourceTransfers> {
    ensure!(peer.role() == "source", "source_transfer_role_mismatch");
    let source = SourceTransfers::open(peer.profile())?;
    ensure!(
        source.authority() == peer.source_authority(),
        "source_transfer_authority_changed"
    );
    Ok(source)
}
fn target(peer: &AuthorizedMigrationPeer) -> Result<IncomingTransfers> {
    ensure!(peer.role() == "target", "source_transfer_role_mismatch");
    let target = if peer.recovery_only() {
        IncomingTransfers::open_existing(peer.profile())?
    } else {
        IncomingTransfers::open(peer.profile())?
    };
    ensure!(
        target.authority() == peer.target_authority(),
        "source_transfer_authority_changed"
    );
    Ok(target)
}
fn intent(peer: &AuthorizedMigrationPeer) -> Result<SourceTransferIntents> {
    let journal = SourceTransferIntents::open(peer.profile())?;
    if journal.exists(peer.request_id())? {
        journal.destination(peer.request_id(), peer.target_authority())?;
    }
    Ok(journal)
}
fn snapshot(
    peer: &AuthorizedMigrationPeer,
    source: &SourceTransfers,
) -> Result<Option<TransferState>> {
    let Some(destination) =
        source.prepared_destination(peer.request_id(), peer.target_authority())?
    else {
        return Ok(None);
    };
    source.state(peer.request_id(), &destination).map(Some)
}
fn source_view(peer: &AuthorizedMigrationPeer) -> Result<Value> {
    peer.validate()?;
    let native = source(peer)?;
    let journal = intent(peer)?;
    let mut snapshot = snapshot(peer, &native)?;
    if !journal.exists(peer.request_id())? {
        ensure!(snapshot.is_none(), "source_transfer_recovery_required");
        return Ok(
            json!({"state":null,"selectionDigest":null,"snapshotControl":null,
            "capture":{"status":"idle","errorCode":null}}),
        );
    }
    let mut ready = snapshot.as_ref().is_some_and(|s| s.ready);
    let mut state = journal.state(peer.request_id(), ready)?;
    let (_, selection_digest) = journal.selectors(peer.request_id())?;
    let capture = journal.observe(peer.request_id(), ready)?;
    if !ready && capture.status == "ready" {
        // A short worker can finish between snapshot and capture observation.
        // Re-read its committed snapshot rather than combining different phases.
        snapshot = self::snapshot(peer, &native)?;
        ready = snapshot.as_ref().is_some_and(|s| s.ready);
        state = journal.state(peer.request_id(), ready)?;
    }
    peer.validate()?;
    Ok(
        json!({"state":state,"selectionDigest":selection_digest,"snapshotControl":snapshot,"capture":capture}),
    )
}
fn target_view(peer: &AuthorizedMigrationPeer) -> Result<Value> {
    peer.validate()?;
    let target = target(peer)?;
    let state = target.state_if_exists(peer.request_id(), peer.source_authority())?;
    let running =
        state.is_some() && target.writer_busy(peer.request_id(), peer.source_authority())?;
    peer.validate()?;
    Ok(json!({"state":state,"workerRunning":running}))
}

fn resolve(
    processor: &MigrationProcessor,
    profile: &std::path::Path,
    selectors: &[TransferSelector],
) -> Result<Vec<ResolvedTransferSelection>> {
    enum Selected {
        Project(kcoder_migration::project_migration::ProjectBatchSource),
        Instructions(
            std::sync::Arc<kcoder_migration::instruction_sources::InstructionSourceSnapshot>,
        ),
        Configuration(kcoder_migration::discovery::ConfigurationBinding),
        Assets(kcoder_migration::asset_sources::AssetBundleBinding),
        History(Box<kcoder_migration::history_discovery::HistorySelectionGrant>),
        Plugin(kcoder_migration::plugin_migration::PluginExportSelection),
    }
    let selected = {
        let guard = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        let registry = || {
            guard
                .as_ref()
                .context("source_transfer_selection_unavailable")
        };
        selectors
            .iter()
            .map(|selector| match selector {
                TransferSelector::Projects {
                    catalog_id,
                    source_handle,
                } => registry()?
                    .selected_project(
                        catalog_id,
                        source_handle,
                        &super::projects::cancelled(processor)?,
                    )
                    .map(Selected::Project),
                TransferSelector::Instructions { capture_id } => processor
                    .instructions
                    .lock()
                    .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?
                    .read(profile, capture_id)
                    .map(|capture| Selected::Instructions(capture.snapshot)),
                TransferSelector::Configuration { source_id } => {
                    registry()?.selected(source_id).map(Selected::Configuration)
                }
                TransferSelector::Assets { source_id } => {
                    registry()?.selected_asset(source_id).map(Selected::Assets)
                }
                TransferSelector::Plugin { candidate_id } => registry()?
                    .selected_plugin(candidate_id)?
                    .export_selection()
                    .map(Selected::Plugin),
                TransferSelector::History {
                    catalog_id,
                    source_handle,
                } => registry()?
                    .history_selection(catalog_id, source_handle)
                    .map(|grant| Selected::History(Box::new(grant))),
            })
            .collect::<Result<Vec<_>>>()?
    };
    let mut resolved = Vec::new();
    for selection in selected {
        match selection {
            Selected::Project(binding) => {
                resolved.push(ResolvedTransferSelection::Project { binding })
            }
            Selected::Instructions(snapshot) => {
                let selection =
                    kcoder_migration::source_transfer::InstructionExportSelection::capture(
                        snapshot,
                    )?;
                resolved.push(ResolvedTransferSelection::Instructions {
                    binding: selection.persisted_binding(),
                });
            }
            Selected::Configuration(binding) => {
                binding.verify_codex_layer_authority(profile)?;
                resolved.push(ResolvedTransferSelection::Configuration { binding })
            }
            Selected::Assets(binding) => {
                let (binding, _) = binding.freeze()?;
                for key in binding.entries()? {
                    resolved.push(ResolvedTransferSelection::Asset {
                        binding: binding.clone(),
                        key,
                    });
                }
            }
            Selected::History(grant) => resolved.push(ResolvedTransferSelection::History {
                selection: grant.pin()?,
            }),
            Selected::Plugin(selection) => {
                resolved.push(ResolvedTransferSelection::Plugin { selection })
            }
        }
        ensure!(resolved.len() <= 64, "source_transfer_budget_exceeded");
    }
    Ok(resolved)
}

fn mirror(
    peer: &AuthorizedMigrationPeer,
    journal: &SourceTransferIntents,
    native: &SourceTransfers,
    command: &str,
) -> Result<()> {
    journal.mirror_cancellation(peer.request_id(), command, || {
        let Some(destination) =
            native.prepared_destination(peer.request_id(), peer.target_authority())?
        else {
            return Ok(None);
        };
        native.cancel(peer.request_id(), &destination, command)?;
        native.cancellation_watermark(peer.request_id(), &destination, command)
    })
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    peer: &AuthorizedMigrationPeer,
    operation: &str,
    value: Value,
) -> Result<Value> {
    peer.validate()?;
    ensure!(peer.permits(operation), "source_transfer_recovery_scope");
    if operation.starts_with("target/attempt/") {
        let result = attempts::execute(processor, peer, operation, value)?;
        peer.validate()?;
        return Ok(result);
    }
    if operation.starts_with("target/") {
        processor.source_attempt_owners.require(peer, operation)?;
    }
    ensure!(
        (operation.starts_with("source/") && peer.role() == "source")
            || (operation.starts_with("target/") && peer.role() == "target"),
        "source_transfer_role_mismatch"
    );
    match operation {
        "source/state" => {
            let _: Empty = params(peer, value)?;
            source_view(peer)
        }
        "source/intent" => {
            let _: Empty = params(peer, value)?;
            let journal = intent(peer)?;
            if !journal.exists(peer.request_id())? {
                return Ok(json!({"intent":null}));
            }
            let (selections, selection_digest) = journal.selectors(peer.request_id())?;
            Ok(json!({"intent":{"selections":selections,"selectionDigest":selection_digest}}))
        }
        "source/prepare" => {
            let params: Prepare = params(peer, value)?;
            ensure!(
                &params.destination.authority == peer.target_authority(),
                "source_transfer_authority_changed"
            );
            let native = source(peer)?;
            let journal = intent(peer)?;
            let selectors = params.selections.clone();
            journal.prepare(peer.request_id(), &params.destination, selectors, || {
                resolve(processor, peer.profile(), &params.selections)
            })?;
            journal.prepare_snapshot(peer.request_id(), |bindings| {
                peer.validate()?;
                native.prepare(
                    peer.request_id(),
                    &params.destination,
                    bindings
                        .iter()
                        .map(ResolvedTransferSelection::export)
                        .collect(),
                )
            })?;
            for command in journal.active_cancel_commands(peer.request_id())? {
                mirror(peer, &journal, &native, &command)?;
            }
            source_view(peer)
        }
        "source/capture" => {
            let _: Empty = params(peer, value)?;
            processor.source_transfer_workers.start(peer.clone())?;
            source_view(peer)
        }
        "source/cancel" => {
            let params: Cancel = params(peer, value)?;
            let native = source(peer)?;
            let journal = intent(peer)?;
            journal.cancel(peer.request_id(), &params.command_id)?;
            mirror(peer, &journal, &native, &params.command_id)?;
            source_view(peer)
        }
        "source/resume" => {
            let params: Resume = params(peer, value)?;
            let native = source(peer)?;
            let journal = intent(peer)?;
            journal.resume(
                peer.request_id(),
                params.expected_sequence,
                params.expected_cancel_watermark,
                || {
                    peer.validate()?;
                    let current = snapshot(peer, &native)?;
                    match (&params.expected_snapshot_control, current) {
                        (None, None) => Ok(()),
                        (Some(expected), Some(_)) => {
                            let destination =
                                journal.destination(peer.request_id(), peer.target_authority())?;
                            native
                                .resume(
                                    peer.request_id(),
                                    &destination,
                                    expected.sequence,
                                    expected.cancel_watermark,
                                )
                                .map(drop)
                        }
                        _ => anyhow::bail!("source_transfer_snapshot_control_changed"),
                    }
                },
            )?;
            source_view(peer)
        }
        "source/manifest" => {
            let _: Empty = params(peer, value)?;
            let native = source(peer)?;
            let journal = intent(peer)?;
            journal.active(peer.request_id())?;
            let destination = journal.destination(peer.request_id(), peer.target_authority())?;
            let manifest = native
                .manifest(peer.request_id(), &destination)?
                .context("source_transfer_not_ready")?;
            Ok(json!({"manifestSha256":manifest.digest()?,"manifest":manifest}))
        }
        "source/chunk" => {
            let params: ChunkRead = params(peer, value)?;
            let native = source(peer)?;
            let journal = intent(peer)?;
            journal.active(peer.request_id())?;
            let destination = journal.destination(peer.request_id(), peer.target_authority())?;
            let manifest = native
                .manifest(peer.request_id(), &destination)?
                .context("source_transfer_not_ready")?;
            let chunk = native.chunk(
                peer.request_id(),
                &destination,
                &manifest.digest()?,
                &params.entry_id,
                params.index,
            )?;
            peer.validate()?;
            Ok(
                json!({"requestId":chunk.request_id,"manifestSha256":chunk.manifest_sha256,"entryId":chunk.entry_id,
                "index":chunk.index,"sha256":chunk.sha256,"dataBase64":STANDARD.encode(chunk.bytes())}),
            )
        }
        "target/state" => {
            let _: Empty = params(peer, value)?;
            target_view(peer)
        }
        "target/summary" => {
            let _: Empty = params(peer, value)?;
            let summary =
                target(peer)?.target_summary(peer.request_id(), peer.source_authority())?;
            peer.validate()?;
            Ok(serde_json::to_value(summary)?)
        }
        "target/grant" => {
            let _: Empty = params(peer, value)?;
            Ok(serde_json::to_value(target(peer)?.issue_destination(
                peer.request_id(),
                peer.source_authority(),
            )?)?)
        }
        "target/begin" => {
            let params: Begin = params(peer, value)?;
            ensure!(
                params.manifest.request_id == peer.request_id(),
                "source_transfer_request_changed"
            );
            target(peer)?.begin(&params.manifest, peer.source_authority())?;
            target_view(peer)
        }
        "target/part/read" => {
            let params: PartRead = params(peer, value)?;
            Ok(
                json!({"receipt":target(peer)?.part_receipt(peer.request_id(), peer.source_authority(), &params.entry_id)?}),
            )
        }
        "target/part/write" => {
            let params: PartWrite = params(peer, value)?;
            ensure!(
                params.data_base64.len() <= 4 * TRANSFER_CHUNK_BYTES.div_ceil(3),
                "source_transfer_budget_exceeded"
            );
            let bytes = STANDARD
                .decode(&params.data_base64)
                .map_err(|_| anyhow::anyhow!("source_transfer_invalid_chunk"))?;
            let chunk = TransferChunk::received(
                peer.request_id().into(),
                params.manifest_sha256,
                params.entry_id,
                params.index,
                params.sha256,
                bytes,
            )?;
            Ok(json!({"receipt":target(peer)?.write_part(peer.source_authority(), &chunk)?}))
        }
        "target/finish" => {
            let _: Empty = params(peer, value)?;
            let receipt =
                target(peer)?.finish(peer.request_id(), peer.source_authority(), |_| {
                    peer.validate().is_ok()
                })?;
            peer.validate()?;
            Ok(json!({"receipt":receipt}))
        }
        "target/receipt" => {
            let _: Empty = params(peer, value)?;
            Ok(
                json!({"receipt":target(peer)?.receipt(peer.request_id(), peer.source_authority())?}),
            )
        }
        "target/cancel" => {
            let params: Cancel = params(peer, value)?;
            target(peer)?.cancel(
                peer.request_id(),
                peer.source_authority(),
                &params.command_id,
            )?;
            target_view(peer)
        }
        "target/resume" => {
            ensure!(
                value.get("expectedOperationControl").is_some(),
                "source_transfer_invalid_request"
            );
            let params: TargetResume = params(peer, value)?;
            target(peer)?.resume_target(
                peer.request_id(),
                peer.source_authority(),
                &params.expected_admission_control,
                params.expected_operation_control.as_ref(),
            )?;
            target_view(peer)
        }
        _ => anyhow::bail!("source_transfer_method_unavailable"),
    }
}
