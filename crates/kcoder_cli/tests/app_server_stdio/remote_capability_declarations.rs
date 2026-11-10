// Native protocol declarations are model-independent and never create an ACP session.
#[cfg(target_os = "linux")]
#[test]
fn actual_native_acp_inbound_declaration_requires_opt_in_and_creates_no_thread() {
    for requested in [None, Some(false), Some(true)] {
        let owned = tempfile::tempdir().unwrap();
        let private = kcoder_config::PrivateDirectory::open_existing(owned.path()).unwrap();
        private
            .create_private_child(std::ffi::OsStr::new("profile"))
            .unwrap();
        private
            .create_private_child(std::ffi::OsStr::new("workspace"))
            .unwrap();
        let profile = owned.path().join("profile");
        let workspace = owned.path().join("workspace");
        let settings = profile.join("settings.json");
        std::fs::write(&settings, serde_json::to_vec(&json!({
            "active_provider":"Unused", "model":"unused", "session_memory":{"enabled":false},
            "providers":{"Unused":{"api_format":"openai_chat_completions","authentication":{"mode":"none"},
            "endpoint":"http://127.0.0.1:9/v1","default_model":"unused","context_window_tokens":32768,
            "max_output_tokens":128,"output_headroom_tokens":128,"discover_models":false}}
        })).unwrap()).unwrap();
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario()
            .spawn();
        let mut experimental = serde_json::Map::new();
        if let Some(value) = requested {
            experimental.insert("acpInboundV1".into(), value.into());
        }
        server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"actual-remote-declarations","version":"1"},"capabilities":{"experimental":experimental}}}));
        let response = server.response(1);
        assert!(response["error"].is_null(), "{response}");
        let advertised = response["result"]["capabilities"]["experimental"].get("acpInboundV1");
        if requested == Some(true) {
            assert_eq!(advertised, Some(&json!(true)));
        } else {
            assert!(advertised.is_none());
        }
        server.send(json!({"id":2,"method":"thread/list","params":{"limit":10}}));
        let threads = server.response(2);
        assert!(threads["error"].is_null(), "{threads}");
        assert_eq!(threads["result"]["threads"].as_array().unwrap().len(), 0);
    }
}
