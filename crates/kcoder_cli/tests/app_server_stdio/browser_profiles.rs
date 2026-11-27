// Actual stdio catalog consumers; no browser process, model or external endpoint.
mod browser_profile_catalog {
    use super::*;

    fn initialize(server: &mut TestAppServer, enabled: bool) -> Value {
        server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"browser-profile-catalog-test","version":"1"},
            "capabilities":{"experimental":{"integrationScopeV1":true,"browserProfilesV1":enabled}}}}));
        assert_eq!(
            server.response(1)["result"]["capabilities"]["experimental"]["browserProfilesV1"],
            enabled
        );
        server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
        server.response(2)["result"].clone()
    }

    fn call(
        server: &mut TestAppServer,
        id: i64,
        method: &str,
        scope: &Value,
        operation: Option<&str>,
        payload: Value,
    ) -> Value {
        let mut params = json!({"contractVersion":"parallel-v1","requestId":format!("request-{id}"),"scope":scope,"timeoutMs":1000,"payload":payload});
        if let Some(operation) = operation {
            params["operationId"] = json!(operation);
        }
        server.send(json!({"id":id,"method":method,"params":params}));
        server.response(id)
    }

    #[test]
    fn actual_browser_catalog_survives_restart_and_legacy_clients_cannot_borrow_opt_in() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        write_test_settings(&settings);
        {
            let mut server = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .spawn();
            let scope = initialize(&mut server, true);
            let list = call(
                &mut server,
                3,
                "integrations/browserProfiles/list",
                &scope,
                None,
                json!({}),
            );
            assert_eq!(
                list["result"]["result"]["page"]["items"],
                json!([]),
                "{list}"
            );
            let payload = json!({"draft":{"id":"office","label":"Department browser","accountLabel":"Business account (user label)","purpose":"business"},"expectedRevision":0});
            let saved = call(
                &mut server,
                4,
                "integrations/browserProfiles/save",
                &scope,
                Some("original-save"),
                payload.clone(),
            );
            assert_eq!(saved["result"]["status"], "completed", "{saved}");
            let replay = call(
                &mut server,
                5,
                "integrations/browserProfiles/save",
                &scope,
                Some("original-save"),
                payload,
            );
            assert_eq!(saved["result"]["result"], replay["result"]["result"]);
            server.send(json!({"id":6,"method":"thread/list","params":{}}));
            assert_eq!(
                server.response(6)["result"]["threads"]
                    .as_array()
                    .unwrap()
                    .len(),
                0
            );
        }
        {
            let mut server = TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .spawn();
            let scope = initialize(&mut server, false);
            let rejected = call(
                &mut server,
                3,
                "integrations/browserProfiles/list",
                &scope,
                None,
                json!({}),
            );
            assert!(rejected.get("error").is_some(), "{rejected}");
        }
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario()
            .spawn();
        let scope = initialize(&mut server, true);
        let read = call(
            &mut server,
            3,
            "integrations/browserProfiles/list",
            &scope,
            None,
            json!({}),
        );
        assert_eq!(
            read["result"]["result"]["page"]["items"][0]["draft"]["id"], "office",
            "{read}"
        );
        let hidden = serde_json::to_string(&read).unwrap();
        assert!(!hidden.contains(profile.to_str().unwrap()));
    }

    #[test]
    fn actual_browser_catalog_rejects_foreign_scope_and_private_path_fields_without_writing() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        write_test_settings(&settings);
        let mut server = TestAppServer::builder(&workspace, &settings)
            .config_dir(&profile)
            .without_scenario()
            .spawn();
        let scope = initialize(&mut server, true);
        let payload = json!({"draft":{"id":"office","label":"Office","purpose":"business"},"expectedRevision":0});
        let mut foreign = scope.clone();
        foreign["accountId"] = json!("foreign-account");
        let rejected = call(
            &mut server,
            3,
            "integrations/browserProfiles/save",
            &foreign,
            Some("foreign-save"),
            payload.clone(),
        );
        assert_eq!(rejected["result"]["status"], "rejected", "{rejected}");
        let mut private = payload;
        private["draft"]["profilePath"] = json!("/private/foreign/browser");
        let rejected = call(
            &mut server,
            4,
            "integrations/browserProfiles/save",
            &scope,
            Some("path-save"),
            private,
        );
        assert_eq!(rejected["result"]["status"], "rejected", "{rejected}");
        let read = call(
            &mut server,
            5,
            "integrations/browserProfiles/list",
            &scope,
            None,
            json!({}),
        );
        assert_eq!(
            read["result"]["result"]["page"]["items"],
            json!([]),
            "{read}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Requires explicit installed Chromium and private D-Bus; actual parent SIGKILL recovery, no model"]
    fn actual_browser_parent_sigkill_recovers_only_original_confirmed_cleanup_receipt() {
        use std::{
            io::Read,
            sync::{
                Arc,
                atomic::{AtomicBool, Ordering},
            },
        };
        let chromium =
            std::env::var_os("KCODER_CHROMIUM_BIN").expect("explicit installed Chromium required");
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let profile = root.path().join("profile");
        kcoder_config::PrivateDirectory::open_or_create(&profile).unwrap();
        let settings = profile.join("settings.json");
        write_test_settings(&settings);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let site = std::thread::spawn(move || {
            while !signal.load(Ordering::Acquire) {
                if let Ok((mut socket, _)) = listener.accept() {
                    socket
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    let mut bytes = [0; 8192];
                    let _ = socket.read(&mut bytes);
                    let body = "<!doctype html><title>Owned crash recovery</title><p>Native browser owner</p>";
                    let _ = write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                } else {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
        });
        struct SiteOwner {
            stop: Arc<AtomicBool>,
            thread: Option<std::thread::JoinHandle<()>>,
        }
        impl Drop for SiteOwner {
            fn drop(&mut self) {
                self.stop.store(true, Ordering::Release);
                if let Some(thread) = self.thread.take() {
                    let _ = thread.join();
                }
            }
        }
        let _site = SiteOwner {
            stop: stop.clone(),
            thread: Some(site),
        };
        let spawn = || {
            TestAppServer::builder(&workspace, &settings)
                .config_dir(&profile)
                .without_scenario()
                .env("KCODER_CHROMIUM_BIN", &chromium)
                .env("KCODER_CHROMIUM_NO_SANDBOX", "1")
                .spawn()
        };
        let init = |server: &mut TestAppServer| {
            server.send(json!({"id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"browser-crash-fixture","version":"1"},"capabilities":{"experimental":{"integrationScopeV1":true,"browserProfilesV1":true,"browserProfileSessionsV1":true}}}}));
            assert_eq!(
                server.response(1)["result"]["capabilities"]["experimental"]["browserProfileSessionsV1"],
                true
            );
            server.send(json!({"id":2,"method":"integrations/scope/read","params":{}}));
            server.response(2)["result"].clone()
        };
        let mut server = spawn();
        let scope = init(&mut server);
        let saved = call(
            &mut server,
            3,
            "integrations/browserProfiles/save",
            &scope,
            Some("create"),
            json!({"draft":{"id":"office","label":"Owned crash fixture","purpose":"business"},"expectedRevision":0}),
        );
        assert_eq!(saved["result"]["status"], "completed");
        let start = |server: &mut TestAppServer, scope: &Value, operation: &str, id: i64| {
            server.send(json!({"id":id,"method":"browser/start","params":{"url":url,"profile":{"scope":scope,"profileId":"office","expectedRevision":1,"operationId":operation}}}));
            server.response(id)
        };
        let original = start(&mut server, &scope, "original-launch", 4);
        assert!(original.get("error").is_none(), "{original}");
        server.child.kill().unwrap();
        server.child.wait().unwrap();
        drop(server);
        let receipt =
            wait_for_named_file(&profile, "profiles.json", Duration::from_secs(5)).unwrap();
        let catalog = receipt.parent().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let complete = std::fs::read_dir(catalog)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("cleanup-"))
                .any(|entry| {
                    std::fs::read(entry.path()).unwrap_or_default()
                        == kcoder_process_supervisor::linux_stdio::CLEANUP_CONFIRMED_BYTES
                });
            if complete {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "original owner cleanup receipt missing"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut reopened = spawn();
        let current = init(&mut reopened);
        let next = start(&mut reopened, &current, "new-user-action", 5);
        assert!(next.get("error").is_none(), "{next}");
        let old = start(&mut reopened, &current, "original-launch", 6);
        assert!(old.get("error").is_some(), "old launch replayed: {old}");
        reopened.send(json!({"id":7,"method":"browser/close","params":{"session_id":next["result"]["session_id"]}}));
        assert_eq!(reopened.response(7)["result"]["closed"], true);
        drop(reopened);
        stop.store(true, Ordering::Release);
    }
}
