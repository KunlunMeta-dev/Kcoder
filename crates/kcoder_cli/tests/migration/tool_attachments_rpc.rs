use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
fn wait_tool(server: &mut TestAppServer, selection: &Value, stage: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let v = rpc(
            server,
            70,
            "migration/history/tool-attachments/read",
            json!({"selection":selection}),
        );
        assert_ne!(v["job"]["stage"], "failed", "{v}");
        if v["job"]["stage"] == stage && v["workerRunning"] == false {
            return v;
        }
        assert!(Instant::now() < deadline, "{v}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn tool_source(f: &Fixture) -> std::path::PathBuf {
    let path = f.source(0);
    let session = path.file_stem().unwrap().to_str().unwrap();
    let marker = f.workspace.join("NEVER_EXECUTE_TOOL_ATTACHMENT");
    let mut content = vec![json!({"type":"text","text":"historical output"})];
    for i in 0..12 {
        content.push(json!({"type":"document","title":format!("附件-{i}.txt"),"source":{"type":"text","media_type":"text/plain","data":format!("from-tool-{i}")}}));
    }
    let records = [
        json!({"type":"assistant","uuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"Bash","input":{"command":format!("touch {}",marker.display())}}]}}),
        json!({"type":"user","uuid":"result","parentUuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"old","content":content}]}}),
    ];
    fs::write(
        &path,
        records
            .into_iter()
            .map(|v| v.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    path
}
#[test]
fn tool_collection_rpc_pages_extracts_selected_children_and_reopens_without_source_execution() {
    let f = Fixture::new();
    let path = tool_source(&f);
    let original = fs::read(&path).unwrap();
    let mut server = f.start();
    let job = archive(&mut server);
    let selection = json!({"jobId":job,"position":1,"blockIndex":0});
    rpc(
        &mut server,
        71,
        "migration/history/tool-attachments/run",
        json!({"selection":selection}),
    );
    let ready = wait_tool(&mut server, &selection, "catalogued");
    assert_eq!(ready["job"]["catalog"]["attachments"], 12);
    assert!(ready["job"]["info"].is_null());
    let first = rpc(
        &mut server,
        72,
        "migration/history/tool-attachments/items",
        json!({"selection":selection}),
    );
    assert_eq!(first["items"].as_array().unwrap().len(), 10);
    assert_eq!(first["items"][0]["sourceArrayIndex"], 1);
    assert_eq!(first["nextCursor"], 10);
    assert!(!first.to_string().contains("from-tool"));
    // A ten-card page plus its next-page request must queue instead of losing observations.
    let observation = |id: i64| {
        if id == 112 {
            json!({"jsonrpc":"2.0","id":id,"method":"migration/history/tool-attachments/items","params":{"selection":selection,"cursor":10}})
        } else {
            json!({"jsonrpc":"2.0","id":id,"method":"migration/history/tool-attachments/read","params":{"selection":{"jobId":job,"position":1,"blockIndex":0,"toolItemIndex":id - 100}}})
        }
    };
    for id in 100..=112 {
        server.send(observation(id));
    }
    server.send(json!({"jsonrpc":"2.0","id":113,"method":"migration/history/tool-attachments/cancel","params":{"selection":selection}}));
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut burst = std::collections::BTreeMap::new();
    while burst.len() < 14 {
        let frame = server.next_value(deadline);
        if let Some(id) = frame["id"].as_i64()
            && (100..=113).contains(&id)
        {
            // Clients retry read-only observations on SQLite contention; the
            // cancel mutation is never replayed.
            if id != 113 && frame["error"]["message"] == "history_catalog_busy" {
                std::thread::sleep(Duration::from_millis(50));
                server.send(observation(id));
                continue;
            }
            assert!(frame.get("error").is_none(), "{frame}");
            burst.insert(id, frame["result"].clone());
        }
    }
    assert_eq!(burst[&112]["items"].as_array().unwrap().len(), 2);
    assert_eq!(burst[&113]["job"]["stage"], "catalogued");

    server.send(json!({"jsonrpc":"2.0","id":69,"method":"migration/history/tool-attachments/read","params":{"selection":{"jobId":job,"position":0,"blockIndex":0}}}));
    assert_eq!(
        server.response(69)["error"]["message"],
        "history_tool_attachments_not_a_result"
    );
    assert_eq!(
        rpc(
            &mut server,
            73,
            "migration/history/tool-attachments/items",
            json!({"selection":selection,"cursor":10})
        )["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let child = json!({"jobId":job,"position":1,"blockIndex":0,"toolItemIndex":7});
    rpc(
        &mut server,
        74,
        "migration/history/tool-attachments/run",
        json!({"selection":child}),
    );
    let saved = wait_tool(&mut server, &child, "ready");
    assert_eq!(saved["job"]["info"]["displayName"], "附件-7.txt");
    assert_ne!(saved["job"]["id"], ready["job"]["id"]);
    let chunk = rpc(
        &mut server,
        75,
        "migration/history/tool-attachments/chunk",
        json!({"selection":child,"offset":0,"limit":100}),
    );
    assert_eq!(
        STANDARD
            .decode(chunk["dataBase64"].as_str().unwrap())
            .unwrap(),
        b"from-tool-7"
    );
    let branch = rpc(
        &mut server,
        76,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let view = branch["progress"]["viewId"].clone();
    rpc(
        &mut server,
        77,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    wait_branch(&mut server, &job, &view);
    let scoped = json!({"jobId":job,"viewId":view,"position":1,"blockIndex":0});
    rpc(
        &mut server,
        78,
        "migration/history/tool-attachments/run",
        json!({"selection":scoped}),
    );
    wait_tool(&mut server, &scoped, "catalogued");
    let selected = json!({"jobId":job,"viewId":view,"position":1,"blockIndex":0,"toolItemIndex":7});
    rpc(
        &mut server,
        79,
        "migration/history/tool-attachments/run",
        json!({"selection":selected}),
    );
    assert_eq!(
        wait_tool(&mut server, &selected, "ready")["job"]["info"]["receipt"],
        saved["job"]["info"]["receipt"]
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
    drop(server);
    let mut server = f.start();
    assert_eq!(
        rpc(
            &mut server,
            80,
            "migration/history/tool-attachments/read",
            json!({"selection":selection})
        )["job"],
        ready["job"]
    );
    assert_eq!(
        rpc(
            &mut server,
            81,
            "migration/history/tool-attachments/read",
            json!({"selection":child})
        )["job"],
        saved["job"]
    );
    server.send(json!({"jsonrpc":"2.0","id":82,"method":"migration/history/tool-attachments/items","params":{"selection":selection,"offset":3}}));
    assert_eq!(
        server.response(82)["error"]["message"],
        "migration_invalid_parameters"
    );
    assert!(!f.workspace.join("NEVER_EXECUTE_TOOL_ATTACHMENT").exists());
    assert_eq!(
        rpc(&mut server, 83, "thread/list", json!({}))["threads"],
        json!([])
    );
}
#[test]
fn tool_collection_rpc_cancellation_restarts_only_with_the_stopped_sequence() {
    let f = Fixture::new();
    tool_source(&f);
    let mut server = f.start();
    let job = archive(&mut server);
    let selection = json!({"jobId":job,"position":1,"blockIndex":0});
    rpc(
        &mut server,
        84,
        "migration/history/tool-attachments/cancel",
        json!({"selection":selection}),
    );
    rpc(
        &mut server,
        85,
        "migration/history/tool-attachments/run",
        json!({"selection":selection}),
    );
    let stopped = wait_tool(&mut server, &selection, "cancelled");
    server.send(json!({"jsonrpc":"2.0","id":86,"method":"migration/history/tool-attachments/run","params":{"selection":selection}}));
    assert_eq!(
        server.response(86)["error"]["message"],
        "history_attachment_resume_required"
    );
    rpc(
        &mut server,
        87,
        "migration/history/tool-attachments/resume",
        json!({"selection":selection,"expectedSequence":stopped["job"]["sequence"]}),
    );
    wait_tool(&mut server, &selection, "catalogued");
}
