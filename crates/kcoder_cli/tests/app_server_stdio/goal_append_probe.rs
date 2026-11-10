use super::thread_goal_status_batch::{builder, initialize, private_temp};
use super::*;

fn source_snapshot(history: &std::path::Path) -> Value {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(history.parent().unwrap().join(".kcoder-history.lock"))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match FileExt::try_lock_shared(&lock) {
            Ok(()) => break,
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("fixture history lock is unavailable: {error}"),
        }
    }
    let bytes = std::fs::read(history.with_extension("hctl").join("source.json")).unwrap();
    FileExt::unlock(&lock).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
#[ignore = "requires an isolated owned profile and controlled native CLI binary"]
fn real_goal_followup_reports_actual_source_receipt_after_assistant_append() {
    let temp = private_temp();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(workspace.join("AGENTS.md"), "").unwrap();
    let specs = workspace.join(".kcoder").join("specs");
    std::fs::create_dir_all(&specs).unwrap();
    std::fs::write(
        specs.join("config.yaml"),
        "schema: kcoder-spec-driven-superpowers\n",
    )
    .unwrap();
    let marketplaces = workspace.join(".agents").join("plugins");
    std::fs::create_dir_all(&marketplaces).unwrap();
    std::fs::write(
        marketplaces.join("marketplace.json"),
        r#"{"name":"owned-empty","plugins":[]}"#,
    )
    .unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    kcoder_config::FolderTrustStore::load(&config)
        .never(&workspace)
        .unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut settings_json: Value =
        serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    settings_json["goal_max_auto_continuations"] = json!(0);
    std::fs::write(&settings, serde_json::to_vec(&settings_json).unwrap()).unwrap();

    let mut server = builder(&workspace, &settings, &config, temp.path())
        .scenario("full-turn")
        .stream_delay_ms("1")
        .subagent_stream_delay_ms("0")
        .followup_stream_delay_ms("0")
        .discard_stderr()
        .spawn();
    assert_eq!(
        initialize(&mut server, 1, true)["result"]["capabilities"]["experimental"]["threadGoalStatusBatchV1"],
        true
    );
    server.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let start = server.response(2);
    let thread = start["result"]["thread"]["id"].as_str().unwrap().to_owned();
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"first owned input"}]}}));
    assert!(server.response(3).get("error").is_none());
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/goal/set","params":{"threadId":thread,"objective":"keep the owned fixture active"}}));
    assert!(server.response(4).get("error").is_none());
    let history =
        wait_for_named_file(&config, &format!("{thread}.jsonl"), Duration::from_secs(5)).unwrap();
    let initial = source_snapshot(&history);
    assert_eq!(initial["commit"]["last_operation"]["kind"], "metadata");
    let previous_bytes = std::fs::metadata(&history).unwrap().len();
    server.send(json!({"jsonrpc":"2.0","id":5,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"second owned input"}]}}));
    assert!(server.response(5).get("error").is_none());
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );
    let new_bytes = std::fs::metadata(&history).unwrap().len();
    assert!(
        new_bytes > previous_bytes,
        "the real follow-up must append history"
    );
    for (offset, request_id, phase) in [(0_u64, 10_i64, "immediate"), (200, 11, "after-200ms")] {
        if offset != 0 {
            std::thread::sleep(Duration::from_millis(offset));
        }
        let before = source_snapshot(&history);
        server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/goal/status/readMany","params":{"threadIds":[thread]}}));
        let result = server.response(request_id);
        let after = source_snapshot(&history);
        let kind = after["commit"]["last_operation"]["kind"]
            .as_str()
            .unwrap_or("unknown");
        let availability = result["result"]["observations"][0]["availability"]
            .as_str()
            .unwrap_or("invalid");
        let stable = before == after;
        eprintln!(
            "goal-followup phase={phase} appended_bytes={} last_operation={kind} stable={stable} availability={availability}",
            new_bytes - previous_bytes
        );
        assert!(matches!(availability, "available" | "unavailable"));
        if phase == "after-200ms" {
            assert!(stable, "the source must settle for the owned fixture");
            assert_eq!(
                kind, "append",
                "the follow-up must exercise a retained metadata receipt"
            );
            assert_eq!(availability, "available", "{result}");
            assert_eq!(
                result["result"]["observations"][0]["status"], "active",
                "{result}"
            );
        }
    }
    server.shutdown_successfully();
    let mut restarted = builder(&workspace, &settings, &config, temp.path())
        .scenario("full-turn")
        .discard_stderr()
        .spawn();
    assert_eq!(
        initialize(&mut restarted, 20, true)["result"]["capabilities"]["experimental"]["threadGoalStatusBatchV1"],
        true
    );
    restarted.send(json!({"jsonrpc":"2.0","id":21,"method":"thread/goal/status/readMany","params":{"threadIds":[thread]}}));
    let result = restarted.response(21);
    assert_eq!(
        result["result"]["observations"][0]["availability"], "unavailable",
        "restart has no original live receipt: {result}"
    );
    restarted.shutdown_successfully();
}
