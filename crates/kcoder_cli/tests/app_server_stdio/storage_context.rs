// Owned native app-server acceptance for the startup context; no model request is sent.
#[cfg(target_os = "linux")]
#[test]
fn storage_context_preserves_selected_native_scope_and_thread_across_restart() {
    use kcoder_types::{
        STORAGE_STARTUP_ENV, StorageConsumer, StorageLocationRecord, StorageStartupContext,
        integrations::core::{IntegrationOwner, IntegrationScope},
    };

    let owned = tempfile::tempdir().unwrap();
    let home = owned.path().join("home");
    let platform_config = home.join(".config");
    let data_root = owned.path().join("selected data");
    let cache_root = owned.path().join("selected cache");
    let workspace = owned.path().join("workspace");
    std::fs::create_dir_all(&platform_config).unwrap();
    std::fs::create_dir_all(&data_root).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    let settings = data_root.join("settings.json");
    write_test_settings(&settings);

    let record = StorageLocationRecord {
        version: 1,
        revision: 1,
        data_root: data_root.clone(),
        cache_root: cache_root.clone(),
        operation_id: None,
    };
    let location_file = kcoder_config::storage::storage_location_file(&home);
    let record_bytes = serde_json::to_vec(&record).unwrap();
    std::fs::write(&location_file, &record_bytes).unwrap();
    let startup_context = StorageStartupContext {
        version: 1,
        home: Some(home.clone()),
        platform_config: Some(platform_config.clone()),
        overrides: Default::default(),
        record: Some(record),
        consumer: StorageConsumer::Gateway,
        development: false,
    };
    let startup_context = serde_json::to_string(&startup_context).unwrap();
    let mut previous_owner = None;
    let mut previous_generation = None;
    let mut previous_thread = None;

    for _ in 0..2 {
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&data_root)
            .without_scenario()
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", &platform_config)
            .env("LOCALAPPDATA", &home.join(".local/share"))
            .env("XDG_CONFIG_HOME", &platform_config)
            .env("KCODER_CACHE_DIR", &cache_root)
            .env(STORAGE_STARTUP_ENV, &startup_context)
            .spawn();

        let initialized = initialize_integration_scope(&mut server, 1);
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["integrationScopeV1"], true,
            "{initialized}"
        );
        server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
        let scope_response = server.response(2);
        assert!(scope_response.get("error").is_none(), "{scope_response}");
        let scope: IntegrationScope =
            serde_json::from_value(scope_response["result"].clone()).unwrap();
        let owner = IntegrationOwner::from(&scope);
        assert!(!scope.account_id.is_empty(), "{scope_response}");
        assert!(!scope.identity_generation.is_empty(), "{scope_response}");

        let listed = integration_memory_request(
            &mut server,
            3,
            "integrations/memory/list",
            &scope_response["result"],
            None,
            None,
            json!({}),
        );
        assert_eq!(listed["result"]["status"], "completed", "{listed}");

        server.send(json!({
            "id":4,
            "method":"thread/start",
            "params":{"clientRequestId":"storage-context-owned-task"}
        }));
        let created = server.response(4);
        assert!(created.get("error").is_none(), "{created}");
        let thread = created["result"]["thread"]["id"]
            .as_str()
            .expect("created thread ID")
            .to_owned();

        if let Some(previous) = previous_owner.replace(owner.clone()) {
            assert_eq!(previous, owner);
        }
        if let Some(previous) = previous_generation.replace(scope.identity_generation.clone()) {
            assert_eq!(previous, scope.identity_generation);
        }
        if let Some(previous) = previous_thread.replace(thread.clone()) {
            assert_eq!(previous, thread);
        }

        server.shutdown_successfully();
        assert_eq!(std::fs::read(&location_file).unwrap(), record_bytes);
    }
}
