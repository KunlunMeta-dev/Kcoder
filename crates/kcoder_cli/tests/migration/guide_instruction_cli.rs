//! Actual terminal-host commands share Native instruction snapshots, batches and original receipts.
#[path = "guide_instruction_format_cli.rs"]
mod format;
use super::*;
use kcoder_config::imported_context::{ImportedContextScope, ImportedContextStore};
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    batch::BatchSource,
    instruction_sources::{InstructionSourceGrant, InstructionSourcePolicy},
    store::{BatchCaptureInput, BatchCreateIntent, BatchCreationStage as Stage, MigrationStore},
};
use kcoder_types::migration::MigrationSourceKind;
use std::sync::Arc;

fn source(f: &Fixture, kind: &str, count: usize) -> PathBuf {
    let root = f.root.path().join("explicit-instruction-root");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    let name = if kind == "codex" {
        "AGENTS.md"
    } else {
        "CLAUDE.md"
    };
    std::fs::write(
        root.join(name),
        "ROOT_SCOPE_GUIDE: preserve ordinary checks.\n",
    )
    .unwrap();
    for n in 1..count {
        std::fs::create_dir(root.join(format!("child{n}"))).unwrap();
        std::fs::write(
            root.join(format!("child{n}/{name}")),
            format!("CHILD_SCOPE_GUIDE_{n}: preserve scoped examples.\n"),
        )
        .unwrap();
    }
    let target = f.root.path().join("workspace");
    std::fs::create_dir_all(target.join("mapped")).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&f.profile).unwrap();
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        json!({"trusted":[root,target],"never":[]}).to_string(),
    )
    .unwrap();
    root
}
fn capture_dialog(f: &Fixture, root: &std::path::Path, kind: &str) -> Dialog {
    let mut d = Dialog::start(f, "", None);
    let p = d.prompt("entry");
    d.answer(&p, "instructions");
    let p = d.prompt("instruction_request_id");
    d.answer(&p, "");
    let p = d.prompt("instruction_source");
    d.answer(&p, kind);
    let p = d.prompt("instruction_root");
    d.answer(&p, root.to_str().unwrap());
    let p = d.prompt("instruction_cwd");
    d.answer(&p, "");
    let p = d.prompt("instruction_source_consent");
    d.answer(&p, "yes");
    let p = d.prompt("instruction_descendants");
    d.answer(&p, "yes");
    let p = d.prompt("instruction_static_subset");
    d.answer(&p, "yes");
    d
}
fn operate(d: &mut Dialog, menu: &Value, action: &str, confirmation: &str) -> Value {
    d.answer(menu, action);
    let p = d.prompt("request_id");
    d.answer(&p, "");
    let p = d.prompt("confirm_operation");
    d.answer(&p, confirmation);
    d.prompt("menu")
}

