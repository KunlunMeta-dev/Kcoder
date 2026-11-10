#[test]
fn turn_file_capture_survives_stdio_restart_without_inventing_changes() {
    for (enabled, state, limitations) in [
        (false, "disabled", json!([])),
        (true, "partial", json!(["policyExclusions"])),
    ] {
        let (_temp, workspace, config, settings) = policy_sandbox();
        std::fs::write(workspace.join("excluded.bin"), b"private fixture content").unwrap();
        let mut overlay: Value =
            serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
        overlay["turn_file_changes"] = json!({"enabled":enabled,"retention_days":14,
            "max_total_bytes":1048576,"max_file_bytes":1048576,"ignore_globs":["excluded.bin"]});
        std::fs::write(&settings, serde_json::to_vec(&overlay).unwrap()).unwrap();
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .stream_delay_ms("1")
            .spawn();
        let initialized = server.initialize(1);
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["turnFileCaptureV1"], true,
            "{initialized}"
        );
        server.send(json!({"jsonrpc":"2.0","id":3,"method":"thread/start","params":{}}));
        let started = server.response(3);
        let thread = started["result"]["thread"]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        server.send(json!({
            "jsonrpc":"2.0","id":4,"method":"turn/start",
            "params":{"threadId":thread,"input":[{"type":"text","text":"capture observation"}]}
        }));
        let accepted = server.response(4);
        assert!(accepted.get("error").is_none(), "{accepted}");
        let completed = server.wait_for_method("turn/completed");
        assert_eq!(
            completed["params"]["turn"]["status"], "completed",
            "{completed}"
        );
        let review = completed["params"]["reviewEvidence"].clone();
        assert_eq!(review["state"], "partial", "{completed}");
        assert_eq!(
            review["observations"][0]["detailsTruncated"], true,
            "{completed}"
        );
        assert_eq!(
            review["observations"][0]["process"]["exitCode"], 0,
            "{completed}"
        );
        let capture = completed["params"]["fileChangesCapture"].clone();
        assert_eq!(capture["threadId"], thread, "{completed}");
        assert_eq!(capture["turnId"], completed["params"]["turn"]["id"]);
        assert_eq!(capture["state"], state, "{completed}");
        assert_eq!(capture["limitations"], limitations, "{completed}");
        assert!(capture["artifactId"].is_null(), "{completed}");
        assert!(completed["params"]["fileChanges"].is_null(), "{completed}");
        if enabled {
            assert!(capture["base"]["completedAtMs"].is_u64(), "{capture}");
            assert!(capture["head"]["completedAtMs"].is_u64(), "{capture}");
        }
        server.shutdown();

        let mut reopened = TestAppServer::builder(&workspace, &settings)
            .config_dir(&config)
            .without_scenario()
            .spawn();
        reopened.initialize(1);
        reopened.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/read",
            "params":{"threadId":thread,"limit":50}}));
        let history = reopened.response(2);
        assert!(history.get("error").is_none(), "{history}");
        let records: Vec<_> = history["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|message| message.get("fileChangesCapture"))
            .collect();
        assert_eq!(records, vec![&capture], "{history}");
        let reviews: Vec<_> = history["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m.get("reviewEvidence"))
            .collect();
        assert_eq!(reviews, vec![&review], "{history}");
        assert_eq!(
            std::fs::read(workspace.join("excluded.bin")).unwrap(),
            b"private fixture content"
        );
        reopened.shutdown();
    }
}
