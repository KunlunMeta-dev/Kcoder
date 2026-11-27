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
            "capabilities":{"experimental":{"agentDefinitionsV1":true,"agentTurnConfigurationV1":true,"threadExpertReadWithoutTurnsV1":true,"taskSourcesV1":true,"threadRuntimeHandoffV1":true,"interactionBindingV1":true,"integrationScopeV1":false,"officeWorkspaceV1":false,"agentDefinitionManagementV1":true,"threadCreationReceiptsV1":true}}}),
        );
        assert!(initialized["error"].is_null(), "{initialized}");
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["agentDefinitionsV1"],
            true
        );
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["agentDefinitionManagementV1"],
            true
        );
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["threadExpertReadWithoutTurnsV1"],
            true
        );
        rpc(server, 2, "agentDefinitions/scope/read", json!({}))["result"].clone()
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
    fn expert_requirement_validation_uses_profile_scope_without_office_readiness() {
        for office_enabled in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("workspace");
            let profile = root.path().join("profile");
            kcoder_config::PrivateDirectory::open_or_create(&workspace).unwrap();
            let profile_directory =
                kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
            let settings = profile.join("settings.json");
            write_test_settings(&settings);
            let mut configured: Value =
                serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
            configured["integrations"] = json!({"office":{"enabled":office_enabled}});
            std::fs::write(&settings, serde_json::to_vec(&configured).unwrap()).unwrap();
            let mut server = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .spawn();
            let initialized = rpc(
                &mut server,
                1,
                "initialize",
                json!({"protocolVersion":"2026-07-27",
                "clientInfo":{"name":"expert-static-requirements","version":"1"},
                "capabilities":{"experimental":{"agentDefinitionManagementV1":true,
                "integrationScopeV1":office_enabled,"officeWorkspaceV1":office_enabled}}}),
            );
            assert!(initialized["error"].is_null(), "{initialized}");
            assert_eq!(
                initialized["result"]["capabilities"]["experimental"]["agentDefinitionManagementV1"],
                true
            );
            let scope =
                rpc(&mut server, 2, "agentDefinitions/scope/read", json!({}))["result"].clone();
            let mut definition = serde_json::to_value(
                kcoder_config::integrations::office::builtin_office_assistant(
                    "builtin.meeting-minutes",
                    "en",
                )
                .unwrap(),
            )
            .unwrap();
            definition["capabilities"] = json!([]);
            for (index, requirement) in [
                json!({"capabilities":[{"capabilityId":"office.document.generate","formats":["docx"]}]}),
                json!({"resources":[{"kind":"application","id":"declared-source","revision":"1"}]}),
                json!({"workflowRef":{"definitionId":"declared-workflow","version":1}}),
            ]
            .into_iter()
            .enumerate()
            {
                let mut declared = definition.clone();
                declared.as_object_mut().unwrap().extend(requirement.as_object().unwrap().clone());
                let report = office(
                    &mut server,
                    3 + index as i64,
                    "integrations/assistant/validate",
                    &scope,
                    &format!("static-requirement-{index}"),
                    json!({"definition":declared}),
                    None,
                );
                assert_eq!(report["definitionValid"], true, "{report}");
                assert_eq!(report["staticOnly"], true, "{report}");
                assert_eq!(report["adoptable"], false, "{report}");
                assert_eq!(report["reasonCode"], "AGENT_RECHECK_ON_EXECUTION");
                assert!(report.get("readiness").is_none(), "{report}");
            }
            if office_enabled {
                let native =
                    rpc(&mut server, 6, "integrations/scope/read", json!({}))["result"].clone();
                let declared = kcoder_config::integrations::office::builtin_office_assistant(
                    "builtin.meeting-minutes",
                    "en",
                )
                .unwrap();
                let report = office(
                    &mut server,
                    7,
                    "integrations/assistant/validate",
                    &native,
                    "office-requirements",
                    json!({"definition":declared}),
                    None,
                );
                assert_eq!(report["reasonCode"], "OFFICE_RECHECK_ON_ADOPTION");
                assert!(report["readiness"].is_object(), "{report}");
            }
            let scope = serde_json::from_value(scope).unwrap();
            assert!(
                kcoder_state::domain_storage::DomainStorageGuard::observe(
                    &profile_directory,
                    &scope,
                    kcoder_state::domain_storage::StorageDomain::WorkspaceResources,
                )
                .unwrap()
                .is_none()
            );
            assert_eq!(
                rpc(&mut server, 8, "thread/list", json!({"limit":10}))["result"]["threads"],
                json!([])
            );
        }
    }

    #[test]
    fn expert_execution_does_not_require_a_negotiated_but_revoked_native_identity() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&workspace).unwrap();
        let directory = kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
            |_, _| FixtureAnswer::Text("Ordinary expert execution completed".into()),
            Some(1),
            Duration::from_secs(20),
        );
        write_fixture_provider_settings(&settings, &endpoint);
        let mut configured: Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        configured["integrations"] = json!({"office":{"enabled":false},
            "remotes":{"enabled":false},"knowledge":{"memory_center_enabled":false}});
        configured["session_memory"] = json!({"enabled":false});
        std::fs::write(&settings, serde_json::to_vec(&configured).unwrap()).unwrap();
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario()
            .spawn();
        let initialized = rpc(
            &mut server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"expert-native-capable-client","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"agentDefinitionManagementV1":true,
                "agentDefinitionsV1":true,"threadCreationReceiptsV1":true}}}),
        );
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["integrationScopeV1"],
            true
        );
        let native = rpc(&mut server, 2, "integrations/scope/read", json!({}));
        let mut native_scope: kcoder_types::integrations::core::IntegrationScope =
            serde_json::from_value(native["result"].clone()).unwrap();
        native_scope.workspace_id = kcoder_types::integrations::core::IntegrationNullable::Null;
        let identity = kcoder_native_scope::NativeIdentity::observe(&directory, &native_scope)
            .unwrap()
            .unwrap();
        identity
            .disable(
                &directory,
                "disable-unused-native-integrations",
                identity.snapshot(&directory).unwrap().revision,
                1000,
            )
            .unwrap();
        let scope = rpc(&mut server, 3, "agentDefinitions/scope/read", json!({}))["result"].clone();
        let mut definition = serde_json::to_value(
            kcoder_config::integrations::office::builtin_office_assistant(
                "builtin.meeting-minutes",
                "en",
            )
            .unwrap(),
        )
        .unwrap();
        definition["id"] = json!("personal.independent-native-capable-client");
        definition["capabilities"] = json!([]);
        definition["allowedTools"] = json!([]);
        definition["instructions"] = json!("EXPERT_WITHOUT_NATIVE_AUTH");
        let draft = office(
            &mut server,
            4,
            "integrations/assistant/saveDraft",
            &scope,
            "independent-native-client-draft",
            json!({"definition":definition}),
            None,
        );
        let version = office(
            &mut server,
            5,
            "integrations/assistant/saveVersion",
            &scope,
            "independent-native-client-version",
            json!({"id":definition["id"],"version":"1"}),
            draft["draft"]["revision"].as_u64(),
        );
        let reference = json!({"id":definition["id"],"version":"1",
            "definitionSha256":version["saved"]["definitionSha256"]});
        let created = rpc(
            &mut server,
            6,
            "thread/start",
            json!({"clientRequestId":"independent-native-client-task","agentDefinition":reference}),
        );
        assert!(created["error"].is_null(), "{created}");
        let thread = created["result"]["thread"]["id"].as_str().unwrap();
        let turn = rpc(
            &mut server,
            7,
            "turn/start",
            json!({"threadId":thread,"input":[{"type":"text","text":"Run the selected expert normally."}]}),
        );
        assert!(turn["error"].is_null(), "{turn}");
        let completed = server.wait_for_method("turn/completed");
        assert_eq!(
            completed["params"]["turn"]["status"], "completed",
            "{completed}"
        );
        server.shutdown_successfully();
        fixture.join().unwrap();
        let requests = calls.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .to_string()
                .contains("EXPERT_WITHOUT_NATIVE_AUTH")
        );
    }

    #[test]
    fn expert_ordinary_task_without_office_keeps_version_history_and_revocation_after_restart() {
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
        configured["integrations"] = json!({"office":{"enabled":false}});
        configured["session_memory"] = json!({"enabled":false});
        std::fs::write(&settings, serde_json::to_vec(&configured).unwrap()).unwrap();
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
        let profile_directory = kcoder_config::PrivateDirectory::open_existing(&profile).unwrap();
        let mut identity_scope: kcoder_types::integrations::core::IntegrationScope =
            serde_json::from_value(scope.clone()).unwrap();
        identity_scope.workspace_id = kcoder_types::integrations::core::IntegrationNullable::Null;
        assert!(
            kcoder_state::domain_storage::DomainStorageGuard::observe(
                &profile_directory,
                &identity_scope,
                kcoder_state::domain_storage::StorageDomain::Identity,
            )
            .unwrap()
            .is_none()
        );
        let definition = json!({"schemaVersion":1,"id":"personal.original-expert","scope":"personal","title":"Original expert",
            "description":"Original immutable instructions","language":"en","inputSchema":{"type":"object"},
            "instructions":"BASE_EXPERT_INSTRUCTIONS","skills":[
                {"slug":"enabled","title":"Enabled","description":"","content":"ENABLED_EXPERT_SKILL","enabled":true},
                {"slug":"disabled","title":"Disabled","description":"","content":"DISABLED_EXPERT_SKILL","enabled":false}],
            "modelSelection":{"kind":"explicit","provider":"fixture","model":"fixture-model"},"allowedTools":[],"outputKinds":["document"],"acceptanceCriteria":["Keep exact source"],"externalSend":"deny"});
        let draft = office(
            &mut server,
            3,
            "integrations/assistant/saveDraft",
            &scope,
            "original-expert-draft",
            json!({"definition":definition}),
            None,
        );
        let original = office(
            &mut server,
            1001,
            "agentDefinitions/operation/read",
            &scope,
            "read-original-expert-draft",
            json!({"operationId":"original-expert-draft"}),
            None,
        );
        assert_eq!(original["phase"], "completed");
        assert_eq!(original["result"]["definition"]["id"], definition["id"]);
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
        let mut disabled_definition = definition.clone();
        disabled_definition["inputSchema"]["x-kcoder-expert"] = json!({"enabled":false});
        let disabled_draft = office(
            &mut server,
            22,
            "integrations/assistant/saveDraft",
            &scope,
            "disable-expert-before-binding",
            json!({"definition":disabled_definition}),
            draft["draft"]["revision"].as_u64(),
        );
        let disabled_start = rpc(
            &mut server,
            23,
            "thread/start",
            json!({"clientRequestId":"disabled-expert-task","agentDefinition":reference}),
        );
        assert_eq!(
            disabled_start["error"]["message"], "AGENT_DEFINITION_DISABLED",
            "{disabled_start}"
        );
        let restored_draft = office(
            &mut server,
            24,
            "integrations/assistant/saveDraft",
            &scope,
            "restore-expert-before-binding",
            json!({"definition":definition}),
            disabled_draft["draft"]["revision"].as_u64(),
        );
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
        let mut unavailable_model_definition = definition.clone();
        unavailable_model_definition["id"] = json!("personal.unavailable-model");
        unavailable_model_definition["modelSelection"] = json!({
            "kind":"explicit",
            "provider":"missing-provider",
            "model":"missing-model"
        });
        let unavailable_model_draft = office(
            &mut server,
            28,
            "integrations/assistant/saveDraft",
            &scope,
            "unavailable-model-draft",
            json!({"definition":unavailable_model_definition}),
            None,
        );
        let unavailable_model_version = office(
            &mut server,
            29,
            "integrations/assistant/saveVersion",
            &scope,
            "unavailable-model-version",
            json!({"id":"personal.unavailable-model","version":"1"}),
            unavailable_model_draft["draft"]["revision"].as_u64(),
        );
        let unavailable_model_reference = json!({
            "id":"personal.unavailable-model",
            "version":"1",
            "definitionSha256":unavailable_model_version["saved"]["definitionSha256"]
        });
        let unavailable_reselection = rpc(
            &mut server,
            30,
            "thread/expert",
            json!({"threadId":thread,"change":{"expectedRevision":2,"expert":unavailable_model_reference}}),
        );
        assert_eq!(
            unavailable_reselection["error"]["message"],
            "AGENT_MODEL_SELECTION_UNAVAILABLE",
            "{unavailable_reselection}"
        );
        let unchanged_binding = rpc(
            &mut server,
            31,
            "thread/expert",
            json!({"threadId":thread,"includeTurns":false}),
        );
        assert_eq!(unchanged_binding["result"]["revision"], 2);
        assert_eq!(unchanged_binding["result"]["expert"]["definition"], reference);
        let mut changed_draft = definition.clone();
        changed_draft["instructions"] = json!("SAVED_PERSONALIZATION_APPLIES_NEXT_TURN");
        changed_draft["allowedTools"] = json!(["read", "write", "skill", "DiscoverSkills"]);
        for skill in changed_draft["skills"].as_array_mut().unwrap() {
            if skill["enabled"] == true {
                skill["allowedTools"] = json!(["read"]);
            }
        }
        let changed_saved_draft = office(
            &mut server,
            16,
            "integrations/assistant/saveDraft",
            &scope,
            "changed-expert-draft",
            json!({"definition":changed_draft.clone()}),
            restored_draft["draft"]["revision"].as_u64(),
        );
        let mut disabled_saved_personalization = changed_draft;
        disabled_saved_personalization["inputSchema"]["x-kcoder-expert"] = json!({"enabled":false});
        let disabled_personalization = office(
            &mut server,
            25,
            "integrations/assistant/saveDraft",
            &scope,
            "disable-expert-after-binding",
            json!({"definition":disabled_saved_personalization}),
            changed_saved_draft["draft"]["revision"].as_u64(),
        );
        assert!(disabled_personalization["error"].is_null(), "{disabled_personalization}");
        let disabled_reselection = rpc(
            &mut server,
            26,
            "thread/expert",
            json!({"threadId":thread,"change":{"expectedRevision":2,"expert":reference}}),
        );
        assert_eq!(
            disabled_reselection["error"]["message"], "AGENT_DEFINITION_DISABLED",
            "{disabled_reselection}"
        );
        let lightweight = rpc(
            &mut server,
            27,
            "thread/expert",
            json!({"threadId":thread,"includeTurns":false}),
        );
        assert!(lightweight["error"].is_null(), "{lightweight}");
        assert_eq!(lightweight["result"]["revision"], 2);
        assert!(lightweight["result"]["expert"].is_object());
        assert_eq!(lightweight["result"]["turns"], json!([]));
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
        // A task that is not resident is read from its persisted sidecar
        // without resuming it; a change still requires the resident owner.
        let cold = rpc(
            &mut restored,
            40,
            "thread/expert",
            json!({"threadId":thread,"includeTurns":false}),
        );
        assert!(cold["error"].is_null(), "{cold}");
        assert_eq!(cold["result"]["revision"], 2);
        assert_eq!(cold["result"]["expert"]["definition"], reference);
        let cold_change = rpc(
            &mut restored,
            41,
            "thread/expert",
            json!({"threadId":thread,"change":{"expectedRevision":2,"expert":null}}),
        );
        assert_eq!(
            cold_change["error"]["message"], "AGENT_ORIGINAL_TASK_UNAVAILABLE",
            "{cold_change}"
        );
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
        assert_eq!(
            turns[0]["personalizationRevision"],
            disabled_personalization["draft"]["revision"]
        );
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
        assert!(
            kcoder_state::domain_storage::DomainStorageGuard::observe(
                &profile_directory,
                &identity_scope,
                kcoder_state::domain_storage::StorageDomain::Identity,
            )
            .unwrap()
            .is_none(),
            "Expert execution and recovery must not initialize a Native identity"
        );
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
