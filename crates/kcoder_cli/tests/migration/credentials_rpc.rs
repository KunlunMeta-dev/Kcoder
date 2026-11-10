use super::{TestAppServer, Value, json, rpc};

#[test]
fn migration_rpc_credentials_require_consent_and_survive_restart_without_echoing_keys() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let claude = root.path().join("claude");
    let codex = root.path().join("codex");
    for directory in [&workspace, &profile, &claude, &codex] {
        std::fs::create_dir(directory).unwrap();
    }
    let original_settings = json!({"credential_store":"file"});
    std::fs::write(profile.join("settings.json"), original_settings.to_string()).unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let claude_key = "SYNTHETIC_CLAUDE_API_KEY_PRIVATE";
    let codex_key = "SYNTHETIC_CODEX_ENV_API_KEY_PRIVATE";
    let claude_source = json!({"model":"fixture", "env":{
        "ANTHROPIC_BASE_URL":"https://claude.example.invalid",
        "ANTHROPIC_API_KEY":claude_key
    }})
    .to_string();
    let codex_source = "model='fixture'\nmodel_provider='Team'\n[model_providers.Team]\nbase_url='https://codex.example.invalid/v1'\nwire_api='responses'\nenv_key='MIGRATION_FIXTURE_API_KEY'\n";
    std::fs::write(claude.join("settings.json"), &claude_source).unwrap();
    std::fs::write(codex.join("config.toml"), codex_source).unwrap();
    for directory in [&claude, &codex] {
        std::fs::write(directory.join("auth.json"), "MUST_NOT_READ_AUTH_CACHE").unwrap();
    }
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .discard_stderr();
        for (name, value) in [
            ("HOME", root.path().as_os_str()),
            ("USERPROFILE", root.path().as_os_str()),
            ("CLAUDE_CONFIG_DIR", claude.as_os_str()),
            ("CODEX_HOME", codex.as_os_str()),
            ("MIGRATION_FIXTURE_API_KEY", std::ffi::OsStr::new(codex_key)),
            (
                "OPENAI_API_KEY",
                std::ffi::OsStr::new("UNSELECTED_KEY_MUST_NOT_BE_USED"),
            ),
        ] {
            builder.extra_env.push((name.into(), value.into()));
        }
        builder.spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        let result = rpc(
            server,
            1,
            "initialize",
            json!({
                "protocolVersion":"2026-07-27",
                "clientInfo":{"name":"credential-migration-fixture","version":"test"}
            }),
        );
        assert_eq!(
            result["capabilities"]["experimental"]["migrationCredentialsV1"],
            true
        );
    };
    let mut server = start();
    initialize(&mut server);
    let mut request = 10;
    for (kind, source_kind, key) in [
        ("claude-code", "configuration", claude_key),
        ("codex", "environment", codex_key),
    ] {
        let mut call = |server: &mut TestAppServer, method: &str, params: Value| {
            request += 1;
            rpc(server, request, method, params)
        };
        let sources = call(&mut server, "migration/discover", json!({"sources":[kind]}));
        let scanned = call(
            &mut server,
            "migration/scan",
            json!({"sourceId":sources["sources"][0]["sourceId"]}),
        );
        let job = scanned["job"]["jobId"].clone();
        let page = call(&mut server, "migration/items", json!({"jobId":job}));
        let item = page["providers"][0]["itemId"].clone();
        let planned = call(
            &mut server,
            "migration/provider/plan",
            json!({
                "jobId":job,"itemId":item,"targetName":"Imported",
                "expectedSequence":scanned["job"]["sequence"],
                "contextWindowTokens":64000,"outputHeadroomTokens":8192,"maxOutputTokens":8192
            }),
        );
        let provider_plan = planned["plans"][0]["planId"].clone();
        let saved = call(
            &mut server,
            "migration/provider/apply",
            json!({
                "jobId":job,"planId":provider_plan,"expectedSequence":planned["job"]["sequence"]
            }),
        );
        assert!(
            !profile.join("credentials.json").exists()
                || !kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
                    .unwrap()
                    .credentials
                    .contains_key("Imported")
        );
        let mut params = json!({"jobId":job,"itemId":item,"source":source_kind,
            "expectedSequence":saved["job"]["sequence"],"consentApiKey":false});
        server.send(
            json!({"jsonrpc":"2.0","id":3,"method":"migration/credential/plan","params":params}),
        );
        assert_eq!(
            server.response(3)["error"]["message"],
            "migration_credential_consent_required"
        );
        params["consentApiKey"] = json!(true);
        server.send(json!({"jsonrpc":"2.0","method":"migration/credential/plan","params":params}));
        let unchanged = call(&mut server, "migration/read", json!({"jobId":job}));
        assert_eq!(unchanged["job"]["sequence"], saved["job"]["sequence"]);
        let preview = call(&mut server, "migration/credential/plan", params);
        assert_eq!(preview["credentialPlans"][0]["storage"], "file");
        assert_eq!(preview["credentialPlans"][0]["source"], source_kind);
        assert!(!preview.to_string().contains(key));
        assert!(
            !preview["credentialPlans"][0]
                .to_string()
                .contains("fingerprint")
        );
        let plan = preview["credentialPlans"][0]["planId"].clone();
        drop(server);
        server = start();
        initialize(&mut server);
        let current = call(&mut server, "migration/read", json!({"jobId":job}));
        let applied = call(
            &mut server,
            "migration/credential/apply",
            json!({
                "jobId":job,"planId":plan,"expectedSequence":current["job"]["sequence"]
            }),
        );
        assert_eq!(applied["credentialPlans"][0]["phase"], "published");
        assert!(!applied.to_string().contains(key));
        let repeated = call(
            &mut server,
            "migration/credential/apply",
            json!({
                "jobId":job,"planId":plan,"expectedSequence":current["job"]["sequence"]
            }),
        );
        assert_eq!(repeated, applied);
        assert_eq!(
            kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
                .unwrap()
                .credentials["Imported"],
            key
        );
        server.send(
            json!({"jsonrpc":"2.0","id":4,"method":"migration/provider/rollback","params":{
                "jobId":job,"planId":provider_plan,"expectedSequence":applied["job"]["sequence"]
            }}),
        );
        assert_eq!(
            server.response(4)["error"]["message"],
            "migration_provider_credentials_depend_on_import"
        );
        let current = call(&mut server, "migration/read", json!({"jobId":job}));
        let undone = call(
            &mut server,
            "migration/credential/undo",
            json!({
                "jobId":job,"planId":plan,"expectedSequence":current["job"]["sequence"]
            }),
        );
        assert_eq!(undone["credentialPlans"][0]["phase"], "undone");
        assert!(
            !kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
                .unwrap()
                .credentials
                .contains_key("Imported")
        );
        let repeated = call(
            &mut server,
            "migration/credential/undo",
            json!({
                "jobId":job,"planId":plan,"expectedSequence":current["job"]["sequence"]
            }),
        );
        assert_eq!(repeated, undone);
        call(
            &mut server,
            "migration/provider/rollback",
            json!({
                "jobId":job,"planId":provider_plan,"expectedSequence":undone["job"]["sequence"]
            }),
        );
        assert_eq!(
            kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
            original_settings
        );
        let sources = call(&mut server, "migration/discover", json!({"sources":[kind]}));
        let batch = call(
            &mut server,
            "migration/batch/scan",
            json!({"sourceIds":[sources["sources"][0]["sourceId"]]}),
        );
        let batch_job = batch["job"]["jobId"].clone();
        let page = call(&mut server, "migration/items", json!({"jobId":batch_job}));
        let batch_item = page["providers"][0]["itemId"].clone();
        let staged = call(
            &mut server,
            "migration/batch/plan",
            json!({
                "jobId":batch_job,"expectedSequence":batch["job"]["sequence"],
                "choices":[{"kind":"provider","itemId":batch_item,"targetName":"BatchImported",
                    "contextWindowTokens":64000,"outputHeadroomTokens":8192,"maxOutputTokens":8192}],
                "credentials":[{"itemId":batch_item,"source":source_kind,"consentApiKey":true}]
            }),
        );
        assert_eq!(staged["batch"]["credentialActions"], 1);
        assert_eq!(staged["batch"]["atomicCredentials"], true);
        assert_eq!(staged["credentialPlans"][0]["grouped"], true);
        assert_eq!(staged["credentialPlans"][0]["phase"], "ready");
        assert!(!staged.to_string().contains(key));
        drop(server);
        server = start();
        initialize(&mut server);
        let current = call(&mut server, "migration/read", json!({"jobId":batch_job}));
        let published = call(
            &mut server,
            "migration/batch/apply",
            json!({
                "jobId":batch_job,"planId":current["batch"]["planId"],"requestId":"confirmed-batch",
                "expectedSequence":current["job"]["sequence"]
            }),
        );
        assert_eq!(published["batch"]["publishedCredentials"], 1);
        assert_eq!(published["batch"]["unresolvedActions"], 0);
        assert_eq!(
            kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
                .unwrap()
                .credentials["BatchImported"],
            key
        );
        let removed = call(
            &mut server,
            "migration/batch/rollback",
            json!({
                "jobId":batch_job,"planId":published["batch"]["planId"],"requestId":"undo-confirmed-batch",
                "expectedSequence":published["job"]["sequence"]
            }),
        );
        assert_eq!(removed["job"]["status"], "rolled_back");
        assert_eq!(removed["credentialPlans"][0]["phase"], "undone");
        assert!(
            !kcoder_config::CredentialStore::load_from(&profile.join("credentials.json"))
                .unwrap()
                .credentials
                .contains_key("BatchImported")
        );
        assert_eq!(
            kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
            original_settings
        );
    }
    assert_eq!(
        std::fs::read_to_string(claude.join("settings.json")).unwrap(),
        claude_source
    );
    assert_eq!(
        std::fs::read_to_string(codex.join("config.toml")).unwrap(),
        codex_source
    );
    for directory in [&claude, &codex] {
        assert_eq!(
            std::fs::read_to_string(directory.join("auth.json")).unwrap(),
            "MUST_NOT_READ_AUTH_CACHE"
        );
    }
    for frame in server.observed.lock().unwrap().iter() {
        assert!(!frame.contains(claude_key) && !frame.contains(codex_key));
    }
}
