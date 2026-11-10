use super::{TestAppServer, Value, json, rpc};
#[path = "batch_history_rpc.rs"]
mod batch;
#[path = "batch_control_rpc.rs"]
mod batch_control;
#[path = "batch_worker_rpc.rs"]
mod batch_worker;
#[path = "branch_rpc.rs"]
mod branches;
#[path = "history_execution_rpc.rs"]
mod execution;
#[cfg(target_os = "linux")]
#[path = "history_faults_rpc.rs"]
mod faults;
#[path = "history_lifecycle_rpc.rs"]
mod lifecycle;
#[path = "local_attachment_upload_rpc.rs"]
mod local_attachment_upload;
#[path = "local_continuation_rpc.rs"]
mod local_continuation;
#[path = "history_parallel_rpc.rs"]
mod parallel;
#[path = "../../../kcoder_migration/tests/fixtures/reinterpretation.rs"]
mod persisted_legacy;
#[path = "plugin_rpc.rs"]
mod plugins;
#[path = "reconstruction_rpc.rs"]
mod reconstruction;
#[path = "reinterpret_rpc.rs"]
mod reinterpretation;
#[path = "resource_budget_rpc.rs"]
mod resource_budget;
#[path = "search_rpc.rs"]
mod search;
#[path = "undo_rpc.rs"]
mod undo;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};

