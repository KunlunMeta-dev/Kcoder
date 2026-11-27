// Actual public user selection, current target Read policy and original tick.
mod native_public_file_selection {
    use super::*;
    use kcoder_types::integrations::knowledge::{AutomationRun, AutomationRunStatus};
    use std::path::PathBuf;

    struct Fixture {
        _root: tempfile::TempDir,
        workspace: PathBuf,
        profile: PathBuf,
        settings: PathBuf,
        workflow: String,
    }
    impl Fixture {
        fn new(allow_read: bool) -> Self {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            std::fs::write(
                workspace.join("selected.txt"),
                "UNTRUSTED_FILE_BODY_IS_NOT_A_SELECTION_RECEIPT",
            )
            .unwrap();
            let profile = root.path().join("profile");
            kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
            let settings = profile.join("settings.json");
            knowledge_control_settings(&settings, true);
            let mut configuration: Value =
                serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
            configuration["permission_mode"] = json!("ask");
            configuration["allowed_tools"] = json!(if allow_read { vec!["read"] } else { vec![] });
            std::fs::write(&settings, serde_json::to_vec(&configuration).unwrap()).unwrap();
            let library =
                kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
            let draft = library
                .create(
                    "Explicit selected-file calculation",
                    "Isolated Code-only fixture",
                )
                .unwrap();
            let draft = library
                .upsert_node(
                    &draft.id,
                    draft.revision,
                    serde_json::from_value(json!({
                        "id":"derive","title":"Verify original selected-file task input","kind":"code",
                        "config":{"code":{"source":"if(input.value !== 7) throw new Error('original input changed'); return {verified:true,fromSelectedFile:input.value*2};","timeoutMs":1000}}
                    }))
                    .unwrap(),
                )
                .unwrap();
            let workflow = library.save(&draft.id, draft.revision).unwrap().id;
            Self {
                _root: root,
                workspace,
                profile,
                settings,
                workflow,
            }
        }
        fn spawn(&self) -> TestAppServer {
            // Read permission is an explicit rule in this isolated real target
            // configuration. No fixture provider or paid endpoint can run.
            TestAppServer::builder(&self.workspace, &self.settings)
                .config_dir(&self.profile)
                .without_scenario()
                .spawn()
        }
    }
    fn initialize(server: &mut TestAppServer) -> Value {
        server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"native-public-file-selection","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"automationTemplatesV1":true,
                "integrationOperationReceiptsV1":true,"studioWorkModesV1":true,"threadStreamContextV1":true}}}}));
        let reply = server.response(1);
        assert_eq!(
            reply["result"]["capabilities"]["experimental"]["automationTemplatesV1"], true,
            "{reply}"
        );
        server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
        let reply = server.response(2);
        assert!(reply.get("error").is_none(), "{reply}");
        reply["result"].clone()
    }
    fn select(server: &mut TestAppServer, scope: &Value, id: i64) -> Value {
        integration_memory_request(
            server,
            id,
            "integrations/automation/selectFileEventSource",
            scope,
            Some("explicit-public-native-file-selection"),
            None,
            json!({"relativeDirectory":".","fileNames":["selected.txt"]}),
        )
    }
    fn threads(server: &mut TestAppServer, id: i64) -> Value {
        server.send(json!({"id":id,"method":"thread/list","params":{}}));
        let reply = server.response(id);
        assert!(reply.get("error").is_none(), "{reply}");
        assert!(reply["result"]["threads"].is_array(), "{reply}");
        reply["result"]["threads"].clone()
    }
    fn runs(server: &mut TestAppServer, scope: &Value, id: i64) -> Vec<AutomationRun> {
        let reply = integration_memory_request(
            server,
            id,
            "integrations/automation/listAutomationRuns",
            scope,
            None,
            None,
            json!({}),
        );
        assert_eq!(reply["result"]["status"], "completed", "{reply}");
        serde_json::from_value(reply["result"]["result"]["page"]["items"].clone()).unwrap()
    }

    #[test]
    fn actual_public_selection_keeps_ask_and_opens_no_thread_or_automation_run() {
        let fixture = Fixture::new(false);
        let before = std::fs::read(&fixture.settings).unwrap();
        let mut server = fixture.spawn();
        let scope = initialize(&mut server);
        let baseline = threads(&mut server, 3);
        let selection = select(&mut server, &scope, 4);
        assert_eq!(selection["result"]["status"], "rejected", "{selection}");
        assert_eq!(
            selection["result"]["error"]["code"], "AUTOMATION_FILE_READ_AUTHORIZATION_REQUIRED",
            "{selection}"
        );
        assert_eq!(threads(&mut server, 5), baseline);
        assert!(runs(&mut server, &scope, 6).is_empty());
        assert_eq!(std::fs::read(&fixture.settings).unwrap(), before);
        server.shutdown_successfully();
    }

    #[test]
    fn actual_public_selection_drives_original_code_tick_and_restart_keeps_same_run() {
        let fixture = Fixture::new(true);
        let settings_before = std::fs::read(&fixture.settings).unwrap();
        let mut server = fixture.spawn();
        let scope = initialize(&mut server);
        let baseline = threads(&mut server, 3);
        let selected = select(&mut server, &scope, 4);
        assert_eq!(selected["result"]["status"], "completed", "{selected}");
        let selection = selected["result"]["result"].clone();
        assert_eq!(selection["items"][0]["name"], "selected.txt");
        assert!(!selection.to_string().contains("UNTRUSTED_FILE_BODY"));
        assert!(
            !selection
                .to_string()
                .contains(fixture.profile.to_string_lossy().as_ref())
        );
        assert_eq!(threads(&mut server, 5), baseline);
        assert!(runs(&mut server, &scope, 6).is_empty());
        let saved = integration_memory_request(
            &mut server,
            10,
            "integrations/automation/saveSubscription",
            &scope,
            Some("explicit-public-selected-file-subscription"),
            Some(0),
            json!({"draft":{"id":"public-selected-file-code","title":"Explicit file-event result",
                "workflowId":fixture.workflow,"workflowVersion":1,"inputs":{"value":7},
                "schedule":null,"eventSource":selection["sourceRef"],"maximumTokens":5000,
                "maximumRuntimeSeconds":30,"delivery":{"kind":"studio"}},
                "consentRef":"actual-public-user-fixture-action"}),
        );
        assert_eq!(saved["result"]["status"], "completed", "{saved}");
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut request_id = 100;
        let original = loop {
            let observed = runs(&mut server, &scope, request_id);
            request_id += 1;
            assert!(observed.len() <= 1, "duplicate event runs: {observed:?}");
            if let Some(run) = observed.into_iter().next() {
                assert!(
                    !matches!(
                        run.status,
                        AutomationRunStatus::Failed | AutomationRunStatus::Cancelled
                    ),
                    "{run:?}"
                );
                if run.status == AutomationRunStatus::Completed {
                    assert!(
                        run.output.as_deref().is_some_and(|value| value
                            .contains("fromSelectedFile")
                            && value.contains("14")),
                        "{run:?}"
                    );
                    assert!(run.native_thread_id.is_some(), "{run:?}");
                    assert!(
                        run.native_turn_id.is_none(),
                        "Code workflow became a model turn: {run:?}"
                    );
                    break run;
                }
            }
            assert!(
                Instant::now() < deadline,
                "actual selected-file Code task did not complete"
            );
            std::thread::sleep(Duration::from_millis(100));
        };
        server.shutdown_successfully();

        let mut restored = fixture.spawn();
        let scope = initialize(&mut restored);
        // Persisted subscription/cursor does not reconstruct the old read
        // authority. This is a fresh actual public selection under current PDP.
        let reselected = select(&mut restored, &scope, 4);
        assert_eq!(reselected["result"]["status"], "completed", "{reselected}");
        assert_eq!(reselected["result"]["result"], selection);
        for id in 20..26 {
            let observed = runs(&mut restored, &scope, id);
            assert_eq!(observed.len(), 1, "{observed:?}");
            assert_eq!(observed[0].id, original.id);
            assert_eq!(
                observed[0].native_operation_id,
                original.native_operation_id
            );
            assert_eq!(observed[0].status, AutomationRunStatus::Completed);
            std::thread::sleep(Duration::from_millis(250));
        }
        assert_eq!(std::fs::read(&fixture.settings).unwrap(), settings_before);
        restored.shutdown_successfully();
    }
}
