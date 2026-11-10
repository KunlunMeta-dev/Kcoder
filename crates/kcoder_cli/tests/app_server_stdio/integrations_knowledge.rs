// Actual subprocess and native Wiki routes; controlled Provider assembly is not live-model quality.
#[test]
fn automation_task_models_capability_keeps_legacy_intent_and_requires_separate_opt_in() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let profile = root.path().join("profile");
    kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    let settings = profile.join("settings.json");
    knowledge_control_settings(&settings, true);
    let draft = json!({"id":"task-models-subscription","title":"Original explicit task model",
        "workflowId":"builtin-office-weekly-report","workflowVersion":1,
        "inputs":{"period":"2099-W01","asOfDate":"2099-01-01","sourceRefs":[{"kind":"publication","id":"not-read-during-preview","revision":"1"}]},
        "schedule":{"kind":"at","at":"2099-01-01T09:00:00Z"},"eventSource":null,
        "maximumTokens":5000,"maximumRuntimeSeconds":30,"delivery":{"kind":"studio"}});
    for enabled in [false, true] {
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .spawn();
        server.send(json!({"id":1,"method":"initialize","params":{
            "protocolVersion":"2026-07-27","clientInfo":{"name":"task-model-consumer","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"automationTemplatesV1":true,
                "modelPoliciesV1":true,"automationTaskModelsV1":enabled}}}}));
        let initialized = server.response(1);
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["automationTaskModelsV1"],
            enabled
        );
        server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
        let scope = server.response(2)["result"].clone();
        let preview = integration_memory_request(
            &mut server,
            3,
            "integrations/automation/previewSubscription",
            &scope,
            None,
            None,
            json!({"draft":draft,"consentRef":"preview-only"}),
        );
        assert_eq!(preview["result"]["status"], "completed", "{preview}");
        assert!(preview["result"]["result"].get("modelSelection").is_none());
        let mut selected = draft.clone();
        selected["modelSelection"] = json!({"kind":"auto_policy","id":"explicit-original-pool","version":"fixed-policy-version"});
        let preview = integration_memory_request(
            &mut server,
            4,
            "integrations/automation/previewSubscription",
            &scope,
            None,
            None,
            json!({"draft":selected,"consentRef":"preview-only"}),
        );
        if enabled {
            assert_eq!(preview["result"]["status"], "completed", "{preview}");
            assert_eq!(
                preview["result"]["result"]["modelSelection"],
                selected["modelSelection"]
            );
            let saved = integration_memory_request(
                &mut server,
                5,
                "integrations/automation/saveSubscription",
                &scope,
                Some("explicit-auto-original-save"),
                Some(0),
                json!({"draft":selected,"consentRef":"explicit-native-task-model-consent"}),
            );
            assert_eq!(saved["result"]["status"], "completed", "{saved}");
            assert_eq!(
                saved["result"]["result"]["subscription"]["draft"]["modelSelection"],
                selected["modelSelection"]
            );
        } else {
            assert!(
                preview.get("error").is_some(),
                "catalog capability must not enable task model intent: {preview}"
            );
        }
    }
}

fn initialize_knowledge_controls(server: &mut TestAppServer, id: i64) -> Value {
    server.send(json!({"id":id,"method":"initialize","params":{
        "protocolVersion":"2026-07-27","clientInfo":{"name":"native-knowledge-test","version":"1"},
        "capabilities":{"experimental":{"integrationScopeV1":true,
            "knowledgePublicationsV1":true,"automationTemplatesV1":true}}
    }}));
    server.response(id)
}

fn knowledge_control_settings(path: &std::path::Path, enabled: bool) {
    write_test_settings(path);
    let mut settings: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    settings["integrations"] = json!({"knowledge":{
        "publications_enabled":enabled,"business_automation_enabled":enabled
    }});
    std::fs::write(path, serde_json::to_vec(&settings).unwrap()).unwrap();
}

