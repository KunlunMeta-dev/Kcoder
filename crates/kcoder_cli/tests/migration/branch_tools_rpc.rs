use super::*;
fn wait_tools(server: &mut TestAppServer, job: &str, view: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = rpc(
            server,
            40,
            "migration/history/branch/tools/read",
            json!({"jobId":job,"viewId":view}),
        );
        if value["state"]["run"]["stage"] == "ready"
            && !value["state"]["workerRunning"].as_bool().unwrap()
        {
            return value;
        }
        assert_ne!(value["state"]["run"]["stage"], "failed", "{value}");
        assert!(Instant::now() < deadline, "{value}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn historical_tool_correlation_round_trips_without_running_the_source_command_and_survives_restart()
{
    let fixture = Fixture::new();
    let path = fixture.source(0);
    let session = path.file_stem().unwrap().to_str().unwrap();
    let marker = fixture.workspace.join("NEVER_RUN");
    let records = vec![
        json!({"type":"assistant","uuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"c","name":"Bash","input":{"command":format!("touch {}",marker.display())}}]}}),
        json!({"type":"user","uuid":"result","parentUuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c","content":"Historical received result"}]}}),
    ];
    fs::write(
        &path,
        records
            .into_iter()
            .map(|row| row.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let mut server = fixture.start();
    let job = archive(&mut server);
    let prepared = rpc(
        &mut server,
        5,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let view = prepared["progress"]["viewId"].clone();
    rpc(
        &mut server,
        6,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    wait_branch(&mut server, &job, &view);
    let before = rpc(
        &mut server,
        7,
        "migration/history/branch/tools/read",
        json!({"jobId":job,"viewId":view}),
    );
    assert!(before["state"]["run"].is_null());
    rpc(
        &mut server,
        8,
        "migration/history/branch/tools/run",
        json!({"jobId":job,"viewId":view}),
    );
    let ready = wait_tools(&mut server, &job, &view);
    assert_eq!(ready["state"]["progress"]["recordedLinks"], 1);
    assert_eq!(ready["state"]["progress"]["sealed"], true);
    let page = rpc(
        &mut server,
        9,
        "migration/history/branch/tools/page",
        json!({"jobId":job,"viewId":view}),
    );
    assert_eq!(page["links"][0]["status"], "linked");
    assert_eq!(page["links"][0]["outcome"], "recorded_result");
    assert_eq!(page["links"][0]["call"]["record"], 0);
    assert_eq!(page["links"][0]["result"]["record"], 1);
    assert!(!marker.exists());
    fs::remove_file(path).unwrap();
    drop(server);
    let mut server = fixture.start();
    assert_eq!(
        rpc(
            &mut server,
            10,
            "migration/history/branch/tools/page",
            json!({"jobId":job,"viewId":view})
        ),
        page
    );
    assert_eq!(
        rpc(
            &mut server,
            11,
            "migration/history/branch/tools/run",
            json!({"jobId":job,"viewId":view})
        )["state"]["progress"],
        ready["state"]["progress"]
    );
    server.send(json!({"jsonrpc":"2.0","id":12,"method":"migration/history/branch/tools/page","params":{"jobId":job,"viewId":view,"record":1}}));
    assert_eq!(
        server.response(12)["error"]["message"],
        "migration_invalid_parameters"
    );
    assert!(!marker.exists());
    assert_eq!(
        rpc(&mut server, 13, "thread/list", json!({}))["threads"],
        json!([])
    );
}

#[test]
fn correlation_cancel_before_run_is_durable_and_resume_checks_its_run_sequence() {
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
    rpc(
        &mut server,
        6,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    wait_branch(&mut server, &job, &view);
    rpc(
        &mut server,
        7,
        "migration/history/branch/tools/cancel",
        json!({"jobId":job,"viewId":view}),
    );
    rpc(
        &mut server,
        8,
        "migration/history/branch/tools/run",
        json!({"jobId":job,"viewId":view}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let stopped = loop {
        let value = rpc(
            &mut server,
            9,
            "migration/history/branch/tools/read",
            json!({"jobId":job,"viewId":view}),
        );
        if value["state"]["run"]["stage"] == "cancelled" && value["state"]["workerRunning"] == false
        {
            break value;
        }
        assert!(Instant::now() < deadline, "correlation did not cancel");
        std::thread::sleep(Duration::from_millis(10));
    };
    server.send(json!({"jsonrpc":"2.0","id":10,"method":"migration/history/branch/tools/run","params":{"jobId":job,"viewId":view}}));
    assert_eq!(
        server.response(10)["error"]["message"],
        "history_tool_links_resume_required"
    );
    rpc(
        &mut server,
        11,
        "migration/history/branch/tools/resume",
        json!({"jobId":job,"viewId":view,"expectedSequence":stopped["state"]["run"]["sequence"]}),
    );
    wait_tools(&mut server, &job, &view);
}
