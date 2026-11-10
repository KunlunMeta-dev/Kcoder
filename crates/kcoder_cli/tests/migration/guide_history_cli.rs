//! Actual terminal clients select native historical children without replaying their tool records.
use super::*;
use kcoder_migration::{
    batch::{
        BatchActionKind,
        execution::{BatchExecution, BatchRunEvent, BatchRunMode},
    },
    history_jobs::HistoryJobStore,
};
use kcoder_types::external_history::HistoryImportStage;

fn histories(f: &Fixture, count: usize) -> Vec<(PathBuf, Vec<u8>)> {
    let directory = f.home.join(".claude/projects/owned");
    std::fs::create_dir_all(&directory).unwrap();
    (0..count).map(|n| {
        let id = uuid::Uuid::new_v4().to_string();
        let records = [
            json!({"type":"user","uuid":format!("u{n}"),"sessionId":id,"version":"2.1.301","message":{"role":"user","content":format!("Owned office history {n:02}")}}),
            json!({"type":"assistant","uuid":format!("a{n}"),"parentUuid":format!("u{n}"),"sessionId":id,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":format!("t{n}"),"name":"Bash","input":{"command":"MUST_NOT_REPLAY_OLD_TOOL"}}]}}),
            json!({"type":"user","uuid":format!("r{n}"),"parentUuid":format!("a{n}"),"sessionId":id,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("t{n}"),"content":"Only a historical result"}]}}),
        ];
        let bytes = records.into_iter().map(|r|format!("{r}\n")).collect::<String>().into_bytes();
        let path = directory.join(format!("{id}.jsonl"));
        std::fs::write(&path,&bytes).unwrap(); (path,bytes)
    }).collect()
}
fn prepare(f: &Fixture, paginate: bool, mixed: bool) -> (String, Value) {
    let mut dialog = Dialog::start_scoped(f, "claude-code", None, true);
    let first = dialog.prompt("history_selection");
    assert!(first["choices"]["items"].as_array().unwrap().len() <= 10);
    dialog.answer(&first, "toggle 1");
    let first = dialog.prompt("history_selection");
    assert_eq!(first["choices"]["selected"], 1);
    if paginate {
        dialog.answer(&first, "next");
        let second = dialog.prompt("history_selection");
        assert_eq!(second["choices"]["page"], 1);
        assert_eq!(second["choices"]["items"].as_array().unwrap().len(), 2);
        dialog.answer(&second, "toggle 1");
        let second = dialog.prompt("history_selection");
        dialog.answer(&second, "prev");
        let previous = dialog.prompt("history_selection");
        assert_eq!(previous["choices"]["selected"], 2);
        dialog.answer(&previous, "done");
    } else {
        dialog.answer(&first, "done");
    }
    let menu = dialog.prompt("menu");
    let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&menu, "select");
    let mut selected = BTreeSet::new();
    loop {
        let frame = dialog.next();
        if frame["type"] != "prompt" {
            continue;
        }
        let code = frame["code"].as_str().unwrap();
        let answer = match code {
            "selection" => {
                let rows = frame["choices"]["items"].as_array().unwrap();
                if let Some(row) = rows.iter().find(|row| {
                    let item = &row["item"];
                    (item["category"] == "history" || mixed && item["category"] == "skill")
                        && !selected.contains(item["id"].as_str().unwrap())
                }) {
                    selected.insert(row["item"]["id"].as_str().unwrap().to_owned());
                    format!("toggle {}", row["number"])
                } else if frame["choices"]["page"].as_u64().unwrap() + 1
                    < frame["choices"]["pages"].as_u64().unwrap()
                {
                    "next".into()
                } else {
                    "preview".into()
                }
            }
            "target_name" => "mixed-history-report".into(),
            "enable_asset" => "yes".into(),
            "reuse" => "no".into(),
            "menu" => {
                let planned = dialog.state.clone();
                dialog.answer(&frame, "quit");
                dialog.finish();
                return (id, planned);
            }
            _ => panic!("unexpected public question {code}"),
        };
        dialog.answer(&frame, &answer);
    }
}
fn operate(f: &Fixture, id: &str, operation: &str, confirmation: &str) -> Value {
    let mut dialog = Dialog::start(f, "", Some(id));
    let menu = dialog.prompt("menu");
    dialog.answer(&menu, operation);
    let request = dialog.prompt("request_id");
    dialog.answer(&request, "");
    let confirm = dialog.prompt("confirm_operation");
    dialog.answer(&confirm, confirmation);
    let menu = dialog.prompt("menu");
    let final_state = dialog.state.clone();
    dialog.answer(&menu, "quit");
    dialog.finish();
    final_state
}
fn children(f: &Fixture, id: &str) -> Vec<String> {
    kcoder_migration::store::MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read(id)
        .unwrap()
        .batch
        .unwrap()
        .actions
        .iter()
        .filter_map(|action| match &action.action {
            BatchActionKind::History { plan } => Some(plan.history_job_id.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn mixed_guide_pages_histories_and_undo_respects_readers_and_preserves_import_facts() {
    let f = Fixture::new("claude-code");
    let originals = histories(&f, 12);
    let (id, planned) = prepare(&f, true, true);
    assert_eq!(planned["batch"]["selectedItems"], 3);
    let child_ids = children(&f, &id);
    assert_eq!(child_ids.len(), 2);
    let history = HistoryJobStore::open_existing(&f.profile).unwrap().unwrap();
    for child in &child_ids {
        assert!(history.read(child).is_err());
    }
    let imported = operate(&f, &id, "apply", "IMPORT");
    assert_eq!(imported["job"]["status"], "completed");
    for child in &child_ids {
        assert_eq!(
            history.read(child).unwrap().stage,
            HistoryImportStage::Normalized
        );
    }
    for (path, bytes) in &originals {
        assert_eq!(std::fs::read(path).unwrap(), *bytes);
    }
    std::fs::rename(f.home.join(".claude"), f.home.join("vendor-withheld")).unwrap();
    let mut read = Dialog::start(&f, "", Some(&id));
    let menu = read.prompt("menu");
    read.answer(&menu, "results");
    loop {
        let page = read.prompt("results_page");
        if read.transcript.contains(&child_ids[0]) && read.transcript.contains(&child_ids[1]) {
            read.answer(&page, "back");
            break;
        }
        read.answer(&page, "next");
    }
    let menu = read.prompt("menu");
    read.answer(&menu, "quit");
    read.finish();
    let active_readers: Vec<_> = child_ids
        .iter()
        .map(|child| history.archive_reader(child).unwrap())
        .collect();
    assert_eq!(
        operate(&f, &id, "undo", "UNDO")["job"]["status"],
        "rollback_conflict"
    );
    let saved = kcoder_migration::store::MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read(&id)
        .unwrap();
    let failures: Vec<_> = saved
        .batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .filter_map(|action| action.error.as_deref())
        .collect();
    #[cfg(target_os = "linux")]
    assert!(
        failures.contains(&"migration_result_referenced"),
        "{failures:?}"
    );
    #[cfg(not(target_os = "linux"))]
    assert!(
        failures.contains(&"migration_history_retirement_retained"),
        "{failures:?}"
    );
    drop(active_readers);
    #[cfg(target_os = "linux")]
    {
        assert_eq!(
            operate(&f, &id, "undo", "UNDO")["job"]["status"],
            "rolled_back"
        );
        for child in &child_ids {
            let archive = history.read(child).unwrap().archive_id.unwrap();
            assert!(history.archive_reader(child).is_err());
            assert!(!f.profile.join("external-history").join(archive).exists());
            assert!(matches!(
                history.retirement_for_job(child).unwrap().unwrap().phase,
                kcoder_state::external_history::lifecycle::ArchiveRetirementPhase::Collected
            ));
        }
    }
    for child in &child_ids {
        assert_eq!(
            history.read(child).unwrap().stage,
            HistoryImportStage::Normalized
        );
    }
    assert!(!f.root.path().join("model-requests").exists());
}

#[test]
fn stopped_native_child_is_explicitly_resumed_by_the_guide_with_the_same_job_identity() {
    let f = Fixture::new("claude-code");
    histories(&f, 1);
    let (id, planned) = prepare(&f, false, false);
    let store = kcoder_migration::store::MigrationStore::open_existing(&f.profile).unwrap();
    let provider = kcoder_migration::providers::ProviderTarget::open(&f.profile).unwrap();
    let mcp = kcoder_migration::mcp::McpTarget::open(&f.profile).unwrap();
    let assets = kcoder_migration::assets::AssetTarget::open(&f.profile).unwrap();
    let history = HistoryJobStore::open_existing(&f.profile).unwrap().unwrap();
    let child = children(&f, &id).remove(0);
    let mut stopped = false;
    let outcome = store.run_batch_controlled(
        BatchExecution {
            job_id: &id,
            plan_id: planned["batch"]["planId"].as_str().unwrap(),
            request_id: "owned-history-stop",
            expected_sequence: planned["job"]["sequence"].as_u64().unwrap(),
            mode: BatchRunMode::Apply,
        },
        &kcoder_migration::store::BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
            history: Some(&history),
        },
        &mut |event| {
            stopped |= matches!(event, BatchRunEvent::History { .. });
            !stopped
        },
    );
    assert!(outcome.is_err());
    assert_eq!(
        history.read(&child).unwrap().stage,
        HistoryImportStage::Cancelled
    );
    assert_eq!(
        operate(&f, &id, "resume", "RESUME")["job"]["status"],
        "completed"
    );
    let original = store.read(&id).unwrap();
    assert_eq!(original.receipts.len(), 1);
    assert_eq!(original.receipts[0].target_id, child);
    assert_eq!(
        history.read(&child).unwrap().stage,
        HistoryImportStage::Normalized
    );
    assert_eq!(
        operate(&f, &id, "resume", "RESUME")["job"]["status"],
        "completed"
    );
    assert_eq!(store.read(&id).unwrap().receipts.len(), 1);
    let saved = store.read(&id).unwrap();
    let replay = f.call(&[
        "migrate",
        "resume-batch",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        &id,
        "--plan-id",
        planned["batch"]["planId"].as_str().unwrap(),
        "--request-id",
        "explicit-terminal-reconcile",
        "--expected-sequence",
        &saved.sequence.to_string(),
    ]);
    assert_eq!(replay["job"]["status"], "completed");
    assert_eq!(store.read(&id).unwrap().receipts.len(), 1);
    assert!(!f.root.path().join("model-requests").exists());
}