#[test]
fn integration_knowledge_public_rpc_uses_fixed_native_wiki_and_survives_restart() {
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let profile = root.path().join("profile");
    let directory = kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    directory
        .create_private_child(std::ffi::OsStr::new("knowledge"))
        .unwrap();
    let settings = profile.join("settings.json");
    knowledge_control_settings(&settings, true);
    let source_scope = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
        &format!("profile:{}", profile.canonicalize().unwrap().display()),
        "execution-host",
    )
    .unwrap();
    let mut source =
        kcoder_knowledge::KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite")).unwrap();
    let library = source
        .create(&source_scope, "native-library", "Original library", "")
        .unwrap();
    let original = source
        .import_text(
            &source_scope,
            &library.id,
            "native-material",
            "Evidence.md",
            "Fixed native source r1.",
        )
        .unwrap();
    let pages = source
        .commit_generated_pages(
            &source_scope,
            &library.id,
            "native-page",
            vec![KnowledgePageDraft {
                page_id: uuid::Uuid::new_v4().to_string(),
                expected_revision: None,
                kind: KnowledgePageKind::Concept,
                title: "Fixed page".into(),
                markdown: "Fixed native source r1.".into(),
                citations: vec![KnowledgeCitation {
                    source_id: original.source_id,
                    revision_id: original.revision_id,
                    chunk_id: "chunk-1".into(),
                    quote: "Fixed native source r1.".into(),
                }],
                related_page_ids: vec![],
            }],
        )
        .unwrap();
    let fixed = json!({"libraryId":library.id,"pageId":pages[0].page_id,"pageRevision":pages[0].revision_id});
    drop(source);
    let spawn = || {
        TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .spawn()
    };
    let mut server = spawn();
    let initialization = initialize_knowledge_controls(&mut server, 1);
    for capability in ["knowledgePublicationsV1", "automationTemplatesV1"] {
        assert_eq!(
            initialization["result"]["capabilities"]["experimental"][capability], true,
            "{initialization}"
        );
    }
    server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let scope = server.response(2)["result"].clone();
    let before = std::fs::read_dir(&profile).unwrap().count();
    let empty = integration_memory_request(
        &mut server,
        3,
        "integrations/knowledge/listPublications",
        &scope,
        None,
        None,
        json!({}),
    );
    assert_eq!(
        empty["result"]["result"]["page"]["items"],
        json!([]),
        "{empty}"
    );
    let templates = integration_memory_request(
        &mut server,
        4,
        "integrations/automation/listTemplates",
        &scope,
        None,
        None,
        json!({"locale":"zh-CN"}),
    );
    assert!(
        templates["result"]["result"]["templates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|template| template["id"] == "scheduled-review"),
        "{templates}"
    );
    assert_eq!(std::fs::read_dir(&profile).unwrap().count(), before);
    let draft = json!({"publicationId":"native-publication","title":"Fixed native publication",
        "visibility":"personal","audienceId":null,"sources":[fixed],
        "validFromMs":null,"validUntilMs":null,"unresolved":[]});
    let published = integration_memory_request(
        &mut server,
        5,
        "integrations/knowledge/publishKnowledge",
        &scope,
        Some("publish-once"),
        Some(0),
        json!({"draft":draft}),
    );
    assert_eq!(published["result"]["status"], "completed", "{published}");
    let publication = published["result"]["result"]["publication"].clone();
    assert_eq!(
        publication["pages"][0]["markdown"],
        "Fixed native source r1."
    );
    let replay = integration_memory_request(
        &mut server,
        6,
        "integrations/knowledge/publishKnowledge",
        &scope,
        Some("publish-once"),
        Some(0),
        json!({"draft":draft}),
    );
    assert_eq!(
        replay["result"]["result"]["publication"], publication,
        "{replay}"
    );
    server.shutdown_successfully();

    let mut restored = spawn();
    initialize_knowledge_controls(&mut restored, 1);
    restored.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let scope = restored.response(2)["result"].clone();
    let reference =
        json!({"owner":publication["owner"],"publicationId":"native-publication","version":1});
    let read = integration_memory_request(
        &mut restored,
        3,
        "integrations/knowledge/resolvePublication",
        &scope,
        None,
        None,
        reference.clone(),
    );
    assert_eq!(
        read["result"]["result"]["publication"], publication,
        "{read}"
    );
    let sources = integration_memory_request(
        &mut restored,
        4,
        "integrations/knowledge/readPublicationSources",
        &scope,
        None,
        None,
        reference.clone(),
    );
    assert_eq!(
        sources["result"]["result"]["page"]["items"][0]["source"], fixed,
        "{sources}"
    );
    let mut wrong = scope.clone();
    wrong["workspaceId"] = json!("different-workspace");
    let denied = integration_memory_request(
        &mut restored,
        5,
        "integrations/knowledge/resolvePublication",
        &wrong,
        None,
        None,
        reference.clone(),
    );
    assert_eq!(denied["result"]["status"], "rejected", "{denied}");
    assert_eq!(denied["result"]["result"], Value::Null);
    let revoked = integration_memory_request(
        &mut restored,
        6,
        "integrations/knowledge/revokePublication",
        &scope,
        Some("revoke-once"),
        Some(1),
        reference.clone(),
    );
    assert_eq!(revoked["result"]["status"], "completed", "{revoked}");
    let revoked_read = integration_memory_request(
        &mut restored,
        7,
        "integrations/knowledge/resolvePublication",
        &scope,
        None,
        None,
        reference,
    );
    assert_eq!(
        revoked_read["result"]["status"], "rejected",
        "{revoked_read}"
    );
    assert!(!revoked_read.to_string().contains("Fixed native source r1."));
    restored.shutdown_successfully();
}

