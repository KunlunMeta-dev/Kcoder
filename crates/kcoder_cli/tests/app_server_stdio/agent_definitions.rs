// Real stdio, protected definition storage, persistent threads and loopback Provider.
#[cfg(target_os = "linux")]
mod agent_definitions {
    use super::*;

    fn rpc(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer) -> Value {
        let initialized = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"agent-definition-original-task","version":"1"},
            "capabilities":{"experimental":{"agentDefinitionsV1":true,"agentTurnConfigurationV1":true,"taskSourcesV1":true,"threadRuntimeHandoffV1":true,"interactionBindingV1":true,"integrationScopeV1":true,"officeWorkspaceV1":true,"threadCreationReceiptsV1":true}}}),
        );
        assert!(initialized["error"].is_null(), "{initialized}");
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["agentDefinitionsV1"],
            true
        );
        rpc(server, 2, "integrations/scope/read", json!({}))["result"].clone()
    }
    fn office(
        server: &mut TestAppServer,
        id: i64,
        method: &str,
        scope: &Value,
        operation: &str,
        payload: Value,
        revision: Option<u64>,
    ) -> Value {
        let mut request = json!({"contractVersion":"parallel-v1","requestId":format!("request-{id}"),"scope":scope,"operationId":operation,"timeoutMs":30000,"payload":payload});
        if let Some(revision) = revision {
            request["expectedRevision"] = json!(revision.to_string());
        }
        let response = rpc(server, id, method, request);
        assert!(response["error"].is_null(), "{response}");
        assert_eq!(response["result"]["status"], "completed", "{response}");
        response["result"]["result"].clone()
    }

    #[test]
    fn expert_ordinary_task_keeps_version_history_and_revocation_after_restart() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&workspace).unwrap();
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        let (release, released) = std::sync::mpsc::channel();
        let (entered, entry) = std::sync::mpsc::channel();
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            move |index, _| {
                if index == 0 {
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(15)).unwrap();
                }
                FixtureAnswer::Text("Original expert result".into())
            },
            Some(3),
            Duration::from_secs(20),
        );
        write_fixture_provider_settings(&settings, &endpoint);
        let mut configured: Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        configured["integrations"] = json!({"office":{"enabled":true}});
        configured["session_memory"] = json!({"enabled":false});
        std::fs::write(&settings, serde_json::to_vec(&configured).unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o600)).unwrap();
        let parent = format!(
            "v1.{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(br#"{"version":1,"mode":"localOs"}"#)
        );
        let spawn = || {
            let builder = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .env("KCODER_PRIVATE_RETENTION_PARENT_V1", &parent);
            match std::env::var_os("KCODER_TEST_EXPERT_BIN") {
                Some(binary) => builder.binary(std::path::Path::new(&binary)).spawn(),
                None => builder.spawn(),
            }
        };
        let mut server = spawn();
        let scope = initialize(&mut server);
        let definition = json!({"schemaVersion":1,"id":"personal.original-expert","scope":"personal","title":"Original expert",
            "description":"Original immutable instructions","language":"en","inputSchema":{"type":"object"},
            "instructions":"BASE_EXPERT_INSTRUCTIONS","skills":[
                {"slug":"enabled","title":"Enabled","description":"","content":"ENABLED_EXPERT_SKILL","enabled":true},
                {"slug":"disabled","title":"Disabled","description":"","content":"DISABLED_EXPERT_SKILL","enabled":false}],
            "modelSelection":{"kind":"inherit_current"},"allowedTools":[],"outputKinds":["document"],"acceptanceCriteria":["Keep exact source"],"externalSend":"deny"});
        let draft = office(
            &mut server,
            3,
            "integrations/assistant/saveDraft",
            &scope,
            "original-expert-draft",
            json!({"definition":definition}),
            None,
        );
        let saved = office(
            &mut server,
            4,
            "integrations/assistant/saveVersion",
            &scope,
            "original-expert-version",
            json!({"id":definition["id"],"version":"1"}),
            draft["draft"]["revision"].as_u64(),
        );
        let stored = &saved["saved"];
        assert!(stored["definitionSha256"].is_string(), "{saved}");
        let reference = json!({"id":definition["id"],"version":"1","definitionSha256":stored["definitionSha256"]});
        let mut wrong_hash = reference.clone();
        wrong_hash["definitionSha256"] = json!("0".repeat(64));
        let denied = rpc(
            &mut server,
            15,
            "thread/start",
            json!({"clientRequestId":"must-not-create", "agentDefinition":wrong_hash}),
        );
        assert!(denied["error"].is_object(), "{denied}");
        let created = rpc(
            &mut server,
            6,
            "thread/start",
            json!({"clientRequestId":"original-expert-task","agentDefinition":reference}),
        );
        assert!(created["error"].is_null(), "{created}");
        let thread = created["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            created["result"]["thread"]["agentDefinition"]["definition"],
            reference
        );
        assert_eq!(created["result"]["thread"]["studioWorkMode"], "kcoder");
        let replay = rpc(
            &mut server,
            7,
            "thread/start",
            json!({"clientRequestId":"original-expert-task","agentDefinition":reference}),
        );
        assert_eq!(replay["result"]["thread"]["id"], thread);
        let first = rpc(
            &mut server,
            8,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"First original request"}]}),
        );
        assert!(first["error"].is_null(), "{first}");
        entry.recv_timeout(Duration::from_secs(15)).unwrap();
        let cleared = rpc(
            &mut server,
            17,
            "thread/expert",
            json!({"threadId":thread,"change":{"expectedRevision":0,"expert":null}}),
        );
        assert!(cleared["error"].is_null(), "{cleared}");
        assert_eq!(cleared["result"]["threadId"], thread);
        assert_eq!(cleared["result"]["revision"], 1);
        release.send(()).unwrap();
        let completed = server.wait_for_method("turn/completed");
        assert_eq!(
            completed["params"]["turn"]["status"], "completed",
            "{completed}"
        );
        let stale = rpc(
            &mut server,
            18,
            "thread/expert",
            json!({"threadId":thread,"change":{"expectedRevision":0,"expert":reference}}),
        );
        assert!(stale["error"].is_object(), "{stale}");
        let plain = rpc(
            &mut server,
            19,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"Plain task request"}]}),
        );
        assert!(plain["error"].is_null(), "{plain}");
        server.wait_for_method("turn/completed");
        let selected = rpc(
            &mut server,
            20,
            "thread/expert",
            json!({"threadId":thread,"change":{"expectedRevision":1,"expert":reference}}),
        );
        assert!(selected["error"].is_null(), "{selected}");
        assert_eq!(selected["result"]["revision"], 2);
        let mut changed_draft = definition.clone();
        changed_draft["instructions"] = json!("SAVED_PERSONALIZATION_APPLIES_NEXT_TURN");
        changed_draft["allowedTools"] = json!(["read", "write", "skill", "DiscoverSkills"]);
        for skill in changed_draft["skills"].as_array_mut().unwrap() {
            if skill["enabled"] == true {
                skill["allowedTools"] = json!(["read"]);
            }
        }
        office(
            &mut server,
            16,
            "integrations/assistant/saveDraft",
            &scope,
            "changed-expert-draft",
            json!({"definition":changed_draft}),
            draft["draft"]["revision"].as_u64(),
        );
        server.shutdown_successfully();

        let mut restored = spawn();
        let scope = initialize(&mut restored);
        let listed = rpc(&mut restored, 9, "thread/list", json!({}));
        let item = listed["result"]["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == thread)
            .unwrap_or_else(|| {
                panic!("Original task {thread} absent from actual public list: {listed}")
            });
        assert_eq!(item["agentDefinition"]["definition"], reference);
        let resumed = rpc(
            &mut restored,
            10,
            "thread/resume",
            json!({"threadId":thread}),
        );
        assert!(resumed["error"].is_null(), "{resumed}");
        let second = rpc(
            &mut restored,
            11,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"Second original request"}]}),
        );
        assert!(second["error"].is_null(), "{second}");
        restored.wait_for_method("turn/completed");
        let trace = rpc(
            &mut restored,
            21,
            "thread/expert",
            json!({"threadId":thread}),
        );
        assert!(trace["error"].is_null(), "{trace}");
        assert_eq!(trace["result"]["revision"], 2);
        assert_eq!(trace["result"]["turns"].as_array().unwrap().len(), 3);
        let turns = trace["result"]["turns"].as_array().unwrap();
        assert_eq!(turns[0]["selectionRevision"], 2);
        assert_eq!(turns[0]["expert"]["definition"], reference);
        assert_eq!(turns[0]["personalizationRevision"], 2);
        assert!(turns[1]["expert"].is_null());
        assert_eq!(turns[2]["selectionRevision"], 0);
        assert_ne!(
            turns[0]["effectiveDefinitionSha256"],
            turns[2]["effectiveDefinitionSha256"]
        );
        office(
            &mut restored,
            12,
            "integrations/assistant/archive",
            &scope,
            "archive-original-version",
            json!({"id":definition["id"],"version":"1"}),
            None,
        );
        let blocked = rpc(
            &mut restored,
            13,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"Must not reach provider"}]}),
        );
        assert!(blocked["error"].is_object(), "{blocked}");
        let history = rpc(&mut restored, 14, "thread/read", json!({"threadId":thread}));
        assert!(history.to_string().contains("First original request"));
        assert!(history.to_string().contains("Second original request"));
        assert!(!history.to_string().contains("Must not reach provider"));
        restored.shutdown_successfully();
        fixture.join().unwrap();
        let requests = calls.lock().unwrap();
        assert_eq!(requests.len(), 3, "{requests:?}");
        let first = requests[0].to_string();
        assert!(
            requests[0]
                .get("tools")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty),
            "Expert tool filter must apply to the actual provider payload"
        );
        assert!(first.contains("BASE_EXPERT_INSTRUCTIONS"));
        assert!(first.contains("ENABLED_EXPERT_SKILL"));
        assert!(first.contains("selected expert \\\"Original expert\\\""));
        assert!(!first.contains("SAVED_PERSONALIZATION_APPLIES_NEXT_TURN"));
        let plain = requests[1].to_string();
        assert!(!plain.contains("BASE_EXPERT_INSTRUCTIONS"));
        assert!(!plain.contains("ENABLED_EXPERT_SKILL"));
        assert!(plain.contains("You are KCoder"));
        let personalized = requests[2].to_string();
        let tool_names = requests[2]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| {
                tool["function"]["name"]
                    .as_str()
                    .or_else(|| tool["name"].as_str())
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(tool_names.contains(&"read"), "{personalized}");
        assert!(tool_names.contains(&"skill"), "{personalized}");
        assert!(!tool_names.contains(&"write"), "{personalized}");
        assert!(personalized.contains("SAVED_PERSONALIZATION_APPLIES_NEXT_TURN"));
        assert!(!personalized.contains("BASE_EXPERT_INSTRUCTIONS"));
        assert!(personalized.contains("selected expert \\\"Original expert\\\""));
        for request in requests.iter() {
            assert!(!request.to_string().contains("DISABLED_EXPERT_SKILL"));
        }
    }
}
