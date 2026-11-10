//! Actual JSONL uses owned synthetic bytes; storage Ready is not a migration publication.
use super::{TestAppServer, json, rpc};
use base64::Engine;
use sha2::{Digest, Sha256};

#[test]
fn source_upload_rpc_recovers_receipts_cancels_resumes_and_verifies_without_importing() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&profile).unwrap();
    let settings = profile.join("settings.json");
    let overlay = workspace.join("overlay.json");
    std::fs::write(&settings, "{}").unwrap();
    std::fs::write(&overlay, "{}").unwrap();
    let start = || {
        TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr()
            .spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        let result = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27",
            "clientInfo":{"name":"owned-source-upload","version":"test"}}),
        );
        assert_eq!(
            result["capabilities"]["experimental"]["migrationSourceUploadV1"],
            true
        );
    };
    let mut server = start();
    initialize(&mut server);
    let id = uuid::Uuid::new_v4().to_string();
    let data = vec![b'x'; 256 * 1024 + 3];
    let mut files = vec![
        json!({"relativePath":"AGENTS.md","bytes":data.len(),"sha256":format!("{:x}",Sha256::digest(&data))}),
    ];
    for index in 0..10 {
        files.push(json!({"relativePath":format!("skills/example/file-{index}.md"),"bytes":0,"sha256":format!("{:x}",Sha256::digest(b""))}));
    }
    let prepared = rpc(
        &mut server,
        2,
        "migration/source/upload/prepare",
        json!({"operationId":id,
        "manifest":{"version":1,"source":"codex","files":files}}),
    );
    assert_eq!(prepared["upload"]["stage"], "prepared");
    let parts = data
        .chunks(128 * 1024)
        .map(|data| base64::engine::general_purpose::STANDARD.encode(data))
        .collect::<Vec<_>>();
    // The client never consumes this write response. A later read is the recovery authority.
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"migration/source/upload/part",
        "params":{"operationId":id,"cancelWatermark":0,"fileIndex":0,"partIndex":0,"contentBase64":parts[0]}}));
    let mut accepted = false;
    for _ in 0..100 {
        if rpc(
            &mut server,
            4,
            "migration/source/upload/read",
            json!({"operationId":id}),
        )["upload"]["receivedBytes"]
            == 128 * 1024
        {
            accepted = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        accepted,
        "the original part must have a durable accepted offset"
    );
    let command = uuid::Uuid::new_v4().to_string();
    let cancelled = rpc(
        &mut server,
        5,
        "migration/source/upload/cancel",
        json!({"operationId":id,"commandId":command}),
    );
    assert_eq!(cancelled["upload"]["cancelRequested"], true);
    drop(server);

    let mut server = start();
    initialize(&mut server);
    let recovered = rpc(
        &mut server,
        2,
        "migration/source/upload/read",
        json!({"operationId":id}),
    );
    assert_eq!(recovered, cancelled);
    let page = rpc(
        &mut server,
        3,
        "migration/source/upload/files",
        json!({"operationId":id}),
    );
    assert_eq!(page["page"]["files"].as_array().unwrap().len(), 10);
    assert_eq!(page["page"]["files"][0]["acceptedBytes"], 128 * 1024);
    let last = rpc(
        &mut server,
        4,
        "migration/source/upload/files",
        json!({"operationId":id,"cursor":page["page"]["nextCursor"]}),
    );
    assert_eq!(last["page"]["files"].as_array().unwrap().len(), 1);
    assert!(last["page"]["nextCursor"].is_null());
    let resumed = rpc(
        &mut server,
        5,
        "migration/source/upload/resume",
        json!({"operationId":id,
        "expectedSequence":recovered["upload"]["sequence"],"cancelWatermark":recovered["upload"]["cancelWatermark"]}),
    );
    server.send(json!({"jsonrpc":"2.0","id":6,"method":"migration/source/upload/part",
        "params":{"operationId":id,"cancelWatermark":0,"fileIndex":0,"partIndex":1,"contentBase64":parts[1]}}));
    assert!(server.response(6).get("error").is_some());
    for (index, part) in parts.iter().enumerate().skip(1) {
        rpc(
            &mut server,
            7,
            "migration/source/upload/part",
            json!({"operationId":id,
            "cancelWatermark":resumed["upload"]["cancelWatermark"],"fileIndex":0,"partIndex":index,"contentBase64":part}),
        );
    }
    rpc(
        &mut server,
        8,
        "migration/source/upload/finish",
        json!({"operationId":id,
        "expectedSequence":resumed["upload"]["sequence"],"cancelWatermark":resumed["upload"]["cancelWatermark"]}),
    );
    let mut ready = None;
    for _ in 0..100 {
        let state = rpc(
            &mut server,
            9,
            "migration/source/upload/read",
            json!({"operationId":id}),
        );
        if state["upload"]["stage"] == "ready" && state["upload"]["workerState"] == "stopped" {
            ready = Some(state);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let ready = ready.expect("verification must settle before fixture cleanup");
    assert_eq!(ready["upload"]["verifiedBytes"], data.len());
    assert_eq!(ready["upload"]["completedFiles"], 11);
    assert!(
        rpc(&mut server, 10, "migration/jobs/list", json!({}))["jobs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    drop(server);
    let mut server = start();
    initialize(&mut server);
    let late = rpc(
        &mut server,
        2,
        "migration/source/upload/cancel",
        json!({"operationId":id,"commandId":uuid::Uuid::new_v4().to_string()}),
    );
    assert_eq!(late, ready);
    assert_eq!(std::fs::read(&settings).unwrap(), b"{}");
}
