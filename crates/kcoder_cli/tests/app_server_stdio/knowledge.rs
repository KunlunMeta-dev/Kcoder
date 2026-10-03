#[test]
fn knowledge_catalog_switch_and_sources_survive_real_app_server_restart() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    assert_eq!(
        server.initialize(1)["result"]["capabilities"]["experimental"]["knowledgeCatalogV1"],
        true
    );
    server.send(json!({"method":"knowledge/configure","params":{"enabled":true}}));
    server.send(json!({"id":2,"method":"knowledge/status","params":{}}));
    assert_eq!(server.response(2)["result"]["enabled"], false);
    server.send(json!({"id":3,"method":"knowledge/list","params":{}}));
    assert!(server.response(3).get("error").is_some());
    server.send(json!({"id":4,"method":"knowledge/configure","params":{"enabled":true}}));
    assert_eq!(server.response(4)["result"]["enabled"], true);
    server.send(json!({"id":5,"method":"knowledge/create","params":{"idempotencyKey":"create","name":"个人 Wiki"}}));
    let created = server.response(5);
    assert!(created.get("error").is_none(), "{created}");
    let library = created["result"]["id"].as_str().unwrap().to_owned();
    server.send(json!({"id":6,"method":"knowledge/source/importText","params":{"libraryId":library,"idempotencyKey":"source","title":"说明","text":"保留原始资料与证据。"}}));
    let imported = server.response(6);
    assert!(imported.get("error").is_none(), "{imported}");
    server.shutdown_successfully();
    let mut server = TestAppServer::builder(root.path(), &settings)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"knowledge/source/read","params":{"libraryId":library,"sourceId":imported["result"]["sourceId"],"revisionId":imported["result"]["revisionId"]}}));
    assert_eq!(
        server.response(2)["result"]["items"][0]["text"],
        "保留原始资料与证据。"
    );
    server.send(json!({"id":3,"method":"knowledge/configure","params":{"enabled":false}}));
    assert_eq!(server.response(3)["result"]["enabled"], false);
    server.send(
        json!({"id":4,"method":"knowledge/search","params":{"libraryId":library,"query":"资料"}}),
    );
    assert!(server.response(4).get("error").is_some());
    server.send(json!({"id":5,"method":"knowledge/configure","params":{"enabled":true}}));
    assert_eq!(server.response(5)["result"]["enabled"], true);
    server.send(json!({"id":6,"method":"knowledge/list","params":{}}));
    assert_eq!(server.response(6)["result"]["items"][0]["id"], library);
    server.shutdown_successfully();
    let other = root.path().join("other-account");
    std::fs::create_dir(&other).unwrap();
    let mut server = TestAppServer::builder(root.path(), &settings)
        .config_dir(&other)
        .without_scenario()
        .spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"knowledge/configure","params":{"enabled":true}}));
    assert_eq!(server.response(2)["result"]["enabled"], true);
    server.send(json!({"id":3,"method":"knowledge/read","params":{"libraryId":library}}));
    assert!(server.response(3).get("error").is_some());
    server.shutdown_successfully();
}

#[test]
fn knowledge_job_uses_target_provider_and_commits_generated_wiki_with_citations() {
    run_knowledge_job_fixture(false, false);
}

#[test]
fn knowledge_review_applies_the_exact_proposal_through_real_rpc() {
    run_knowledge_job_fixture(true, false);
}

#[test]
fn knowledge_worker_finishes_accepted_job_after_app_server_disconnect() {
    run_knowledge_job_fixture(false, true);
}

