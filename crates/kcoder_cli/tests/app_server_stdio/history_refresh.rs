#[test]
fn short_thread_ids_survive_stdio_restart_resume_and_indexed_pagination() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut seed = TestAppServer::start(temp.path(), &settings);
    seed.initialize(1);
    let mut threads = Vec::new();
    for request in [2, 4] {
        seed.send(json!({"id":request,"method":"thread/start","params":{}}));
        let response = seed.response(request);
        assert!(response.get("error").is_none(), "{response}");
        let thread = response["result"]["thread"]["id"].as_str().unwrap().to_owned();
        assert_eq!(thread.len(), 5, "{thread}");
        assert!(thread.bytes().all(|byte| byte.is_ascii_alphanumeric()), "{thread}");
        seed.send(json!({"id":request+1,"method":"turn/start","params":{
            "threadId":thread,"input":[{"type":"text","text":format!("short-id fixture {request}")}]
        }}));
        assert!(seed.response(request+1).get("error").is_none());
        seed.wait_for_method("turn/completed");
        threads.push(thread);
    }
    assert_ne!(threads[0].to_ascii_lowercase(), threads[1].to_ascii_lowercase());
    seed.shutdown();
    // Append deterministic fixture turns only after the owned process has exited.
    for thread in &threads {
        let source = find_named_file(temp.path(), &format!("{thread}.jsonl")).unwrap();
        let mut file = std::fs::OpenOptions::new().append(true).open(source).unwrap();
        for index in 0..6 {
            writeln!(file, "{}", json!({"session_id":thread,"timestamp_ms":2_000_000_000_000u64+index,
                "uuid":format!("short-{thread}-{index}"),"role":if index%2==0 {"user"} else {"assistant"},
                "content":[{"type":"text","text":format!("short-id page {thread} {index}")}]})).unwrap();
        }
    }
    let mut restored = TestAppServer::start(temp.path(), &settings);
    restored.initialize(10);
    restored.send(json!({"id":11,"method":"thread/list","params":{}}));
    let listed = restored.response(11);
    for thread in &threads {
        assert!(listed["result"]["threads"].as_array().unwrap().iter().any(|row| row["id"] == *thread));
    }
    restored.send(json!({"id":12,"method":"thread/history/refresh","params":{"acknowledgeExternalWriters":true}}));
    let mut progress = restored.response(12);
    let mut request_id = 20;
    for _ in 0..50 {
        if progress["result"]["status"] != "building" { break; }
        restored.send(json!({"id":request_id,"method":"thread/history/refresh","params":{"cursor":progress["result"]["nextCursor"]}}));
        progress = restored.response(request_id);
        request_id += 1;
    }
    assert_eq!(progress["result"]["status"], "ready", "{progress}");
    for thread in &threads {
        let oracle = collect_transcript_pages(&mut restored, thread, "thread/read", 2, &mut request_id);
        let indexed = collect_transcript_pages(&mut restored, thread, "thread/read/indexed", 2, &mut request_id);
        assert_eq!(indexed, oracle);
        assert!(indexed.iter().any(|row| row.to_string().contains(&format!("short-id page {thread} 5"))));
        restored.send(json!({"id":request_id,"method":"thread/resume","params":{"threadId":thread}}));
        let resumed = restored.response(request_id);
        request_id += 1;
        assert_eq!(resumed["result"]["thread"]["id"], *thread, "{resumed}");
        let resident = collect_transcript_pages(&mut restored, thread, "thread/read", 2, &mut request_id);
        assert_eq!(resident, oracle);
    }
    restored.shutdown();
}

