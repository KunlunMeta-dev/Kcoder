use super::*;
#[path = "continuation_rpc.rs"]
pub(super) mod continuation;
#[path = "branch_tools_rpc.rs"]
mod tools;

fn wait_branch(server: &mut TestAppServer, job: &str, view: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = rpc(
            server,
            30,
            "migration/history/branch/read",
            json!({"jobId":job,"viewId":view}),
        );
        if value["progress"]["stage"] == "ready" && value["workerRunning"] == false {
            return value;
        }
        assert!(Instant::now() < deadline, "branch did not settle: {value}");
        assert_ne!(value["progress"]["stage"], "failed", "{value}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn archive(server: &mut TestAppServer) -> String {
    let sources = rpc(
        server,
        3,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let job = uuid::Uuid::new_v4().to_string();
    create(server, &sources, &sources["items"][0], &job);
    rpc(
        server,
        4,
        "migration/history/run",
        json!({"jobId":job,"expectedSequence":0}),
    );
    wait(server, &job, |value| value["job"]["stage"] == "normalized");
    job
}

#[test]
fn branch_rpc_selects_the_current_chain_binds_body_cursors_and_recovers_after_restart() {
    let fixture = Fixture::new();
    let file = fixture.source(0);
    let session = file.file_stem().unwrap().to_str().unwrap();
    let current = "Current branch body ".repeat(8000);
    let message = |id: &str, parent: Option<&str>, text: &str| json!({"type":"assistant","uuid":id,"parentUuid":parent,"sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":text}});
    let mut side = message("side", Some("root"), "Unselected side chain");
    side["isSidechain"] = true.into();
    let records = vec![
        message("root", None, "Root input"),
        message("old", Some("root"), "Old branch must not appear"),
        message("current", Some("root"), &current),
        side,
    ];
    let source = records
        .into_iter()
        .map(|row| row.to_string() + "\n")
        .collect::<String>();
    fs::write(&file, &source).unwrap();
    let mut server = fixture.start();
    let job = archive(&mut server);
    let none = rpc(
        &mut server,
        5,
        "migration/history/branch/read",
        json!({"jobId":job}),
    );
    assert!(none["progress"].is_null());
    let prepared = rpc(
        &mut server,
        6,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let view = prepared["progress"]["viewId"].clone();
    assert_eq!(prepared["progress"]["stage"], "planned");
    assert_eq!(
        rpc(
            &mut server,
            7,
            "migration/history/branch/prepare",
            json!({"jobId":job})
        )["progress"]["viewId"],
        view
    );
    rpc(
        &mut server,
        8,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    let ready = wait_branch(&mut server, &job, &view);
    assert_eq!(ready["progress"]["totalItems"], 2);
    assert_eq!(ready["progress"]["structuralComplete"], true);
    assert!(
        !ready
            .to_string()
            .contains(fixture.root.path().to_str().unwrap())
    );
    assert!(!ready.to_string().contains("projectionFingerprint"));
    let page = rpc(
        &mut server,
        9,
        "migration/history/branch/page",
        json!({"jobId":job,"viewId":view}),
    );
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(page["items"][1]["record"]["record"], 2);
    assert!(!page.to_string().contains("Old branch must not appear"));
    assert!(!page.to_string().contains("Unselected side chain"));
    let first = rpc(
        &mut server,
        10,
        "migration/history/branch/text",
        json!({"jobId":job,"viewId":view,"position":1,"blockIndex":0}),
    );
    assert!(first["nextCursor"].is_string());
    let next = rpc(
        &mut server,
        11,
        "migration/history/branch/text",
        json!({"jobId":job,"viewId":view,"position":1,"blockIndex":0,"cursor":first["nextCursor"]}),
    );
    assert!(!next["text"].as_str().unwrap().is_empty());
    server.send(json!({"jsonrpc":"2.0","id":12,"method":"migration/history/branch/text","params":{"jobId":job,"viewId":view,"position":0,"blockIndex":0,"cursor":first["nextCursor"]}}));
    assert_eq!(
        server.response(12)["error"]["message"],
        "history_display_invalid_cursor"
    );
    server.send(json!({"jsonrpc":"2.0","id":13,"method":"migration/history/branch/text","params":{"jobId":job,"viewId":view,"position":1,"blockIndex":0,"record":1}}));
    assert_eq!(
        server.response(13)["error"]["message"],
        "migration_invalid_parameters"
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), source);
    fs::remove_file(file).unwrap();
    drop(server);
    let mut server = fixture.start();
    let restored = rpc(
        &mut server,
        14,
        "migration/history/branch/read",
        json!({"jobId":job}),
    );
    assert_eq!(restored["progress"], ready["progress"]);
    assert_eq!(
        rpc(
            &mut server,
            15,
            "migration/history/branch/page",
            json!({"jobId":job,"viewId":view})
        ),
        page
    );
    server.send(json!({"jsonrpc":"2.0","id":16,"method":"migration/history/branch/text","params":{"jobId":job,"viewId":view,"position":1,"blockIndex":0,"cursor":first["nextCursor"]}}));
    assert_eq!(
        server.response(16)["error"]["message"],
        "history_display_invalid_cursor"
    );
    assert_eq!(
        rpc(&mut server, 17, "thread/list", json!({}))["threads"],
        json!([])
    );
}

#[test]
fn branch_cancellation_and_resume_are_explicit_and_scoped_to_the_selected_view() {
    let fixture = Fixture::new();
    fixture.source(3);
    let mut server = fixture.start();
    let job = archive(&mut server);
    let prepared = rpc(
        &mut server,
        5,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let view = prepared["progress"]["viewId"].clone();
    assert_eq!(
        rpc(
            &mut server,
            6,
            "migration/history/branch/cancel",
            json!({"jobId":job,"viewId":view})
        )["cancelRequested"],
        true
    );
    rpc(
        &mut server,
        7,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let cancelled = loop {
        let value = rpc(
            &mut server,
            8,
            "migration/history/branch/read",
            json!({"jobId":job,"viewId":view}),
        );
        if value["progress"]["stage"] == "cancelled" && value["workerRunning"] == false {
            break value;
        }
        assert!(
            Instant::now() < deadline,
            "branch cancellation did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    server.send(json!({"jsonrpc":"2.0","id":9,"method":"migration/history/branch/run","params":{"jobId":job,"viewId":view}}));
    assert_eq!(
        server.response(9)["error"]["message"],
        "history_branch_resume_required"
    );
    rpc(
        &mut server,
        10,
        "migration/history/branch/resume",
        json!({"jobId":job,"viewId":view,"expectedSequence":cancelled["progress"]["sequence"]}),
    );
    rpc(
        &mut server,
        11,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    wait_branch(&mut server, &job, &view);
}

#[path = "branch_attachments_rpc.rs"]
mod attachments;

#[path = "tool_attachments_rpc.rs"]
mod tool_attachments;