fn run_knowledge_job_fixture(needs_review: bool, durable: bool) {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    let (endpoint, calls, fixture) = serving_fixture_decided(move |index, request| {
        assert!(
            request.get("tools").is_none()
                || request["tools"].as_array().is_some_and(Vec::is_empty)
        );
        let content = &request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "user")
            .unwrap()["content"];
        let text = content.as_str().map(str::to_string).unwrap_or_else(|| {
            content
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        });
        let input: Value = serde_json::from_str(&text).unwrap();
        if index == 0 {
            return FixtureAnswer::Text(
                json!({"summary":"产品支持协议 A","queries":["协议"],"conflicts":[]}).to_string(),
            );
        }
        let source = &input["source"];
        let chunk = &source["chunks"][0];
        FixtureAnswer::Text(json!({"pages":[{"pageId":input["newPageIds"][0],"expectedRevision":null,"kind":"concept","title":"协议兼容性","markdown":"# 协议兼容性\n\n产品支持协议 A。","citations":[{"sourceId":source["sourceId"],"revisionId":source["revisionId"],"chunkId":chunk["chunkId"],"quote":chunk["text"]}],"relatedPageIds":[]}],"reviewNotes":if needs_review {vec!["请核对适用条件"]} else {vec![]}}).to_string())
    });
    write_fixture_provider_settings(&settings, &endpoint);
    let identity = uuid::Uuid::new_v4().to_string();
    let builder = || {
        let builder = TestAppServer::builder(root.path(), &settings).without_scenario();
        if durable { builder.config_dir(root.path()).wiki_account(&identity) } else { builder }
    };
    struct WorkerGuard(Option<std::process::Child>);
    impl Drop for WorkerGuard {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 { let _ = child.kill(); let _ = child.wait(); }
        }
    }
    let mut worker = WorkerGuard(None);
    let mut server = builder().spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"knowledge/configure","params":{"enabled":true}}));
    assert_eq!(server.response(2)["result"]["enabled"], true);
    server.send(json!({"id":3,"method":"knowledge/create","params":{"idempotencyKey":"wiki","name":"Wiki"}}));
    let library = server.response(3)["result"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":4,"method":"knowledge/source/importText","params":{"libraryId":library,"idempotencyKey":"source","title":"产品文档","text":"产品支持协议 A。"}}));
    let source = server.response(4)["result"].clone();
    server.send(json!({"id":5,"method":"knowledge/job/start","params":{"libraryId":library,"sourceId":source["sourceId"],"revisionId":source["revisionId"],"idempotencyKey":"ingest","language":"zh-CN"}}));
    let started = server.response(5);
    assert!(started.get("error").is_none(), "{started}");
    let job = started["result"]["id"].as_str().unwrap().to_owned();
    if durable {
        server.shutdown_successfully();
        // Start the independent runtime after the submitting connection is
        // completely gone, proving the database queue owns accepted work.
        worker.0 = Some(Command::new(env!("CARGO_BIN_EXE_kcoder"))
            .arg("--internal-wiki-worker").arg(&settings)
            .env("KCODER_ACCOUNT_PRINCIPAL_ID", &identity)
            .env("KCODER_CONFIG_DIR", root.path())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
            .spawn().unwrap());
        server = builder().spawn();
        server.initialize(1);
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        server.send(
            json!({"id":6,"method":"knowledge/job/get","params":{"libraryId":library,"jobId":job}}),
        );
        let state = server.response(6);
        assert!(state.get("error").is_none(), "{state}");
        assert_ne!(state["result"]["status"], "failed", "{state}");
        if state["result"]["status"]
            == if needs_review {
                "awaiting_review"
            } else {
                "completed"
            }
        {
            break;
        }
        assert!(Instant::now() < deadline, "job timeout: {state}");
        std::thread::sleep(Duration::from_millis(50));
    }
    if needs_review {
        server.send(json!({"id":9,"method":"knowledge/review/read","params":{"libraryId":library,"jobId":job}}));
        let review = server.response(9);
        assert!(review.get("error").is_none(), "{review}");
        let token = review["result"]["token"].clone();
        server.send(json!({"id":10,"method":"knowledge/review/page","params":{"libraryId":library,"jobId":job,"token":token,"pageId":review["result"]["pages"][0]["pageId"]}}));
        assert!(
            server.response(10)["result"]["proposed"]
                .as_str()
                .unwrap()
                .contains("协议 A")
        );
        server.send(json!({"id":11,"method":"knowledge/review/decide","params":{"libraryId":library,"jobId":job,"token":token,"decision":"accept"}}));
        let accepted = server.response(11);
        assert_eq!(accepted["result"]["status"], "completed", "{accepted}");
    }
    server.send(json!({"id":7,"method":"knowledge/page/list","params":{"libraryId":library}}));
    let list = server.response(7);
    assert_eq!(list["result"]["items"].as_array().unwrap().len(), 3);
    let page = list["result"]["items"][0]["pageId"].clone();
    server.send(
        json!({"id":8,"method":"knowledge/page/read","params":{"libraryId":library,"pageId":page}}),
    );
    let result = server.response(8);
    assert_eq!(
        result["result"]["draft"]["citations"][0]["sourceId"],
        source["sourceId"]
    );
    assert_eq!(fixture_call_count(&calls), 2);
    server.shutdown_successfully();
    fixture.join().unwrap();
}

