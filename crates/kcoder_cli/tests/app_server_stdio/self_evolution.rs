fn evolution_request(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
    server.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
    server.response(id)
}

#[test]
fn self_evolution_is_server_declared_and_serves_an_older_client_with_provenance_keys() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    for directory in [&workspace, &config] {
        std::fs::create_dir_all(directory).unwrap();
    }
    write_test_settings(&config.join("settings.json"));
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    // A client that predates the capability requests nothing; the server
    // still declares it so newer clients can observe it.
    server.send(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "evolution-test", "version": "1"},
            "capabilities": {"experimental": {"extensionsInventoryV1": true}}}
    }));
    let initialized = server.response(1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["selfEvolutionV1"],
        true
    );

    let status = evolution_request(&mut server, 2, "evolution/status", json!({}));
    assert_eq!(status["result"]["enabled"], false, "{status}");
    let skill = status["result"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["type"] == "skill")
        .unwrap();
    assert_eq!(skill["implemented"], true);
    assert!(
        !config.join("evolution").exists(),
        "status must not create evolution storage"
    );

    let mut items = Vec::new();
    let mut cursor = Value::Null;
    for page in 0..20 {
        let mut params = json!({"type": "skill", "limit": 200});
        if !cursor.is_null() {
            params["cursor"] = cursor.clone();
        }
        let listed = evolution_request(&mut server, 100 + page, "evolution/targets/list", params);
        items.extend(
            listed["result"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .cloned(),
        );
        cursor = listed["result"]["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert!(!items.is_empty());
    for item in &items {
        let key = item["targetKey"].as_str().unwrap();
        assert!(key.starts_with("skill:"), "{key}");
        assert_eq!(item["evolutionMode"], "overlay");
    }

    let inventory = evolution_request(&mut server, 4, "extensions/inventory", json!({}));
    let effective: Vec<_> = inventory["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"] == "skill" && item["effective"] == true)
        .collect();
    assert!(!effective.is_empty());
    for item in effective {
        let key = item["targetKey"]
            .as_str()
            .expect("skill items carry targetKey");
        assert!(
            items.iter().any(|listed| listed["targetKey"] == key),
            "inventory key {key} is listed by evolution/targets/list"
        );
    }

    let unconfirmed = evolution_request(
        &mut server,
        5,
        "evolution/data/clear",
        json!({"scope": "all", "confirm": false}),
    );
    assert_eq!(unconfirmed["error"]["code"], -32602);
    // Every type the status reports as not implemented is refused.
    let pending: Vec<String> = status["result"]["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| target["implemented"] == false)
        .map(|target| target["type"].as_str().unwrap().to_owned())
        .collect();
    for (index, target_type) in pending.iter().enumerate() {
        let unsupported = evolution_request(
            &mut server,
            200 + index as i64,
            "evolution/target/read",
            json!({"targetKey": format!("{target_type}:global:tone")}),
        );
        assert_eq!(
            unsupported["error"]["data"]["kind"],
            "evolution_unsupported_target_type"
        );
    }
    let settings = evolution_request(&mut server, 7, "settings/evolution/read", json!({}));
    assert_eq!(settings["result"]["settings"]["enabled"], false);
    assert_eq!(settings["result"]["revision"].as_str().unwrap().len(), 64);
}

/// A skill activated during a real turn is recorded by the Engine where
/// `evolution/rate` looks for it: same data root, the app-server thread id,
/// the client `turn-N` id and the target key the listing reports.
#[test]
fn a_skill_activated_in_a_turn_can_be_rated_for_that_turn() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    for directory in [&workspace, &config] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let user_settings = config.join("settings.json");
    write_test_settings(&user_settings);
    let mut document: Value =
        serde_json::from_slice(&std::fs::read(&user_settings).unwrap()).unwrap();
    document["evolution"] = json!({"enabled": true});
    std::fs::write(&user_settings, serde_json::to_vec(&document).unwrap()).unwrap();
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .scenario("skill-activation")
        .spawn();
    server.initialize(1);

    let listed = evolution_request(
        &mut server,
        2,
        "evolution/targets/list",
        json!({"type": "skill", "limit": 200}),
    );
    let target_key = listed["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["targetKey"].as_str().unwrap().to_owned())
        .find(|key| key.starts_with("skill:bundled:"))
        .expect("a bundled skill target");
    let skill = target_key.rsplit(':').next().unwrap().to_owned();

    server.send(json!({"jsonrpc": "2.0", "id": 3, "method": "thread/start", "params": {}}));
    let thread_id = server.response(3)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": format!("use skill={skill}")}]}
    }));
    let turn_id = server.response(4)["result"]["turn"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.wait_for_method("turn/completed");
    server.send(json!({
        "jsonrpc": "2.0", "id": 40, "method": "thread/read",
        "params": {"threadId": thread_id, "limit": 20}
    }));
    let transcript = server.response(40)["result"]["messages"].to_string();

    let rated = evolution_request(
        &mut server,
        5,
        "evolution/rate",
        json!({"threadId": thread_id, "turnId": turn_id, "rating": "up", "reason": "worked"}),
    );
    assert_eq!(
        rated["result"]["recorded"],
        true,
        "{rated} for {target_key} in {thread_id}/{turn_id}; transcript: {}; stored: {}",
        transcript.chars().take(3000).collect::<String>(),
        stored_evolution_files(&config)
    );
    // The ratable-turn projection names the same turn id `turn/start`
    // returned, the recorded `skill` call, and the standing rating.
    let listed = evolution_request(
        &mut server,
        41,
        "evolution/ratings/list",
        json!({"threadId": thread_id}),
    );
    let items = listed["result"]["items"].as_array().unwrap().clone();
    assert_eq!(items.len(), 1, "{listed}");
    assert_eq!(items[0]["turnId"], turn_id.as_str());
    assert_eq!(items[0]["rating"], "up");
    assert_eq!(items[0]["targetKeys"][0], target_key.as_str());
    // The user may change their mind: the latest rating stands.
    let opposite = evolution_request(
        &mut server,
        6,
        "evolution/rate",
        json!({"threadId": thread_id, "turnId": turn_id, "rating": "down"}),
    );
    assert_eq!(opposite["result"]["recorded"], true, "{opposite}");
    let listed = evolution_request(
        &mut server,
        42,
        "evolution/ratings/list",
        json!({"threadId": thread_id}),
    );
    assert_eq!(listed["result"]["items"][0]["rating"], "down", "{listed}");
    // A client that only knows the skill call (for example after a reload
    // whose turn grouping differs) still addresses the usage.
    if let Some(call) = items[0]["toolCallIds"][0].as_str() {
        assert!(
            transcript.contains(call),
            "the call is the one the transcript shows"
        );
        let by_call = evolution_request(
            &mut server,
            43,
            "evolution/rate",
            json!({"threadId": thread_id, "turnId": "unknown-turn", "toolCallIds": [call], "rating": "up"}),
        );
        assert_eq!(by_call["result"]["recorded"], true, "{by_call}");
    }
    server.shutdown();
}