#[test]
fn guided_instructions_map_two_scopes_default_off_and_reopen_original_bytes_then_owned_undo() {
    for kind in ["codex", "claude-code"] {
        let f = Fixture::new(kind);
        let root = source(&f, kind, 2);
        let original = std::fs::read(f.profile.join("settings.json")).unwrap();
        let mut d = capture_dialog(&f, &root, kind);
        let p = d.prompt("instruction_selection");
        assert_eq!(p["choices"]["items"].as_array().unwrap().len(), 2);
        let root_row = p["choices"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["relativeScope"] == "")
            .unwrap()["number"]
            .as_u64()
            .unwrap();
        let child_row = if root_row == 1 { 2 } else { 1 };
        d.answer(&p, &format!("toggle {root_row}"));
        let p = d.prompt("instruction_target_scope");
        d.answer(&p, ".");
        let p = d.prompt("instruction_selection");
        d.answer(&p, &format!("toggle {child_row}"));
        let p = d.prompt("instruction_target_scope");
        d.answer(&p, "mapped");
        let p = d.prompt("instruction_selection");
        d.answer(&p, "done");
        let p = d.prompt("instruction_capture_confirm");
        d.answer(&p, "CAPTURE");
        let mut menu = d.prompt("menu");
        let id = d.state["job"]["jobId"].as_str().unwrap().to_owned();
        let mut request = None;
        for line in d.transcript.lines() {
            let frame: Value = serde_json::from_str(line).unwrap();
            if frame["type"] == "instruction_capture" {
                request = Some(frame["result"]["requestId"].as_str().unwrap().to_owned());
            }
        }
        let request = request.unwrap();
        d.answer(&menu, "select");
        for n in 1..=2 {
            let p = d.prompt("selection");
            d.answer(&p, &format!("toggle {n}"));
            let p = d.prompt("target_name");
            d.answer(&p, "");
            let p = d.prompt("enable_asset");
            d.answer(&p, "no");
        }
        let p = d.prompt("selection");
        d.answer(&p, "preview");
        let p = d.prompt("reuse");
        d.answer(&p, "no");
        menu = d.prompt("menu");
        menu = operate(&mut d, &menu, "apply", "IMPORT");
        assert_eq!(d.state["job"]["status"], "completed");
        let records = ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(
            records
                .iter()
                .all(|row| !row.enabled && row.instruction_provenance.is_some())
        );
        let workspace = f.root.path().join("workspace");
        assert!(records.iter().any(|row| row.scope
            == ImportedContextScope::Project {
                root: workspace.clone()
            }));
        assert!(records.iter().any(|row| row.scope
            == ImportedContextScope::Project {
                root: workspace.join("mapped")
            }));
        let cohort = records[0]
            .instruction_provenance
            .as_ref()
            .unwrap()
            .cohort_id
            .clone();
        assert!(
            records
                .iter()
                .all(|row| row.instruction_provenance.as_ref().unwrap().cohort_id == cohort)
        );
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            original
        );
        d.answer(&menu, "quit");
        d.finish();
        std::fs::rename(&root, root.with_extension("withheld")).unwrap();
        // Lost terminal reply: recover by original request before consulting any live source.
        let mut recovered = Dialog::start(&f, "", None);
        let p = recovered.prompt("entry");
        recovered.answer(&p, "creation");
        let p = recovered.prompt("creation_request_id");
        recovered.answer(&p, &request);
        let menu = recovered.prompt("menu");
        assert_eq!(recovered.state["job"]["jobId"], id);
        assert_eq!(recovered.state["job"]["status"], "completed");
        recovered.answer(&menu, "instructions");
        let p = recovered.prompt("instruction_saved");
        recovered.answer(&p, "1");
        let p = recovered.prompt("instruction_saved");
        assert!(recovered.transcript.contains("SCOPE_GUIDE"));
        recovered.answer(&p, "back");
        let menu = recovered.prompt("menu");
        let menu = operate(&mut recovered, &menu, "undo", "UNDO");
        assert_eq!(recovered.state["job"]["status"], "rolled_back");
        recovered.answer(&menu, "quit");
        recovered.finish();
        assert!(
            ImportedContextStore::open(&f.profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            original
        );
        assert!(!f.profile.join("skills").exists());
        assert!(!f.root.path().join("model-requests").exists());
    }
}

