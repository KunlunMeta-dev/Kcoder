//! Real app-server upload frames use explicit bytes, never a client-supplied server path.
#[path = "upload_collection_rpc.rs"]
mod collection;
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

fn upload_rpc(server: &mut TestAppServer, name: &str, params: Value) -> Value {
    rpc(
        server,
        301,
        &format!("migration/history/local-attachment/{name}"),
        params,
    )
}
fn settle(server: &mut TestAppServer, operation: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state = upload_rpc(server, "read", json!({"operationId":operation}));
        if state["workerRunning"] == false {
            return state;
        }
        assert!(
            Instant::now() < deadline,
            "local upload worker did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn selected_reference() -> (Fixture, PathBuf, TestAppServer, Value) {
    let (fixture, source) = super::branches::continuation::setup();
    let session = source.file_stem().unwrap().to_str().unwrap();
    let mut text = fs::read_to_string(&source).unwrap();
    text.push_str(&format!("{}\n", json!({"type":"user","uuid":"local-document","parentUuid":"old-result","sessionId":session,"version":"2.1.301","message":{"role":"user","content":[{"type":"document","path":"/NEVER_AUTHORIZED/secret.txt","title":"untrusted.pdf","media_type":"application/pdf"}]}})));
    fs::write(&source, text).unwrap();
    let mut server = fixture.start();
    let (job, view) = super::branches::continuation::selected(&mut server);
    let selection = json!({"jobId":job,"viewId":view,"position":2,"blockIndex":0});
    (fixture, source, server, selection)
}

#[test]
fn browser_bytes_upload_survives_restart_and_downloads_the_exact_owned_payload() {
    let (fixture, source, mut server, selection) = selected_reference();
    let original = fs::read(&source).unwrap();
    assert!(
        upload_rpc(&mut server, "list", json!({"selection":selection}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let operation = uuid::Uuid::new_v4().to_string();
    let prepared = upload_rpc(
        &mut server,
        "prepare",
        json!({"requestId":operation,"selection":selection}),
    );
    assert_eq!(prepared["upload"]["stage"], "prepared");
    assert!(prepared["upload"]["localJob"].is_null());
    let bytes = "explicit uploaded document 中文😀\n"
        .repeat(10000)
        .into_bytes();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let mut current = upload_rpc(
        &mut server,
        "begin",
        json!({"operationId":operation,
        "expectedSequence":prepared["upload"]["sequence"],"filename":"selected.txt","bytes":bytes.len(),"sha256":digest}),
    );
    for (index, part) in bytes.chunks(192 * 1024).enumerate() {
        current = upload_rpc(
            &mut server,
            "part",
            json!({"operationId":operation,
            "expectedSequence":current["upload"]["sequence"],"index":index,"contentBase64":STANDARD.encode(part)}),
        );
        assert_eq!(
            current["upload"]["receivedBytes"],
            ((index + 1) * 192 * 1024).min(bytes.len())
        );
    }
    server.shutdown();
    fs::remove_file(&source).unwrap();
    let mut server = fixture.start();
    let restored = upload_rpc(&mut server, "read", json!({"operationId":operation}));
    assert_eq!(restored["upload"]["receivedBytes"], bytes.len());
    assert_eq!(restored["upload"]["sha256"], digest);
    upload_rpc(
        &mut server,
        "finish",
        json!({"operationId":operation,"expectedSequence":restored["upload"]["sequence"]}),
    );
    let authorized = settle(&mut server, &operation);
    assert_eq!(authorized["upload"]["stage"], "authorized", "{authorized}");
    assert_eq!(
        authorized["upload"]["localJob"]["historicalContentVerified"],
        false
    );
    let cancelled = upload_rpc(&mut server, "cancel", json!({"operationId":operation}));
    let resumed = upload_rpc(
        &mut server,
        "resume",
        json!({"operationId":operation,
        "expectedSequence":cancelled["upload"]["sequence"]}),
    );
    assert_eq!(resumed["upload"]["cancelRequested"], false);
    assert_eq!(
        resumed["upload"]["localJob"]["state"]["cancelRequested"],
        true
    );
    upload_rpc(
        &mut server,
        "run",
        json!({"operationId":operation,
        "expectedSequence":resumed["upload"]["localJob"]["state"]["sequence"]}),
    );
    let saved = settle(&mut server, &operation);
    assert_eq!(
        saved["upload"]["localJob"]["state"]["stage"], "ready",
        "{saved}"
    );
    let receipt = saved["upload"]["localJob"]["state"]["receipt"].clone();
    assert_eq!(receipt["sha256"], digest);
    let mut offset = 0u64;
    let mut downloaded = Vec::new();
    loop {
        let chunk = upload_rpc(
            &mut server,
            "chunk",
            json!({"operationId":operation,
            "selection":selection,"expectedReceipt":receipt,"offset":offset,"limit":262144}),
        );
        let part = STANDARD
            .decode(chunk["dataBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(chunk["dataSha256"], format!("{:x}", Sha256::digest(&part)));
        downloaded.extend(part);
        let Some(next) = chunk["nextOffset"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(downloaded, bytes);
    let records = upload_rpc(&mut server, "list", json!({"selection":selection}));
    assert_eq!(records["items"].as_array().unwrap().len(), 1);
    assert_eq!(records["items"][0]["operationId"], operation);
    assert_eq!(
        upload_rpc(&mut server, "cancel", json!({"operationId":operation}))["upload"]["localJob"]["state"]
            ["stage"],
        "ready"
    );
    assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
    let archived = kcoder_migration::history_jobs::HistoryJobStore::open_existing(&fixture.profile)
        .unwrap()
        .unwrap()
        .archive_reader(selection["jobId"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        archived.receipt().unwrap().unwrap().source_sha256,
        format!("{:x}", Sha256::digest(original))
    );
    server.shutdown();
}

#[test]
fn upload_rpc_rejects_server_path_authority_oversized_parts_and_stale_sequences() {
    let (fixture, source, mut server, selection) = selected_reference();
    let operation = uuid::Uuid::new_v4().to_string();
    let prepared = upload_rpc(
        &mut server,
        "prepare",
        json!({"requestId":operation,"selection":selection}),
    );
    server.send(json!({"jsonrpc":"2.0","id":302,"method":"migration/history/local-attachment/begin","params":{
        "operationId":operation,"expectedSequence":prepared["upload"]["sequence"],"filename":"safe.txt","bytes":3,"sha256":"a".repeat(64),"sourcePath":source}}));
    assert_eq!(
        server.response(302)["error"]["message"],
        "migration_invalid_parameters"
    );
    server.send(json!({"jsonrpc":"2.0","id":303,"method":"migration/history/local-attachment/part","params":{
        "operationId":operation,"expectedSequence":0,"index":0,"contentBase64":"A".repeat(262148)}}));
    assert_eq!(
        server.response(303)["error"]["message"],
        "local_attachment_upload_part_budget_exceeded"
    );
    let before = upload_rpc(&mut server, "cancel", json!({"operationId":operation}));
    server.send(json!({"jsonrpc":"2.0","id":304,"method":"migration/history/local-attachment/begin","params":{
        "operationId":operation,"expectedSequence":prepared["upload"]["sequence"],"filename":"safe.txt","bytes":3,"sha256":"a".repeat(64)}}));
    assert!(server.response(304)["error"].is_object());
    let after = upload_rpc(&mut server, "read", json!({"operationId":operation}));
    assert_eq!(
        before["upload"]["cancelRevision"],
        after["upload"]["cancelRevision"]
    );
    assert_eq!(after["upload"]["receivedBytes"], 0);
    assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
    server.shutdown();
}
