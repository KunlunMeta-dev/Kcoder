//! Two owned profiles transfer static data; ordinary target batches keep local scope authority.
use super::*;
use crate::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    batch::{BatchResolution, BatchSource},
    instruction_sources::{
        InstructionDestination, InstructionSourceGrant, InstructionSourcePolicy,
        InstructionSourceSnapshot, ScopedInstructionDestination,
    },
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchCaptureInput, BatchCreateIntent, BatchTargets, MigrationStore},
};
use kcoder_config::imported_context::{ImportedContextScope, ImportedContextStore};
use std::sync::Arc;
pub(super) fn capture(f: &Fixture, kind: Kind) -> Arc<InstructionSourceSnapshot> {
    std::fs::create_dir_all(f.files.join(".git")).unwrap();
    std::fs::create_dir_all(f.files.join("child")).unwrap();
    match kind {
        Kind::ClaudeCode => {
            std::fs::write(
                f.files.join("CLAUDE.md"),
                "<!-- HUMAN_ONLY_NOTE -->\nUse @rules.md\n",
            )
            .unwrap();
            std::fs::write(
                f.files.join("rules.md"),
                "ROOT_IMPORTED_RULE Do not execute source commands.\n",
            )
            .unwrap();
            std::fs::write(
                f.files.join("child/CLAUDE.md"),
                "CHILD_RULE Scope to the selected child.\n",
            )
            .unwrap();
        }
        Kind::Codex => {
            std::fs::write(f.files.join("AGENTS.md"),"---\nname: ordinary-markdown\n---\nROOT_IMPORTED_RULE Keep @literal as Markdown.\n").unwrap();
            std::fs::write(
                f.files.join("child/AGENTS.md"),
                "CHILD_RULE Scope to the selected child.\n",
            )
            .unwrap();
        }
    }
    trust(&f.source_profile, &f.files, true);
    Arc::new(
        InstructionSourceGrant::capture(&f.source_profile, &f.files, &f.files, kind)
            .unwrap()
            .capture_static_sources(
                &InstructionSourcePolicy {
                    include_descendants: true,
                    ..Default::default()
                },
                true,
                |_| true,
            )
            .unwrap(),
    )
}
pub(super) fn trust(profile: &Path, root: &Path, yes: bool) {
    std::fs::write(
        profile.join("trusted-folders.json"),
        serde_json::json!({"trusted":if yes {vec![root]} else {vec![]},"never":[]}).to_string(),
    )
    .unwrap();
}
pub(super) fn target(f: &Fixture) -> PathBuf {
    let workspace = f._root.path().join("actual-target-workspace");
    std::fs::create_dir_all(workspace.join("mapped")).unwrap();
    std::fs::write(f.target_profile.join("settings.json"), "{}").unwrap();
    trust(&f.target_profile, &workspace, true);
    workspace
}
pub(super) fn transfer(
    f: &Fixture,
    local: Arc<InstructionSourceSnapshot>,
) -> (
    TransferManifest,
    TransferReceipt,
    Arc<InstructionSourceSnapshot>,
) {
    let manifest = f.export(ExportSelection::Instructions(
        InstructionExportSelection::capture(local).unwrap(),
    ));
    assert_eq!(manifest.entries.len(), 1);
    assert!(
        matches!(&manifest.entries[0].content,TransferContent::InstructionBundle{parser_revision,..} if parser_revision=="scoped-instructions/v2")
    );
    let receipt = f.copy(&manifest);
    let received = f
        .target
        .received_instruction_snapshot(
            &f.request,
            &receipt.manifest_sha256,
            &manifest.entries[0].id,
            |_| true,
        )
        .unwrap();
    (manifest, receipt, received)
}
fn mapped(
    f: &Fixture,
    workspace: &Path,
    snapshot: Arc<InstructionSourceSnapshot>,
) -> AssetBundleBinding {
    let mapping = snapshot
        .summaries()
        .into_iter()
        .map(|row| {
            (
                row.id,
                if row.relative_scope.is_empty() {
                    String::new()
                } else {
                    "mapped".into()
                },
            )
        })
        .collect::<Vec<_>>();
    AssetBundleBinding::capture_scoped_instructions(
        &f.target_profile,
        workspace,
        snapshot,
        &mapping,
        false,
    )
    .unwrap()
}
fn scan(f: &Fixture, binding: AssetBundleBinding) -> crate::store::MigrationJob {
    let store = MigrationStore::open_or_create(&f.target_profile).unwrap();
    let intent=BatchCreateIntent::new(&uuid::Uuid::new_v4().to_string(),&serde_json::json!({"source":"received-owned-graph","requestId":f.request,"mapping":[".","mapped"]})).unwrap();
    store
        .create_batch_scan_idempotent(
            &intent,
            |_| {
                Ok(BatchCaptureInput {
                    sources: vec![BatchSource::Assets(binding)],
                    resource_limits: Default::default(),
                    project: None,
                })
            },
            &mut |_, _| true,
        )
        .unwrap()
        .job
        .unwrap()
}