/// Evolution files under `root` with their (small) contents, for failure
/// messages.
fn stored_evolution_files(root: &std::path::Path) -> String {
    let mut out = String::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.to_string_lossy().contains("evolution") {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                out.push_str(&format!(
                    "\n{}: {}",
                    path.display(),
                    text.chars().take(1500).collect::<String>()
                ));
            }
        }
    }
    out
}

/// A server with self-evolution enabled in the user settings, running the
/// `skill-activation` scenario, and the first bundled skill target it lists.
fn enabled_server(temp: &std::path::Path) -> (TestAppServer, std::path::PathBuf, String, String) {
    enabled_server_with(temp, json!({"enabled": true}))
}

/// [`enabled_server`] with the given user-level `evolution` block. The
/// deterministic scenario server serves the settings it started with.
fn enabled_server_with(
    temp: &std::path::Path,
    evolution: Value,
) -> (TestAppServer, std::path::PathBuf, String, String) {
    let workspace = temp.join("workspace");
    let config = temp.join("config");
    for directory in [&workspace, &config] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let user_settings = config.join("settings.json");
    write_test_settings(&user_settings);
    let mut document: Value =
        serde_json::from_slice(&std::fs::read(&user_settings).unwrap()).unwrap();
    document["evolution"] = evolution;
    document["providers"]["integration-test"]["authentication"] = json!({"mode": "api_key"});
    document["providers"]["integration-test"]["credential_env"] =
        json!(["KCODER_EVOLUTION_TEST_KEY"]);
    std::fs::write(&user_settings, serde_json::to_vec(&document).unwrap()).unwrap();
    let overlay = temp.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let builder = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .scenario("skill-activation");
    // A configured evolution model builds its own provider; no request
    // reaches it in these tests.
    #[cfg(any(target_os = "linux", windows))]
    let builder = builder.env("KCODER_EVOLUTION_TEST_KEY", "evolution-test-key-unused");
    let mut server = builder.spawn();
    server.initialize(1);
    let listed = evolution_request(
        &mut server,
        2,
        "evolution/targets/list",
        json!({"type": "skill", "limit": 200}),
    );
    let target_key = listed["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["targetKey"].as_str().unwrap().to_owned())
        .find(|key| key.starts_with("skill:bundled:"))
        .expect("a bundled skill target");
    let skill = target_key.rsplit(':').next().unwrap().to_owned();
    (server, config, target_key, skill)
}

fn start_thread(server: &mut TestAppServer, id: i64) -> String {
    server.send(json!({"jsonrpc": "2.0", "id": id, "method": "thread/start", "params": {}}));
    server.response(id)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A subagent's skill activation is recorded under the agent task id and
/// the child's own turn, which `evolution/rate` with `subagentId` names.
#[test]
fn a_skill_activated_by_a_subagent_can_be_rated_through_the_parent_thread() {
    let temp = tempfile::tempdir().unwrap();
    let (mut server, config, target_key, skill) = enabled_server(temp.path());
    let thread_id = start_thread(&mut server, 3);
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": format!("delegate subagent-skill={skill}")}]}
    }));
    assert!(server.response(4)["error"].is_null());
    server.wait_for_method("turn/completed");
    server.send(json!({"jsonrpc": "2.0", "id": 5, "method": "agent/list", "params": {"threadId": thread_id}}));
    let agents = server.response(5)["result"]["agents"].clone();
    let agent_id = agents[0]["agentId"]
        .as_str()
        .unwrap_or_else(|| panic!("a spawned agent: {agents}"))
        .to_owned();

    // The child's turns are numbered in its own conversation, which the
    // subagent view cannot see; the ratable-turn projection names them.
    let listed = evolution_request(
        &mut server,
        10,
        "evolution/ratings/list",
        json!({"threadId": thread_id, "subagentId": agent_id}),
    );
    let items = listed["result"]["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        items.len(),
        1,
        "{listed} for {target_key} by {agent_id}; stored: {}",
        stored_evolution_files(&config)
    );
    let child_turn = items[0]["turnId"].as_str().unwrap().to_owned();
    let rated = evolution_request(
        &mut server,
        11,
        "evolution/rate",
        json!({"threadId": thread_id, "subagentId": agent_id, "turnId": child_turn, "rating": "up"}),
    );
    assert_eq!(rated["result"]["recorded"], true, "{rated}");
    // The parent's own projection does not list the child's turn.
    let parent_list = evolution_request(
        &mut server,
        12,
        "evolution/ratings/list",
        json!({"threadId": thread_id}),
    );
    assert_eq!(parent_list["result"]["items"], json!([]), "{parent_list}");
    // The parent's own turn used no skill.
    let parent = evolution_request(
        &mut server,
        7,
        "evolution/rate",
        json!({"threadId": thread_id, "turnId": "turn-1", "rating": "up"}),
    );
    assert_eq!(parent["result"]["recorded"], false, "{parent}");
    server.shutdown();
}

