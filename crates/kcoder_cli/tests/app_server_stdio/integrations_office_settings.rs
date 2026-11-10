// Actual public CAS/config/reconnect behavior. No model turn or resource fixture.
#[cfg(target_os = "linux")]
mod integrations_office_settings {
    use super::*;
    use std::path::Path;
    const READ: &str = "settings/integrations/office/read";
    const SAVE: &str = "settings/integrations/office/save";
    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer) -> Value {
        let response = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"actual-office-settings-cas","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"officeSettingsV1":true,"officeWorkspaceV1":true}}}),
        );
        assert!(response["error"].is_null(), "{response}");
        response["result"].clone()
    }
    fn builder(workspace: &Path, settings: &Path, profile: &Path) -> TestAppServerBuilder {
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
        builder
    }
    fn envelope(scope: &Value, id: &str, op: Option<&str>, payload: Value) -> Value {
        json!({"contractVersion":"parallel-v1","requestId":id,"scope":scope,"operationId":op,"timeoutMs":30000,"payload":payload})
    }
    fn no_threads(server: &mut TestAppServer, id: i64) {
        let response = rpc(server, id, "thread/list", json!({}));
        assert!(response["error"].is_null(), "{response}");
        assert!(response["result"]["threads"].as_array().unwrap().is_empty());
    }
    #[test]
    fn integration_office_settings_public_cas_requires_reconnect_for_activation() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        let settings = profile.join("settings.json");
        write_fixture_provider_settings(&settings, "http://127.0.0.1:1/v1");
        let mut initial: Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        initial["integrations"] = json!({"office":{"enabled":false}});
        initial["max_retries"] = json!(2);
        initial["session_memory"] = json!({"enabled":false});
        std::fs::write(&settings, serde_json::to_vec(&initial).unwrap()).unwrap();
        // This is only initial owned fixture materialization. The enabled field
        // below is changed solely through the actual public save operation.
        let mut first = builder(&workspace, &settings, &profile).spawn();
        let capabilities = initialize(&mut first);
        assert_eq!(
            capabilities["capabilities"]["experimental"]["officeSettingsV1"],
            true
        );
        assert_eq!(
            capabilities["capabilities"]["experimental"]["officeWorkspaceV1"],
            false
        );
        let before = rpc(&mut first, 2, READ, json!({}));
        assert!(before["error"].is_null(), "{before}");
        let before = before["result"].clone();
        assert_eq!(before["persistedEnabled"], false);
        assert_eq!(before["effectiveEnabled"], false);
        assert_eq!(before["connectionEnabled"], false);
        assert_eq!(before["restartRequired"], false);
        let old_revision = before["revision"].as_str().unwrap();
        assert_eq!(old_revision.len(), 64);
        let scope = rpc(&mut first, 3, "integrations/scope/read", json!({}));
        assert!(scope["error"].is_null(), "{scope}");
        let scope = scope["result"].clone();
        let disabled = rpc(
            &mut first,
            4,
            "integrations/assistant/list",
            envelope(&scope, "disabled-list", None, json!({"limit":10})),
        );
        assert!(disabled["error"].is_object(), "{disabled}");
        no_threads(&mut first, 5);
        let saved = rpc(
            &mut first,
            6,
            SAVE,
            json!({"enabled":true,"expectedRevision":old_revision}),
        );
        assert!(saved["error"].is_null(), "{saved}");
        let saved = saved["result"].clone();
        assert_eq!(saved["persistedEnabled"], true);
        assert_eq!(saved["effectiveEnabled"], true);
        assert_eq!(saved["connectionEnabled"], false);
        assert_eq!(saved["restartRequired"], true);
        assert_ne!(saved["revision"], before["revision"]);
        let stale = rpc(
            &mut first,
            7,
            SAVE,
            json!({"enabled":false,"expectedRevision":old_revision}),
        );
        assert!(stale["error"].is_object(), "{stale}");
        assert!(
            stale["error"]["message"]
                .as_str()
                .unwrap()
                .contains("REVISION_CONFLICT")
        );
        let extra = rpc(
            &mut first,
            8,
            SAVE,
            json!({"enabled":false,"expectedRevision":saved["revision"],"path":"not-a-config-grant"}),
        );
        assert!(extra["error"].is_object(), "{extra}");
        let pending = rpc(&mut first, 9, READ, json!({}));
        assert_eq!(pending["result"]["connectionEnabled"], false);
        assert_eq!(pending["result"]["effectiveEnabled"], true);
        assert_eq!(pending["result"]["restartRequired"], true);
        let still_disabled = rpc(
            &mut first,
            10,
            "integrations/assistant/list",
            envelope(&scope, "still-disabled-list", None, json!({"limit":10})),
        );
        assert!(still_disabled["error"].is_object(), "{still_disabled}");
        let actual: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        assert_eq!(actual["integrations"]["office"]["enabled"], true);
        assert_eq!(actual["max_retries"], initial["max_retries"]);
        assert_eq!(actual["providers"], initial["providers"]);
        assert_eq!(actual["session_memory"], initial["session_memory"]);
        no_threads(&mut first, 11);
        first.shutdown_successfully();
        let mut restored = builder(&workspace, &settings, &profile).spawn();
        let capabilities = initialize(&mut restored);
        assert_eq!(
            capabilities["capabilities"]["experimental"]["officeSettingsV1"],
            true
        );
        assert_eq!(
            capabilities["capabilities"]["experimental"]["officeWorkspaceV1"],
            true
        );
        let current = rpc(&mut restored, 2, READ, json!({}));
        assert!(current["error"].is_null(), "{current}");
        assert_eq!(current["result"]["persistedEnabled"], true);
        assert_eq!(current["result"]["effectiveEnabled"], true);
        assert_eq!(current["result"]["connectionEnabled"], true);
        assert_eq!(current["result"]["restartRequired"], false);
        assert_eq!(current["result"]["revision"], saved["revision"]);
        let scope = rpc(&mut restored, 3, "integrations/scope/read", json!({}));
        assert!(scope["error"].is_null(), "{scope}");
        let scope = scope["result"].clone();
        let definition = json!({"schemaVersion":1,"id":"public-settings-activation","scope":"personal","title":"Actual public settings activation","description":"Metadata-only actual native acceptance","language":"en","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"instructions":"Preserve source facts and unknown values.","modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],"acceptanceCriteria":["Explicit user data is preserved"],"externalSend":"deny"});
        let written = rpc(
            &mut restored,
            4,
            "integrations/assistant/saveDraft",
            envelope(
                &scope,
                "activated-draft",
                Some("public-settings-draft-operation"),
                json!({"definition":definition}),
            ),
        );
        assert!(written["error"].is_null(), "{written}");
        assert_eq!(written["result"]["status"], "completed", "{written}");
        let listed = rpc(
            &mut restored,
            5,
            "integrations/assistant/list",
            // Built-ins precede saved drafts; since fcf2b2873 there are more
            // than ten (Octop assistants), so list personal entries only.
            envelope(
                &scope,
                "activated-list",
                None,
                json!({"limit":10,"personalOnly":true}),
            ),
        );
        assert!(listed["error"].is_null(), "{listed}");
        assert_eq!(listed["result"]["status"], "completed", "{listed}");
        assert!(
            serde_json::to_string(&listed)
                .unwrap()
                .contains("public-settings-activation")
        );
        no_threads(&mut restored, 6);
        restored.shutdown_successfully();
    }
}
