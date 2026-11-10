use super::{TestAppServer, Value, json, rpc};

#[test]
fn migration_rpc_mcp_private_slots_require_consent_and_reconcile_after_restart_without_source_execution()
 {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let claude = root.path().join("claude");
    let codex = root.path().join("codex");
    for dir in [&workspace, &profile, &claude, &codex] {
        std::fs::create_dir(dir).unwrap();
    }
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    std::fs::write(
        profile.join("settings.json"),
        r#"{"credential_store":"file"}"#,
    )
    .unwrap();
    let secret = "SYNTHETIC_RPC_MCP_SELECTED_VALUE";
    let unselected = "SYNTHETIC_RPC_MCP_UNSELECTED_VALUE";
    let helper = codex.join("never-run.sh");
    std::fs::write(&helper, "printf invoked > \"$0.marker\"\n").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let claude_text = json!({"mcpServers":{"docs":{"type":"http","url":url,"headers":{"Authorization":format!("Bearer {secret}")}}}}).to_string();
    let codex_text = format!(
        "[mcp_servers.docs]\ncommand='sh'\nargs=[{}]\n[mcp_servers.docs.env]\nTOKEN='{secret}'\nUNSELECTED='{unselected}'\n",
        serde_json::to_string(&helper.to_string_lossy()).unwrap()
    );
    std::fs::write(claude.join("settings.json"), &claude_text).unwrap();
    std::fs::write(codex.join("config.toml"), &codex_text).unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .discard_stderr();
        for (name, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", claude.as_path()),
            ("CODEX_HOME", codex.as_path()),
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
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"mcp-credential-fixture","version":"0"}}),
        );
        assert_eq!(
            result["capabilities"]["experimental"]["migrationMcpCredentialsV1"],
            true
        );
    };
    let mut server = start();
    initialize(&mut server);
    let mut request = 10;
    for (kind, slot, remaining) in [
        ("codex", json!({"kind":"environment","name":"TOKEN"}), 1),
        (
            "claude-code",
            json!({"kind":"header","name":"Authorization"}),
            0,
        ),
    ] {
        let mut call = |server: &mut TestAppServer, method: &str, params: Value| {
            request += 1;
            let result = rpc(server, request, method, params);
            let public = result.to_string();
            assert!(!public.contains(secret));
            assert!(!public.contains(unselected));
            assert!(!public.contains("fingerprint"));
            assert!(!public.contains("profileIdentity"));
            result
        };
        let sources = call(&mut server, "migration/discover", json!({"sources":[kind]}));
        let scanned = call(
            &mut server,
            "migration/scan",
            json!({"sourceId":sources["sources"][0]["sourceId"]}),
        );
        let job = scanned["job"]["jobId"].clone();
        let items = call(&mut server, "migration/items", json!({"jobId":job}));
        let item = items["mcps"][0]["itemId"].clone();
        let planned = call(
            &mut server,
            "migration/mcp/plan",
            json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],"itemId":item,"targetName":if kind == "codex" {"ImportedCodexDocs"} else {"ImportedClaudeDocs"},"enableAfterImport":false}),
        );
        let mcp = planned["mcpPlans"][0]["planId"].clone();
        let saved = call(
            &mut server,
            "migration/mcp/apply",
            json!({"jobId":job,"expectedSequence":planned["job"]["sequence"],"planId":mcp}),
        );
        let params = json!({"jobId":job,"expectedSequence":saved["job"]["sequence"],"itemId":item,"fields":[slot],"consentPrivateValues":false});
        server.send(json!({"jsonrpc":"2.0","id":3,"method":"migration/mcp/credential/plan","params":params}));
        assert_eq!(
            server.response(3)["error"]["message"],
            "migration_mcp_private_consent_required"
        );
        let mut params = params;
        params["consentPrivateValues"] = true.into();
        let planned = call(&mut server, "migration/mcp/credential/plan", params);
        assert_eq!(planned["plans"][0]["remainingFields"], remaining);
        let plan = planned["plans"][0]["planId"].clone();
        let committed = call(
            &mut server,
            "migration/mcp/credential/apply",
            json!({"jobId":job,"expectedSequence":planned["job"]["sequence"],"planId":plan}),
        );
        assert_eq!(committed["plans"][0]["phase"], "published");
        assert!(
            !kcoder_config::read_settings_file(&profile.join("settings.json"))
                .unwrap()
                .to_string()
                .contains(secret)
        );
        drop(server);
        server = start();
        initialize(&mut server);
        let read = call(
            &mut server,
            "migration/mcp/credential/read",
            json!({"jobId":job}),
        );
        assert_eq!(read, committed);
        let source = if kind == "codex" {
            codex.join("config.toml")
        } else {
            claude.join("settings.json")
        };
        let bytes = std::fs::read(&source).unwrap();
        std::fs::remove_file(&source).unwrap();
        assert_eq!(
            call(
                &mut server,
                "migration/mcp/credential/apply",
                json!({"jobId":job,"expectedSequence":0,"planId":plan})
            ),
            committed
        );
        let undone = call(
            &mut server,
            "migration/mcp/credential/undo",
            json!({"jobId":job,"expectedSequence":committed["job"]["sequence"],"planId":plan}),
        );
        assert_eq!(undone["plans"][0]["phase"], "undone");
        std::fs::write(&source, bytes).unwrap();
        call(
            &mut server,
            "migration/mcp/rollback",
            json!({"jobId":job,"expectedSequence":undone["job"]["sequence"],"planId":mcp}),
        );
    }
    assert!(!helper.with_extension("sh.marker").exists());
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(
        std::fs::read_to_string(claude.join("settings.json")).unwrap(),
        claude_text
    );
    assert_eq!(
        std::fs::read_to_string(codex.join("config.toml")).unwrap(),
        codex_text
    );
}