#[test]
fn history_refresh_stdio_rebuild_preserves_listing_and_tracks_metadata_across_restart() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut creator = TestAppServer::start(temp.path(), &settings);
    creator.initialize(1);
    creator.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread_id = creator.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    creator.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":thread_id,"input":[{"type":"text","text":"index fixture"}]}}));
    assert!(creator.response(3).get("error").is_none());
    creator.wait_for_method("turn/completed");
    creator.shutdown();

    let mut server = TestAppServer::start(temp.path(), &settings);
    assert_eq!(
        server.initialize(10)["result"]["capabilities"]["experimental"]["threadHistoryIndexRefresh"],
        true
    );
    server.send(json!({"jsonrpc":"2.0","id":11,"method":"thread/list","params":{}}));
    let before = server.response(11)["result"]["threads"].clone();
    assert!(
        before
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == thread_id)
    );
    server.send(json!({"jsonrpc":"2.0","id":12,"method":"thread/history/refresh","params":{}}));
    assert!(server.response(12).get("error").is_some());
    server.send(json!({"jsonrpc":"2.0","id":13,"method":"thread/history/refresh","params":{"acknowledgeExternalWriters":true}}));
    let mut progress = server.response(13);
    let mut cursors = std::collections::HashSet::new();
    for id in 20..52 {
        if progress["result"]["status"] != "building" {
            break;
        }
        let cursor = progress["result"]["nextCursor"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(cursors.insert(cursor.clone()));
        server.send(json!({"jsonrpc":"2.0","id":id,"method":"thread/history/refresh","params":{"cursor":cursor}}));
        progress = server.response(id);
    }
    assert_eq!(progress["result"]["status"], "ready", "{progress}");
    assert_eq!(progress["result"]["issueCount"], 0);
    server.send(json!({"jsonrpc":"2.0","id":53,"method":"thread/read/indexed","params":{"threadId":thread_id,"limit":1}}));
    let indexed_page = server.response(53);
    assert!(indexed_page.get("error").is_none(), "{indexed_page}");
    assert!(indexed_page["result"]["beforeCursor"].as_str().unwrap().starts_with("tp1:"));
    server.send(json!({"jsonrpc":"2.0","id":54,"method":"thread/read","params":{"threadId":thread_id,"limit":1}}));
    let legacy_page = server.response(54);
    assert_eq!(indexed_page["result"]["messages"], legacy_page["result"]["messages"]);
    assert_eq!(indexed_page["result"]["thread"], legacy_page["result"]["thread"]);
    server.send(json!({"jsonrpc":"2.0","id":55,"method":"thread/read/indexed","params":{"threadId":thread_id,"limit":1,"beforeCursor":indexed_page["result"]["beforeCursor"]}}));
    let earlier = server.response(55);
    server.send(json!({"jsonrpc":"2.0","id":56,"method":"thread/read","params":{"threadId":thread_id,"limit":1,"beforeCursor":legacy_page["result"]["beforeCursor"]}}));
    assert_eq!(earlier["result"]["messages"], server.response(56)["result"]["messages"]);
    // External edits require explicit refresh. Withhold this fixture source to prove the
    // actual list dispatch uses the ready catalog rather than silently passing via a full scan.
    let source = find_named_file(temp.path(), &format!("{thread_id}.jsonl")).unwrap();
    let withheld = source.with_extension("withheld");
    std::fs::rename(&source, &withheld).unwrap();
    server.send(json!({"jsonrpc":"2.0","id":59,"method":"thread/read/indexed","params":{"threadId":thread_id,"limit":1}}));
    assert_eq!(server.response(59)["result"], indexed_page["result"]);
    server.send(json!({"jsonrpc":"2.0","id":60,"method":"thread/list","params":{}}));
    let after = server.response(60)["result"]["threads"].clone();
    std::fs::rename(&withheld, &source).unwrap();
    assert_eq!(after, before);
    server.send(json!({"jsonrpc":"2.0","id":61,"method":"thread/metadata/update","params":{"threadId":thread_id,"title":"indexed title","archivedAt":"2026-09-12T00:00:00Z"}}));
    assert!(server.response(61).get("error").is_none());
    server.send(json!({"jsonrpc":"2.0","id":63,"method":"thread/read/indexed","params":{"threadId":thread_id,"limit":1,"beforeCursor":indexed_page["result"]["beforeCursor"]}}));
    let stale = server.response(63);
    assert_eq!(stale["error"]["message"], "TRANSCRIPT_CURSOR_STALE");
    assert_eq!(stale["error"]["code"], -32041);
    server.send(json!({"jsonrpc":"2.0","id":62,"method":"thread/list","params":{"archived":true}}));
    let indexed = server.response(62)["result"]["threads"].clone();
    assert!(
        indexed
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == thread_id && row["title"] == "indexed title")
    );
    server.shutdown();
    let mut restored = TestAppServer::start(temp.path(), &settings);
    restored.initialize(70);
    restored.send(json!({"jsonrpc":"2.0","id":71,"method":"thread/list","params":{"archived":true}}));
    assert_eq!(restored.response(71)["result"]["threads"], indexed);
    restored.send(json!({"jsonrpc":"2.0","id":72,"method":"thread/resume","params":{"threadId":thread_id}}));
    assert!(restored.response(72).get("error").is_none());
    restored.send(json!({"jsonrpc":"2.0","id":73,"method":"thread/read/indexed","params":{"threadId":thread_id,"limit":1}}));
    let resident_page = restored.response(73);
    restored.send(json!({"jsonrpc":"2.0","id":74,"method":"thread/read","params":{"threadId":thread_id,"limit":1}}));
    let resident_legacy = restored.response(74);
    assert_eq!(resident_page["result"]["thread"], resident_legacy["result"]["thread"]);
    assert_eq!(resident_page["result"]["messages"], resident_legacy["result"]["messages"]);
    restored.shutdown();
}

