// Actual default-profile policy edits use finite RPCs, native CAS and original operation receipts.
#[cfg(target_os = "linux")]
mod integrations_model_policy_settings {
    use super::*;
    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer, settings: bool) -> Value {
        let response = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"policy-settings-native","version":"1"},"capabilities":{"experimental":{"integrationScopeV1":true,"modelPoliciesV1":true,"modelPolicySettingsV1":settings}}}),
        );
        assert_eq!(
            response["result"]["capabilities"]["experimental"]["modelPolicySettingsV1"], settings,
            "{response}"
        );
        rpc(server, 2, "integrations/scope/read", json!({}))["result"].clone()
    }
    fn envelope(scope: &Value, payload: Value) -> Value {
        json!({"contractVersion":"parallel-v1","requestId":"model-settings-request","scope":scope,"timeoutMs":10000,"payload":payload})
    }
    fn no_threads(server: &mut TestAppServer, id: i64) {
        let value = rpc(server, id, "thread/list", json!({}));
        assert_eq!(
            value["result"]["threads"].as_array().unwrap().len(),
            0,
            "{value}"
        );
    }
    fn setup() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
        Value,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let directory = kcoder_config::PrivateDirectory::open_existing(temp.path()).unwrap();
        directory
            .create_private_child(std::ffi::OsStr::new("profile"))
            .unwrap();
        directory
            .create_private_child(std::ffi::OsStr::new("workspace"))
            .unwrap();
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        let path = profile.join("settings.json");
        let document = json!({"active_provider":"ActualConfigured","model":"ExactModel","session_memory":{"enabled":false},"providers":{"ActualConfigured":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":"http://127.0.0.1:9/v1","default_model":"ExactModel","context_window_tokens":128000,"max_output_tokens":128,"output_headroom_tokens":128,"discover_models":false}}});
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        (temp, profile, workspace, path, document)
    }
    fn builder(
        workspace: &std::path::Path,
        path: &std::path::Path,
        profile: &std::path::Path,
    ) -> TestAppServerBuilder {
        let mut builder = TestAppServer::builder(workspace, path)
            .config_dir(profile)
            .without_scenario();
        builder.training_mode = true;
        builder
    }
    #[test]
    fn actual_public_policy_settings_cas_and_original_receipts_survive_reconnect_without_model_or_task_creation()
     {
        let (_temp, profile, workspace, path, original) = setup();
        let mut server = builder(&workspace, &path, &profile).spawn();
        let scope = initialize(&mut server, true);
        let read = rpc(
            &mut server,
            3,
            "integrations/models/settings/read",
            envelope(&scope, json!({})),
        );
        assert_eq!(read["result"]["status"], "completed", "{read}");
        let before = read["result"]["result"].clone();
        assert_eq!(before["policies"], json!([]));
        assert_eq!(before["models"][0]["provider"], "ActualConfigured");
        assert_eq!(before["modelsTruncated"], false);
        no_threads(&mut server, 4);
        let policies = json!([{"id":"user.explicit","title":"User ordered policy","enabled":true,"candidates":[{"provider":"ActualConfigured","model":"ExactModel","enabled":true}]}]);
        let mut save = envelope(&scope, json!({"policies":policies}));
        save["operationId"] = json!("original-policy-settings-save");
        save["expectedRevision"] = before["revision"].clone();
        let result = rpc(
            &mut server,
            5,
            "integrations/models/settings/save",
            save.clone(),
        );
        assert_eq!(result["result"]["status"], "completed", "{result}");
        let result = result["result"]["result"].clone();
        assert_eq!(result["operation"]["phase"], "completed");
        assert_eq!(
            result["operation"]["entityRef"]["kind"],
            "model_policy_configuration"
        );
        assert_eq!(
            result["operation"]["entityRef"]["revision"],
            result["current"]["revision"]
        );
        assert_ne!(result["current"]["revision"], before["revision"]);
        let operation = rpc(
            &mut server,
            6,
            "integrations/models/settings/readOperation",
            envelope(
                &scope,
                json!({"operationId":"original-policy-settings-save"}),
            ),
        );
        assert_eq!(
            operation["result"]["result"]["receipt"],
            result["operation"]
        );
        let catalog = rpc(
            &mut server,
            7,
            "integrations/models/readPolicies",
            envelope(&scope, json!({})),
        );
        let reference = catalog["result"]["result"]["policies"][0]["reference"].clone();
        assert_eq!(reference["id"], "user.explicit");
        let preview = rpc(
            &mut server,
            8,
            "integrations/models/resolveSelection",
            envelope(
                &scope,
                json!({"selection":{"kind":"auto_policy","id":reference["id"],"version":reference["version"]}}),
            ),
        );
        assert_eq!(
            preview["result"]["result"]["model"]["modelId"], "ExactModel",
            "{preview}"
        );
        assert_eq!(
            preview["result"]["result"]["budget"]["reservationState"],
            "not_reserved"
        );
        no_threads(&mut server, 9);
        server.shutdown_successfully();
        let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["providers"], original["providers"]);
        assert_eq!(document["model"], original["model"]);
        let mut restored = builder(&workspace, &path, &profile).spawn();
        let current_scope = initialize(&mut restored, true);
        let current = rpc(
            &mut restored,
            3,
            "integrations/models/settings/read",
            envelope(&current_scope, json!({})),
        );
        assert_eq!(current["result"]["result"]["policies"], policies);
        let receipt = rpc(
            &mut restored,
            4,
            "integrations/models/settings/readOperation",
            envelope(
                &current_scope,
                json!({"operationId":"original-policy-settings-save"}),
            ),
        );
        assert_eq!(receipt["result"]["result"]["receipt"], result["operation"]);
        save["scope"] = current_scope.clone();
        let same = rpc(
            &mut restored,
            5,
            "integrations/models/settings/save",
            save.clone(),
        );
        assert_eq!(
            same["result"]["result"]["operation"], result["operation"],
            "{same}"
        );
        let mut conflict = save.clone();
        conflict["payload"]["policies"][0]["title"] = json!("Do not change the original intent");
        let conflict = rpc(
            &mut restored,
            6,
            "integrations/models/settings/save",
            conflict,
        );
        assert!(conflict["error"].is_object(), "{conflict}");
        let mut stale = save;
        stale["operationId"] = json!("new-save-old-revision");
        stale["payload"]["policies"][0]["title"] = json!("Rejected stale overwrite");
        let stale = rpc(&mut restored, 7, "integrations/models/settings/save", stale);
        assert_eq!(
            stale["result"]["result"]["operation"]["phase"], "rejected",
            "{stale}"
        );
        let mut foreign = current_scope;
        foreign["accountId"] = json!("another-owner");
        assert!(
            rpc(
                &mut restored,
                8,
                "integrations/models/settings/read",
                envelope(&foreign, json!({}))
            )["error"]
                .is_object()
        );
        no_threads(&mut restored, 9);
        restored.shutdown_successfully();
    }
    #[test]
    fn original_model_policies_capability_does_not_authorize_policy_configuration_writes() {
        let (_temp, profile, workspace, path, _) = setup();
        let bytes = std::fs::read(&path).unwrap();
        let mut server = builder(&workspace, &path, &profile).spawn();
        let scope = initialize(&mut server, false);
        let result = rpc(
            &mut server,
            3,
            "integrations/models/settings/read",
            envelope(&scope, json!({})),
        );
        assert!(result["error"].is_object(), "{result}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        no_threads(&mut server, 4);
        server.shutdown_successfully();
    }
}
