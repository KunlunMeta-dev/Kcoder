// Actual public setup while disabled, revision conflicts, and new-connection capability activation.
#[cfg(target_os = "linux")]
mod integrations_knowledge_settings {
    use super::*;
    fn call(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer, requested: bool) -> Value {
        let capabilities = if requested {
            json!({"knowledgeSettingsV1":true,"integrationScopeV1":true,"automationTemplatesV1":true})
        } else {
            json!({})
        };
        let result = call(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"actual-knowledge-feature-setup","version":"1"},"capabilities":{"experimental":capabilities}}),
        );
        assert!(result["error"].is_null(), "{result}");
        result["result"].clone()
    }
    fn start(
        workspace: &std::path::Path,
        settings: &std::path::Path,
        profile: &std::path::Path,
    ) -> TestAppServer {
        let parent = format!(
            "v1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(br#"{"version":1,"mode":"localOs"}"#)
        );
        let mut builder = TestAppServer::builder(workspace, settings)
            .config_dir(profile)
            .without_scenario()
            .env("KCODER_PRIVATE_RETENTION_PARENT_V1", parent);
        builder.training_mode = true;
        builder.spawn()
    }
    #[test]
    fn knowledge_feature_setup_is_explicit_narrow_and_requires_a_new_connection() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        let settings = profile.join("settings.json");
        write_fixture_provider_settings(&settings, "http://127.0.0.1:1/v1");
        let mut document: Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        document["integrations"] = json!({"knowledge":{"memory_center_enabled":false,"publications_enabled":false,"business_automation_enabled":false}});
        std::fs::write(&settings, serde_json::to_vec(&document).unwrap()).unwrap();
        let original = std::fs::read(&settings).unwrap();
        let mut first = start(&workspace, &settings, &profile);
        let capabilities = initialize(&mut first, true);
        assert_eq!(
            capabilities["capabilities"]["experimental"]["knowledgeSettingsV1"],
            true
        );
        assert_eq!(
            capabilities["capabilities"]["experimental"]["automationTemplatesV1"],
            false
        );
        let read = call(
            &mut first,
            2,
            "settings/integrations/knowledge/read",
            json!({}),
        );
        assert!(read["error"].is_null(), "{read}");
        assert_eq!(
            read["result"]["effective"]["businessAutomationEnabled"],
            false
        );
        assert_eq!(std::fs::read(&settings).unwrap(), original);
        let saved = call(
            &mut first,
            3,
            "settings/integrations/knowledge/save",
            json!({"feature":"subscriptions","enabled":true,"expectedRevision":read["result"]["revision"]}),
        );
        assert!(saved["error"].is_null(), "{saved}");
        assert_eq!(
            saved["result"]["effective"]["businessAutomationEnabled"],
            true
        );
        assert_eq!(
            saved["result"]["connection"]["businessAutomationEnabled"],
            false
        );
        assert_eq!(saved["result"]["restartRequired"], true);
        assert_eq!(saved["result"]["effective"]["memoryCenterEnabled"], false);
        assert_eq!(saved["result"]["effective"]["publicationsEnabled"], false);
        let bytes = std::fs::read(&settings).unwrap();
        let conflict = call(
            &mut first,
            4,
            "settings/integrations/knowledge/save",
            json!({"feature":"memoryCenter","enabled":true,"expectedRevision":read["result"]["revision"]}),
        );
        assert_eq!(
            conflict["error"]["message"],
            "KNOWLEDGE_SETTINGS_REVISION_CONFLICT"
        );
        assert_eq!(std::fs::read(&settings).unwrap(), bytes);
        first.shutdown_successfully();
        let mut fresh = start(&workspace, &settings, &profile);
        let capabilities = initialize(&mut fresh, true);
        assert_eq!(
            capabilities["capabilities"]["experimental"]["automationTemplatesV1"],
            true
        );
        let read = call(
            &mut fresh,
            2,
            "settings/integrations/knowledge/read",
            json!({}),
        );
        assert_eq!(
            read["result"]["connection"]["businessAutomationEnabled"],
            true
        );
        assert_eq!(read["result"]["restartRequired"], false);
        let threads = call(&mut fresh, 3, "thread/list", json!({}));
        assert!(threads["result"]["threads"].as_array().unwrap().is_empty());
        fresh.shutdown_successfully();
        let mut legacy = start(&workspace, &settings, &profile);
        initialize(&mut legacy, false);
        let rejected = call(
            &mut legacy,
            2,
            "settings/integrations/knowledge/save",
            json!({"feature":"memoryCenter","enabled":true,"expectedRevision":saved["result"]["revision"]}),
        );
        assert!(rejected["error"].is_object());
        assert_eq!(std::fs::read(&settings).unwrap(), bytes);
        legacy.shutdown_successfully();
    }

    #[test]
    fn memory_feature_first_enable_and_new_workspace_reach_actual_provider_without_a_saved_memory()
    {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let (endpoint, calls, fixture) = serving_fixture_decided(|_, request| {
            assert!(!request.to_string().contains("<reviewed-memory-turn-data>"));
            FixtureAnswer::Text("Completed with a verified empty memory source.".into())
        });
        let settings = profile.join("settings.json");
        write_fixture_provider_settings(&settings, &endpoint);
        let mut first = start(&workspace, &settings, &profile);
        initialize(&mut first, true);
        assert!(find_named_file(&profile, "memory-review.json").is_none());
        let read = call(
            &mut first,
            2,
            "settings/integrations/knowledge/read",
            json!({}),
        );
        let saved = call(
            &mut first,
            3,
            "settings/integrations/knowledge/save",
            json!({
                "feature":"memoryCenter", "enabled":true,
                "expectedRevision":read["result"]["revision"],
            }),
        );
        assert!(saved["error"].is_null(), "{saved}");
        assert_eq!(saved["result"]["effective"]["memoryCenterEnabled"], true);
        assert!(find_named_file(&profile, "memory-review.json").is_some());
        first.shutdown_successfully();

        for directory in ["workspace", "second-workspace"] {
            let workspace = root.path().join(directory);
            if !workspace.exists() {
                std::fs::create_dir(&workspace).unwrap();
            }
            let mut server = start(&workspace, &settings, &profile);
            initialize(&mut server, true);
            let started = call(&mut server, 2, "thread/start", json!({}));
            let thread = started["result"]["thread"]["id"].as_str().unwrap();
            let accepted = call(
                &mut server,
                3,
                "turn/start",
                json!({
                    "threadId":thread, "input":[{"type":"text","text":"Complete this bounded fixture."}],
                }),
            );
            assert!(accepted["error"].is_null(), "{accepted}");
            let started = server.wait_for_method("turn/started");
            assert!(
                started["params"]["turn"]["memorySnapshotId"].is_string(),
                "{started}"
            );
            let completed = server.wait_for_method("turn/completed");
            assert_eq!(
                completed["params"]["turn"]["status"], "completed",
                "{completed}"
            );
            server.shutdown_successfully();
        }
        assert_eq!(calls.lock().unwrap().len(), 2);
        fixture.join().unwrap();
    }
}
