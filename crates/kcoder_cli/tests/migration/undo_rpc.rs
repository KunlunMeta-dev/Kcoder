//! Actual app-server subprocess acceptance for native continuation undo.
use super::branches::continuation::{create_continuation, selected, setup, wait_continuation};
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_migration::history_continuation_jobs::{ContinuationJobs, ContinuationTarget};
use std::path::Path;

struct Published {
    fixture: Fixture,
    server: TestAppServer,
    original: Vec<u8>,
    source_file: PathBuf,
    archive: String,
    view: Value,
    imported: Value,
    key: String,
    target: ContinuationTarget,
}
fn published(with_attachment: bool) -> Published {
    let (fixture, source_file) = setup();
    if with_attachment {
        let mut settings: Value =
            serde_json::from_slice(&fs::read(&fixture.overlay).unwrap()).unwrap();
        settings["model_capabilities"] = json!({"vision":true});
        fs::write(&fixture.overlay, serde_json::to_vec(&settings).unwrap()).unwrap();
        let session = source_file.file_stem().unwrap().to_str().unwrap();
        let row = json!({"type":"user","uuid":"attachment","parentUuid":"old-result","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(crate::png_image_fixture())}}]}});
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&source_file)
            .unwrap();
        writeln!(file, "{row}").unwrap();
    }
    let original = fs::read(&source_file).unwrap();
    let mut server = fixture.start();
    let (archive, view) = selected(&mut server);
    if with_attachment {
        let selection = json!({"jobId":archive,"viewId":view,"position":2,"blockIndex":0});
        rpc(
            &mut server,
            100,
            "migration/history/attachment/run",
            json!({"selection":selection}),
        );
        let until = Instant::now() + Duration::from_secs(30);
        loop {
            let result = rpc(
                &mut server,
                101,
                "migration/history/attachment/read",
                json!({"selection":selection}),
            );
            if result["job"]["stage"] == "ready" && result["workerRunning"] == false {
                break;
            }
            assert!(Instant::now() < until, "{result}");
            assert_ne!(result["job"]["stage"], "failed", "{result}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let key = uuid::Uuid::new_v4().to_string();
    create_continuation(&mut server, &archive, &view, &key);
    rpc(
        &mut server,
        102,
        "migration/history/continuation/run",
        json!({"jobId":key,"expectedSequence":0}),
    );
    let imported = wait_continuation(&mut server, &key);
    let continuations = ContinuationJobs::open_existing(&fixture.profile, &fixture.workspace)
        .unwrap()
        .unwrap();
    assert!(
        continuations.published_undo_seal(&key).unwrap().is_some(),
        "publication must actually seal before testing undo"
    );
    let target = continuations.target(&key).unwrap().unwrap();
    Published {
        fixture,
        server,
        original,
        source_file,
        archive,
        view,
        imported,
        key,
        target,
    }
}
fn history(target: &ContinuationTarget) -> PathBuf {
    target
        .history_directory
        .join(format!("{}.jsonl", target.session_id))
}
fn undo_create(server: &mut TestAppServer, key: &str, source: &str, sequence: &Value) -> Value {
    rpc(
        server,
        110,
        "migration/history/undo/create",
        json!({"requestId":key,"continuationJobId":source,"expectedContinuationSequence":sequence}),
    )
}
fn undo_read(server: &mut TestAppServer, key: &str) -> Value {
    rpc(
        server,
        111,
        "migration/history/undo/read",
        json!({"jobId":key}),
    )
}
fn undo_wait(server: &mut TestAppServer, key: &str) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let value = undo_read(server, key);
        if value["workerRunning"] == false && value["job"]["stage"] != "planned" {
            return value;
        }
        assert!(Instant::now() < until, "undo did not settle: {value}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn undo_run(server: &mut TestAppServer, job: &Value) -> Value {
    let key = job["job"]["jobId"].as_str().unwrap();
    rpc(
        server,
        112,
        "migration/history/undo/run",
        json!({"jobId":key,"expectedSequence":job["job"]["sequence"]}),
    );
    undo_wait(server, key)
}
fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn visit(root: &Path, at: &Path, files: &mut Vec<(PathBuf, Vec<u8>)>) {
        for entry in fs::read_dir(at).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, files);
            } else {
                files.push((
                    path.strip_prefix(root).unwrap().into(),
                    fs::read(&path).unwrap(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
fn request_error(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
    server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
    let response = server.response(id);
    assert!(response.get("error").is_some(), "{response}");
    response["error"].clone()
}

#[test]
fn undo_rpc_publishes_and_retires_one_native_thread_preserving_archives_attachments_and_imported_fact()
 {
    let mut fixture = published(true);
    let native = history(&fixture.target);
    let initial = fs::read(&native).unwrap();
    let artifacts = fixture
        .target
        .artifact_directory
        .join(&fixture.target.session_id);
    let owned = snapshot(&artifacts);
    assert!(
        owned
            .iter()
            .any(|(path, _)| path.to_string_lossy().contains("attachments")),
        "real copied attachment must be present"
    );
    let undo_directory = fixture.fixture.profile.join("migrations/history-undo");
    assert!(!undo_directory.exists());
    let lookup = rpc(
        &mut fixture.server,
        113,
        "migration/history/undo/lookup",
        json!({"continuationJobId":fixture.key}),
    );
    assert!(lookup["existingJob"].is_null());
    assert!(!undo_directory.exists());
    let preview = rpc(
        &mut fixture.server,
        114,
        "migration/history/undo/preview",
        json!({"continuationJobId":fixture.key}),
    );
    assert_eq!(preview["canUndo"], true, "{preview}");
    assert!(!undo_directory.exists());
    let key = uuid::Uuid::new_v4().to_string();
    let created = undo_create(
        &mut fixture.server,
        &key,
        &fixture.key,
        &fixture.imported["job"]["sequence"],
    );
    let alias = uuid::Uuid::new_v4().to_string();
    let reused = undo_create(
        &mut fixture.server,
        &alias,
        &fixture.key,
        &fixture.imported["job"]["sequence"],
    );
    assert_eq!(reused["job"], created["job"]);
    assert_eq!(
        request_error(
            &mut fixture.server,
            115,
            "migration/history/undo/create",
            json!({"requestId":alias,"continuationJobId":uuid::Uuid::new_v4().to_string(),"expectedContinuationSequence":0})
        )["message"],
        "historical_undo_request_changed"
    );
    let done = undo_run(&mut fixture.server, &created);
    assert_eq!(done["job"]["stage"], "undone", "{done}");
    assert_eq!(done["job"]["archivesRetained"], true);
    assert_eq!(done["job"]["attachmentsRetained"], true);
    assert!(!native.exists());
    assert_eq!(snapshot(&artifacts), owned);
    assert_eq!(fs::read(&fixture.source_file).unwrap(), fixture.original);
    assert_eq!(
        rpc(
            &mut fixture.server,
            116,
            "migration/history/continuation/read",
            json!({"jobId":fixture.key})
        )["job"],
        fixture.imported["job"]
    );
    let archive = rpc(
        &mut fixture.server,
        117,
        "migration/history/transcript",
        json!({"jobId":fixture.archive}),
    );
    assert_eq!(archive["items"].as_array().unwrap().len(), 3);
    let branch = rpc(
        &mut fixture.server,
        118,
        "migration/history/branch/page",
        json!({"jobId":fixture.archive,"viewId":fixture.view}),
    );
    assert_eq!(branch["items"].as_array().unwrap().len(), 3);
    let held = native.parent().unwrap().join(format!(
        ".{}.history-undo-{key}.bin",
        fixture.target.session_id
    ));
    assert_eq!(fs::read(&held).unwrap(), initial);
    assert!(
        request_error(
            &mut fixture.server,
            119,
            "thread/resume",
            json!({"threadId":fixture.target.session_id})
        )
        .is_object()
    );
    assert_eq!(
        rpc(&mut fixture.server, 122, "thread/list", json!({}))["threads"],
        json!([])
    );
    assert!(
        !fixture
            .fixture
            .workspace
            .join("NEVER_REPLAY_CONTINUATION")
            .exists()
    );
    assert!(
        !done
            .to_string()
            .contains(fixture.fixture.root.path().to_str().unwrap())
    );
    assert!(!done.to_string().contains("sealSha256"));
    drop(fixture.server);
    let mut reopened = fixture.fixture.start();
    assert_eq!(undo_read(&mut reopened, &key)["job"], done["job"]);
    assert_eq!(
        rpc(
            &mut reopened,
            120,
            "migration/history/undo/lookup",
            json!({"continuationJobId":fixture.key})
        )["existingJob"],
        done["job"]
    );
    assert!(
        request_error(
            &mut reopened,
            121,
            "thread/resume",
            json!({"threadId":fixture.target.session_id})
        )
        .is_object()
    );
    assert!(!native.exists());
    assert_eq!(snapshot(&artifacts), owned);
    assert_eq!(
        rpc(&mut reopened, 123, "thread/list", json!({}))["threads"],
        json!([])
    );
}

#[test]
fn lightweight_lookup_works_while_another_owner_holds_the_real_session_lease_and_undo_refuses() {
    use fs2::FileExt;
    let mut fixture = published(false);
    let native = history(&fixture.target);
    let initial = fs::read(&native).unwrap();
    {
        let lease = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(native.with_extension("lease"))
            .unwrap();
        lease.try_lock_exclusive().unwrap();
        assert!(
            rpc(
                &mut fixture.server,
                129,
                "migration/history/undo/lookup",
                json!({"continuationJobId":fixture.key})
            )["existingJob"]
                .is_null()
        );
        assert!(
            !fixture
                .fixture
                .profile
                .join("migrations/history-undo")
                .exists()
        );
    }
    let key = uuid::Uuid::new_v4().to_string();
    let created = undo_create(
        &mut fixture.server,
        &key,
        &fixture.key,
        &fixture.imported["job"]["sequence"],
    );
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(native.with_extension("lease"))
        .unwrap();
    lease.try_lock_exclusive().unwrap();
    assert_eq!(
        rpc(
            &mut fixture.server,
            130,
            "migration/history/undo/lookup",
            json!({"continuationJobId":fixture.key})
        )["existingJob"],
        created["job"]
    );
    let preview = rpc(
        &mut fixture.server,
        131,
        "migration/history/undo/preview",
        json!({"continuationJobId":fixture.key}),
    );
    assert_eq!(preview["canUndo"], false);
    assert_eq!(preview["reasonCode"], "historical_undo_busy");
    let blocked = undo_run(&mut fixture.server, &created);
    assert_eq!(blocked["job"]["stage"], "conflict");
    assert_eq!(fs::read(&native).unwrap(), initial);
    drop(lease);
    let done = undo_run(&mut fixture.server, &blocked);
    assert_eq!(done["job"]["stage"], "undone");
}

#[test]
fn metadata_changed_via_rpc_and_appended_user_work_block_retirement() {
    for append in [false, true] {
        let mut fixture = published(false);
        let native = history(&fixture.target);
        let key = uuid::Uuid::new_v4().to_string();
        let created = undo_create(
            &mut fixture.server,
            &key,
            &fixture.key,
            &fixture.imported["job"]["sequence"],
        );
        if !append {
            rpc(
                &mut fixture.server,
                140,
                "thread/metadata/update",
                json!({"threadId":fixture.target.session_id,"title":"user selected newer title"}),
            );
        }
        drop(fixture.server);
        if append {
            let state = kcoder_state::AppState::new(&fixture.fixture.workspace);
            state.resume_from_history(&native).unwrap();
            state.add_message(kcoder_types::Message::user_text(
                "later native user message",
            ));
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(state.flush_history())
                .unwrap();
        }
        let current = fs::read(&native).unwrap();
        let mut server = fixture.fixture.start();
        let preview = rpc(
            &mut server,
            141,
            "migration/history/undo/preview",
            json!({"continuationJobId":fixture.key}),
        );
        assert_eq!(preview["canUndo"], false, "{preview}");
        assert_eq!(
            preview["reasonCode"], "historical_undo_session_modified",
            "{preview}"
        );
        let result = undo_run(&mut server, &created);
        assert_eq!(result["job"]["stage"], "conflict", "{result}");
        assert_eq!(fs::read(&native).unwrap(), current);
        let read = rpc(
            &mut server,
            142,
            "thread/read",
            json!({"threadId":fixture.target.session_id}),
        );
        assert_eq!(read["thread"]["id"], fixture.target.session_id);
        if !append {
            assert_eq!(read["thread"]["title"], "user selected newer title");
        }
        assert_eq!(
            rpc(
                &mut server,
                143,
                "migration/history/continuation/read",
                json!({"jobId":fixture.key})
            )["job"]["stage"],
            "imported"
        );
    }
}

#[test]
fn cancelled_undo_and_stale_sequences_recover_after_restart_without_touching_the_session() {
    let mut fixture = published(false);
    let native = history(&fixture.target);
    let current = fs::read(&native).unwrap();
    let key = uuid::Uuid::new_v4().to_string();
    let created = undo_create(
        &mut fixture.server,
        &key,
        &fixture.key,
        &fixture.imported["job"]["sequence"],
    );
    let cancelled = rpc(
        &mut fixture.server,
        150,
        "migration/history/undo/cancel",
        json!({"jobId":key}),
    );
    assert_eq!(cancelled["job"]["stage"], "cancelled");
    assert_eq!(cancelled["job"]["cancelRequested"], true);
    assert_eq!(
        request_error(
            &mut fixture.server,
            151,
            "migration/history/undo/run",
            json!({"jobId":key,"expectedSequence":created["job"]["sequence"]})
        )["message"],
        "historical_undo_revision_conflict"
    );
    assert_eq!(fs::read(&native).unwrap(), current);
    drop(fixture.server);
    let mut server = fixture.fixture.start();
    assert_eq!(undo_read(&mut server, &key)["job"], cancelled["job"]);
    let done = undo_run(&mut server, &cancelled);
    assert_eq!(done["job"]["stage"], "undone");
    assert!(!native.exists());
}

#[test]
fn unknown_cleanup_with_a_lost_native_receipt_is_not_repaired_by_reads_or_mislabelled_cancelled() {
    let mut fixture = published(false);
    let native = history(&fixture.target);
    let key = uuid::Uuid::new_v4().to_string();
    let created = undo_create(
        &mut fixture.server,
        &key,
        &fixture.key,
        &fixture.imported["job"]["sequence"],
    );
    let done = undo_run(&mut fixture.server, &created);
    assert_eq!(done["job"]["stage"], "undone");
    drop(fixture.server);
    let journal = fixture
        .fixture
        .profile
        .join("migrations/history-undo")
        .join(format!("{key}.json"));
    let mut stored: Value = serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    stored["receipt"] = Value::Null;
    stored["view"]["stage"] = json!("outcome_unknown");
    stored["view"]["failureCode"] = json!("historical_undo_unconfirmed");
    fs::write(&journal, serde_json::to_vec(&stored).unwrap()).unwrap();
    fs::remove_file(
        native
            .with_extension("hctl")
            .join(format!("historical-undo-{key}.receipt.json")),
    )
    .unwrap();
    let held = native.parent().unwrap().join(format!(
        ".{}.history-undo-{key}.bin",
        fixture.target.session_id
    ));
    fs::rename(&held, &native).unwrap();
    let original = fs::read(&native).unwrap();
    let mut server = fixture.fixture.start();
    let observed = undo_read(&mut server, &key);
    assert_eq!(observed["job"]["stage"], "outcome_unknown");
    assert_eq!(fs::read(&native).unwrap(), original);
    assert!(!held.exists());
    let lookup = rpc(
        &mut server,
        160,
        "migration/history/undo/lookup",
        json!({"continuationJobId":fixture.key}),
    );
    assert_eq!(lookup["existingJob"]["stage"], "outcome_unknown");
    assert!(native.exists());
    let cancelled = rpc(
        &mut server,
        161,
        "migration/history/undo/cancel",
        json!({"jobId":key}),
    );
    assert_eq!(cancelled["job"]["stage"], "outcome_unknown");
    assert_eq!(cancelled["job"]["cancelRequested"], true);
    assert!(native.exists());
    let reconciled = undo_run(&mut server, &cancelled);
    assert_eq!(reconciled["job"]["stage"], "undone", "{reconciled}");
    assert!(!native.exists());
    assert_eq!(fs::read(&held).unwrap(), original);
}