// Model-independent pagination: deterministic source records are written only
// after the owned seed process exits, before explicit index activation.
#[test]
fn indexed_transcript_many_pages_match_legacy_without_source_reads() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut seed = TestAppServer::start(temp.path(), &settings);
    seed.initialize(1);
    seed.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread = seed.response(2)["result"]["thread"]["id"].as_str().unwrap().to_owned();
    seed.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"paging fixture"}]}}));
    assert!(seed.response(3).get("error").is_none());
    seed.wait_for_method("turn/completed");
    seed.shutdown();
    let source = find_named_file(temp.path(), &format!("{thread}.jsonl")).unwrap();
    let mut file = std::fs::OpenOptions::new().append(true).open(&source).unwrap();
    for index in 0..500 {
        writeln!(file, "{}", json!({"session_id":thread,"timestamp_ms":2_000_000_000_000u64+index,
            "uuid":format!("fixture-{index}"),"role":if index%2==0 {"user"} else {"assistant"},
            "content":[{"type":"text","text":format!("分页消息 {index}")}]})).unwrap();
    }
    drop(file);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(10);
    let mut request_id = 20;
    let oracle = collect_transcript_pages(&mut server, &thread, "thread/read", 100, &mut request_id);
    assert!(oracle.len() >= 500);
    server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/history/refresh","params":{"acknowledgeExternalWriters":true}}));
    let mut progress = server.response(request_id);
    request_id += 1;
    for _ in 0..50 {
        if progress["result"]["status"] != "building" { break; }
        server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/history/refresh","params":{"cursor":progress["result"]["nextCursor"]}}));
        progress = server.response(request_id);
        request_id += 1;
    }
    assert_eq!(progress["result"]["status"], "ready");
    let read_id = request_id;
    let second_read_id = request_id + 1;
    let resources_id = request_id + 2;
    server.send_batch([
        json!({"jsonrpc":"2.0","id":read_id,"method":"thread/read/indexed","params":{"threadId":thread,"limit":37}}),
        json!({"jsonrpc":"2.0","id":second_read_id,"method":"thread/read/indexed","params":{"threadId":thread,"limit":37}}),
        json!({"jsonrpc":"2.0","id":resources_id,"method":"server/resources/read","params":{}}),
    ]);
    let first_response = loop {
        let line = server.rx.recv_timeout(Duration::from_secs(30)).unwrap().unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["id"] == read_id || value["id"] == second_read_id || value["id"] == resources_id { break value; }
    };
    assert_eq!(first_response["id"], resources_id, "cold index construction must not occupy the request dispatcher");
    assert!(first_response["result"]["activity"]["pendingServiceRequests"].as_u64().unwrap() > 0);
    let mut responses = std::collections::HashMap::new();
    while responses.len() < 2 {
        let line = server.rx.recv_timeout(Duration::from_secs(30)).unwrap().unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        if let Some(id) = value["id"].as_i64() {
            if id == read_id || id == second_read_id { responses.insert(id, value); }
        }
    }
    let first = responses.remove(&read_id).unwrap();
    let second = responses.remove(&second_read_id).unwrap();
    assert_eq!(first["result"], second["result"], "same-thread cold reads must reuse the same published generation");
    request_id += 3;
    assert!(first["result"]["beforeCursor"].as_str().unwrap().starts_with("tp1:"));
    let withheld = source.with_extension("withheld");
    std::fs::rename(&source, &withheld).unwrap();
    let indexed = collect_transcript_pages(&mut server, &thread, "thread/read/indexed", 37, &mut request_id);
    std::fs::rename(&withheld, &source).unwrap();
    assert_eq!(indexed, oracle);
    let unique: std::collections::HashSet<_> = indexed.iter().map(|row| row["id"].as_str().unwrap()).collect();
    assert_eq!(unique.len(), indexed.len());
    // Chunk storage must preserve full payloads; response-budget overflow still falls back.
    for kib in [1100usize, 1600] {
        let mut file = std::fs::OpenOptions::new().append(true).open(&source).unwrap();
        let mut records = vec![
            json!({"role":"user","content":[{"type":"text","text":"large tool fixture"}]}),
            json!({"role":"assistant","content":[{"type":"tool_use","id":"large-call","name":"Read","input":{"payload":"x".repeat(kib*1024)}}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"large-call","content":[{"type":"text","text":"done"}]}]}),
            json!({"role":"assistant","content":[{"type":"text","text":"large fixture complete"}]}),
        ];
        if kib == 1600 {
            records.extend([
                json!({"role":"user","content":[{"type":"text","text":"after oversized row"}]}),
                json!({"role":"assistant","content":[{"type":"text","text":"small tail"}]}),
            ]);
        }
        for (index, mut record) in records.into_iter().enumerate() {
            record["session_id"] = json!(thread);
            record["timestamp_ms"] = json!(2_000_000_001_000u64 + kib as u64 * 10 + index as u64);
            record["uuid"] = json!(format!("large-{kib}-{index}"));
            writeln!(file, "{record}").unwrap();
        }
        drop(file);
        server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/history/refresh","params":{"acknowledgeExternalWriters":true}}));
        let mut progress = server.response(request_id);
        request_id += 1;
        for _ in 0..50 {
            if progress["result"]["status"] != "building" { break; }
            server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/history/refresh","params":{"cursor":progress["result"]["nextCursor"]}}));
            progress = server.response(request_id);
            request_id += 1;
        }
        assert_eq!(progress["result"]["status"], "ready");
        server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/read/indexed","params":{"threadId":thread,"limit":1}}));
        let mut oversized = server.response(request_id);
        request_id += 1;
        assert!(oversized.get("error").is_none());
        let first_cursor = oversized["result"]["beforeCursor"].as_str().unwrap();
        if kib == 1100 {
            assert!(first_cursor.starts_with("tp1:"), "chunked row within the response budget must stay indexed");
        } else {
            assert!(first_cursor.parse::<usize>().is_ok(), "over-budget row anywhere in history must use the compatible cursor");
            let scope = serde_json::to_string(&("final-transcript-v1", oversized["result"]["thread"]["cwd"].as_str().unwrap(), &thread)).unwrap();
            let index_root = fixture_transcript_index_root(temp.path()).unwrap();
            let visible_scope = serde_json::to_string(&("final-transcript-v2", oversized["result"]["thread"]["cwd"].as_str().unwrap(), &thread)).unwrap();
            let declined = || {
                let receipt = kcoder_state::history_index::TranscriptReadFence::acquire(source.parent().unwrap(), index_root.parent().unwrap(), &visible_scope).unwrap().unwrap();
                let store = kcoder_state::history_index::TranscriptPageStore::open(&index_root, &scope, false).unwrap().unwrap();
                store.declined_generation(receipt.proof(), 1_500_000 - 4096).unwrap()
            };
            let generation = declined().expect("verified row limit should be remembered");
            server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/read/indexed","params":{"threadId":thread,"limit":1}}));
            let repeated = server.response(request_id);
            request_id += 1;
            assert_eq!(repeated["result"], oversized["result"]);
            assert_eq!(declined(), Some(generation.clone()), "unchanged input must not begin another failed build");
            server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/history/refresh","params":{"acknowledgeExternalWriters":true}}));
            let mut refreshed = server.response(request_id);
            request_id += 1;
            for _ in 0..50 {
                if refreshed["result"]["status"] != "building" { break; }
                server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/history/refresh","params":{"cursor":refreshed["result"]["nextCursor"]}}));
                refreshed = server.response(request_id);
                request_id += 1;
            }
            assert_eq!(refreshed["result"]["status"], "ready");
            assert!(declined().is_none(), "explicit refresh must invalidate the failure proof");
            server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/read/indexed","params":{"threadId":thread,"limit":1}}));
            assert!(server.response(request_id).get("error").is_none());
            request_id += 1;
            assert_ne!(declined().unwrap(), generation);
        }
        let mut legacy_before = Value::Null;
        for _ in 0..4 {
            let found = oversized["result"]["messages"].as_array().unwrap().iter()
                .flat_map(|message| message["blocks"].as_array().into_iter().flatten())
                .any(|block| block["tool_use_id"] == "large-call");
            if found { break; }
            legacy_before = oversized["result"]["beforeCursor"].clone();
            let end = oversized["result"]["rangeStart"].clone();
            server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/read/indexed","params":{"threadId":thread,"limit":1,"beforeCursor":legacy_before}}));
            oversized = server.response(request_id);
            request_id += 1;
            assert_eq!(oversized["result"]["rangeEnd"], end);
        }
        let cursor = oversized["result"]["beforeCursor"].as_str().unwrap();
        server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/read","params":{"threadId":thread,"limit":1,"beforeCursor":legacy_before}}));
        let legacy = server.response(request_id);
        request_id += 1;
        for key in ["messages", "thread", "rangeStart", "rangeEnd", "hasMoreBefore"] {
            assert_eq!(oversized["result"][key], legacy["result"][key], "{key}");
        }
        assert!(serde_json::to_vec(&oversized["result"]["messages"]).unwrap().len() > 1024*1024);
        let tool = oversized["result"]["messages"].as_array().unwrap().iter()
            .flat_map(|message| message["blocks"].as_array().into_iter().flatten())
            .find(|block| block["tool_use_id"] == "large-call").unwrap();
        let payload = tool["tool_input"]["payload"].as_str().unwrap();
        assert_eq!(payload.len(), kib*1024);
        assert!(payload.bytes().all(|byte| byte == b'x'));
        server.send(json!({"jsonrpc":"2.0","id":request_id,"method":"thread/read/indexed","params":{"threadId":thread,"limit":1,"beforeCursor":cursor}}));
        let preceding = server.response(request_id);
        assert!(preceding.get("error").is_none());
        assert_eq!(preceding["result"]["rangeEnd"], oversized["result"]["rangeStart"]);
        request_id += 1;
    }
    server.shutdown();
}

