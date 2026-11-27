use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
fn wait_attachment(server: &mut TestAppServer, selection: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let v = rpc(
            server,
            50,
            "migration/history/attachment/read",
            json!({"selection":selection}),
        );
        assert_ne!(v["job"]["stage"], "failed", "{v}");
        if v["job"]["stage"] == "ready" && !v["workerRunning"].as_bool().unwrap() {
            return v;
        }
        assert!(Instant::now() < deadline, "{v}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn historical_attachments_extract_and_download_in_bounded_chunks_without_running_source_tools() {
    let f = Fixture::new();
    let path = f.source(0);
    let session = path.file_stem().unwrap().to_str().unwrap();
    let marker = f.workspace.join("NEVER_EXECUTE_ATTACHMENT_SOURCE");
    let bytes: Vec<u8> = (0..600_001).map(|i| (i % 251) as u8).collect();
    let records = vec![
        json!({"type":"user","uuid":"root","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":STANDARD.encode(&bytes)}}]}}),
        json!({"type":"assistant","uuid":"call","parentUuid":"root","sessionId":session,"version":"2.1.301","message":{"role":"assistant","content":[{"type":"tool_use","id":"c","name":"Bash","input":{"command":format!("touch {}",marker.display())}}]}}),
        json!({"type":"user","uuid":"result","parentUuid":"call","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"c","content":"old result"}]}}),
    ];
    let original = records
        .into_iter()
        .map(|v| v.to_string() + "\n")
        .collect::<String>();
    fs::write(&path, &original).unwrap();
    let mut server = f.start();
    let job = archive(&mut server);
    let selection = json!({"jobId":job,"position":0,"blockIndex":0});
    assert!(
        rpc(
            &mut server,
            51,
            "migration/history/attachment/read",
            json!({"selection":selection})
        )["job"]
            .is_null()
    );
    rpc(
        &mut server,
        52,
        "migration/history/attachment/run",
        json!({"selection":selection}),
    );
    let ready = wait_attachment(&mut server, &selection);
    assert_eq!(ready["job"]["info"]["receipt"]["bytes"], bytes.len());
    let mut downloaded = Vec::new();
    loop {
        let v = rpc(
            &mut server,
            53,
            "migration/history/attachment/chunk",
            json!({"selection":selection,"offset":downloaded.len(),"limit":200_000}),
        );
        let chunk = STANDARD.decode(v["dataBase64"].as_str().unwrap()).unwrap();
        assert!(chunk.len() <= 200_000);
        downloaded.extend(chunk);
        if v["nextOffset"].is_null() {
            break;
        }
        assert_eq!(v["nextOffset"], downloaded.len());
    }
    assert_eq!(downloaded, bytes);
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert!(!marker.exists());
    let branch = rpc(
        &mut server,
        54,
        "migration/history/branch/prepare",
        json!({"jobId":job}),
    );
    let view = branch["progress"]["viewId"].clone();
    rpc(
        &mut server,
        55,
        "migration/history/branch/run",
        json!({"jobId":job,"viewId":view}),
    );
    wait_branch(&mut server, &job, &view);
    let selected = json!({"jobId":job,"viewId":view,"position":0,"blockIndex":0});
    rpc(
        &mut server,
        56,
        "migration/history/attachment/run",
        json!({"selection":selected}),
    );
    assert_eq!(
        wait_attachment(&mut server, &selected)["job"]["info"]["receipt"],
        ready["job"]["info"]["receipt"]
    );
    fs::remove_file(path).unwrap();
    drop(server);
    let mut server = f.start();
    assert_eq!(
        rpc(
            &mut server,
            57,
            "migration/history/attachment/read",
            json!({"selection":selection})
        )["job"],
        ready["job"]
    );
    server.send(json!({"jsonrpc":"2.0","id":58,"method":"migration/history/attachment/chunk","params":{"selection":selection,"offset":0,"path":"/outside"}}));
    assert_eq!(
        server.response(58)["error"]["message"],
        "migration_invalid_parameters"
    );
    assert!(!marker.exists());
    assert_eq!(
        rpc(&mut server, 59, "thread/list", json!({}))["threads"],
        json!([])
    );
}
#[test]
fn attachment_cancellation_is_durable_and_an_old_resume_cannot_clear_a_new_cancel() {
    let f = Fixture::new();
    let path = f.source(0);
    let session = path.file_stem().unwrap().to_str().unwrap();
    fs::write(&path,json!({"type":"user","uuid":"root","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAEC"}}]}}).to_string()+"\n").unwrap();
    let mut server = f.start();
    let job = archive(&mut server);
    let selection = json!({"jobId":job,"position":0,"blockIndex":0});
    rpc(
        &mut server,
        60,
        "migration/history/attachment/cancel",
        json!({"selection":selection}),
    );
    rpc(
        &mut server,
        61,
        "migration/history/attachment/run",
        json!({"selection":selection}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let stopped = loop {
        let v = rpc(
            &mut server,
            62,
            "migration/history/attachment/read",
            json!({"selection":selection}),
        );
        if v["job"]["stage"] == "cancelled" && !v["workerRunning"].as_bool().unwrap() {
            break v;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    };
    drop(server);
    let mut server = f.start();
    server.send(json!({"jsonrpc":"2.0","id":63,"method":"migration/history/attachment/run","params":{"selection":selection}}));
    assert_eq!(
        server.response(63)["error"]["message"],
        "history_attachment_resume_required"
    );
    rpc(
        &mut server,
        64,
        "migration/history/attachment/resume",
        json!({"selection":selection,"expectedSequence":stopped["job"]["sequence"]}),
    );
    wait_attachment(&mut server, &selection);
}
