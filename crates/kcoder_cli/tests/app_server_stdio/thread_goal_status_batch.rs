use super::*;

pub(super) fn private_temp() -> tempfile::TempDir {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    }
    #[cfg(windows)]
    {
        let temp = tempfile::tempdir().unwrap();
        kcoder_config::PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .verify_private_directory()
            .unwrap();
        temp
    }
}

pub(super) fn initialize(server: &mut TestAppServer, id: i64, offer: bool) -> Value {
    server.send(json!({"jsonrpc":"2.0","id":id,"method":"initialize","params":{
        "protocolVersion":"2026-07-27", "clientInfo":{"name":"goal-batch-fixture","version":"1"},
        "capabilities":{"experimental":{"threadGoalStatusBatchV1":offer}}
    }}));
    server.response(id)
}

pub(super) fn builder(
    workspace: &std::path::Path,
    settings: &std::path::Path,
    config: &std::path::Path,
    temp: &std::path::Path,
) -> TestAppServerBuilder {
    let mut builder = TestAppServer::builder(workspace, settings)
        .config_dir(config)
        .temp_dir(temp)
        .env("KCODER_TRUST_ALL", "0");
    // Keep this subprocess test independent of project plugin discovery.
    builder.training_mode = true;
    #[cfg(any(target_os = "linux", windows))]
    let builder = if let Some(binary) = std::env::var_os("KCODER_GOAL_TEST_BIN") {
        builder.binary(std::path::Path::new(&binary))
    } else {
        builder
    };
    builder
}

#[test]
#[ignore = "requires an isolated owned profile and controlled native CLI binary"]
fn goal_batch_real_stdio_negotiation_and_per_thread_results() {
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

    let mut legacy = builder(&workspace, &settings, &config, temp.path())
        .without_scenario()
        .discard_stderr()
        .spawn();
    let init = initialize(&mut legacy, 1, false);
    assert_eq!(
        init["result"]["capabilities"]["experimental"]["threadGoalStatusBatchV1"], false,
        "{init}"
    );
    legacy.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/goal/status/readMany","params":{"threadIds":["missing"]}}));
    let refused = legacy.response(2);
    assert_eq!(refused["error"]["code"], -32602, "{refused}");
    legacy.shutdown_successfully();

    let mut server = builder(&workspace, &settings, &config, temp.path())
        .scenario("full-turn")
        .stream_delay_ms("1")
        .subagent_stream_delay_ms("0")
        .followup_stream_delay_ms("0")
        .discard_stderr()
        .spawn();
    let init = initialize(&mut server, 3, true);
    assert_eq!(
        init["result"]["capabilities"]["experimental"]["threadGoalStatusBatchV1"], true,
        "{init}"
    );
    server.send(json!({"jsonrpc":"2.0","id":4,"method":"thread/start","params":{}}));
    let started = server.response(4);
    assert!(started.get("error").is_none(), "{started}");
    let thread = started["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"jsonrpc":"2.0","id":5,"method":"turn/start","params":{
            "threadId":thread,"input":[{"type":"text","text":"persist the fixture"}]
        }}),
    );
    let turn = server.response(5);
    assert!(turn.get("error").is_none(), "{turn}");
    assert_eq!(
        server.wait_for_method("turn/completed")["params"]["turn"]["status"],
        "completed"
    );
    server.send(json!({"jsonrpc":"2.0","id":6,"method":"thread/goal/set","params":{"threadId":thread,"objective":"observe this Goal"}}));
    let goal = server.response(6);
    assert!(goal.get("error").is_none(), "{goal}");
    server.send(json!({"jsonrpc":"2.0","id":7,"method":"thread/goal/status/readMany","params":{"threadIds":[thread,"missing"]}}));
    let result = server.response(7);
    assert_eq!(
        result["result"]["observations"],
        json!([
            {"threadId":thread,"availability":"available","status":"active"},
            {"threadId":"missing","availability":"unavailable"}
        ]),
        "{result}"
    );
    server.send(json!({"jsonrpc":"2.0","id":8,"method":"thread/goal/status/readMany","params":{"threadIds":[thread,thread]}}));
    assert_eq!(server.response(8)["error"]["code"], -32602);
    server.shutdown_successfully();
}
