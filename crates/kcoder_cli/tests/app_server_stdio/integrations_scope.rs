// Model-independent native subprocess acceptance; no model request is sent.
fn initialize_integration_scope(server: &mut TestAppServer, id: i64) -> Value {
    server.send(json!({
        "jsonrpc":"2.0", "id":id, "method":"initialize",
        "params":{"protocolVersion":"2026-07-27", "clientInfo":{"name":"integration-scope-test","version":"1"},
        "capabilities":{"experimental":{"integrationScopeV1":true,"memoryReviewV1":true,"integrationOperationReceiptsV1":true}}}
    }));
    server.response(id)
}

fn integration_memory_request(server: &mut TestAppServer, id: i64, method: &str, scope: &Value, operation: Option<&str>, revision: Option<u64>, payload: Value) -> Value {
    let mut request = json!({"contractVersion":"parallel-v1","requestId":format!("native-request-{id}"),"scope":scope,"timeoutMs":10_000,"payload":payload});
    if let Some(operation) = operation { request["operationId"] = json!(operation); }
    if let Some(revision) = revision { request["expectedRevision"] = json!(revision.to_string()); }
    server.send(json!({"id":id,"method":method,"params":request}));
    server.response(id)
}

#[test]
fn integration_memory_native_crud_replays_original_receipts_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let spawn = || TestAppServer::builder(&workspace, &settings).config_dir(&config).spawn();
    let mut server = spawn();
    let initialized = initialize_integration_scope(&mut server, 1);
    assert_eq!(initialized["result"]["capabilities"]["experimental"]["memoryReviewV1"], true);
    server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let scope = server.response(2)["result"].clone();
    let before = std::fs::read_dir(&config).unwrap().count();
    let empty = integration_memory_request(&mut server, 3, "integrations/memory/list", &scope, None, None, json!({}));
    assert_eq!(empty["result"]["result"]["page"]["items"], json!([]), "{empty}");
    assert_eq!(std::fs::read_dir(&config).unwrap().count(), before);
    let absent = integration_memory_request(&mut server, 11, "integrations/operation/read", &scope, None, None, json!({"operationId":"unseen-operation"}));
    assert_eq!(absent["result"]["result"]["receipt"], Value::Null, "{absent}");
    assert_eq!(std::fs::read_dir(&config).unwrap().count(), before);
    let mut forged = scope.clone();
    forged["accountId"] = json!("someone-else");
    let denied = integration_memory_request(&mut server, 4, "integrations/memory/list", &forged, None, None, json!({}));
    assert_eq!(denied["result"]["status"], "rejected", "{denied}");
    assert_eq!(std::fs::read_dir(&config).unwrap().count(), before);
    let proposal = json!({"proposal":{"title":"报告偏好","content":"先列结论，再列来源。","category":"preference","origin":"manual","provenance":[],"validUntilMs":null}});
    let created = integration_memory_request(&mut server, 5, "integrations/memory/propose", &scope, Some("proposal-once"), None, proposal.clone());
    assert_eq!(created["result"]["status"], "completed", "{created}");
    let memory = created["result"]["result"]["memory"].clone();
    assert_eq!(memory["enabled"], false);
    let memory_id = memory["id"].as_str().unwrap().to_owned();
    let replay = integration_memory_request(&mut server, 6, "integrations/memory/propose", &scope, Some("proposal-once"), None, proposal);
    assert_eq!(replay["result"]["result"]["memory"], memory);
    let reviewed = integration_memory_request(&mut server, 7, "integrations/memory/review", &scope, Some("review-once"), Some(1), json!({"memoryId":memory_id,"review":{"action":"accept","editedContent":null}}));
    assert_eq!(reviewed["result"]["result"]["memory"]["revision"], 2, "{reviewed}");
    assert_eq!(reviewed["result"]["result"]["memory"]["enabled"], true);
    let stale = integration_memory_request(&mut server, 8, "integrations/memory/edit", &scope, Some("stale-edit"), Some(1), json!({"memoryId":memory_id,"content":"stale content"}));
    assert_eq!(stale["result"]["status"], "rejected", "{stale}");
    let receipt = integration_memory_request(&mut server, 9, "integrations/operation/read", &scope, None, None, json!({"operationId":"proposal-once"}));
    assert_eq!(receipt["result"]["result"]["receipt"]["phase"], "completed", "{receipt}");
    assert_eq!(receipt["result"]["result"]["receipt"]["scope"], scope);
    assert!(!receipt.to_string().contains("先列结论"));
    let rejected = integration_memory_request(&mut server, 10, "integrations/operation/read", &scope, None, None, json!({"operationId":"stale-edit"}));
    assert_eq!(rejected["result"]["result"]["receipt"]["phase"], "rejected", "{rejected}");
    server.shutdown_successfully();

    let mut restored = spawn();
    initialize_integration_scope(&mut restored, 1);
    restored.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let restored_scope = restored.response(2)["result"].clone();
    let read = integration_memory_request(&mut restored, 3, "integrations/memory/read", &restored_scope, None, None, json!({"memoryId":memory_id}));
    assert_eq!(read["result"]["result"]["memory"]["revision"], 2, "{read}");
    assert_eq!(read["result"]["result"]["memory"]["proposal"]["content"], "先列结论，再列来源。");
    let removed = integration_memory_request(&mut restored, 4, "integrations/memory/forget", &restored_scope, Some("forget-once"), Some(2), json!({"memoryId":memory_id}));
    assert_eq!(removed["result"]["result"]["memory"]["deleted"], true, "{removed}");
    let list = integration_memory_request(&mut restored, 5, "integrations/memory/list", &restored_scope, None, None, json!({}));
    assert_eq!(list["result"]["result"]["page"]["items"], json!([]));
    restored.shutdown_successfully();
}