#[test]
fn guided_instruction_capture_rejects_child_replacement_between_mapping_and_confirmation() {
    let f = Fixture::new("codex");
    let root = source(&f, "codex", 1);
    let mut d = capture_dialog(&f, &root, "codex");
    let p = d.prompt("instruction_selection");
    d.answer(&p, "toggle 1");
    let p = d.prompt("instruction_target_scope");
    d.answer(&p, "mapped");
    let p = d.prompt("instruction_selection");
    d.answer(&p, "done");
    let p = d.prompt("instruction_capture_confirm");
    let workspace = f.root.path().join("workspace");
    std::fs::rename(workspace.join("mapped"), workspace.join("retained-mapped")).unwrap();
    std::fs::create_dir(workspace.join("mapped")).unwrap();
    d.answer(&p, "CAPTURE");
    let p = d.prompt("creation_control");
    assert!(
        d.transcript
            .contains("migration_instruction_target_changed")
    );
    assert_eq!(p["choices"]["canFinishWithoutSource"], false);
    d.answer(&p, "resume");
    let p = d.prompt("creation_control");
    assert!(
        d.transcript
            .contains("migration_batch_creation_original_source_required")
    );
    d.answer(&p, "back");
    d.finish();
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn guided_prepared_capture_can_explicitly_finish_after_source_removal_without_importing() {
    let f = Fixture::new("codex");
    let root = source(&f, "codex", 1);
    let snapshot = Arc::new(
        InstructionSourceGrant::capture(&f.profile, &root, &root, MigrationSourceKind::Codex)
            .unwrap()
            .capture_sources(&InstructionSourcePolicy::default(), |_| true)
            .unwrap(),
    );
    let mapping = vec![(snapshot.summaries()[0].id.clone(), String::new())];
    let binding = AssetBundleBinding::capture_scoped_instructions(
        &f.profile,
        &f.root.path().join("workspace"),
        snapshot,
        &mapping,
        false,
    )
    .unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let intent = BatchCreateIntent::new(
        &request,
        &json!({"kind":"owned-prepared-terminal-fixture","mapping":"root"}),
    )
    .unwrap();
    let store = MigrationStore::open_or_create(&f.profile).unwrap();
    assert!(
        store
            .create_batch_scan_idempotent(
                &intent,
                |_| Ok(BatchCaptureInput {
                    sources: vec![BatchSource::Assets(binding)],
                    resource_limits: Default::default(),
                    project: None
                }),
                &mut |stage, _| stage != Stage::Prepared
            )
            .is_err()
    );
    let pending = store.read_batch_creation(&request).unwrap();
    assert_eq!(pending.stage, Stage::Prepared);
    std::fs::rename(&root, root.with_extension("withheld")).unwrap();
    let mut d = Dialog::start(&f, "", None);
    let p = d.prompt("entry");
    d.answer(&p, "creation");
    let p = d.prompt("creation_request_id");
    d.answer(&p, &request);
    let p = d.prompt("creation_control");
    assert_eq!(p["choices"]["canFinishWithoutSource"], true);
    d.answer(&p, "resume");
    let p = d.prompt("creation_control_id");
    d.answer(&p, "");
    let p = d.prompt("creation_confirm");
    d.answer(&p, "RESUME");
    let p = d.prompt("menu");
    assert_eq!(d.state["job"]["jobId"], pending.job_id);
    assert_eq!(d.state["job"]["status"], "ready");
    d.answer(&p, "instructions");
    let p = d.prompt("instruction_saved");
    d.answer(&p, "1");
    let p = d.prompt("instruction_saved");
    assert!(d.transcript.contains("ROOT_SCOPE_GUIDE"));
    d.answer(&p, "back");
    let p = d.prompt("menu");
    d.answer(&p, "quit");
    d.finish();
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.read_batch_creation(&request).unwrap().stage,
        Stage::Published
    );
}

#[test]
fn guided_instruction_sources_page_by_ten_and_body_is_only_read_explicitly() {
    let f = Fixture::new("codex");
    let root = source(&f, "codex", 12);
    let mut d = capture_dialog(&f, &root, "codex");
    let p = d.prompt("instruction_selection");
    assert_eq!(p["choices"]["items"].as_array().unwrap().len(), 10);
    assert!(!d.transcript.contains("ROOT_SCOPE_GUIDE"));
    d.answer(&p, "next");
    let p = d.prompt("instruction_selection");
    assert_eq!(p["choices"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(p["choices"]["page"], 1);
    d.answer(&p, "body 1");
    let p = d.prompt("instruction_selection");
    assert!(d.transcript.contains("CHILD_SCOPE_GUIDE"));
    d.answer(&p, "back");
    d.finish();
    assert!(
        MigrationStore::open_existing(&f.profile)
            .unwrap()
            .records(None)
            .unwrap()
            .0
            .is_empty()
    );
}