#[test]
fn integration_knowledge_disabled_or_non_opted_in_clients_cannot_initialize_domains() {
    for enabled in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        knowledge_control_settings(&settings, enabled);
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .spawn();
        let initialization = if enabled {
            server.initialize(1)
        } else {
            initialize_knowledge_controls(&mut server, 1)
        };
        assert_ne!(
            initialization["result"]["capabilities"]["experimental"]["knowledgePublicationsV1"],
            true
        );
        let before = std::fs::read_dir(&profile).unwrap().count();
        server.send(json!({"id":2,"method":"integrations/knowledge/listPublications","params":{}}));
        let denied = server.response(2);
        assert_eq!(
            denied["error"]["message"], "KNOWLEDGE_RPC_UNAVAILABLE",
            "{denied}"
        );
        assert_eq!(std::fs::read_dir(&profile).unwrap().count(), before);
        assert!(!profile.join("knowledge").exists());
        server.shutdown_successfully();
    }
}

#[test]
fn integration_reviewed_memory_binds_before_actual_provider_and_exposes_only_authorized_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let profile = root.path().join("profile");
    kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
    let settings = profile.join("settings.json");
    let marker = "NATIVE_REVIEWED_MEMORY_LITERAL";
    let (endpoint, calls, fixture) = serving_fixture_decided(move |_, request| {
        let body = serde_json::to_string(&request).unwrap();
        assert_eq!(
            body.matches(marker).count(),
            1,
            "only one frozen Runtime note belongs in this request"
        );
        FixtureAnswer::Text("Completed the bounded task using the reviewed preference.".into())
    });
    write_fixture_provider_settings(&settings, &endpoint);
    let mut document: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    document["integrations"] = json!({"knowledge":{"memory_center_enabled":true}});
    std::fs::write(&settings, serde_json::to_vec(&document).unwrap()).unwrap();
    let mut server = TestAppServer::builder(&workspace, &settings)
        .config_dir(&profile)
        .without_scenario()
        .spawn();
    initialize_integration_scope(&mut server, 1);
    server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let scope = server.response(2)["result"].clone();
    let proposal = integration_memory_request(
        &mut server,
        3,
        "integrations/memory/propose",
        &scope,
        Some("reviewed-note"),
        None,
        json!({"proposal":{"title":"Output preference",
        "content":"NATIVE_REVIEWED_MEMORY_LITERAL: use short paragraphs.","category":"preference",
        "origin":"manual","provenance":[],"validUntilMs":null}}),
    );
    let memory_id = proposal["result"]["result"]["memory"]["id"]
        .as_str()
        .unwrap();
    let reviewed = integration_memory_request(
        &mut server,
        4,
        "integrations/memory/review",
        &scope,
        Some("accept-note"),
        Some(1),
        json!({"memoryId":memory_id,"review":{"action":"accept","editedContent":null}}),
    );
    assert_eq!(reviewed["result"]["status"], "completed", "{reviewed}");
    server.send(json!({"id":5,"method":"thread/start","params":{}}));
    let thread = server.response(5)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(
        json!({"id":6,"method":"turn/start","params":{"threadId":thread,
        "input":[{"type":"text","text":"Use my saved output preference for this bounded task."}]}}),
    );
    assert!(server.response(6).get("error").is_none());
    let started = server.wait_for_method("turn/started");
    let snapshot = started["params"]["turn"]["memorySnapshotId"]
        .as_str()
        .expect("native typed locator")
        .to_owned();
    let completed = server.wait_for_method("turn/completed");
    assert_eq!(
        completed["params"]["turn"]["status"], "completed",
        "{completed}"
    );
    assert_eq!(calls.lock().unwrap().len(), 1);
    let read = integration_memory_request(
        &mut server,
        7,
        "integrations/memory/readTaskSnapshot",
        &scope,
        None,
        None,
        json!({"threadId":thread,"taskId":snapshot}),
    );
    assert_eq!(read["result"]["status"], "completed", "{read}");
    assert!(
        read["result"]["result"]["snapshot"]
            .to_string()
            .contains(marker)
    );
    let mut wrong = scope.clone();
    wrong["accountId"] = json!("not-the-native-owner");
    let denied = integration_memory_request(
        &mut server,
        8,
        "integrations/memory/readTaskSnapshot",
        &wrong,
        None,
        None,
        json!({"threadId":thread,"taskId":snapshot}),
    );
    assert_ne!(denied["result"]["status"], "completed", "{denied}");
    assert!(!denied.to_string().contains(marker));
    server.send(json!({"id":9,"method":"thread/read","params":{"threadId":thread,"limit":50}}));
    assert!(
        !server.response(9)["result"]["messages"]
            .to_string()
            .contains(marker)
    );
    server.shutdown_successfully();
    fixture.join().unwrap();
}
