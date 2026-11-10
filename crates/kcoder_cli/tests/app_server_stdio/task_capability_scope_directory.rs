// Actual public negotiation/read uses only an owned private profile; no model or execution.
mod task_capability_scope_directory {
    use super::*;

    fn request(server: &mut TestAppServer, id: i64, method: &str, params: Value) -> Value {
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }
    fn initialize(server: &mut TestAppServer, directory: bool) -> Value {
        let initialized = request(
            server,
            1,
            "initialize",
            json!({
                "protocolVersion":"2026-07-27", "clientInfo":{"name":"original-source-directory","version":"1"},
                "capabilities":{"experimental":{"integrationScopeV1":true,"taskSourceDirectoryV1":directory}}
            }),
        );
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["taskSourceDirectoryV1"],
            directory,
            "{initialized}"
        );
        assert_ne!(
            initialized["result"]["capabilities"]["experimental"]["taskSourcesV1"],
            true
        );
        request(server, 2, "integrations/scope/read", json!({}))["result"].clone()
    }
    #[test]
    fn actual_saved_source_directory_is_explicit_unknown_without_a_store_or_ghost_task() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        std::fs::create_dir(&workspace).unwrap();
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        knowledge_control_settings(&settings, false);
        let baseline = std::fs::read(&settings).unwrap();
        for opted_in in [false, true] {
            let mut server = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .spawn();
            let scope = initialize(&mut server, opted_in);
            let envelope = |scope: Value| {
                json!({
                    "contractVersion":"parallel-v1", "requestId":"original-source-directory-read",
                    "scope":scope,"timeoutMs":1000,"payload":{}
                })
            };
            let read = request(
                &mut server,
                3,
                "integrations/tasks/readSavedTaskSourceBindings",
                envelope(scope.clone()),
            );
            if opted_in {
                assert_eq!(read["result"]["status"], "completed", "{read}");
                assert_eq!(
                    read["result"]["result"]["observationState"], "unknown",
                    "{read}"
                );
                assert_eq!(read["result"]["result"]["entries"], json!([]));
                let mut foreign = scope;
                foreign["targetId"] = json!("foreign-target");
                let denied = request(
                    &mut server,
                    4,
                    "integrations/tasks/readSavedTaskSourceBindings",
                    envelope(foreign),
                );
                assert!(denied.get("error").is_some(), "{denied}");
            } else {
                assert!(read.get("error").is_some(), "{read}");
            }
            let threads = request(&mut server, 5, "thread/list", json!({"limit":10}));
            assert_eq!(threads["result"]["threads"], json!([]), "{threads}");
            server.shutdown_successfully();
        }
        assert_eq!(std::fs::read(settings).unwrap(), baseline);
    }
}
