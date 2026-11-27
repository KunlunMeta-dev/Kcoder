// Ordinary KWorker keeps general file tools after dedicated Office tools were retired.
// The bounded loopback provider verifies the real request/tool round trip, not model quality.
#[cfg(target_os = "linux")]
mod integrations_office {
    use super::*;

    #[test]
    fn kworker_uses_general_read_without_advertising_retired_office_tools() {
        const MATERIAL: &str = "EXPERT_REFERENCE_REMAINS_READABLE_7c8e";
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&workspace).unwrap();
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        std::fs::write(workspace.join("reference.md"), MATERIAL).unwrap();
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |index, request| {
                let names = request["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|tool| tool["function"]["name"].as_str())
                    .collect::<Vec<_>>();
                assert!(
                    names.contains(&"read"),
                    "ordinary read must remain available"
                );
                for name in [
                    "OfficeRead",
                    "OfficeData",
                    "OfficeDocument",
                    "OfficeCard",
                    "OfficeExport",
                ] {
                    assert!(!names.contains(&name), "retired tool {name} was advertised");
                }
                match index {
                    0 => FixtureAnswer::Tool {
                        id: "read-kworker-reference".into(),
                        name: "read".into(),
                        input: json!({"file_path":"reference.md"}),
                    },
                    1 => {
                        let result = request["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|message| {
                                message["role"] == "tool"
                                    && message["tool_call_id"] == "read-kworker-reference"
                            })
                            .expect("actual general read result");
                        assert!(result["content"].as_str().unwrap().contains(MATERIAL));
                        FixtureAnswer::Text("The ordinary KWorker read completed.".into())
                    }
                    _ => panic!("unexpected provider request"),
                }
            },
            Some(2),
            Duration::from_secs(30),
        );
        let settings = profile.join("settings.json");
        write_fixture_provider_settings(&settings, &endpoint);
        let mut configured: Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        configured["permission_mode"] = json!("ask");
        configured["allowed_tools"] = json!(["read"]);
        configured["session_memory"] = json!({"enabled":false});
        // A retained legacy setting must not restore the removed ordinary Office runtime.
        configured["integrations"] = json!({"office":{"enabled":true}});
        configured["tools"] = json!({"studio":{"kworker":["read","OfficeRead","OfficeDocument"]}});
        std::fs::write(&settings, serde_json::to_vec(&configured).unwrap()).unwrap();
        let mut builder = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario();
        builder.training_mode = true;
        let mut server = builder.spawn();
        server.send(json!({"id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"kworker-general-tools","version":"1"},
            "capabilities":{"experimental":{"studioWorkModesV1":true,"threadStreamContextV1":true,
                "integrationScopeV1":false,"officeWorkspaceV1":false}}
        }}));
        let initialized = server.response(1);
        assert!(initialized["error"].is_null(), "{initialized}");
        server.send(json!({"id":2,"method":"thread/start","params":{"cwd":workspace,"studioWorkMode":"kworker"}}));
        let started = server.response(2);
        assert!(started["error"].is_null(), "{started}");
        let thread = started["result"]["thread"]["id"].as_str().unwrap();
        server.send(
            json!({"id":3,"method":"turn/start","params":{"threadId":thread,
            "clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":false},
            "input":[{"type":"text","text":"Read reference.md and acknowledge the result."}]}}),
        );
        let accepted = server.response(3);
        assert!(accepted["error"].is_null(), "{accepted}");
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            let event = server.next_value(deadline);
            if event["method"] == "turn/completed" && event["params"]["threadId"] == thread {
                assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                break;
            }
        }
        server.shutdown_successfully();
        fixture.join().unwrap();
        assert_eq!(calls.lock().unwrap().len(), 2);
    }
}
