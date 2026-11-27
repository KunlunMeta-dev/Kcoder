// Actual public model-policy preview and ordinary native model application.
// The deterministic endpoint proves protocol/identity, not model quality or paid-model readiness.
#[cfg(target_os = "linux")]
mod integrations_model_policies {
    use super::*;

    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer, enabled: bool) -> Value {
        let value = rpc(
            server,
            1,
            "initialize",
            json!({
                "protocolVersion":"2026-07-27", "clientInfo":{"name":"actual-model-policies","version":"1"},
                "capabilities":{"experimental":{"integrationScopeV1":true,"modelPoliciesV1":enabled,"modelHealthV1":enabled,"modelUsageV1":enabled}}
            }),
        );
        assert!(value["error"].is_null(), "{value}");
        assert_eq!(
            value["result"]["capabilities"]["experimental"]["modelPoliciesV1"],
            enabled
        );
        let scope = rpc(server, 2, "integrations/scope/read", json!({}));
        assert!(scope["error"].is_null(), "{scope}");
        scope["result"].clone()
    }
    fn envelope(scope: &Value, payload: Value) -> Value {
        json!({"contractVersion":"parallel-v1","requestId":"actual-model-preview","scope":scope,"timeoutMs":10000,"payload":payload})
    }
    fn no_threads(server: &mut TestAppServer, id: i64) {
        let result = rpc(server, id, "thread/list", json!({}));
        assert!(result["error"].is_null(), "{result}");
        assert_eq!(
            result["result"]["threads"].as_array().unwrap().len(),
            0,
            "{result}"
        );
    }
    fn turn(server: &mut TestAppServer, id: i64, thread: &str) {
        let result = rpc(
            server,
            id,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"Return one ordinary answer using this explicitly selected model."}]}),
        );
        assert!(result["error"].is_null(), "{result}");
        let turn = result["result"]["turn"]["id"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed" && event["params"]["turnId"] == turn {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
    }
    fn private_paths(temp: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = kcoder_config::PrivateDirectory::open_existing(temp).unwrap();
        root.create_private_child(std::ffi::OsStr::new("profile"))
            .unwrap();
        root.create_private_child(std::ffi::OsStr::new("workspace"))
            .unwrap();
        (temp.join("profile"), temp.join("workspace"))
    }
    fn settings(endpoint: &str) -> Value {
        let deployment = |model: &str| json!({"api_format":"openai_chat_completions","authentication":{"mode":"none"},"endpoint":endpoint,"default_model":model,"context_window_tokens":128000,"max_output_tokens":128,"output_headroom_tokens":128,"discover_models":false,"capabilities":{"text":true,"tools":true,"vision":false,"reasoning":false,"structured_output":true}});
        json!({"active_provider":"Current","model":"manual","session_memory":{"enabled":false},"providers":{"Current":deployment("manual"),"Chosen":deployment("approved")},"integrations":{"core":{"modelPolicies":[{"id":"work-policy","title":"Explicitly selected pool","candidates":[{"provider":"Chosen","model":"approved"},{"provider":"Current","model":"manual"}]}]}}})
    }
    #[test]
    fn actual_public_auto_preview_preserves_manual_model_then_original_native_turn_uses_explicit_choice()
     {
        let temp = tempfile::tempdir().unwrap();
        let (profile, workspace) = private_paths(temp.path());
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| FixtureAnswer::Text("The actual configured model answered.".into()),
            Some(2),
            Duration::from_secs(2),
        );
        let path = profile.join("settings.json");
        let mut document = settings(&endpoint);
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let mut builder = TestAppServer::builder(&workspace, &path)
            .config_dir(&profile)
            .without_scenario();
        builder.training_mode = true;
        let mut server = builder.spawn();
        let scope = initialize(&mut server, true);
        no_threads(&mut server, 3);
        let catalog = rpc(
            &mut server,
            4,
            "integrations/models/readPolicies",
            envelope(&scope, json!({})),
        );
        assert_eq!(catalog["result"]["status"], "completed", "{catalog}");
        let policy = &catalog["result"]["result"]["policies"][0];
        let version = policy["reference"]["version"].as_str().unwrap().to_owned();
        assert_eq!(policy["candidates"][0]["provider"], "Chosen");
        let input = json!({"selection":{"kind":"auto_policy","id":"work-policy","version":version},"requirements":{"inputTokens":100,"outputTokens":128}});
        let preview = rpc(
            &mut server,
            5,
            "integrations/models/resolveSelection",
            envelope(&scope, input.clone()),
        );
        assert_eq!(preview["result"]["status"], "completed", "{preview}");
        let resolved = &preview["result"]["result"];
        assert_eq!(resolved["selectionKind"], "auto_policy");
        assert_eq!(resolved["model"]["providerId"], "Chosen");
        assert_eq!(resolved["model"]["modelId"], "approved");
        assert_eq!(resolved["budget"]["reservationState"], "not_reserved");
        assert_eq!(resolved["budget"]["costKnown"], false);
        assert_eq!(calls.lock().unwrap().len(), 0);
        no_threads(&mut server, 6);
        let original = rpc(
            &mut server,
            7,
            "integrations/models/resolveSelection",
            envelope(&scope, json!({"selection":{"kind":"inherit_current"}})),
        );
        assert_eq!(
            original["error"]["message"], "MODEL_SELECTION_REQUIRES_TASK_CONTEXT",
            "{original}"
        );
        let mut incompatible = input.clone();
        incompatible["requirements"]["vision"] = json!(true);
        let rejected = rpc(
            &mut server,
            8,
            "integrations/models/resolveSelection",
            envelope(&scope, incompatible),
        );
        assert_eq!(
            rejected["error"]["message"], "MODEL_AUTO_NO_ELIGIBLE_CANDIDATE",
            "{rejected}"
        );
        let mut too_large = input.clone();
        too_large["requirements"]["inputTokens"] = json!(128000);
        assert!(
            rpc(
                &mut server,
                9,
                "integrations/models/resolveSelection",
                envelope(&scope, too_large)
            )["error"]
                .is_object()
        );
        let mut foreign = scope.clone();
        foreign["accountId"] = json!("foreign-owner");
        assert!(
            rpc(
                &mut server,
                10,
                "integrations/models/readPolicies",
                envelope(&foreign, json!({}))
            )["error"]
                .is_object()
        );
        assert_eq!(calls.lock().unwrap().len(), 0);
        let manual = rpc(&mut server, 11, "thread/start", json!({"cwd":workspace}));
        let manual = manual["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        turn(&mut server, 12, &manual);
        assert_eq!(calls.lock().unwrap()[0]["model"], "manual");
        // A model preview is not execution authority. The user explicitly
        // applies its exact identity through the ordinary native creation API.
        let selected = rpc(
            &mut server,
            13,
            "thread/start",
            json!({"cwd":workspace,"model":"Chosen::approved"}),
        );
        let selected = selected["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        turn(&mut server, 14, &selected);
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(calls.lock().unwrap()[1]["model"], "approved");
        document["integrations"]["core"]["modelPolicies"][0]["candidates"][0]["enabled"] =
            json!(false);
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let stale = rpc(
            &mut server,
            15,
            "integrations/models/resolveSelection",
            envelope(&scope, input),
        );
        assert_eq!(
            stale["error"]["message"], "MODEL_AUTO_POLICY_VERSION_CHANGED",
            "{stale}"
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
        server.shutdown_successfully();
        fixture.join().unwrap();
    }
    #[test]
    fn actual_http_health_is_observed_and_auto_changes_only_at_a_fresh_request_boundary() {
        let temp = tempfile::tempdir().unwrap();
        let (profile, workspace) = private_paths(temp.path());
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |index, _| {
                if index == 0 {
                    FixtureAnswer::Custom(|socket: &mut std::net::TcpStream| {
                        let body = r#"{"error":{"type":"overloaded_error","message":"fault diagnostic must not enter health"}}"#;
                        write!(socket, "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                    })
                } else {
                    FixtureAnswer::Text("The next explicitly admitted request completed.".into())
                }
            },
            Some(2),
            Duration::from_secs(3),
        );
        let path = profile.join("settings.json");
        let mut document = settings(&endpoint);
        document["max_retries"] = json!(0);
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let mut builder = TestAppServer::builder(&workspace, &path)
            .config_dir(&profile)
            .without_scenario();
        builder.training_mode = true;
        let mut server = builder.spawn();
        let scope = initialize(&mut server, true);
        let catalog = rpc(
            &mut server,
            3,
            "integrations/models/readPolicies",
            envelope(&scope, json!({})),
        );
        let version = catalog["result"]["result"]["policies"][0]["reference"]["version"].clone();
        let input =
            json!({"selection":{"kind":"auto_policy","id":"work-policy","version":version}});
        let preview = rpc(
            &mut server,
            4,
            "integrations/models/resolveSelection",
            envelope(&scope, input.clone()),
        );
        assert_eq!(
            preview["result"]["result"]["model"]["providerId"], "Chosen",
            "{preview}"
        );
        let created = rpc(
            &mut server,
            5,
            "thread/start",
            json!({"cwd":workspace,"model":"Chosen::approved"}),
        );
        let thread = created["result"]["thread"]["id"].as_str().unwrap();
        let original = rpc(
            &mut server,
            6,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"Use the original request once; do not replay any tools."}]}),
        );
        let original_turn = original["result"]["turn"]["id"].as_str().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed" && event["params"]["turnId"] == original_turn {
                assert_eq!(event["params"]["turn"]["status"], "failed", "{event}");
                break;
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 1);
        let health = rpc(
            &mut server,
            7,
            "integrations/models/readHealth",
            envelope(&scope, json!({"id":"work-policy","version":version})),
        );
        assert_eq!(health["result"]["status"], "completed", "{health}");
        let failed = health["result"]["result"]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["provider"] == "Chosen")
            .unwrap();
        assert_eq!(failed["state"], "cooling_down", "{failed}");
        assert_eq!(failed["failure"]["http_status"], 503);
        assert_eq!(failed["failure"]["retryable"], true);
        assert!(!health.to_string().contains("fault diagnostic"));
        let next = rpc(
            &mut server,
            8,
            "integrations/models/resolveSelection",
            envelope(&scope, input),
        );
        assert_eq!(
            next["result"]["result"]["model"]["providerId"], "Current",
            "{next}"
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        // Reading health and a new preview do not resume the failed turn or
        // emit a hidden retry. The user admits a separate ordinary request.
        let next_thread = rpc(
            &mut server,
            9,
            "thread/start",
            json!({"cwd":workspace,"model":"Current::manual"}),
        );
        let next_thread = next_thread["result"]["thread"]["id"].as_str().unwrap();
        turn(&mut server, 10, next_thread);
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(calls.lock().unwrap()[0]["model"], "approved");
        assert_eq!(calls.lock().unwrap()[1]["model"], "manual");
        let health = rpc(
            &mut server,
            11,
            "integrations/models/readHealth",
            envelope(&scope, json!({"id":"work-policy","version":version})),
        );
        let current = health["result"]["result"]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["provider"] == "Current")
            .unwrap();
        assert_eq!(current["state"], "healthy", "{current}");
        // Configuration replacement yields an unobserved identity; the old
        // endpoint's failure is never borrowed as the new deployment's fact.
        document["providers"]["Chosen"]["endpoint"] = json!("http://127.0.0.1:9/v1");
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let changed = rpc(
            &mut server,
            12,
            "integrations/models/readHealth",
            envelope(&scope, json!({"id":"work-policy","version":version})),
        );
        let changed = changed["result"]["result"]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["provider"] == "Chosen")
            .unwrap();
        assert_eq!(changed["state"], "unknown", "{changed}");
        assert_ne!(
            changed["configurationRevision"],
            failed["configurationRevision"]
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
        server.shutdown_successfully();
        fixture.join().unwrap();
    }

    #[test]
    fn actual_provider_usage_is_read_from_native_events_without_inventing_missing_fields_or_cost() {
        let temp = tempfile::tempdir().unwrap();
        let (profile, workspace) = private_paths(temp.path());
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| {
                FixtureAnswer::Custom(|socket: &mut std::net::TcpStream| {
                    let text = json!({"choices":[{"index":0,"delta":{"content":"Actual bounded usage response."},"finish_reason":null}]});
                    let usage = json!({"choices":[],"usage":{"prompt_tokens":111,"completion_tokens":23,"total_tokens":134,"prompt_tokens_details":{"cached_tokens":0}}});
                    let stop = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
                    let body = format!(
                        "data: {text}\n\ndata: {usage}\n\ndata: {stop}\n\ndata: [DONE]\n\n"
                    );
                    write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                })
            },
            Some(1),
            Duration::from_secs(2),
        );
        let path = profile.join("settings.json");
        std::fs::write(&path, serde_json::to_vec(&settings(&endpoint)).unwrap()).unwrap();
        let mut builder = TestAppServer::builder(&workspace, &path)
            .config_dir(&profile)
            .without_scenario();
        builder.training_mode = true;
        let mut server = builder.spawn();
        let scope = initialize(&mut server, true);
        let catalog = rpc(
            &mut server,
            3,
            "integrations/models/readPolicies",
            envelope(&scope, json!({})),
        );
        let reference = catalog["result"]["result"]["policies"][0]["reference"].clone();
        let unknown = rpc(
            &mut server,
            4,
            "integrations/models/readUsage",
            envelope(&scope, reference.clone()),
        );
        assert_eq!(unknown["result"]["status"], "completed", "{unknown}");
        let unknown = &unknown["result"]["result"]["observations"][0];
        assert!(unknown["reportedInputTokens"].is_null());
        assert!(unknown["reportedOutputTokens"].is_null());
        assert_eq!(unknown["complete"], false);
        assert_eq!(calls.lock().unwrap().len(), 0);
        let started = rpc(&mut server, 5, "thread/start", json!({"cwd":workspace}));
        let thread = started["result"]["thread"]["id"].as_str().unwrap();
        turn(&mut server, 6, thread);
        let reported = rpc(
            &mut server,
            7,
            "integrations/models/readUsage",
            envelope(&scope, reference),
        );
        assert_eq!(reported["result"]["status"], "completed", "{reported}");
        let actual = reported["result"]["result"]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["provider"] == "Current")
            .unwrap();
        assert_eq!(actual["reportedInputTokens"], 111, "{actual}");
        assert_eq!(actual["reportedOutputTokens"], 23);
        assert_eq!(actual["reportedTotalTokens"], 134);
        assert_eq!(actual["reportedCacheReadInputTokens"], 0);
        assert_eq!(actual["complete"], false);
        assert!(actual.get("costUsd").is_none());
        assert_eq!(calls.lock().unwrap().len(), 1);
        server.shutdown_successfully();
        fixture.join().unwrap();
    }

    #[test]
    fn old_model_policy_capability_does_not_imply_native_health_support() {
        let temp = tempfile::tempdir().unwrap();
        let (profile, workspace) = private_paths(temp.path());
        let path = profile.join("settings.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&settings("http://127.0.0.1:9/v1")).unwrap(),
        )
        .unwrap();
        let mut server = TestAppServer::builder(&workspace, &path)
            .config_dir(&profile)
            .without_scenario()
            .spawn();
        let response = rpc(
            &mut server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"legacy-policies-only","version":"1"},"capabilities":{"experimental":{"integrationScopeV1":true,"modelPoliciesV1":true}}}),
        );
        assert_eq!(
            response["result"]["capabilities"]["experimental"]["modelPoliciesV1"],
            true
        );
        assert_ne!(
            response["result"]["capabilities"]["experimental"]["modelHealthV1"],
            true
        );
        let scope = rpc(&mut server, 2, "integrations/scope/read", json!({}))["result"].clone();
        let policies = rpc(
            &mut server,
            3,
            "integrations/models/readPolicies",
            envelope(&scope, json!({})),
        );
        assert_eq!(policies["result"]["status"], "completed", "{policies}");
        let reference = policies["result"]["result"]["policies"][0]["reference"].clone();
        let denied = rpc(
            &mut server,
            4,
            "integrations/models/readHealth",
            envelope(&scope, reference),
        );
        assert!(
            denied["error"].is_object() && denied["result"].is_null(),
            "{denied}"
        );
        no_threads(&mut server, 5);
        server.shutdown_successfully();
    }

    #[test]
    fn public_model_policies_require_negotiation_and_do_not_create_tasks() {
        let temp = tempfile::tempdir().unwrap();
        let (profile, workspace) = private_paths(temp.path());
        let path = profile.join("settings.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&settings("http://127.0.0.1:9/v1")).unwrap(),
        )
        .unwrap();
        let mut server = TestAppServer::builder(&workspace, &path)
            .config_dir(&profile)
            .without_scenario()
            .spawn();
        let scope = initialize(&mut server, false);
        let denied = rpc(
            &mut server,
            3,
            "integrations/models/readPolicies",
            envelope(&scope, json!({})),
        );
        assert!(
            denied["error"].is_object() && denied["result"].is_null(),
            "{denied}"
        );
        no_threads(&mut server, 4);
        server.shutdown_successfully();
    }
}