struct Fixture {
    root: tempfile::TempDir,
    workspace: PathBuf,
    profile: PathBuf,
    claude: PathBuf,
    codex: PathBuf,
    overlay: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        let claude = root.path().join("claude");
        let codex = root.path().join("codex");
        for path in [&workspace, &profile, &claude, &codex] {
            fs::create_dir(path).unwrap();
        }
        let overlay = workspace.join("overlay.json");
        fs::write(&overlay, "{}").unwrap();
        fs::write(profile.join("settings.json"), "{}").unwrap();
        fs::write(claude.join("auth.json"), "PRIVATE-AUTH-CANARY").unwrap();
        Self {
            root,
            workspace,
            profile,
            claude,
            codex,
            overlay,
        }
    }
    fn source(&self, count: usize) -> PathBuf {
        let id = uuid::Uuid::new_v4().to_string();
        let path = self.claude.join(format!("projects/project/{id}.jsonl"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::File::create(&path).unwrap();
        for index in 0..count {
            writeln!(
                file,
                "{}",
                json!({"type":"user","uuid":format!("message-{index}"),"sessionId":id,
                "message":{"role":"user","content":"Archive fixture request"}})
            )
            .unwrap();
        }
        path
    }
    fn start(&self) -> TestAppServer {
        let mut builder = TestAppServer::builder(&self.workspace, &self.overlay)
            .config_dir(&self.profile)
            .discard_stderr();
        for (key, value) in [
            ("HOME", self.root.path()),
            ("USERPROFILE", self.root.path()),
            ("CLAUDE_CONFIG_DIR", self.claude.as_path()),
            ("CODEX_HOME", self.codex.as_path()),
        ] {
            builder
                .extra_env
                .push((key.into(), value.as_os_str().into()));
        }
        let mut server = builder.spawn();
        let init = rpc(
            &mut server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"history-archive-fixture","version":"test"}}),
        );
        assert_eq!(
            init["capabilities"]["experimental"]["migrationHistoryJobsV1"],
            true
        );
        assert_eq!(
            init["capabilities"]["experimental"]["migrationResourceBudgetV1"],
            true
        );
        assert!(
            init["capabilities"]["experimental"]
                .get("externalHistoryImportV1")
                .is_none()
        );
        server
    }
}
fn create(server: &mut TestAppServer, page: &Value, item: &Value, id: &str) -> Value {
    rpc(
        server,
        11,
        "migration/history/create",
        json!({"catalogId":page["catalogId"],"sourceHandle":item["sourceHandle"],"requestId":id}),
    )
}
fn read(server: &mut TestAppServer, id: &str) -> Value {
    rpc(server, 20, "migration/history/read", json!({"jobId":id}))
}
fn wait(server: &mut TestAppServer, id: &str, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = read(server, id);
        if predicate(&value) {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "history state did not settle: {value}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn history_jobs_route_native_selections_page_and_recover_without_replaying_sources() {
    let fixture = Fixture::new();
    let sources = (0..12).map(|_| fixture.source(25)).collect::<Vec<_>>();
    let original = fs::read(&sources[0]).unwrap();
    let mut server = fixture.start();
    assert_eq!(
        rpc(&mut server, 2, "migration/history/jobs", json!({}))["jobs"],
        json!([])
    );
    let page = rpc(
        &mut server,
        3,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    assert_eq!(page["totalItems"], 12);
    assert_eq!(page["items"].as_array().unwrap().len(), 10);
    assert!(!page.to_string().contains("PRIVATE-AUTH-CANARY"));
    let rest = rpc(
        &mut server,
        4,
        "migration/history/sources",
        json!({"catalogId":page["catalogId"],"cursor":page["nextCursor"]}),
    );
    assert_eq!(rest["items"].as_array().unwrap().len(), 2);
    let selected = &page["items"][0];
    let id = uuid::Uuid::new_v4().to_string();
    let initial = create(&mut server, &page, selected, &id);
    assert_eq!(initial["job"]["stage"], "capturing");
    assert!(initial["job"]["archiveId"].is_null());
    assert_eq!(create(&mut server, &page, selected, &id), initial);
    for item in page["items"]
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .chain(rest["items"].as_array().unwrap().iter().take(1))
    {
        create(&mut server, &page, item, &uuid::Uuid::new_v4().to_string());
    }
    let jobs = rpc(&mut server, 5, "migration/history/jobs", json!({}));
    assert_eq!(jobs["jobs"].as_array().unwrap().len(), 10);
    assert!(jobs["nextCursor"].is_string());
    assert_eq!(
        rpc(
            &mut server,
            6,
            "migration/history/jobs",
            json!({"cursor":jobs["nextCursor"]})
        )["jobs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"migration/history/create","params":{"catalogId":page["catalogId"],"sourceHandle":"forged","requestId":id}}));
    assert_eq!(
        server.response(7)["error"]["message"],
        "history_discovery_selection_unavailable"
    );
    let no_id = uuid::Uuid::new_v4().to_string();
    server.send(json!({"jsonrpc":"2.0","method":"migration/history/create","params":{"catalogId":page["catalogId"],"sourceHandle":selected["sourceHandle"],"requestId":no_id}}));
    server.send(
        json!({"jsonrpc":"2.0","id":8,"method":"migration/history/read","params":{"jobId":no_id}}),
    );
    assert_eq!(
        server.response(8)["error"]["message"],
        "history_job_not_found"
    );
    rpc(
        &mut server,
        9,
        "migration/history/run",
        json!({"jobId":id,"expectedSequence":0}),
    );
    let done = wait(&mut server, &id, |value| {
        value["job"]["stage"] == "normalized" && value["workerRunning"] == false
    });
    assert_eq!(done["job"]["normalization"]["normalizedRecords"], 25);
    assert!(
        !done
            .to_string()
            .contains(fixture.root.path().to_str().unwrap())
    );
    let codex_id = uuid::Uuid::new_v4().to_string();
    let codex_file = fixture.codex.join(format!(
        "sessions/2026/10/16/rollout-2026-10-16T10-00-00-{codex_id}.jsonl"
    ));
    fs::create_dir_all(codex_file.parent().unwrap()).unwrap();
    fs::write(&codex_file, format!("{}\n{}\n", json!({"type":"session_meta","payload":{"id":codex_id,"cli_version":"0.163.0"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Codex archive fixture"}]}}))).unwrap();
    let codex_page = rpc(
        &mut server,
        15,
        "migration/history/discover",
        json!({"source":"codex"}),
    );
    let codex_job = uuid::Uuid::new_v4().to_string();
    create(
        &mut server,
        &codex_page,
        &codex_page["items"][0],
        &codex_job,
    );
    rpc(
        &mut server,
        16,
        "migration/history/run",
        json!({"jobId":codex_job,"expectedSequence":0}),
    );
    let codex_done = wait(&mut server, &codex_job, |value| {
        value["job"]["stage"] == "normalized" && value["workerRunning"] == false
    });
    assert_eq!(codex_done["job"]["normalization"]["normalizedRecords"], 2);
    let count = rpc(&mut server, 10, "thread/list", json!({}));
    assert_eq!(count["threads"], json!([]));
    assert_eq!(fs::read(&sources[0]).unwrap(), original);
    for source in &sources {
        fs::remove_file(source).unwrap();
    }
    drop(server);
    let mut server = fixture.start();
    let restored = read(&mut server, &id);
    assert_eq!(restored["job"], done["job"]);
    assert_eq!(restored["workerRunning"], false);
    assert_eq!(
        rpc(
            &mut server,
            12,
            "migration/history/run",
            json!({"jobId":id,"expectedSequence":0})
        )["job"],
        done["job"]
    );
    assert_eq!(
        fs::read_to_string(fixture.profile.join("settings.json")).unwrap(),
        "{}"
    );
}

#[test]
fn history_capture_is_cancelled_on_owner_disconnect_and_can_resume_after_restart() {
    let fixture = Fixture::new();
    let source = fixture.source(1);
    let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
    let chunk = vec![b' '; 1024 * 1024];
    for _ in 0..64 {
        file.write_all(&chunk).unwrap();
    }
    drop(file);
    let mut server = fixture.start();
    let page = rpc(
        &mut server,
        3,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let id = uuid::Uuid::new_v4().to_string();
    create(&mut server, &page, &page["items"][0], &id);
    rpc(
        &mut server,
        4,
        "migration/history/run",
        json!({"jobId":id,"expectedSequence":0}),
    );
    let active = wait(&mut server, &id, |value| {
        value["workerRunning"] == true
            && value["progress"]["processed"]
                .as_u64()
                .is_some_and(|count| count > 0)
    });
    assert_eq!(active["progress"]["unit"], "bytes");
    let resources = rpc(&mut server, 5, "server/resources/read", json!({}));
    assert!(
        resources["activity"]["pendingServiceRequests"]
            .as_u64()
            .is_some_and(|value| value > 0),
        "{resources}"
    );
    drop(server.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(30);
    while server.child.try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "owned history worker prevented server shutdown"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(server);
    let mut server = fixture.start();
    let cancelled = read(&mut server, &id);
    assert_eq!(cancelled["job"]["stage"], "cancelled");
    assert_eq!(cancelled["workerRunning"], false);
    let resumed = rpc(
        &mut server,
        6,
        "migration/history/resume",
        json!({"jobId":id,"expectedSequence":cancelled["job"]["sequence"]}),
    );
    assert_ne!(resumed["job"]["stage"], "cancelled");
    let settled = rpc(
        &mut server,
        7,
        "migration/history/cancel",
        json!({"jobId":id}),
    );
    assert_eq!(settled["job"]["stage"], "cancelled");
    assert!(source.exists());
}

#[test]
fn historical_content_reads_page_and_bind_text_positions_to_the_job_block_and_connection() {
    let fixture = Fixture::new();
    let file = fixture.source(0);
    let session = file.file_stem().unwrap().to_str().unwrap();
    let text = "X".repeat(130_000) + "\n::kcoder-widget{widget_id=\"old-widget\" revision=1}";
    let mut blocks = vec![
        json!({"type":"text","text":text}),
        json!({"type":"thinking","thinking":"Historical thought","signature":"PRIVATE-SIGNATURE-CANARY"}),
        json!({"type":"tool_use","id":"call","name":"Bash","input":{"command":"echo historical-only"}}),
    ];
    blocks.extend((0..11).map(|index| json!({"type":"text","text":format!("Block {index}")})));
    let data = vec![
        json!({"type":"assistant","uuid":"message","sessionId":session,"message":{"role":"assistant","content":blocks}}),
        json!({"type":"user","uuid":"result","sessionId":session,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"Original result"}]}}),
    ];
    fs::write(
        &file,
        data.into_iter()
            .map(|value| value.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let mut server = fixture.start();
    let page = rpc(
        &mut server,
        3,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let id = uuid::Uuid::new_v4().to_string();
    create(&mut server, &page, &page["items"][0], &id);
    rpc(
        &mut server,
        4,
        "migration/history/run",
        json!({"jobId":id,"expectedSequence":0}),
    );
    wait(&mut server, &id, |value| {
        value["job"]["stage"] == "normalized"
    });
    let transcript = rpc(
        &mut server,
        5,
        "migration/history/transcript",
        json!({"jobId":id}),
    );
    assert_eq!(transcript["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        transcript["items"][0]["blocks"].as_array().unwrap().len(),
        10
    );
    assert_eq!(transcript["items"][0]["totalBlocks"], 15);
    assert_eq!(transcript["items"][0]["blocks"][2]["bodyAvailable"], false);
    assert!(!transcript.to_string().contains("PRIVATE-SIGNATURE-CANARY"));
    assert_eq!(
        transcript["items"][1]["blocks"][0]["outcome"],
        "recorded_result"
    );
    let more = rpc(
        &mut server,
        6,
        "migration/history/blocks",
        json!({"jobId":id,"record":0,"cursor":10}),
    );
    assert_eq!(more["blocks"].as_array().unwrap().len(), 5);
    let first = rpc(
        &mut server,
        7,
        "migration/history/text",
        json!({"jobId":id,"record":0,"blockIndex":0}),
    );
    assert_eq!(first["text"].as_str().unwrap().len(), 64 * 1024);
    let cursor = first["nextCursor"].clone();
    let second = rpc(
        &mut server,
        8,
        "migration/history/text",
        json!({"jobId":id,"record":0,"blockIndex":0,"cursor":cursor}),
    );
    assert!(second["nextCursor"].is_null());
    assert_eq!(
        first["text"].as_str().unwrap().to_owned() + second["text"].as_str().unwrap(),
        text
    );
    for (params, expected) in [
        (
            json!({"jobId":id,"record":0,"blockIndex":1,"cursor":cursor}),
            "history_display_invalid_cursor",
        ),
        (
            json!({"jobId":uuid::Uuid::new_v4().to_string(),"record":0,"blockIndex":0,"cursor":cursor}),
            "history_display_invalid_cursor",
        ),
        (
            json!({"jobId":id,"record":0,"blockIndex":2}),
            "history_display_opaque_body_unavailable",
        ),
        (
            json!({"jobId":id,"record":0,"blockIndex":0,"offset":10}),
            "migration_invalid_parameters",
        ),
    ] {
        server.send(
            json!({"jsonrpc":"2.0","id":9,"method":"migration/history/text","params":params}),
        );
        assert_eq!(server.response(9)["error"]["message"], expected);
    }
    fs::remove_file(file).unwrap();
    drop(server);
    let mut server = fixture.start();
    server.send(json!({"jsonrpc":"2.0","id":10,"method":"migration/history/text","params":{"jobId":id,"record":0,"blockIndex":0,"cursor":cursor}}));
    assert_eq!(
        server.response(10)["error"]["message"],
        "history_display_invalid_cursor"
    );
    assert_eq!(
        rpc(
            &mut server,
            11,
            "migration/history/text",
            json!({"jobId":id,"record":0,"blockIndex":0})
        )["text"],
        first["text"]
    );
    assert_eq!(
        rpc(&mut server, 12, "thread/list", json!({}))["threads"],
        json!([])
    );
}