#[test]
fn both_source_graphs_cross_profiles_then_original_batch_scope_preview_and_undo_survive_source_gone()
 {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new();
        let workspace = target(&f);
        let local = capture(&f, kind);
        let original = local
            .summaries()
            .into_iter()
            .map(|row| {
                (
                    row.relative_path,
                    local.original_bytes(&row.id).unwrap().to_vec(),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let (manifest, receipt, _received) = transfer(&f, local);
        let chunk = f
            .source
            .chunk(
                &f.request,
                &f.destination,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                0,
            )
            .unwrap();
        let graph: serde_json::Value = serde_json::from_slice(&chunk.bytes).unwrap();
        for forbidden in [
            f.source_profile.to_str().unwrap(),
            f.files.to_str().unwrap(),
            "rootIdentity",
            "fileIdentity",
            "profileIdentity",
            "targetRoot",
        ] {
            assert!(
                !graph.to_string().contains(forbidden),
                "transport must not carry physical or destination authority"
            );
        }
        let page = f
            .target
            .received_sources(&f.request, &receipt.manifest_sha256, 0)
            .unwrap();
        assert_eq!(page.items[0].class, ReceivedSourceClass::Instructions);
        assert!(page.items[0].project_scoped);
        std::fs::rename(&f.files, f._root.path().join("source-withheld")).unwrap();
        std::fs::rename(
            &f.source_profile,
            f._root.path().join("source-profile-withheld"),
        )
        .unwrap();
        let reopened = IncomingTransfers::open_existing(&f.target_profile).unwrap();
        let received = reopened
            .received_instruction_snapshot(
                &f.request,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                |_| true,
            )
            .unwrap();
        assert!(received.is_received_instruction());
        let saved = scan(&f, mapped(&f, &workspace, received.clone()));
        let store = MigrationStore::open_existing(&f.target_profile).unwrap();
        let provider = ProviderTarget::open(&f.target_profile).unwrap();
        let mcp = McpTarget::open(&f.target_profile).unwrap();
        let assets = AssetTarget::open(&f.target_profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
            history: None,
        };
        let choices = saved
            .inventory
            .items
            .iter()
            .map(|item| {
                BatchResolution::Asset(AssetResolution {
                    agent_adaptation: None,
                    item_id: item.preview.id.clone(),
                    target_name: "Received scoped guide".into(),
                    enable_after_import: false,
                    memory_scope: None,
                })
            })
            .collect::<Vec<_>>();
        let planned = store
            .prepare_batch(&saved.job_id, saved.sequence, &choices, &targets)
            .unwrap();
        let plan = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
        let applied = store
            .run_batch(
                &planned.job_id,
                plan,
                "received-instructions-apply",
                planned.sequence,
                false,
                &targets,
            )
            .unwrap();
        assert_eq!(
            applied.status,
            kcoder_types::migration::MigrationJobStatus::Completed
        );
        let records = ImportedContextStore::open(&f.target_profile)
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|row| !row.enabled));
        for record in &records {
            let origin = record.instruction_provenance.as_ref().unwrap();
            assert!(origin.source_file_identity.is_none());
            assert_eq!(origin.source, kind);
            assert_eq!(
                origin.source_sha256,
                format!(
                    "{:x}",
                    sha2::Sha256::digest(&original[&origin.source_relative_path])
                )
            );
            assert!(
                record.content.contains("ROOT_IMPORTED_RULE")
                    || record.content.contains("CHILD_RULE")
            );
            assert!(!record.content.contains("HUMAN_ONLY_NOTE"));
            assert!(
                matches!(&record.scope,ImportedContextScope::Project{root} if root==&workspace || root==&workspace.join("mapped"))
            );
        }
        assert_eq!(
            records[0]
                .instruction_provenance
                .as_ref()
                .unwrap()
                .cohort_id,
            records[1]
                .instruction_provenance
                .as_ref()
                .unwrap()
                .cohort_id
        );
        for item in &applied.inventory.items {
            let raw = store
                .instruction_source_snapshot(&applied.job_id, &item.preview.id)
                .unwrap()
                .unwrap();
            let compiled = store
                .instruction_compiled_snapshot(&applied.job_id, &item.preview.id)
                .unwrap()
                .unwrap();
            assert!(original.values().any(|bytes| bytes == &raw));
            assert!(records.iter().any(|row| row.content == compiled));
        }
        // The normal job owns its immutable recipe and Undo after receiving bytes are unavailable.
        let incoming = f.target_profile.join("migrations/source-transfer/incoming");
        std::fs::rename(&incoming, f._root.path().join("incoming-withheld")).unwrap();
        for item in &applied.inventory.items {
            store
                .instruction_compiled_snapshot(&applied.job_id, &item.preview.id)
                .unwrap()
                .unwrap();
        }
        let undone = store
            .run_batch(
                &applied.job_id,
                plan,
                "received-instructions-undo",
                applied.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(
            undone.status,
            kcoder_types::migration::MigrationJobStatus::RolledBack
        );
        assert!(
            ImportedContextStore::open(&f.target_profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read_to_string(f.target_profile.join("settings.json")).unwrap(),
            "{}"
        );
        assert!(!f.target_profile.join("skills").exists());
    }
}

#[test]
fn strict_received_and_physical_roots_never_decode_each_others_authority_fields() {
    let f = Fixture::new();
    target(&f);
    let local = capture(&f, Kind::ClaudeCode);
    let physical = serde_json::to_value(&local).unwrap();
    assert!(physical["root"].get("authorityKind").is_none());
    assert_eq!(
        serde_json::to_vec(&local).unwrap(),
        serde_json::to_vec(
            &serde_json::from_value::<InstructionSourceSnapshot>(physical.clone()).unwrap()
        )
        .unwrap()
    );
    let (_, _, received) = transfer(&f, local);
    let value = serde_json::to_value(&received).unwrap();
    assert!(
        (*received)
            .clone()
            .for_creation(&uuid::Uuid::new_v4().to_string())
            .is_err()
    );
    assert_eq!(value["root"]["authorityKind"], "received_instruction_graph");
    for mut hybrid in [physical.clone(), value.clone()] {
        if hybrid["root"].get("authorityKind").is_none() {
            hybrid["root"]["authorityKind"] = serde_json::json!("received_instruction_graph");
        } else {
            hybrid["root"]["root"] = serde_json::json!("/foreign/root");
        }
        assert!(serde_json::from_value::<InstructionSourceSnapshot>(hybrid).is_err());
    }
    let mut unknown = value.clone();
    unknown["root"]["authorityKind"] = serde_json::json!("physical");
    assert!(serde_json::from_value::<InstructionSourceSnapshot>(unknown).is_err());
    let mut forged = value;
    forged["observations"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .for_each(|v| v["identity"] = serde_json::Value::Null);
    forged["root"]["binding"]["parserRevision"] = serde_json::json!("scoped-instructions/v1");
    let forged: InstructionSourceSnapshot = serde_json::from_value(forged).unwrap();
    assert!(forged.original_bytes(&forged.summaries()[0].id).is_err());
}

#[test]
fn received_graph_rejects_wrong_receipt_account_parser_and_payload_without_repair() {
    let f = Fixture::new();
    let local = capture(&f, Kind::Codex);
    let (manifest, receipt, snapshot) = transfer(&f, local);
    let entry = &manifest.entries[0];
    assert!(
        f.target
            .received_instruction_snapshot(&f.request, &"0".repeat(64), &entry.id, |_| true)
            .is_err()
    );
    let peer = IncomingTransfers::open(&f._root.path().join("peer-profile")).unwrap();
    assert!(
        peer.received_instruction_snapshot(&f.request, &receipt.manifest_sha256, &entry.id, |_| {
            true
        })
        .is_err()
    );
    let mut unsupported = manifest.clone();
    unsupported.entries[0].content = TransferContent::InstructionBundle {
        source: Kind::Codex,
        parser_revision: "scoped-instructions/v99".into(),
    };
    assert!(unsupported.validate().is_err());
    let path = f
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(&f.request)
        .join(super::super::source::payload_name(entry));
    let mut bytes = std::fs::read(&path).unwrap();
    let at = bytes.iter().position(|b| *b == b'R').unwrap();
    bytes[at] = b'X';
    std::fs::write(&path, bytes).unwrap();
    assert!(snapshot.verify_source(|_| true).is_err());
    assert!(
        f.target
            .received_instruction_snapshot(&f.request, &receipt.manifest_sha256, &entry.id, |_| {
                true
            })
            .is_err()
    );
    assert!(!f.target_profile.join("imported-context.json").exists());
}

#[test]
fn graph_capture_and_target_authority_stay_cancellable_and_reject_replaced_mapping() {
    let f = Fixture::new();
    let workspace = target(&f);
    let local = capture(&f, Kind::ClaudeCode);
    assert!(InstructionExportSelection::capture_checked(local.clone(), |_| false).is_err());
    let (_, _, received) = transfer(&f, local);
    let peer = f._root.path().join("peer-profile");
    PrivateDirectory::open_or_create(&peer).unwrap();
    trust(&peer, &workspace, true);
    let error = AssetBundleBinding::capture_scoped_instructions(
        &peer,
        &workspace,
        received.clone(),
        &[(received.summaries()[0].id.clone(), String::new())],
        false,
    )
    .expect_err("a receiving receipt belongs to its original target profile");
    assert_eq!(error.to_string(), "source_transfer_wrong_consumer");
    let destination = InstructionDestination::capture(&f.target_profile, &workspace).unwrap();
    let chosen = ScopedInstructionDestination::capture(&destination, "mapped").unwrap();
    let id = received.summaries()[0].id.clone();
    std::fs::rename(workspace.join("mapped"), workspace.join("original-mapped")).unwrap();
    std::fs::create_dir(workspace.join("mapped")).unwrap();
    assert!(
        AssetBundleBinding::capture_mapped_instructions(
            &f.target_profile,
            &workspace,
            received.clone(),
            &[(id.clone(), chosen)],
            false
        )
        .is_err()
    );
    trust(&f.target_profile, &workspace, false);
    assert!(
        AssetBundleBinding::capture_scoped_instructions(
            &f.target_profile,
            &workspace,
            received,
            &[(id, String::new())],
            false
        )
        .is_err()
    );
    assert!(
        ImportedContextStore::open(&f.target_profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn export_rechecks_source_trust_then_same_original_request_recovers_after_explicit_restore() {
    let f = Fixture::new();
    let local = capture(&f, Kind::ClaudeCode);
    let selection = InstructionExportSelection::capture(local).unwrap();
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![ExportSelection::Instructions(selection.clone())],
        )
        .unwrap();
    trust(&f.source_profile, &f.files, false);
    assert!(
        f.source
            .capture(&f.request, &f.destination, |_| true)
            .is_err()
    );
    assert!(
        f.source
            .manifest(&f.request, &f.destination)
            .unwrap()
            .is_none()
    );
    trust(&f.source_profile, &f.files, true);
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![ExportSelection::Instructions(selection)],
        )
        .unwrap();
    let manifest = f
        .source
        .capture(&f.request, &f.destination, |_| true)
        .unwrap();
    let receipt = f.copy(&manifest);
    assert!(
        f.target
            .received_instruction_snapshot(
                &f.request,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                |_| false
            )
            .is_err()
    );
    assert!(
        f.target
            .received_instruction_snapshot(
                &f.request,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                |_| true
            )
            .is_ok()
    );
}

#[test]
fn partial_origin_requires_explicit_same_request_restore_and_published_export_reopens_without_source()
 {
    let f = Fixture::new();
    let local = capture(&f, Kind::Codex);
    let selection = InstructionExportSelection::capture(local).unwrap();
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![ExportSelection::Instructions(selection.clone())],
        )
        .unwrap();
    let origin = f
        .source_profile
        .join("migrations/source-transfer/exports")
        .join(&f.request)
        .join("instructions-origin-0000.json");
    let original = std::fs::read(&origin).unwrap();
    std::fs::remove_file(&origin).unwrap();
    assert!(!f.source.state(&f.request, &f.destination).unwrap().ready);
    assert!(!origin.exists());
    assert!(
        f.source
            .capture(&f.request, &f.destination, |_| true)
            .is_err()
    );
    assert!(!origin.exists());
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![ExportSelection::Instructions(selection.clone())],
        )
        .unwrap();
    assert_eq!(std::fs::read(&origin).unwrap(), original);
    let cancelled = f
        .source
        .cancel(
            &f.request,
            &f.destination,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(cancelled.cancelled);
    assert!(
        f.source
            .capture(&f.request, &f.destination, |_| true)
            .is_err()
    );
    f.source
        .resume(
            &f.request,
            &f.destination,
            cancelled.sequence,
            cancelled.cancel_watermark,
        )
        .unwrap();
    let manifest = f
        .source
        .capture(&f.request, &f.destination, |_| true)
        .unwrap();
    std::fs::rename(&f.files, f._root.path().join("source-gone")).unwrap();
    std::fs::remove_file(&origin).unwrap();
    let reopened = SourceTransfers::open_existing(&f.source_profile).unwrap();
    assert!(
        reopened
            .prepare(
                &f.request,
                &f.destination,
                vec![ExportSelection::Instructions(selection)]
            )
            .unwrap()
            .ready
    );
    assert!(
        reopened
            .capture(&f.request, &f.destination, |_| true)
            .unwrap()
            == manifest
    );
    assert!(
        !origin.exists(),
        "sealed manifest recovery must not read or reconstruct source authority"
    );
    let receipt = f.copy(&manifest);
    assert!(
        f.target
            .received_instruction_snapshot(
                &f.request,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                |_| true
            )
            .is_ok()
    );
}
