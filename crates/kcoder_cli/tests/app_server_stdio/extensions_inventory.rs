fn write_lark_plugin(source: &std::path::Path) {
    std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
    std::fs::write(
        source.join(".codex-plugin/plugin.json"),
        r#"{"name":"lark-fixture","version":"1.0.8","description":"Feishu fixture","repository":"https://github.com/larksuite/cli.git"}"#,
    )
    .unwrap();
    for (name, marker) in [
        ("lark-doc", "PLUGIN_LARK_DOC"),
        ("lark-fixture-only", "PLUGIN_ONLY"),
    ] {
        std::fs::create_dir_all(source.join("skills").join(name)).unwrap();
        std::fs::write(
            source.join("skills").join(name).join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {marker}\n---\n{marker} body"),
        )
        .unwrap();
    }
}

fn initialize_with_inventory(server: &mut TestAppServer, id: i64) -> Value {
    server.send(json!({
        "jsonrpc": "2.0", "id": id, "method": "initialize",
        "params": {"protocolVersion": "2026-07-27", "clientInfo": {"name": "inventory-test", "version": "1"},
            "capabilities": {"experimental": {"extensionsInventoryV1": true}}}
    }));
    server.response(id)
}

fn request(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
    server.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
    server.response(id)
}

fn skill_copies<'a>(inventory: &'a Value, name: &str) -> Vec<&'a Value> {
    inventory["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"] == "skill" && item["name"] == name)
        .collect()
}

