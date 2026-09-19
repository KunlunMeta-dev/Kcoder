#[test]
fn tools_catalog_is_scoped_to_resident_thread_and_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(temp.path(), &settings).spawn();
    assert_eq!(
        server.initialize(1)["result"]["capabilities"]["experimental"]["toolsCatalog"],
        true
    );
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
