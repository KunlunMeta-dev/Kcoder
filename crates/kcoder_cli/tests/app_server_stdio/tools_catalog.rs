#[test]
fn tools_catalog_is_scoped_to_resident_thread_and_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings).spawn();
    let initialized = server.initialize(1);
    assert_eq!(initialized["result"]["capabilities"]["experimental"]["toolsCatalog"], true);
    assert_eq!(initialized["result"]["capabilities"]["experimental"]["toolProfilesV1"], false);
    server.send(json!({"id":2,"method":"tools/catalog","params":{}}));
    let baseline = server.response(2);
    assert_eq!(baseline["result"]["scope"], "workspace");
    assert_eq!(baseline["result"]["cachePolicy"], "no-store");
    server.send(json!({"id":3,"method":"thread/start","params":{}}));
    let ordinary = server.response(3)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":4,"method":"thread/start","params":{"sessionMode":"orchestrate"}}));
    let orchestrate = server.response(4)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":5,"method":"tools/catalog","params":{"threadId":ordinary}}));
    let normal = server.response(5);
    server.send(json!({"id":6,"method":"tools/catalog","params":{"threadId":orchestrate}}));
    let arranged = server.response(6);
    assert_eq!(normal["result"]["threadId"], ordinary);
    assert_eq!(arranged["result"]["threadId"], orchestrate);
    let names = |value: &Value| {
        value["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&normal), names(&baseline));
    assert_ne!(names(&normal), names(&arranged));
    assert!(!normal["result"]["tools"].as_array().unwrap().is_empty());
    for tool in normal["result"]["tools"].as_array().unwrap() {
        assert!(tool.get("inputSchema").is_none());
        assert!(tool["displayName"].as_str().unwrap().chars().count() <= 128);
        assert!(tool["description"].as_str().unwrap().chars().count() <= 512);
    }
    server.send(json!({"id":7,"method":"tools/catalog","params":{"threadId":"unknown-thread"}}));
    assert!(server.response(7).get("error").is_some());
    server.send(json!({"id":8,"method":"tools/catalog","params":{"threadId":ordinary}}));
    assert_eq!(names(&server.response(8)), names(&normal));
    server.shutdown_successfully();
}

#[test]
fn tools_catalog_training_mode_keeps_runtime_tools_and_targets_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut builder = TestAppServer::builder(temp.path(), &settings);
    builder.training_mode = true;
    let mut training = builder.spawn();
    training.initialize(1);
    training.send(json!({"id":2,"method":"thread/start","params":{}}));
    let thread = training.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    training.send(json!({"id":3,"method":"tools/catalog","params":{"threadId":thread}}));
    let catalog = training.response(3);
    let entries = catalog["result"]["tools"].as_array().unwrap();
    assert!(entries.iter().any(|tool| tool["name"] == "spawn_agent"));
    assert!(
        entries
            .iter()
            .all(|tool| !tool["name"].as_str().unwrap().starts_with("mcp__"))
    );
    let second = tempfile::tempdir().unwrap();
    let second_settings = second.path().join("settings.json");
    write_test_settings(&second_settings);
    let mut other = TestAppServer::builder(second.path(), &second_settings).spawn();
    other.initialize(1);
    other.send(json!({"id":2,"method":"tools/catalog","params":{"threadId":thread}}));
    assert!(other.response(2).get("error").is_some());
    training.shutdown_successfully();
    other.shutdown_successfully();
}

#[test]
fn tools_profile_reloads_for_new_conversations_without_changing_resident_tools() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut document: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    document["providers"]["integration-test"]["endpoint"] = json!("http://10.31.6.8");
    document["providers"]["integration-test"]["capabilities"] = json!({"text":true,"tools":true});
    std::fs::write(&settings, serde_json::to_vec(&document).unwrap()).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    let names = |response: Value| {
        assert!(response.get("error").is_none(), "{response}");
        response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    server.send(json!({"id":2,"method":"thread/start","params":{}}));
    let first = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"tools/catalog","params":{"threadId":first}}));
    let full = names(server.response(3));
    assert!(full.iter().any(|name| name == "DiscoverSkills"));
    assert!(full.iter().any(|name| name == "skill"));
    for (index, profile) in ["core", "nano", "none", "full"].into_iter().enumerate() {
        document["tools"] = json!({"profile":profile});
        std::fs::write(&settings, serde_json::to_vec(&document).unwrap()).unwrap();
        let id = 10 + (index as i64) * 3;
        server.send(json!({"id":id,"method":"thread/start","params":{}}));
        let reply = server.response(id);
        assert!(reply.get("error").is_none(), "{reply}");
        let thread = reply["result"]["thread"]["id"].as_str().unwrap();
        server.send(json!({"id":id+1,"method":"tools/catalog","params":{"threadId":thread}}));
        let current = names(server.response(id + 1));
        assert_eq!(
            current.iter().any(|name| name == "DiscoverSkills"),
            profile == "full"
        );
        assert_eq!(current.is_empty(), profile == "none");
        server.send(json!({"id":id+2,"method":"tools/catalog","params":{"threadId":first}}));
        assert_eq!(names(server.response(id + 2)), full);
    }
    server.shutdown_successfully();
}

#[test]
fn tool_profile_rpc_saves_only_selected_user_setting() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let config_dir = temp.path().join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    let user_path = config_dir.join("settings.json");
    let original = json!({"tools":{"coerce":{"semantic_boolean":false},"disabled":["WebBrowser"],"luna":{"allowed":["read"]}},"permission_mode":"ask"});
    std::fs::write(&user_path, serde_json::to_vec(&original).unwrap()).unwrap();
    let mut server = TestAppServer::builder(temp.path(), &settings).without_scenario().spawn();
    let initialized = server.initialize(1);
    assert_eq!(initialized["result"]["capabilities"]["experimental"]["toolProfilesV1"], true);
    server.send(json!({"id":2,"method":"settings/tools/read","params":{}}));
    assert_eq!(server.response(2)["result"]["effectiveProfile"], "full");
    server.send(json!({"id":3,"method":"settings/tools/save","params":{"profile":"core"}}));
    let saved = server.response(3);
    assert!(saved.get("error").is_none(), "{saved}");
    assert_eq!(saved["result"]["profile"], "core");
    assert_eq!(saved["result"]["effectiveProfile"], "core");
    assert!(saved["result"]["cliOverride"].is_null());
    let mut expected = original;
    expected["tools"]["profile"] = json!("core");
    let stored: Value = serde_json::from_slice(&std::fs::read(&user_path).unwrap()).unwrap();
    assert_eq!(stored, expected);
    server.send(json!({"id":4,"method":"settings/tools/save","params":{"profile":"auto"}}));
    assert!(server.response(4).get("error").is_some());
    assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&user_path).unwrap()).unwrap(), expected);
    server.shutdown_successfully();
}