#[test]
fn extensions_inventory_keeps_bundled_lark_skill_and_opt_in_flips_one_name() {
    // Without a scenario the app-server re-resolves settings, plugins and skills
    // per request, as a real target does.
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    for directory in [&workspace, &config] {
        std::fs::create_dir_all(directory).unwrap();
    }
    write_test_settings(&config.join("settings.json"));
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let source = temp.path().join("lark-plugin");
    write_lark_plugin(&source);
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    let initialized = initialize_with_inventory(&mut server, 1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["extensionsInventoryV1"],
        true
    );

    let installed = request(
        &mut server,
        2,
        "plugin/install",
        json!({"path": source, "installAttemptId": "inventory-fixture-1"}),
    );
    let plugin_id = installed["result"]["plugin"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let entries = installed["result"]["extensionConflicts"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("install preview missing: {installed}"));
    let doc = entries
        .iter()
        .find(|entry| entry["name"] == "lark-doc")
        .unwrap();
    assert_eq!(doc["outcome"], "shadowed_by_existing", "{doc}");
    assert_eq!(doc["existing"]["layer"], "bundled");
    assert_eq!(doc["sameUpstream"], true);
    let only = entries
        .iter()
        .find(|entry| entry["name"] == "lark-fixture-only")
        .unwrap();
    assert_eq!(only["outcome"], "none");
    assert!(
        installed["result"]["extensionConflicts"]["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|conflict| conflict["reason"] == "mixed_family" && conflict["name"] == "lark")
    );

    let inventory = request(&mut server, 3, "extensions/inventory", json!({}));
    assert_eq!(
        inventory["result"]["binariesIncluded"], false,
        "{inventory}"
    );
    assert!(
        inventory["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["kind"] != "binary")
    );
    let copies = skill_copies(&inventory, "lark-doc");
    assert_eq!(copies.len(), 2, "{copies:?}");
    let bundled = copies
        .iter()
        .find(|item| item["layer"] == "bundled")
        .unwrap();
    assert_eq!(bundled["effective"], true);
    assert_eq!(bundled["upstream"]["ref"], "v1.0.100");
    assert_eq!(bundled["family"], "lark");
    let plugin = copies
        .iter()
        .find(|item| item["layer"] == "plugin")
        .unwrap();
    assert_eq!(plugin["effective"], false);
    assert_eq!(plugin["ownerPluginId"], plugin_id.as_str());
    assert_eq!(plugin["shadowedBy"]["layer"], "bundled");
    let conflict = inventory["result"]["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|conflict| conflict["reason"] == "same_name" && conflict["name"] == "lark-doc")
        .unwrap();
    assert_eq!(conflict["sameUpstream"], true);
    assert!(
        inventory["result"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "plugin" && item["ownerPluginId"] == plugin_id.as_str())
    );
    let listed = request(&mut server, 4, "skills/list", json!({}));
    let listed_doc = listed["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "lark-doc")
        .unwrap();
    assert!(listed_doc["path"].as_str().unwrap().contains(".builtin"));

    let revision = inventory["result"]["skillPreferenceRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    let saved = request(
        &mut server,
        5,
        "extensions/skillPreference/update",
        json!({"expectedRevision": revision, "preference": {"preferPluginSkills": {"lark-doc": plugin_id}}}),
    );
    assert_eq!(
        saved["result"]["preference"]["preferPluginSkills"]["lark-doc"],
        plugin_id.as_str(),
        "{saved}"
    );
    let stale = request(
        &mut server,
        6,
        "extensions/skillPreference/update",
        json!({"expectedRevision": revision, "preference": {}}),
    );
    assert_eq!(stale["error"]["code"], -32049, "{stale}");
    assert_eq!(stale["error"]["data"]["kind"], "skill_preference_conflict");

    let flipped = request(&mut server, 7, "extensions/inventory", json!({}));
    let copies = skill_copies(&flipped, "lark-doc");
    let plugin = copies
        .iter()
        .find(|item| item["layer"] == "plugin")
        .unwrap();
    assert_eq!(plugin["effective"], true, "{plugin}");
    assert_eq!(plugin["preferred"], true);
    let listed = request(&mut server, 8, "skills/list", json!({}));
    let listed_doc = listed["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "lark-doc")
        .unwrap();
    assert!(
        !listed_doc["path"].as_str().unwrap().contains(".builtin"),
        "{listed_doc}"
    );

    let invalid = request(
        &mut server,
        9,
        "extensions/inventory",
        json!({"path": "/other"}),
    );
    assert_eq!(invalid["error"]["code"], -32602);
    server.shutdown();
}

#[test]
fn plugin_install_conflicts_stay_out_of_legacy_client_responses() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let source = temp.path().join("lark-plugin");
    write_lark_plugin(&source);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(1);
    let installed = request(
        &mut server,
        2,
        "plugin/install",
        json!({"path": source, "installAttemptId": "inventory-legacy-1"}),
    );
    assert!(
        installed["result"]["plugin"]["id"].is_string(),
        "{installed}"
    );
    assert!(installed["result"].get("extensionConflicts").is_none());
    let read = request(
        &mut server,
        3,
        "plugin/read",
        json!({"pluginId": installed["result"]["plugin"]["id"]}),
    );
    assert!(read["result"].get("extensionConflicts").is_none());
    server.shutdown();
}

#[cfg(unix)]
fn fake_lark_cli(directory: &std::path::Path, counter: &std::path::Path, version: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(directory).unwrap();
    let binary = directory.join("lark-cli");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\necho probe >> '{}'\necho 'lark-cli version {version}'\n",
            counter.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
fn path_with(directory: &std::path::Path) -> std::ffi::OsString {
    let mut entries = vec![directory.to_path_buf()];
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(entries).unwrap()
}

#[cfg(unix)]
#[test]
fn binary_probes_run_only_when_the_inventory_request_asks_for_them() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let bin = temp.path().join("fake-bin");
    let counter = temp.path().join("lark-cli-probes.log");
    fake_lark_cli(&bin, &counter, "9.9.9");
    let mut server = TestAppServer::builder(temp.path(), &settings)
        .scenario("full-turn")
        .env("PATH", path_with(&bin))
        .discard_stderr()
        .spawn();
    initialize_with_inventory(&mut server, 1);
    for id in 2..5 {
        let polled = request(&mut server, id, "extensions/inventory", json!({}));
        assert_eq!(polled["result"]["binariesIncluded"], false);
    }
    request(&mut server, 5, "skills/list", json!({}));
    assert!(
        !counter.exists(),
        "ordinary inventory and skill reads must not run binaries"
    );
    let explicit = request(
        &mut server,
        6,
        "extensions/inventory",
        json!({"includeBinaries": true}),
    );
    let lark = explicit["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| {
            item["kind"] == "binary" && item["name"] == "lark-cli" && item["effective"] == true
        })
        .unwrap_or_else(|| panic!("{explicit}"));
    assert_eq!(lark["version"], "9.9.9");
    assert_eq!(lark["bundled"], false);
    assert!(
        explicit["result"]["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|conflict| conflict["reason"] == "version_mismatch"
                && conflict["name"] == "lark-cli")
    );
    assert_eq!(
        std::fs::read_to_string(&counter).unwrap().lines().count(),
        1
    );
    server.shutdown();
}

#[cfg(unix)]
#[test]
fn doctor_reports_lark_cli_resolution_and_plugin_copies() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let bin = temp.path().join("fake-bin");
    let counter = temp.path().join("doctor-probes.log");
    fake_lark_cli(&bin, &counter, "1.0.8");
    let output = Command::new(env!("CARGO_BIN_EXE_kcoder"))
        .args([
            "--settings-file",
            settings.to_str().unwrap(),
            "--cwd",
            temp.path().to_str().unwrap(),
            "doctor",
        ])
        .env("KCODER_CONFIG_DIR", temp.path().join("config"))
        .env("XDG_CONFIG_HOME", temp.path().join("config"))
        .env("PATH", path_with(&bin))
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("Feishu/Lark:"), "{stdout}");
    assert!(
        stdout.contains(&format!(
            "lark-cli on PATH: {}",
            bin.join("lark-cli").display()
        )),
        "{stdout}"
    );
    assert!(
        stdout.contains("version 1.0.8; not the bundled copy"),
        "{stdout}"
    );
    assert!(
        stdout.contains("differs from the bundled 1.0.100"),
        "{stdout}"
    );
    assert!(stdout.contains("plugin lark-* skills: none"), "{stdout}");
    assert!(stdout.contains("~/.lark-cli"), "{stdout}");
}

fn plugin_item<'a>(inventory: &'a Value, plugin_id: &str) -> &'a Value {
    inventory["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["kind"] == "plugin" && item["ownerPluginId"] == plugin_id)
        .unwrap_or_else(|| panic!("plugin item missing: {inventory}"))
}

fn listed_skill_names(listed: &Value) -> Vec<String> {
    listed["result"]["items"]
        .as_array()
        .unwrap_or_else(|| panic!("{listed}"))
        .iter()
        .filter_map(|item| item["name"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn plugin_skill_switch_removes_only_that_plugins_copies_with_revision_check() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let config = temp.path().join("config");
    for directory in [&workspace, &config] {
        std::fs::create_dir_all(directory).unwrap();
    }
    write_test_settings(&config.join("settings.json"));
    let overlay = temp.path().join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let source = temp.path().join("lark-plugin");
    write_lark_plugin(&source);
    // A command profile is adapted into a namespaced prompt skill.
    std::fs::create_dir_all(source.join("commands")).unwrap();
    std::fs::write(
        source.join("commands/review.md"),
        "---\ndescription: PROMPT_REVIEW\n---\nReview $ARGUMENTS",
    )
    .unwrap();
    let mut server = TestAppServer::builder(&workspace, &overlay)
        .config_dir(&config)
        .without_scenario()
        .spawn();
    let initialized = initialize_with_inventory(&mut server, 1);
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["pluginSkillPolicyV1"], true,
        "{initialized}"
    );
    let installed = request(
        &mut server,
        2,
        "plugin/install",
        json!({"path": source, "installAttemptId": "skill-switch-1"}),
    );
    let plugin_id = installed["result"]["plugin"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned();

    let before = request(&mut server, 3, "extensions/inventory", json!({}));
    assert_eq!(before["result"]["pluginSkillPolicy"], true, "{before}");
    // The adapted name is namespaced by plugin and kind, with a path-derived suffix.
    let prompt_prefix = format!("plugin:{}:command:review-", plugin_id.replace('@', ":"));
    let prompt_skill = before["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["kind"] == "skill")
        .filter_map(|item| item["name"].as_str())
        .find(|name| name.starts_with(&prompt_prefix))
        .unwrap_or_else(|| panic!("prompt skill missing: {before}"))
        .to_owned();
    let prompt_copies = skill_copies(&before, &prompt_skill);
    assert_eq!(prompt_copies.len(), 1, "{before}");
    assert_eq!(prompt_copies[0]["effective"], true, "{}", prompt_copies[0]);
    assert_eq!(prompt_copies[0]["ownerPluginId"], plugin_id.as_str());
    let plugin = plugin_item(&before, &plugin_id);
    assert_eq!(plugin["skillsEnabled"], true, "{plugin}");
    let revision = plugin["skillPolicyRevision"].as_str().unwrap().to_owned();
    assert_eq!(revision.len(), 64);
    let listed = request(&mut server, 4, "skills/list", json!({}));
    assert!(listed_skill_names(&listed).contains(&"lark-fixture-only".to_owned()));

    let disabled = request(
        &mut server,
        5,
        "plugin/skills/setEnabled",
        json!({"pluginId": plugin_id, "enabled": false, "expectedRevision": revision}),
    );
    assert_eq!(disabled["result"]["skillsEnabled"], false, "{disabled}");
    assert_eq!(disabled["result"]["changed"], true);
    assert_eq!(disabled["result"]["appliesToNewConversations"], true);
    let disabled_revision = disabled["result"]["revision"].as_str().unwrap().to_owned();
    assert_ne!(disabled_revision, revision);
    let document: Value =
        serde_json::from_slice(&std::fs::read(config.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        document["plugins"]["installed"][&plugin_id]["skills"]["enabled"],
        false
    );

    let after = request(&mut server, 6, "extensions/inventory", json!({}));
    let plugin = plugin_item(&after, &plugin_id);
    assert_eq!(plugin["skillsEnabled"], false, "{plugin}");
    assert_eq!(plugin["enabled"], true, "the plugin itself stays enabled");
    assert_eq!(plugin["skillPolicyRevision"], disabled_revision.as_str());
    for name in ["lark-doc", "lark-fixture-only"] {
        let copy = skill_copies(&after, name)
            .into_iter()
            .find(|item| item["layer"] == "plugin")
            .unwrap_or_else(|| panic!("{name} plugin copy missing: {after}"));
        assert_eq!(copy["enabled"], false, "{copy}");
        assert_eq!(copy["disabledBy"], "plugin");
        assert_eq!(copy["effective"], false);
    }
    let prompt_copies = skill_copies(&after, &prompt_skill);
    assert_eq!(prompt_copies.len(), 1, "prompt skill copy missing: {after}");
    let prompt_copy = prompt_copies[0];
    assert_eq!(prompt_copy["layer"], "plugin", "{prompt_copy}");
    assert_eq!(prompt_copy["ownerPluginId"], plugin_id.as_str());
    assert_eq!(prompt_copy["enabled"], false);
    assert_eq!(prompt_copy["disabledBy"], "plugin");
    assert_eq!(prompt_copy["effective"], false);
    assert!(
        prompt_copy["path"]
            .as_str()
            .is_some_and(|path| path.ends_with("review.md")),
        "{prompt_copy}"
    );
    assert!(
        prompt_copy["description"]
            .as_str()
            .is_some_and(|text| text.starts_with("PROMPT_REVIEW")),
        "{prompt_copy}"
    );
    let bundled = skill_copies(&after, "lark-doc")
        .into_iter()
        .find(|item| item["layer"] == "bundled")
        .unwrap();
    assert_eq!(bundled["effective"], true, "other copies are unaffected");
    let listed = request(&mut server, 7, "skills/list", json!({}));
    let names = listed_skill_names(&listed);
    assert!(
        !names.contains(&"lark-fixture-only".to_owned()),
        "{names:?}"
    );
    assert!(names.contains(&"lark-doc".to_owned()));

    let stale = request(
        &mut server,
        8,
        "plugin/skills/setEnabled",
        json!({"pluginId": plugin_id, "enabled": true, "expectedRevision": revision}),
    );
    assert_eq!(stale["error"]["code"], -32049, "{stale}");
    assert_eq!(
        stale["error"]["data"]["kind"],
        "plugin_skill_policy_conflict"
    );
    let malformed = request(
        &mut server,
        9,
        "plugin/skills/setEnabled",
        json!({"pluginId": plugin_id, "enabled": true, "expectedRevision": "stale"}),
    );
    assert_eq!(malformed["error"]["code"], -32602, "{malformed}");
    let missing = request(
        &mut server,
        10,
        "plugin/skills/setEnabled",
        json!({"pluginId": "absent@nowhere", "enabled": false}),
    );
    assert_eq!(missing["error"]["code"], -32054, "{missing}");
    assert_eq!(missing["error"]["data"]["kind"], "not_found");

    let restored = request(
        &mut server,
        11,
        "plugin/skills/setEnabled",
        json!({"pluginId": plugin_id, "enabled": true, "expectedRevision": disabled_revision}),
    );
    assert_eq!(restored["result"]["skillsEnabled"], true, "{restored}");
    assert_eq!(restored["result"]["revision"], revision.as_str());
    let listed = request(&mut server, 12, "skills/list", json!({}));
    assert!(listed_skill_names(&listed).contains(&"lark-fixture-only".to_owned()));
    let restored_inventory = request(&mut server, 13, "extensions/inventory", json!({}));
    assert_eq!(
        plugin_item(&restored_inventory, &plugin_id)["skillsEnabled"],
        true
    );
    let prompt_copies = skill_copies(&restored_inventory, &prompt_skill);
    assert_eq!(prompt_copies.len(), 1, "{restored_inventory}");
    assert_eq!(prompt_copies[0]["effective"], true, "{}", prompt_copies[0]);
    assert!(prompt_copies[0]["disabledBy"].is_null());
    server.shutdown();
}