#[test]
fn integration_memory_native_missing_committed_data_is_not_silently_reinitialized() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(&workspace, &settings).config_dir(&config).spawn();
    initialize_integration_scope(&mut server, 1);
    server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let scope = server.response(2)["result"].clone();
    let created = integration_memory_request(&mut server, 3, "integrations/memory/propose", &scope, Some("original-proposal"), None,
        json!({"proposal":{"title":"格式","content":"保留来源。","category":"preference","origin":"manual","provenance":[],"validUntilMs":null}}));
    assert_eq!(created["result"]["status"], "completed", "{created}");
    let data = find_named_file(&config, "memory-review.json").unwrap();
    std::fs::remove_file(&data).unwrap();
    let read = integration_memory_request(&mut server, 4, "integrations/memory/list", &scope, None, None, json!({}));
    assert_ne!(read["result"]["status"], "completed", "{read}");
    assert!(read["result"]["result"].is_null());
    assert!(!data.exists());
    server.shutdown_successfully();
}

#[test]
fn integration_scope_native_subprocess_is_opt_in_and_does_not_accept_owner_labels() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let spawn = || TestAppServer::builder(&workspace, &settings).config_dir(&config).spawn();
    let mut legacy = spawn();
    let initialization = legacy.initialize(1);
    assert_ne!(initialization["result"]["capabilities"]["experimental"]["integrationScopeV1"], true);
    legacy.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    assert_eq!(legacy.response(2)["error"]["code"], -32070);
    legacy.shutdown_successfully();

    let mut current = spawn();
    let initialization = initialize_integration_scope(&mut current, 1);
    assert_eq!(initialization["result"]["capabilities"]["experimental"]["integrationScopeV1"], true, "{initialization}");
    current.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let first = current.response(2);
    let scope: kcoder_types::integrations::core::IntegrationScope = serde_json::from_value(first["result"].clone()).unwrap();
    scope.validate().unwrap();
    assert!(scope.organization_id.is_none());
    assert!(!first.to_string().contains(temp.path().to_str().unwrap()));
    current.send(json!({"id":3,"method":"integrations/scope/read","params":{"accountId":"caller-chosen"}}));
    assert_eq!(current.response(3)["error"]["code"], -32070);
    current.send(json!({"id":4,"method":"integrations/scope/read","params":{}}));
    assert_eq!(current.response(4)["result"], first["result"]);
    current.shutdown_successfully();
}

#[test]
fn integration_scope_restart_preserves_owner_and_persistent_identity_generation() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let spawn = || TestAppServer::builder(&workspace, &settings).config_dir(&config).spawn();
    let mut first = spawn();
    initialize_integration_scope(&mut first, 1);
    first.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let first_scope: kcoder_types::integrations::core::IntegrationScope = serde_json::from_value(first.response(2)["result"].clone()).unwrap();
    first.shutdown_successfully();
    let mut second = spawn();
    initialize_integration_scope(&mut second, 1);
    second.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    let second_scope: kcoder_types::integrations::core::IntegrationScope = serde_json::from_value(second.response(2)["result"].clone()).unwrap();
    assert_eq!(kcoder_types::integrations::core::IntegrationOwner::from(&first_scope), kcoder_types::integrations::core::IntegrationOwner::from(&second_scope));
    assert_eq!(first_scope.identity_generation, second_scope.identity_generation);
    second.shutdown_successfully();
}

#[test]
fn integration_scope_native_subprocess_rejects_a_replaced_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    std::fs::create_dir(&workspace).unwrap();
    kcoder_config::PrivateDirectory::open_or_create(&config).unwrap();
    let settings = config.join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(&workspace, &settings).config_dir(&config).spawn();
    initialize_integration_scope(&mut server, 1);
    server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
    assert!(server.response(2).get("error").is_none());
    std::fs::rename(&workspace, temp.path().join("original-workspace")).unwrap();
    std::fs::create_dir(&workspace).unwrap();
    server.send(json!({"id":3,"method":"integrations/scope/read","params":{}}));
    let error = server.response(3);
    assert_eq!(error["error"]["message"], "INTEGRATION_SCOPE_UNAVAILABLE");
    assert!(!error.to_string().contains(temp.path().to_str().unwrap()));
    server.shutdown_successfully();
}
