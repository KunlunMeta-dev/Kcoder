use super::{TestAppServer, Value, json, rpc};

#[test]
fn migration_rpc_batch_mcp_private_payloads_share_publication_and_recover_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let input = root.path().join("claude");
    for dir in [&workspace, &profile, &input] {
        std::fs::create_dir(dir).unwrap();
    }
    let settings_path = profile.join("settings.json");
    std::fs::write(&settings_path, r#"{"credential_store":"file"}"#).unwrap();
    let before = kcoder_config::read_settings_file(&settings_path).unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let secret = "SYNTHETIC_BATCH_RPC_PRIVATE_VALUE";
    let skipped = "SYNTHETIC_BATCH_RPC_UNSELECTED_VALUE";
    let source = input.join("settings.json");
    let helper = input.join("must-not-run.sh");
    std::fs::write(&helper, "printf invoked > \"$0.marker\"\n").unwrap();
    let source_text = json!({"model":"fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_API_KEY":secret},
        "mcpServers":{"docs":{"command":"sh","args":[helper],"env":{"TOKEN":secret,"UNSELECTED":skipped}},
        "remote":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":format!("Bearer {secret}")}}}}).to_string();
    std::fs::write(&source, &source_text).unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .discard_stderr();
        for (name, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", input.as_path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((name.into(), path.as_os_str().into()));
        }
        builder.spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        let result = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"batch-mcp-private-fixture","version":"0"}}),
        );
        assert_eq!(
            result["capabilities"]["experimental"]["migrationBatchMcpCredentialsV1"],
            true
        );
    };
    let mut server = start();
    initialize(&mut server);
    let call = |server: &mut TestAppServer, method: &str, params: Value| {
        let value = rpc(server, 10, method, params);
        let text = value.to_string();
        for private in [
            secret,
            skipped,
            "fingerprint",
            "profileIdentity",
            "mcp_bindings",
        ] {
            assert!(!text.contains(private));
        }
        value
    };
    let found = call(
        &mut server,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let scanned = call(
        &mut server,
        "migration/batch/scan",
        json!({"sourceIds":[found["sources"][0]["sourceId"]]}),
    );
    let job = scanned["job"]["jobId"].clone();
    let items = call(&mut server, "migration/items", json!({"jobId":job}));
    let provider = items["providers"][0]["itemId"].clone();
    let mut choices = vec![
        json!({"kind":"provider","itemId":provider,"targetName":"Office","contextWindowTokens":64000,"outputHeadroomTokens":8192,"maxOutputTokens":8192}),
    ];
    let mut private_choices = Vec::new();
    for (index, candidate) in items["mcps"].as_array().unwrap().iter().enumerate() {
        let item = candidate["itemId"].clone();
        let field = if candidate["transport"] == "stdio" {
            json!({"kind":"environment","name":"TOKEN"})
        } else {
            json!({"kind":"header","name":"Authorization"})
        };
        choices.push(json!({"kind":"mcp","itemId":item,"targetName":format!("Imported{index}"),"enableAfterImport":false}));
        private_choices.push(json!({"itemId":item,"fields":[field],"consentPrivateValues":true}));
    }
    assert_eq!(private_choices.len(), 2);
    let params = json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],"choices":choices,
        "credentials":[{"itemId":provider,"source":"configuration","consentApiKey":true}],"mcpCredentials":private_choices});
    let planned = call(&mut server, "migration/batch/plan", params);
    assert_eq!(planned["batch"]["credentialActions"], 3);
    assert_eq!(
        planned["batch"]["publishedCredentials"]
            .as_u64()
            .unwrap_or(0),
        0
    );
    assert_eq!(
        kcoder_config::read_settings_file(&settings_path).unwrap(),
        before
    );
    assert!(!profile.join("credentials.json").exists());
    let private = call(
        &mut server,
        "migration/batch/mcp/credential/read",
        json!({"jobId":job}),
    );
    assert_eq!(private["plans"].as_array().unwrap().len(), 2);
    assert!(
        private["plans"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plan| plan["phase"] == "ready")
    );
    assert!(
        call(
            &mut server,
            "migration/mcp/credential/read",
            json!({"jobId":job})
        )["plans"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    for method in [
        "migration/mcp/credential/apply",
        "migration/mcp/credential/undo",
    ] {
        server.send(json!({"jsonrpc":"2.0","id":11,"method":method,"params":{"jobId":job,"expectedSequence":planned["job"]["sequence"],"planId":private["plans"][0]["planId"]}}));
        assert_eq!(
            server.response(11)["error"]["message"],
            "migration_credential_group_operation_required"
        );
    }
    let plan = planned["batch"]["planId"].clone();
    let saved = call(
        &mut server,
        "migration/batch/apply",
        json!({"jobId":job,"expectedSequence":planned["job"]["sequence"],"planId":plan,"requestId":"apply"}),
    );
    assert_eq!(saved["batch"]["publishedCredentials"], 3);
    assert_eq!(
        saved["batch"]["committedActions"],
        saved["batch"]["totalActions"]
    );
    let published = kcoder_config::read_settings_file(&settings_path).unwrap();
    assert_eq!(
        published["mcp_disabled_servers"].as_array().unwrap().len(),
        2
    );
    assert!(!published.to_string().contains(secret));
    assert!(
        !std::fs::read_to_string(profile.join("credentials.json"))
            .unwrap()
            .contains(skipped)
    );
    assert_eq!(std::fs::read_to_string(&source).unwrap(), source_text);
    assert!(!input.join("must-not-run.sh.marker").exists());
    drop(server);
    std::fs::remove_file(&source).unwrap();
    let mut server = start();
    initialize(&mut server);
    let restored = call(
        &mut server,
        "migration/batch/mcp/credential/read",
        json!({"jobId":job}),
    );
    assert!(
        restored["plans"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plan| plan["phase"] == "published")
    );
    let undone = call(
        &mut server,
        "migration/batch/rollback",
        json!({"jobId":job,"expectedSequence":restored["job"]["sequence"],"planId":plan,"requestId":"undo"}),
    );
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert_eq!(
        undone["batch"]["publishedCredentials"]
            .as_u64()
            .unwrap_or(0),
        0
    );
    assert_eq!(
        kcoder_config::read_settings_file(&settings_path).unwrap(),
        before
    );
    let private = call(
        &mut server,
        "migration/batch/mcp/credential/read",
        json!({"jobId":job}),
    );
    assert!(
        private["plans"]
            .as_array()
            .unwrap()
            .iter()
            .all(|plan| plan["phase"] == "undone")
    );
}
