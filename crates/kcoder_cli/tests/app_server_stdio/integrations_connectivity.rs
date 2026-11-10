// Direct stdio resource discovery cannot create a Gateway-owned application host.
#[cfg(target_os = "linux")]
mod integrations_connectivity {
    use super::*;
    fn call(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer, expected: bool) -> Value {
        let reply = call(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"actual-native-main-controls","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"connectivityV1":true}}}),
        );
        assert_eq!(
            reply["result"]["capabilities"]["experimental"]["connectivityV1"], expected,
            "{reply}"
        );
        call(server, 2, "integrations/scope/read", json!({}))["result"].clone()
    }
    fn request(scope: &Value, id: &str, payload: Value, operation: Option<&str>) -> Value {
        let mut request = json!({"contractVersion":"parallel-v1","requestId":id,"scope":scope,"timeoutMs":30000,"payload":payload});
        if let Some(operation) = operation {
            request["operationId"] = json!(operation);
        }
        request
    }
    fn setup(
        root: &std::path::Path,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let profile = root.join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        write_fixture_provider_settings(&settings, "http://127.0.0.1:1");
        let mut value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        value["credential_store"] = json!("file");
        value["session_memory"] = json!({"enabled":false});
        value["integrations"] = json!({"connectivity":{"enabled":false}});
        std::fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
        (workspace, profile, settings)
    }
    #[test]
    fn actual_main_public_control_cannot_be_enabled_by_scope_or_json_without_native_launch() {
        let root = tempfile::tempdir().unwrap();
        let (workspace, profile, settings) = setup(root.path());
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario()
            .spawn();
        let scope = initialize(&mut server, false);
        let reply = call(
            &mut server,
            3,
            "integrations/connectivity/listConnections",
            request(
                &scope,
                "no-native-launch",
                json!({"category":"applications","limit":10}),
                None,
            ),
        );
        assert!(reply["error"].is_object(), "{reply}");
        server.shutdown_successfully();
    }
    #[test]
    fn direct_stdio_catalog_requires_gateway_for_application_mutations() {
        let root = tempfile::tempdir().unwrap();
        let (workspace, profile, settings) = setup(root.path());
        let mut enabled: Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        enabled["integrations"]["connectivity"]["enabled"] = json!(true);
        // Enabling connectivity also enables native services, as the settings save does.
        enabled["integrations"]["services"] = json!({"enabled": true});
        std::fs::write(&settings, serde_json::to_vec(&enabled).unwrap()).unwrap();
        let node = which::which("node").unwrap().canonicalize().unwrap();
        let stage = root.path().join("sealed-application-resources");
        let script = kcoder_test_harness::workspace_root()
            .expect("resolve current workspace")
            .join("apps/kcoder-channel-host/scripts/stage-native-resources.mjs");
        let output = std::process::Command::new(&node)
            .arg(script)
            .arg(&stage)
            .arg(&node)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "staging failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let startup: Value = serde_json::from_slice(&output.stdout).unwrap();
        let startup = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&startup).unwrap());
        let parent = format!(
            "v1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(br#"{"version":1,"mode":"localOs"}"#)
        );
        let builder = || {
            TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .env("KCODER_PRIVATE_RETENTION_PARENT_V1", &parent)
                .env("KCODER_NATIVE_CONNECTIVITY_BINDING_V1", &startup)
        };
        let mut server = builder().spawn();
        let scope = initialize(&mut server, true);
        let before = std::fs::read_dir(&profile)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        let cold = call(
            &mut server,
            3,
            "integrations/connectivity/listConnections",
            request(
                &scope,
                "cold-main-read",
                json!({"category":"applications","limit":10}),
                None,
            ),
        );
        assert_eq!(cold["result"]["status"], "completed", "{cold}");
        assert_eq!(
            cold["result"]["result"]["connectionObservationState"],
            "unknown"
        );
        // The application host catalog has no platform-channel entries.
        assert_eq!(
            cold["result"]["result"]["catalog"]["applications"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            cold["result"]["result"]["reasonCode"],
            "CONNECTIVITY_STORE_NOT_OBSERVED"
        );
        let after = std::fs::read_dir(&profile)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(before, after, "cold read never creates native/Node stores");
        let saved = call(
            &mut server,
            4,
            "integrations/connectivity/prepareConnectionAction",
            request(
                &scope,
                "save-config",
                json!({
            "action":"save","connectionId":"owned-config-only","kind":"tencent_docs","label":"Owned application config",
            "configuration":{"mcpServerName":"owned-docs-source"},"resourceGrants":[]}),
                Some("owned-explicit-config"),
            ),
        );
        // Resource discovery is supported, but a direct stdio connection has no
        // Gateway-owned host. It must not create one or persist configuration.
        assert_eq!(saved["result"]["status"], "unknown", "{saved}");
        assert_eq!(
            saved["result"]["error"]["code"],
            "CONNECTIVITY_NATIVE_UNAVAILABLE",
            "{saved}"
        );
        let after_mutation = std::fs::read_dir(&profile)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(before, after_mutation, "no host or stores are initialized");
        let entry = stage.join("src/applications/stdio.mjs");
        let original_entry = std::fs::read(&entry).unwrap();
        let mut changed_entry = original_entry.clone();
        changed_entry.extend_from_slice(b"\n// Controlled resource identity replacement.\n");
        std::fs::write(&entry, changed_entry).unwrap();
        let changed = call(
            &mut server,
            6,
            "integrations/connectivity/listConnections",
            request(
                &scope,
                "changed-resource-read",
                json!({"category":"applications","limit":10}),
                None,
            ),
        );
        // An observed resource identity is retained within this connection;
        // ordinary catalog reads do not repeat the cold bundle hash.
        assert_eq!(changed["result"]["status"], "completed", "{changed}");
        server.shutdown_successfully();
        // A new load must verify the on-disk bytes and fail closed when they changed.
        let mut tampered = builder().spawn();
        let scope = initialize(&mut tampered, true);
        let refused = call(
            &mut tampered,
            3,
            "integrations/connectivity/listConnections",
            request(
                &scope,
                "changed-resource-launch",
                json!({"category":"applications","limit":10}),
                None,
            ),
        );
        assert_eq!(refused["result"]["status"], "unavailable", "{refused}");
        tampered.shutdown_successfully();
        std::fs::write(&entry, original_entry).unwrap();
        let mut reopened = builder().spawn();
        let scope = initialize(&mut reopened, true);
        let listed = call(
            &mut reopened,
            3,
            "integrations/connectivity/listConnections",
            request(
                &scope,
                "reopened-main-list",
                json!({"category":"applications","limit":10}),
                None,
            ),
        );
        assert_eq!(listed["result"]["status"], "completed", "{listed}");
        assert_eq!(
            listed["result"]["result"]["items"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        reopened.shutdown_successfully();
    }
}