/// Changes the Engine's automation makes reach the client as
/// `evolution/changed`: an approved proposal whose skill changed since it
/// was made is rejected at the next idle step.
#[test]
fn background_evolution_changes_are_forwarded_as_notifications() {
    let temp = tempfile::tempdir().unwrap();
    let (mut server, config, target_key, _) = enabled_server(temp.path());
    let _thread = start_thread(&mut server, 3);
    let store = kcoder_evolution::EvolutionStore::open(&config).unwrap();
    let key = kcoder_types::evolution::TargetKey::parse(&target_key).unwrap();
    let created = store
        .create_proposal(
            kcoder_evolution::ProposalDraft {
                target_key: key,
                base_revision: "sha256:0000000000000000".into(),
                location: kcoder_types::evolution::ProposalLocation::Overlay,
                changes: kcoder_types::evolution::ProposalChanges {
                    lessons_add: vec!["Lead with the outcome.".into()],
                    ..Default::default()
                },
                pattern_ids: Vec::new(),
                evidence_ids: Vec::new(),
                actor: kcoder_types::evolution::ProposalActor::Auto,
            },
            1,
        )
        .unwrap()
        .proposal;
    store
        .record_proposal_review(
            &created.proposal_id,
            created.revision,
            Some(kcoder_types::evolution::SafetyScanResult {
                passed: true,
                findings: Vec::new(),
            }),
            None,
            2,
        )
        .unwrap();

    let decided = evolution_request(
        &mut server,
        4,
        "evolution/proposal/decide",
        json!({"targetKey": target_key, "proposalId": created.proposal_id,
            "decision": "accept", "expectedRevision": "0"}),
    );
    assert!(decided["error"].is_null(), "{decided}");
    // The approval itself is a proposal change made by the request.
    let approved = server.wait_for_method("evolution/changed");
    assert_eq!(approved["params"]["reason"], "proposal", "{approved}");
    // The automation then rejects the stale proposal on its own.
    let automated = server.wait_for_method("evolution/changed");
    assert_eq!(automated["params"]["reason"], "proposal", "{automated}");
    assert_eq!(automated["params"]["targetKey"], target_key);
    let detail = evolution_request(
        &mut server,
        5,
        "evolution/target/read",
        json!({"targetKey": target_key}),
    );
    assert_eq!(
        detail["result"]["proposals"][0]["state"], "rejected",
        "{detail}"
    );
    server.shutdown();
}

