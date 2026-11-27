//! Actual app-server acceptance; package hooks/MCP/scripts remain inert throughout migration.
use super::*;
fn source_plugin(fixture: &Fixture) -> PathBuf {
    let root = fixture.claude.join("plugins/cache/fixture/sample/1.0.0");
    fs::create_dir_all(root.join(".claude-plugin")).unwrap();
    fs::create_dir_all(root.join("skills/check")).unwrap();
    fs::write(
        root.join("skills/check/SKILL.md"),
        "---\nname: check\ndescription: Read the supplied evidence\n---\nReport the evidence.",
    )
    .unwrap();
    let marker = fixture.root.path().join("source-command-must-not-run");
    fs::write(root.join(".claude-plugin/plugin.json"),json!({"name":"sample","version":"1.0.0","mcpServers":{"fixture":{"command":"must-not-run-plugin-source","env":{"REQUIRED_API_KEY":"${REQUIRED_API_KEY}"}}},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":format!("touch {}",marker.display())}]}]}}).to_string()).unwrap();
    fs::write(fixture.claude.join("plugins/installed_plugins.json"),json!({"version":2,"plugins":{"sample@fixture":[{"scope":"user","version":"1.0.0","installPath":root}]}}).to_string()).unwrap();
    root
}
fn response(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
    server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
    server.response(id)
}
fn plugin_wait(server: &mut TestAppServer, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let result = response(
            server,
            990,
            "migration/plugin/read",
            json!({"operationId":id}),
        );
        if let Some(result) = result.get("result")
            && result["workerRunning"] == false
        {
            return result.clone();
        }
        assert!(Instant::now() < deadline, "{result}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn plugin_rpc_runs_owned_default_disabled_install_and_undo_without_executing_source() {
    let fixture = Fixture::new();
    let package = source_plugin(&fixture);
    let original = kcoder_plugins::migration::package_revision(
        &package,
        kcoder_plugins::InstallLimits::default(),
        &kcoder_plugins::PluginCancellationToken::default(),
    )
    .unwrap();
    let mut server = fixture.start();
    let found = rpc(
        &mut server,
        900,
        "migration/plugin/discover",
        json!({"sources":["claude-code"]}),
    );
    assert_eq!(found["candidates"].as_array().unwrap().len(), 1);
    let operation = uuid::Uuid::new_v4().to_string();
    let planned = rpc(
        &mut server,
        901,
        "migration/plugin/plan",
        json!({"requestId":operation,"candidateId":found["candidates"][0]["candidateId"]}),
    );
    assert_eq!(planned["job"]["operationId"], operation);
    let ready = plugin_wait(&mut server, &operation);
    assert_eq!(ready["job"]["stage"], "ready");
    // The app-server bootstrap may initialize the empty runtime store; preparation must not install a plugin.
    assert!(
        kcoder_plugins::PluginStore::open_for_migration(&fixture.profile.join("plugin_store"))
            .unwrap()
            .installed_plugins()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        ready["job"]["readiness"],
        json!(["plugin_environment_required"])
    );
    assert!(!ready.to_string().contains("PRIVATE-AUTH-CANARY"));
    assert!(
        !fixture
            .root
            .path()
            .join("source-command-must-not-run")
            .exists()
    );
    let cancelled = rpc(
        &mut server,
        902,
        "migration/plugin/cancel",
        json!({"operationId":operation,"expectedSequence":ready["job"]["sequence"]}),
    );
    assert_eq!(cancelled["job"]["stage"], "cancelled");
    let resumed = rpc(
        &mut server,
        903,
        "migration/plugin/resume",
        json!({"operationId":operation,"expectedSequence":cancelled["job"]["sequence"]}),
    );
    assert_eq!(resumed["job"]["stage"], "ready");
    rpc(
        &mut server,
        904,
        "migration/plugin/apply",
        json!({"operationId":operation,"expectedSequence":resumed["job"]["sequence"]}),
    );
    let imported = plugin_wait(&mut server, &operation);
    assert_eq!(imported["job"]["stage"], "imported");
    let native =
        kcoder_plugins::PluginStore::open_for_migration(&fixture.profile.join("plugin_store"))
            .unwrap();
    let target = imported["job"]["targetId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let record = native.read(&target).unwrap().unwrap();
    assert!(!record.enabled_by_default);
    assert_eq!(
        kcoder_plugins::migration::package_revision(
            &package,
            kcoder_plugins::InstallLimits::default(),
            &kcoder_plugins::PluginCancellationToken::default()
        )
        .unwrap()
        .sha256,
        original.sha256
    );
    assert!(
        !fixture
            .root
            .path()
            .join("source-command-must-not-run")
            .exists()
    );
    drop(server);
    let mut server = fixture.start();
    let read = rpc(
        &mut server,
        905,
        "migration/plugin/read",
        json!({"operationId":operation}),
    );
    assert_eq!(read["job"]["stage"], "imported");
    fs::remove_dir_all(&package).unwrap();
    rpc(
        &mut server,
        906,
        "migration/plugin/undo",
        json!({"operationId":operation,"expectedSequence":read["job"]["sequence"]}),
    );
    let undone = plugin_wait(&mut server, &operation);
    assert_eq!(undone["job"]["stage"], "undone");
    assert_eq!(undone["job"]["imported"], true);
    assert!(native.read(&target).unwrap().is_none());
    assert!(
        fixture
            .profile
            .join("plugin-migrations-v1")
            .join(&operation)
            .join("job.json")
            .is_file()
    );
    assert!(
        !fixture
            .root
            .path()
            .join("source-command-must-not-run")
            .exists()
    );
}
#[test]
fn plugin_rpc_rejects_client_path_authority_and_preserves_user_enabled_output() {
    let fixture = Fixture::new();
    source_plugin(&fixture);
    let mut server = fixture.start();
    let invalid = response(
        &mut server,
        910,
        "migration/plugin/plan",
        json!({"requestId":uuid::Uuid::new_v4().to_string(),"candidateId":"unknown","sourcePath":fixture.claude}),
    );
    assert!(invalid.get("error").is_some());
    assert!(!invalid.to_string().contains("PRIVATE-AUTH-CANARY"));
    assert!(!fixture.profile.join("plugin-migrations-v1").exists());
    let found = rpc(
        &mut server,
        911,
        "migration/plugin/discover",
        json!({"sources":["claude-code"]}),
    );
    let operation = uuid::Uuid::new_v4().to_string();
    rpc(
        &mut server,
        912,
        "migration/plugin/plan",
        json!({"requestId":operation,"candidateId":found["candidates"][0]["candidateId"]}),
    );
    let ready = plugin_wait(&mut server, &operation);
    rpc(
        &mut server,
        913,
        "migration/plugin/apply",
        json!({"operationId":operation,"expectedSequence":ready["job"]["sequence"]}),
    );
    let imported = plugin_wait(&mut server, &operation);
    let target = imported["job"]["targetId"].as_str().unwrap();
    let settings = kcoder_config::ProfileSettingsFile::new(
        kcoder_config::PrivateDirectory::open_existing(&fixture.profile).unwrap(),
    )
    .unwrap();
    settings
        .update(|settings| {
            settings["plugins"] = json!({"installed":{target:{"enabled":true}}});
            Ok(())
        })
        .unwrap();
    rpc(
        &mut server,
        914,
        "migration/plugin/undo",
        json!({"operationId":operation,"expectedSequence":imported["job"]["sequence"]}),
    );
    let result = plugin_wait(&mut server, &operation);
    assert_eq!(result["job"]["stage"], "imported");
    assert_eq!(
        result["job"]["failureCode"],
        "plugin_migration_user_policy_changed"
    );
    assert_eq!(
        result["workerError"],
        "plugin_migration_user_policy_changed"
    );
    let native =
        kcoder_plugins::PluginStore::open_for_migration(&fixture.profile.join("plugin_store"))
            .unwrap();
    assert!(native.read(&target.parse().unwrap()).unwrap().is_some());
    drop(server);
    let mut server = fixture.start();
    let read = rpc(
        &mut server,
        915,
        "migration/plugin/read",
        json!({"operationId":operation}),
    );
    assert_eq!(
        read["job"]["failureCode"],
        "plugin_migration_user_policy_changed"
    );
    assert!(native.read(&target.parse().unwrap()).unwrap().is_some());
}

fn batch_plugin_wait(server: &mut TestAppServer, job: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = rpc(server, 1090, "migration/batch/read", json!({"jobId":job}));
        if state["workerRunning"] == false {
            return state["state"].clone();
        }
        assert!(Instant::now() < deadline, "owned plugin batch must settle");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn prepared_plugin_enters_one_batch_after_restart_without_live_source_discovery() {
    let fixture = Fixture::new();
    let package = source_plugin(&fixture);
    let original = fs::read(package.join(".claude-plugin/plugin.json")).unwrap();
    let mut server = fixture.start();
    let found = rpc(
        &mut server,
        1000,
        "migration/plugin/discover",
        json!({"sources":["claude-code"]}),
    );
    let operation = uuid::Uuid::new_v4().to_string();
    rpc(
        &mut server,
        1001,
        "migration/plugin/plan",
        json!({"requestId":operation,"candidateId":found["candidates"][0]["candidateId"]}),
    );
    let ready = plugin_wait(&mut server, &operation);
    assert_eq!(ready["job"]["stage"], "ready");
    let selection = json!({"operationId":operation,"expectedSequence":ready["job"]["sequence"]});
    drop(server);
    let mut server = fixture.start();
    // This connection has no SourceRegistry catalog: a durable prepared package is its selector.
    let duplicate = response(
        &mut server,
        1002,
        "migration/batch/scan",
        json!({"sourceIds":[],"pluginSources":[selection,selection]}),
    );
    assert!(duplicate.get("error").is_some());
    let stale = response(
        &mut server,
        1003,
        "migration/batch/scan",
        json!({"sourceIds":[],"pluginSources":[{"operationId":operation,"expectedSequence":ready["job"]["sequence"].as_u64().unwrap()+1}]}),
    );
    assert!(stale.get("error").is_some());
    let records = rpc(&mut server, 1004, "migration/jobs/list", json!({}));
    assert!(records["jobs"].as_array().unwrap().is_empty());
    let scanned = rpc(
        &mut server,
        1005,
        "migration/batch/scan",
        json!({"sourceIds":[],"pluginSources":[selection]}),
    );
    assert_eq!(scanned["job"]["totalItems"], 1);
    let job = scanned["job"]["jobId"].clone();
    let items = rpc(&mut server, 1006, "migration/items", json!({"jobId":job}));
    let item = items["items"][0]["id"].clone();
    assert_eq!(items["items"][0]["category"], "plugin");
    let planned = rpc(
        &mut server,
        1007,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],"choices":[{"kind":"plugin","itemId":item,"targetName":"rpc-office"}]}),
    );
    assert!(
        kcoder_plugins::PluginStore::open_for_migration(&fixture.profile.join("plugin_store"))
            .unwrap()
            .installed_plugins()
            .unwrap()
            .is_empty()
    );
    let plan = planned["batch"]["planId"].clone();
    rpc(
        &mut server,
        1008,
        "migration/batch/run",
        json!({"jobId":job,"planId":plan,"requestId":"confirmed-plugin-batch","expectedSequence":planned["job"]["sequence"],"mode":"apply"}),
    );
    let applied = batch_plugin_wait(&mut server, &job);
    assert_eq!(applied["job"]["committedItems"], 1);
    assert_eq!(applied["job"]["status"], "completed_with_issues");
    let child = rpc(
        &mut server,
        1009,
        "migration/plugin/read",
        json!({"operationId":operation}),
    );
    assert_eq!(child["job"]["stage"], "imported");
    assert_eq!(child["job"]["batchJobId"], job);
    assert!(
        child["job"]["targetId"]
            .as_str()
            .unwrap()
            .starts_with("rpc-office@")
    );
    assert_eq!(
        fs::read(package.join(".claude-plugin/plugin.json")).unwrap(),
        original
    );
    let native =
        kcoder_plugins::PluginStore::open_for_migration(&fixture.profile.join("plugin_store"))
            .unwrap();
    assert!(!native.installed_plugins().unwrap()[0].enabled_by_default);
    let standalone = response(
        &mut server,
        1010,
        "migration/plugin/undo",
        json!({"operationId":operation,"expectedSequence":child["job"]["sequence"]}),
    );
    assert!(
        standalone.get("error").is_some(),
        "standalone calls cannot cross a batch claim"
    );
    rpc(
        &mut server,
        1011,
        "migration/batch/run",
        json!({"jobId":job,"planId":plan,"requestId":"undo-plugin-batch","expectedSequence":applied["job"]["sequence"],"mode":"rollback"}),
    );
    let undone = batch_plugin_wait(&mut server, &job);
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert!(native.installed_plugins().unwrap().is_empty());
    assert!(
        !fixture
            .root
            .path()
            .join("source-command-must-not-run")
            .exists()
    );
}