#[test]
fn knowledge_attachment_import_uses_connection_owned_upload_and_preserves_utf16() {
    use base64::Engine as _;
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings).without_scenario().spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"knowledge/configure","params":{"enabled":true}}));
    assert_eq!(server.response(2)["result"]["enabled"],true);
    server.send(json!({"id":3,"method":"knowledge/create","params":{"idempotencyKey":"library","name":"Wiki"}}));
    let library=server.response(3)["result"]["id"].clone();
    server.send(json!({"id":4,"method":"knowledge/source/importAttachment","params":{"libraryId":library,"idempotencyKey":"bad","title":"settings.txt","attachmentPath":settings}}));
    assert!(server.response(4).get("error").is_some());
    let original:Vec<u8>=[0xff,0xfe].into_iter().chain("中文资料".encode_utf16().flat_map(u16::to_le_bytes)).collect();
    server.send(json!({"id":5,"method":"attachment/save","params":{"filename":"source.txt","content_base64":base64::engine::general_purpose::STANDARD.encode(original)}}));
    let saved=server.response(5);assert!(saved.get("error").is_none(),"{saved}");
    server.send(json!({"id":6,"method":"knowledge/source/importAttachment","params":{"libraryId":library,"idempotencyKey":"source","title":"source.txt","attachmentPath":saved["result"]["path"]}}));
    let imported=server.response(6);assert!(imported.get("error").is_none(),"{imported}");
    server.send(json!({"id":7,"method":"knowledge/source/read","params":{"libraryId":library,"sourceId":imported["result"]["sourceId"],"revisionId":imported["result"]["revisionId"]}}));
    assert_eq!(server.response(7)["result"]["items"][0]["text"],"中文资料");
    server.send(json!({"id":8,"method":"knowledge/export","params":{"libraryId":library}}));
    let exported = server.response(8); assert!(exported.get("error").is_none(), "{exported}");
    let path = exported["result"]["path"].clone();
    server.send(json!({"id":9,"method":"knowledge/export/read","params":{"attachmentPath":path,"offset":0}}));
    let downloaded = server.response(9); assert!(downloaded.get("error").is_none(), "{downloaded}");
    assert!(downloaded["result"]["contentBase64"].as_str().is_some_and(|value| !value.is_empty()));
    server.send(json!({"id":10,"method":"knowledge/importArchive","params":{"attachmentPath":path,"idempotencyKey":"restore"}}));
    let restored = server.response(10); assert!(restored.get("error").is_none(), "{restored}");
    assert_ne!(restored["result"]["id"], library);
    server.send(json!({"id":11,"method":"knowledge/source/read","params":{"libraryId":restored["result"]["id"],"sourceId":imported["result"]["sourceId"],"revisionId":imported["result"]["revisionId"]}}));
    assert_eq!(server.response(11)["result"]["items"][0]["text"],"中文资料");

    server.shutdown_successfully();
}

#[test]
fn knowledge_catalog_accepts_the_parallel_reads_used_by_the_workspace() {
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("settings.json");
    write_test_settings(&settings);
    let mut server = TestAppServer::builder(root.path(), &settings).without_scenario().spawn();
    server.initialize(1);
    server.send(json!({"id":2,"method":"knowledge/configure","params":{"enabled":true}}));
    assert_eq!(server.response(2)["result"]["organizationEnabled"],true);
    server.send(json!({"id":3,"method":"knowledge/create","params":{"name":"Wiki","idempotencyKey":"create"}}));
    let library = server.response(3)["result"]["id"].clone();
    for id in 10..22 {
        let (method, params) = match id % 4 {
            0 => ("knowledge/list",json!({})),
            1 => ("knowledge/default/read",json!({})),
            2 => ("knowledge/page/list",json!({"libraryId":library})),
            _ => ("knowledge/job/overview",json!({"libraryId":library})),
        };
        server.send(json!({"id":id,"method":method,"params":params}));
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut received = std::collections::BTreeSet::new();
    while received.len() < 12 {
        let response = server.next_value(deadline);
        if let Some(id) = response["id"].as_i64() && (10..22).contains(&id) {
            assert!(response.get("error").is_none(), "{response}");
            assert!(received.insert(id), "duplicate response");
        }
    }
    server.shutdown_successfully();
}