#[test]
fn indexed_cold_read_disconnect_exits_and_rebuilds_complete_pages() {
    let temp = tempfile::tempdir().unwrap();
    let settings = temp.path().join("settings.json");
    write_test_settings(&settings);
    let mut seed = TestAppServer::start(temp.path(), &settings);
    seed.initialize(1);
    seed.send(json!({"jsonrpc":"2.0","id":2,"method":"thread/start","params":{}}));
    let thread = seed.response(2)["result"]["thread"]["id"].as_str().unwrap().to_owned();
    seed.send(json!({"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":"cancel fixture"}]}}));
    assert!(seed.response(3).get("error").is_none());
    seed.wait_for_method("turn/completed");
    seed.shutdown();
    let source = find_named_file(temp.path(), &format!("{thread}.jsonl")).unwrap();
    let mut file = std::fs::OpenOptions::new().append(true).open(&source).unwrap();
    for index in 0..8000 {
        writeln!(file, "{}", json!({"session_id":thread,"timestamp_ms":2_000_000_000_000u64+index,
            "uuid":format!("cancel-fixture-{index}"),"role":if index%2==0 {"user"} else {"assistant"},
            "content":[{"type":"text","text":format!("{index}:{}", "x".repeat(1024))}]})).unwrap();
    }
    drop(file);
    let mut server = TestAppServer::start(temp.path(), &settings);
    server.initialize(10);
    server.send(json!({"jsonrpc":"2.0","id":20,"method":"thread/history/refresh","params":{"acknowledgeExternalWriters":true}}));
    let mut progress = server.response(20);
    for id in 21..100 {
        if progress["result"]["status"] != "building" { break; }
        server.send(json!({"jsonrpc":"2.0","id":id,"method":"thread/history/refresh","params":{"cursor":progress["result"]["nextCursor"]}}));
        progress = server.response(id);
    }
    assert_eq!(progress["result"]["status"], "ready", "{progress}");
    server.send_batch([
        json!({"jsonrpc":"2.0","id":101,"method":"thread/read/indexed","params":{"threadId":thread,"limit":25}}),
        json!({"jsonrpc":"2.0","id":102,"method":"thread/read/indexed","params":{"threadId":thread,"limit":25}}),
        json!({"jsonrpc":"2.0","id":103,"method":"server/resources/read","params":{}}),
    ]);
    let response_deadline = Instant::now() + Duration::from_secs(30);
    let active = loop {
        let value = server.next_value(response_deadline);
        if matches!(value["id"].as_i64(), Some(101 | 102 | 103)) { break value; }
    };
    assert_eq!(active["id"], 103, "indexed read finished before disconnect fixture became active");
    assert_eq!(active["result"]["activity"]["pendingServiceRequests"], 2);
    drop(server.stdin.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            assert!(status.success(), "disconnect did not exit cleanly: {status}");
            break;
        }
        if Instant::now() >= deadline {
            server.child.kill().unwrap();
            server.child.wait().unwrap();
            panic!("cold indexed requests kept the disconnected process alive");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let drain_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match server.rx.recv_timeout(drain_deadline.saturating_duration_since(Instant::now())) {
            Ok(line) => {
                let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
                assert!(!matches!(value["id"].as_i64(), Some(101 | 102)), "read completed instead of being abandoned: {value}");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("stdout reader did not close after child exit"),
        }
    }
    let mut restored = TestAppServer::start(temp.path(), &settings);
    restored.initialize(200);
    restored.send(json!({"jsonrpc":"2.0","id":201,"method":"thread/read","params":{"threadId":thread,"limit":25}}));
    let expected = restored.response(201)["result"].clone();
    assert!(expected["rangeEnd"].as_u64().unwrap() >= 8000);
    restored.send(json!({"jsonrpc":"2.0","id":202,"method":"thread/read/indexed","params":{"threadId":thread,"limit":25}}));
    let rebuilt = restored.response(202);
    assert!(rebuilt["result"]["beforeCursor"].as_str().unwrap().starts_with("tp1:"), "{rebuilt}");
    for key in ["messages", "thread", "rangeStart", "rangeEnd", "hasMoreBefore"] {
        assert_eq!(rebuilt["result"][key], expected[key], "{key}");
    }
    restored.shutdown();
}