/// Parent and subagent usages of the same skill are kept apart: each lands
/// on its own thread and turn, with independent automatic evidence and ratings.
#[test]
fn parent_and_subagent_skill_usages_are_attributed_to_their_own_turns() {
    let temp = tempfile::tempdir().unwrap();
    let (mut server, config, target_key, skill) = enabled_server(temp.path());
    let thread_id = start_thread(&mut server, 3);
    server.send(json!({
        "jsonrpc": "2.0", "id": 4, "method": "turn/start",
        "params": {"threadId": thread_id, "input": [{"type": "text", "text": format!("both parent-and-subagent-skill={skill} subagent-artifact")}]}
    }));
    assert!(server.response(4)["error"].is_null());
    server.wait_for_method("turn/completed");
    server.send(json!({"jsonrpc": "2.0", "id": 5, "method": "agent/list", "params": {"threadId": thread_id}}));
    let agents = server.response(5)["result"]["agents"].clone();
    let agent_id = agents[0]["agentId"]
        .as_str()
        .unwrap_or_else(|| panic!("a spawned agent: {agents}"))
        .to_owned();

    let store = kcoder_evolution::EvolutionStore::open(&config).unwrap();
    let usages: Vec<_> = store
        .read_amended_usages()
        .unwrap()
        .records
        .into_iter()
        .filter(|usage| usage.target_key.to_string() == target_key)
        .collect();
    assert_eq!(usages.len(), 2, "{usages:?}");
    let parent = usages
        .iter()
        .find(|usage| usage.thread_id == thread_id)
        .expect("the parent's own usage");
    let child = usages
        .iter()
        .find(|usage| usage.thread_id == agent_id)
        .expect("the subagent's usage under its agent id");
    assert_eq!(parent.turn_id.as_deref(), Some("turn-1"));
    assert_ne!(parent.usage_id, child.usage_id);
    assert!(!parent.profile_hints.wrote_files && parent.artifacts.is_empty());
    assert!(
        child.profile_hints.wrote_files,
        "child artifact facts: {child:?}"
    );
    assert!(
        matches!(
            child.artifacts.as_slice(),
            [kcoder_types::evolution::ArtifactRef::File { path, .. }]
                if std::path::Path::new(path).file_name().and_then(|name| name.to_str())
                    == Some("evolution-child-artifact.txt")
        ),
        "child artifacts: {:?}",
        child.artifacts
    );
    let automatic = store.read_outcomes().unwrap().records;
    for usage in [parent, child] {
        let terminal: Vec<_> = automatic
            .iter()
            .filter(|item| {
                item.usage_id == usage.usage_id
                    && item.signal == kcoder_types::evolution::SignalKind::TaskTerminal
            })
            .collect();
        assert_eq!(terminal.len(), 1, "terminal signal for {}", usage.usage_id);
        assert_eq!(terminal[0].metrics.extra.get("completed"), Some(&1.0));
    }

    let observation_of = |usage_id: &str| {
        store
            .read_outcomes()
            .unwrap()
            .records
            .into_iter()
            .filter(|observation| {
                observation.usage_id == usage_id
                    && observation.signal == kcoder_types::evolution::SignalKind::Rating
            })
            .map(|observation| observation.metrics.rating_value)
            .collect::<Vec<_>>()
    };
    let rated = evolution_request(
        &mut server,
        6,
        "evolution/rate",
        json!({"threadId": thread_id, "turnId": "turn-1", "rating": "up"}),
    );
    assert_eq!(rated["result"]["recorded"], true, "{rated}");
    assert_eq!(observation_of(&parent.usage_id), [Some(1.0)]);
    assert!(
        observation_of(&child.usage_id).is_empty(),
        "the parent's rating never reaches the subagent's usage"
    );

    let rated = evolution_request(
        &mut server,
        7,
        "evolution/rate",
        json!({"threadId": thread_id, "subagentId": agent_id,
            "turnId": child.turn_id.clone().unwrap(), "rating": "down"}),
    );
    assert_eq!(rated["result"]["recorded"], true, "{rated}");
    assert_eq!(observation_of(&child.usage_id), [Some(0.0)]);
    assert_eq!(
        observation_of(&parent.usage_id),
        [Some(1.0)],
        "the subagent's rating never reaches the parent's usage"
    );
    server.shutdown();
}

/// With no thread open, a distillation with a configured evolution model is
/// queued on the workspace engine and carried out by the request's task.
#[cfg(any(target_os = "linux", windows))]
#[test]
fn a_distillation_without_an_open_session_runs_with_a_configured_model() {
    let temp = tempfile::tempdir().unwrap();
    let (mut server, config, target_key, _) = enabled_server_with(
        temp.path(),
        json!({"enabled": true,
            "model": {"provider": "integration-test", "model": "deterministic-scenario"}}),
    );

    let requested = evolution_request(
        &mut server,
        5,
        "evolution/target/distill",
        json!({"targetKey": target_key}),
    );
    assert_eq!(requested["result"]["outcome"], "queued", "{requested}");
    let store = kcoder_evolution::EvolutionStore::open(&config).unwrap();
    let key = kcoder_types::evolution::TargetKey::parse(&target_key).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let ran = store
            .read_state()
            .unwrap()
            .distill
            .get(&key)
            .is_some_and(|cursor| cursor.last_run_at_ms.is_some());
        if ran {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the queued distillation did not run; stored: {}",
            stored_evolution_files(&config)
        );
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    server.shutdown();
}
