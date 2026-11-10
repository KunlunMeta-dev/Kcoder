// Actual persistent user subscription -> original timer -> native Code workflow.
// No Agent/model/extra runtime is used and no private fixture JSON is a receipt.
mod native_business_scheduler {
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
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            let profile = root.path().join("profile");
            kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
            let settings = profile.join("settings.json");
            knowledge_control_settings(&settings, true);
            let library =
                kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
            let draft = library
                .create(
                    "Actual subscribed local calculation",
                    "Isolated user-authorized native scheduler acceptance; no model",
                )
                .unwrap();
            let draft = library.upsert_node(&draft.id, draft.revision, serde_json::from_value(json!({
                "id":"derive","title":"Verify the stored original input","kind":"code",
                "config":{"code":{"source":"if(input.value !== 7) throw new Error('original input changed'); return {verified:true,fromOriginalTick:input.value*2};","timeoutMs":1000}}
            })).unwrap()).unwrap();
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
            // The only configured endpoint is loopback port1. A model request
            // cannot be silently satisfied by a scenario or an external account.
            TestAppServer::builder(&self.workspace, &self.settings)
                .config_dir(&self.profile)
                .without_scenario()
                .spawn()
        }
    }
    fn initialize(server: &mut TestAppServer) -> Value {
        server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"native-subscription-timer","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"taskSourceDirectoryV1":true,"taskSourcesV1":true,"automationTemplatesV1":true,"automationPeriodBudgetsV1":true,"integrationOperationReceiptsV1":true,"studioWorkModesV1":true,"threadStreamContextV1":true}}}}));
        let initialized = server.response(1);
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["automationTemplatesV1"], true,
            "{initialized}"
        );
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["automationPeriodBudgetsV1"],
            true,
            "{initialized}"
        );
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["taskSourcesV1"], true,
            "{initialized}"
        );
        server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
        let scope = server.response(2);
        assert!(scope.get("error").is_none(), "{scope}");
        scope["result"].clone()
    }
    fn save(server: &mut TestAppServer, fixture: &Fixture, scope: &Value, at: &str) {
        let response = integration_memory_request(
            server,
            10,
            "integrations/automation/saveSubscription",
            scope,
            Some("explicit-user-schedule"),
            Some(0),
            json!({
            "draft":{"id":"actual-owned-code-subscription","title":"Explicit local scheduled result","workflowId":fixture.workflow,
                "workflowVersion":1,"inputs":{"value":7},"schedule":{"kind":"at","at":at},"eventSource":null,
                "maximumTokens":5000,"maximumRuntimeSeconds":30,"delivery":{"kind":"studio"}},
            "consentRef":"explicit-native-scheduler-test-action"}),
        );
        assert_eq!(response["result"]["status"], "completed", "{response}");
        assert_eq!(
            response["result"]["result"]["subscription"]["enabled"], true,
            "{response}"
        );
    }
    fn runs(server: &mut TestAppServer, scope: &Value, id: i64) -> Vec<AutomationRun> {
        let response = integration_memory_request(
            server,
            id,
            "integrations/automation/listAutomationRuns",
            scope,
            None,
            None,
            json!({}),
        );
        assert_eq!(response["result"]["status"], "completed", "{response}");
        serde_json::from_value(response["result"]["result"]["page"]["items"].clone()).unwrap()
    }
    fn completed(server: &mut TestAppServer, scope: &Value) -> AutomationRun {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut id = 100;
        loop {
            let observed = runs(server, scope, id);
            id += 1;
            assert!(
                observed.len() <= 1,
                "duplicate persistent runs: {observed:?}"
            );
            if let Some(run) = observed.into_iter().next() {
                assert!(
                    !matches!(
                        run.status,
                        AutomationRunStatus::Failed | AutomationRunStatus::Cancelled
                    ),
                    "native scheduler outcome: {run:?}"
                );
                if run.status == AutomationRunStatus::Completed {
                    assert!(run.output.as_deref().is_some_and(|value|value.contains("verified")&&value.contains("14")),"{run:?}");
                    assert!(
                        run.native_thread_id
                            .as_ref()
                            .is_some_and(|id| !id.is_empty()),
                        "{run:?}"
                    );
                    assert!(
                        run.native_turn_id.is_none(),
                        "Code workflow was replaced by a prompt turn: {run:?}"
                    );
                    return run;
                }
            }
            assert!(
                Instant::now() < deadline,
                "native subscribed run did not complete"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn receipt(server: &mut TestAppServer, scope: &Value, run: &AutomationRun) -> Value {
        let response = integration_memory_request(
            server,
            900,
            "integrations/operation/read",
            scope,
            None,
            None,
            json!({"operationId":run.native_operation_id}),
        );
        assert_eq!(response["result"]["status"], "completed", "{response}");
        let receipt = response["result"]["result"]["receipt"].clone();
        assert_eq!(receipt["port"], "P-RUNTIME", "{receipt}");
        assert_eq!(receipt["method"], "acceptTask", "{receipt}");
        assert_eq!(receipt["phase"], "completed", "{receipt}");
        assert_eq!(
            receipt["runtimeAcceptance"]["threadId"],
            run.native_thread_id.as_deref().unwrap(),
            "{receipt}"
        );
        assert!(
            receipt["runtimeAcceptance"]["taskId"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "{receipt}"
        );
        receipt
    }

    #[test]
    fn actual_existing_subscription_period_preview_is_pure_save_binds_revision_and_original_tick() {
        let fixture = Fixture::new();
        let mut server = fixture.spawn();
        let scope = initialize(&mut server);
        let later = (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339();
        save(&mut server, &fixture, &scope, &later);
        let listed = integration_memory_request(
            &mut server,
            11,
            "integrations/automation/listSubscriptions",
            &scope,
            None,
            None,
            json!({}),
        );
        let mut draft = listed["result"]["result"]["page"]["items"][0]["draft"].clone();
        assert!(draft.get("periodBudget").is_none());
        draft["periodBudget"] =
            json!({"windowSeconds":86400,"maximumTokens":10000,"maximumModelCalls":5});
        draft["schedule"] = json!({"kind":"at","at":(chrono::Utc::now()+chrono::Duration::seconds(3)).to_rfc3339()});
        let names = || {
            let mut names = std::fs::read_dir(&fixture.profile)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>();
            names.sort();
            names
        };
        let before = names();
        let preview = integration_memory_request(
            &mut server,
            12,
            "integrations/automation/previewSubscription",
            &scope,
            None,
            None,
            json!({"draft":draft,"consentRef":"preview-only"}),
        );
        assert_eq!(preview["result"]["status"], "completed", "{preview}");
        assert_eq!(
            preview["result"]["result"]["periodBudget"]["configuration"],
            draft["periodBudget"]
        );
        assert_eq!(
            preview["result"]["result"]["periodBudget"]["createsSubscription"],
            false
        );
        assert_eq!(
            names(),
            before,
            "preview created budget or subscription storage"
        );
        assert!(runs(&mut server, &scope, 13).is_empty());
        let saved = integration_memory_request(
            &mut server,
            14,
            "integrations/automation/saveSubscription",
            &scope,
            Some("explicit-original-period-update"),
            Some(1),
            json!({"draft":draft,"consentRef":"explicit-period-update"}),
        );
        assert_eq!(saved["result"]["status"], "completed", "{saved}");
        assert_eq!(saved["result"]["result"]["subscription"]["revision"], 2);
        assert_eq!(
            saved["result"]["result"]["subscription"]["draft"]["id"],
            "actual-owned-code-subscription"
        );
        let run = completed(&mut server, &scope);
        assert_eq!(run.subscription_revision, 2);
        receipt(&mut server, &scope, &run);
        server.shutdown_successfully();
    }

    #[test]
    fn actual_subscription_tick_completes_code_and_restart_reads_same_native_operation() {
        let fixture = Fixture::new();
        let settings_before = std::fs::read(&fixture.settings).unwrap();
        let mut server = fixture.spawn();
        let scope = initialize(&mut server);
        assert!(runs(&mut server, &scope, 3).is_empty());
        let at = (chrono::Utc::now() + chrono::Duration::seconds(3)).to_rfc3339();
        save(&mut server, &fixture, &scope, &at);
        let first = completed(&mut server, &scope);
        let accepted = receipt(&mut server, &scope, &first);
        server.shutdown_successfully();
        let mut restored = fixture.spawn();
        let scope = initialize(&mut restored);
        // A new connection has a new scheduler owner but must observe the same
        // canonical operation/task, not enqueue another thread or prompt.
        for id in 20..25 {
            let current = runs(&mut restored, &scope, id);
            assert_eq!(current.len(), 1, "{current:?}");
            assert_eq!(current[0].id, first.id);
            assert_eq!(current[0].native_operation_id, first.native_operation_id);
            assert_eq!(current[0].native_thread_id, first.native_thread_id);
            std::thread::sleep(Duration::from_millis(200));
        }
        assert_eq!(
            receipt(&mut restored, &scope, &first)["runtimeAcceptance"],
            accepted["runtimeAcceptance"]
        );
        restored.shutdown_successfully();
        assert_eq!(std::fs::read(&fixture.settings).unwrap(), settings_before);
    }

    #[test]
    fn actual_missed_one_shot_tick_is_recovered_once_after_process_restart() {
        let fixture = Fixture::new();
        let mut server = fixture.spawn();
        let scope = initialize(&mut server);
        let at = (chrono::Utc::now() + chrono::Duration::seconds(3)).to_rfc3339();
        save(&mut server, &fixture, &scope, &at);
        assert!(runs(&mut server, &scope, 11).is_empty());
        server.shutdown_successfully();
        std::thread::sleep(Duration::from_millis(3500));
        let mut restored = fixture.spawn();
        let scope = initialize(&mut restored);
        let result = completed(&mut restored, &scope);
        receipt(&mut restored, &scope, &result);
        assert_eq!(runs(&mut restored, &scope, 950).len(), 1);
        restored.shutdown_successfully();
    }

    #[test]
    fn fresh_native_subscription_thread_preserves_explicit_output_limit() {
        let fixture = Fixture::new();
        let mut settings: Value =
            serde_json::from_slice(&std::fs::read(&fixture.settings).unwrap()).unwrap();
        settings["max_tokens"] = json!(1024);
        std::fs::write(&fixture.settings, serde_json::to_vec(&settings).unwrap()).unwrap();
        let before = std::fs::read(&fixture.settings).unwrap();
        let mut server = TestAppServer::builder(&fixture.workspace, &fixture.settings)
            .config_dir(&fixture.profile)
            .env("KCODER_MAX_TOKENS", "1024")
            .without_scenario()
            .spawn();
        let scope = initialize(&mut server);
        let at = (chrono::Utc::now() + chrono::Duration::seconds(3)).to_rfc3339();
        save(&mut server, &fixture, &scope, &at);
        let completed = completed(&mut server, &scope);
        receipt(&mut server, &scope, &completed);
        server.shutdown_successfully();
        assert_eq!(std::fs::read(&fixture.settings).unwrap(), before);
    }

    #[test]
    fn actual_disabled_subscription_survives_restart_without_a_native_run() {
        let fixture = Fixture::new();
        let mut server = fixture.spawn();
        let scope = initialize(&mut server);
        let at = (chrono::Utc::now() + chrono::Duration::seconds(3)).to_rfc3339();
        save(&mut server, &fixture, &scope, &at);
        let stopped = integration_memory_request(
            &mut server,
            11,
            "integrations/automation/setSubscriptionEnabled",
            &scope,
            Some("explicit-user-disable"),
            Some(1),
            json!({"subscriptionId":"actual-owned-code-subscription","enabled":false}),
        );
        assert_eq!(stopped["result"]["status"], "completed", "{stopped}");
        server.shutdown_successfully();
        std::thread::sleep(Duration::from_millis(3500));
        let mut restored = fixture.spawn();
        let scope = initialize(&mut restored);
        for id in 20..25 {
            assert!(runs(&mut restored, &scope, id).is_empty());
            std::thread::sleep(Duration::from_millis(150));
        }
        restored.shutdown_successfully();
    }
}