fn fixture_transcript_index_root(root: &std::path::Path) -> Option<std::path::PathBuf> {
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if !entry.file_type().ok()?.is_dir() { continue; }
        if entry.file_name() == "transcript-pages" { return Some(root.to_owned()); }
        if let Some(found) = fixture_transcript_index_root(&entry.path()) { return Some(found); }
    }
    None
}

fn collect_transcript_pages(server: &mut TestAppServer, thread: &str, method: &str, limit: usize, request_id: &mut i64) -> Vec<Value> {
    let mut cursor = None::<String>;
    let mut pages = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut previous_start = None;
    for _ in 0..50 {
        let mut params = json!({"threadId":thread,"limit":limit});
        if let Some(cursor) = &cursor { params["beforeCursor"] = json!(cursor); }
        server.send(json!({"jsonrpc":"2.0","id":*request_id,"method":method,"params":params}));
        let response = server.response(*request_id);
        *request_id += 1;
        assert!(response.get("error").is_none(), "{response}");
        let page = &response["result"];
        let start = page["rangeStart"].as_u64().unwrap();
        let end = page["rangeEnd"].as_u64().unwrap();
        if let Some(previous) = previous_start { assert_eq!(end, previous); }
        let messages = page["messages"].as_array().unwrap().clone();
        assert!(messages.len() <= limit);
        assert_eq!(end-start, messages.len() as u64);
        pages.push(messages);
        if page["hasMoreBefore"] != true {
            assert_eq!(start, 0);
            assert!(pages.len() > 1, "the many-page fixture must exercise multiple responses");
            return pages.into_iter().rev().flatten().collect();
        }
        assert!(start < end);
        previous_start = Some(start);
        cursor = Some(page["beforeCursor"].as_str().unwrap().to_owned());
        assert!(seen.insert(cursor.clone().unwrap()));
        if method.ends_with("/indexed") { assert!(cursor.as_ref().unwrap().starts_with("tp1:")); }
    }
    panic!("fixture exceeded bounded pagination steps");
}
