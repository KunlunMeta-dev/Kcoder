//! Host intents persist original source proof without source bodies or registry lifetime.
use super::instructions::{capture, transfer};
use super::*;
use crate::source_transfer::source::InstructionExportBinding;

#[test]
fn thin_binding_reopens_exact_sources_then_ready_uses_original_artifact_after_source_gone() {
    let f = Fixture::new();
    let snapshot = capture(&f, Kind::ClaudeCode);
    let original = snapshot
        .original_bytes(&snapshot.summaries()[0].id)
        .unwrap();
    let selection = InstructionExportSelection::capture(snapshot).unwrap();
    let value = serde_json::to_value(selection.persisted_binding()).unwrap();
    assert!(value["seed"].get("sources").is_none());
    assert!(!value.to_string().contains(&base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &*original
    )));
    let reopened: InstructionExportBinding = serde_json::from_value(value.clone()).unwrap();
    let manifest = f.export(ExportSelection::Instructions(reopened.export()));
    let receipt = f.copy(&manifest);
    std::fs::rename(&f.files, f._root.path().join("original-source-offline")).unwrap();
    let native = SourceTransfers::open_existing(&f.source_profile).unwrap();
    let reopened: InstructionExportBinding = serde_json::from_value(value).unwrap();
    assert!(
        native
            .prepare(
                &f.request,
                &f.destination,
                vec![ExportSelection::Instructions(reopened.export())]
            )
            .unwrap()
            .ready
    );
    assert!(
        native
            .capture(&f.request, &f.destination, |_| true)
            .unwrap()
            == manifest
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
fn thin_binding_never_refreshes_changed_bytes_missing_dependencies_or_revoked_trust() {
    for change in [0, 1, 2] {
        let f = Fixture::new();
        let snapshot = capture(&f, Kind::ClaudeCode);
        let binding = InstructionExportSelection::capture(snapshot)
            .unwrap()
            .persisted_binding();
        let reopened: InstructionExportBinding =
            serde_json::from_slice(&serde_json::to_vec(&binding).unwrap()).unwrap();
        match change {
            0 => std::fs::write(
                f.files.join("rules.md"),
                "Changed bytes must not replace the original source intent.",
            )
            .unwrap(),
            1 => std::fs::remove_file(f.files.join("rules.md")).unwrap(),
            _ => super::instructions::trust(&f.source_profile, &f.files, false),
        }
        assert!(
            f.source
                .prepare(
                    &f.request,
                    &f.destination,
                    vec![ExportSelection::Instructions(reopened.export())]
                )
                .is_err()
        );
        assert!(
            f.source
                .manifest(&f.request, &f.destination)
                .unwrap()
                .is_none()
        );
        assert!(!f.source.state(&f.request, &f.destination).unwrap().ready);
    }
}
#[test]
fn foreign_received_graphs_are_not_relabelled_as_native_seed_authority() {
    let f = Fixture::new();
    let snapshot = capture(&f, Kind::Codex);
    let (_, _, received) = transfer(&f, snapshot);
    assert!(InstructionExportSelection::capture(received).is_err());
}
