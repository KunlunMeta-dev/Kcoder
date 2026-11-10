//! Real stdio requests keep collection explicit, scoped and recoverable across hosts.
use super::*;

fn collection_rpc(server: &mut TestAppServer, name: &str, params: Value) -> Value {
    rpc(
        server,
        330,
        &format!("migration/history/upload-collection/{name}"),
        params,
    )
}
fn filled(server: &mut TestAppServer, selection: &Value, data: &[u8]) -> (String, Value) {
    let operation = uuid::Uuid::new_v4().to_string();
    let state = upload_rpc(
        server,
        "prepare",
        json!({"requestId":operation,"selection":selection}),
    );
    let mut state = upload_rpc(
        server,
        "begin",
        json!({"operationId":operation,"expectedSequence":state["upload"]["sequence"],"filename":"owned.txt","bytes":data.len(),"sha256":format!("{:x}",Sha256::digest(data))}),
    );
    for (index, part) in data.chunks(192 * 1024).enumerate() {
        state = upload_rpc(
            server,
            "part",
            json!({"operationId":operation,"expectedSequence":state["upload"]["sequence"],"index":index,"contentBase64":STANDARD.encode(part)}),
        );
    }
    (operation, state)
}
fn finish_collection(server: &mut TestAppServer, operation: &str, selection: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let value = collection_rpc(
            server,
            "read",
            json!({"operationId":operation,"selection":selection}),
        );
        if value["workerRunning"] == false && value["workerScheduled"] == false {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "collection worker did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn run_params(value: &Value, selection: &Value) -> Value {
    json!({"operationId":value["collection"]["operationId"],"selection":selection,"collectionId":value["collection"]["collectionId"],"expectedSequence":value["collection"]["sequence"]})
}

#[test]
fn collection_rpc_prepares_without_delete_cancel_reopens_and_resumes_without_implicit_execution() {
    let (fixture, original_source, mut server, selection) = selected_reference();
    let original = fs::read(&original_source).unwrap();
    let upload_dir = fixture.profile.join("migrations/local-attachment-uploads");
    assert!(!upload_dir.exists());
    let empty = collection_rpc(&mut server, "list", json!({"selection":selection}));
    assert_eq!(empty["items"], json!([]));
    assert!(
        !upload_dir.exists(),
        "read-only collection list created storage"
    );
    let (id, state) = filled(&mut server, &selection, b"explicit staging bytes");
    let data = upload_dir.join(&id).join("parts/part-0000.bin");
    let before = collection_rpc(
        &mut server,
        "read",
        json!({"operationId":id,"selection":selection}),
    );
    assert!(before["collection"].is_null());
    assert!(!upload_dir.join(&id).join("collection.json").exists());
    let prepared = collection_rpc(
        &mut server,
        "prepare",
        json!({"operationId":id,"selection":selection,"expectedUploadSequence":state["upload"]["sequence"]}),
    );
    assert_eq!(prepared["collection"]["stage"], "prepared");
    assert!(data.exists());
    let cancel = collection_rpc(
        &mut server,
        "cancel",
        json!({"operationId":id,"selection":selection,"collectionId":prepared["collection"]["collectionId"]}),
    );
    assert_eq!(cancel["collection"]["cancelRequested"], true);
    assert_eq!(cancel["collection"]["storageRetired"], false);
    assert!(data.exists());
    server.shutdown();
    let mut server = fixture.start();
    let recovered = collection_rpc(
        &mut server,
        "read",
        json!({"operationId":id,"selection":selection}),
    );
    assert_eq!(
        recovered["collection"]["collectionId"],
        prepared["collection"]["collectionId"]
    );
    let mut params = run_params(&recovered, &selection);
    params["expectedUploadSequence"] = state["upload"]["sequence"].clone();
    let resumed = collection_rpc(&mut server, "resume", params);
    assert_eq!(resumed["collection"]["stage"], "prepared");
    assert_eq!(resumed["workerScheduled"], false);
    assert!(data.exists(), "resume implicitly deleted staging");
    server.send(json!({"jsonrpc":"2.0","method":"migration/history/upload-collection/run","params":run_params(&resumed,&selection)}));
    collection_rpc(
        &mut server,
        "read",
        json!({"operationId":id,"selection":selection}),
    );
    assert!(data.exists(), "notification executed a deletion mutation");
    let accepted = collection_rpc(&mut server, "run", run_params(&resumed, &selection));
    assert_eq!(accepted["workerScheduled"], true);
    let done = finish_collection(&mut server, &id, &selection);
    assert_eq!(done["collection"]["stage"], "collected", "{done}");
    assert_eq!(done["collection"]["deletedBytes"], 22);
    assert!(!data.exists());
    assert!(
        upload_dir
            .join(&id)
            .join("parts/part-0000.receipt.json")
            .exists()
    );
    assert!(upload_dir.join(&id).join("grant.json").exists());
    assert_eq!(fs::read(original_source).unwrap(), original);
    server.shutdown();
}

#[test]
fn collection_rpc_cannot_delete_an_active_local_dependency_and_keeps_the_final_attachment_readable()
{
    let (fixture, source, mut server, selection) = selected_reference();
    let original = fs::read(&source).unwrap();
    let bytes = b"final native attachment survives staging collection";
    let (id, state) = filled(&mut server, &selection, bytes);
    upload_rpc(
        &mut server,
        "finish",
        json!({"operationId":id,"expectedSequence":state["upload"]["sequence"]}),
    );
    let authorized = settle(&mut server, &id);
    upload_rpc(
        &mut server,
        "run",
        json!({"operationId":id,"expectedSequence":authorized["upload"]["localJob"]["state"]["sequence"]}),
    );
    let ready = settle(&mut server, &id);
    assert_eq!(ready["upload"]["localJob"]["state"]["stage"], "ready");
    let receipt = ready["upload"]["localJob"]["state"]["receipt"].clone();
    let prepared = collection_rpc(
        &mut server,
        "prepare",
        json!({"operationId":id,"selection":selection,"expectedUploadSequence":ready["upload"]["sequence"]}),
    );
    let jobs = kcoder_migration::history_jobs::HistoryJobStore::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let archive = jobs
        .archive_reader(selection["jobId"].as_str().unwrap())
        .unwrap();
    let writer = archive.local_attachment_import(&id, true).unwrap().unwrap();
    collection_rpc(&mut server, "run", run_params(&prepared, &selection));
    let blocked = finish_collection(&mut server, &id, &selection);
    assert_eq!(blocked["collection"]["stage"], "blocked", "{blocked}");
    assert_eq!(blocked["collection"]["storageRetired"], false);
    assert!(
        fixture
            .profile
            .join("migrations/local-attachment-uploads")
            .join(&id)
            .join("payload.bin")
            .exists()
    );
    drop(writer);
    let mut params = run_params(&blocked, &selection);
    params["expectedUploadSequence"] = ready["upload"]["sequence"].clone();
    let resumed = collection_rpc(&mut server, "resume", params);
    collection_rpc(&mut server, "run", run_params(&resumed, &selection));
    let done = finish_collection(&mut server, &id, &selection);
    assert_eq!(done["collection"]["stage"], "collected", "{done}");
    let retained = collection_rpc(
        &mut server,
        "attachment",
        json!({"operationId":id,"selection":selection}),
    );
    assert_eq!(retained["job"]["state"]["receipt"], receipt);
    assert_eq!(retained["job"]["selection"], selection);
    assert_eq!(retained["job"]["historicalContentVerified"], false);
    let chunk = upload_rpc(
        &mut server,
        "chunk",
        json!({"operationId":id,"selection":selection,"expectedReceipt":receipt,"offset":0,"limit":65536}),
    );
    assert_eq!(
        STANDARD
            .decode(chunk["dataBase64"].as_str().unwrap())
            .unwrap(),
        bytes
    );
    assert_eq!(fs::read(source).unwrap(), original);
    assert!(!fixture.workspace.join("NEVER_REPLAY_CONTINUATION").exists());
    server.shutdown();
}

#[test]
fn collection_rpc_pages_ten_and_rejects_other_selections_paths_and_stale_controls() {
    let (fixture, _source, mut server, selection) = selected_reference();
    let mut first = None;
    for _ in 0..12 {
        let (id, state) = filled(&mut server, &selection, b"original");
        let prepared = collection_rpc(
            &mut server,
            "prepare",
            json!({"operationId":id,"selection":selection,"expectedUploadSequence":state["upload"]["sequence"]}),
        );
        first.get_or_insert(prepared);
    }
    let first = first.unwrap();
    let page = collection_rpc(&mut server, "list", json!({"selection":selection}));
    assert_eq!(page["items"].as_array().unwrap().len(), 10);
    let page2 = collection_rpc(
        &mut server,
        "list",
        json!({"selection":selection,"cursor":page["nextCursor"]}),
    );
    assert_eq!(page2["items"].as_array().unwrap().len(), 2);
    let mut wrong = selection.clone();
    wrong["position"] = json!(99);
    server.send(json!({"jsonrpc":"2.0","id":331,"method":"migration/history/upload-collection/read","params":{"operationId":first["collection"]["operationId"],"selection":wrong}}));
    assert_eq!(
        server.response(331)["error"]["message"],
        "local_upload_collection_selection_changed"
    );
    let mut paths = run_params(&first, &selection);
    paths["path"] = json!("/NEVER_AUTHORIZED");
    server.send(json!({"jsonrpc":"2.0","id":332,"method":"migration/history/upload-collection/run","params":paths}));
    assert_eq!(
        server.response(332)["error"]["message"],
        "migration_invalid_parameters"
    );
    let mut stale = run_params(&first, &selection);
    stale["expectedSequence"] = json!(0);
    server.send(json!({"jsonrpc":"2.0","id":333,"method":"migration/history/upload-collection/run","params":stale}));
    assert_eq!(
        server.response(333)["error"]["message"],
        "local_upload_collection_stale_sequence"
    );
    assert_eq!(
        collection_rpc(&mut server, "list", json!({"selection":selection}))["items"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert!(
        fixture
            .profile
            .join("migrations/local-attachment-uploads")
            .exists()
    );
    server.shutdown();
}

#[test]
fn a_native_peer_collection_lock_is_reported_as_running_without_claiming_connection_scheduling() {
    let (fixture, _source, mut server, selection) = selected_reference();
    let (id, state) = filled(&mut server, &selection, b"peer-owned collection input");
    let prepared = collection_rpc(
        &mut server,
        "prepare",
        json!({"operationId":id,"selection":selection,"expectedUploadSequence":state["upload"]["sequence"]}),
    );
    let directory = kcoder_config::PrivateDirectory::open_existing(
        &fixture
            .profile
            .join("migrations/local-attachment-uploads")
            .join(&id),
    )
    .unwrap();
    let identity = directory
        .portable_regular_identity(std::ffi::OsStr::new("collection-writer.lock"))
        .unwrap();
    let read_probe = directory
        .try_existing_portable_lock(
            std::ffi::OsStr::new("collection-writer.lock"),
            &identity,
            kcoder_config::PrivateLeaseMode::Shared,
        )
        .unwrap()
        .unwrap();
    let idle = collection_rpc(
        &mut server,
        "read",
        json!({"operationId":id,"selection":selection}),
    );
    assert_eq!(
        idle["workerRunning"], false,
        "a pure shared observation is not a collector"
    );
    drop(read_probe);
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(0);
    let (resume_tx, resume_rx) = std::sync::mpsc::sync_channel(0);
    let profile = fixture.profile.clone();
    let worker_id = id.clone();
    let collection_id = prepared["collection"]["collectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let sequence = prepared["collection"]["sequence"].as_u64().unwrap();
    let worker = std::thread::spawn(move || {
        let store = kcoder_migration::local_attachment::upload::HistoryLocalAttachmentUploads::open_existing(&profile).unwrap().unwrap();
        let mut entered = false;
        store
            .run_collection(&worker_id, &collection_id, sequence, |_| {
                if !entered {
                    entered = true;
                    entered_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                }
                true
            })
            .unwrap()
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let observed = collection_rpc(
        &mut server,
        "read",
        json!({"operationId":id,"selection":selection}),
    );
    assert_eq!(observed["workerRunning"], true);
    assert_eq!(observed["workerScheduled"], false);
    collection_rpc(
        &mut server,
        "cancel",
        json!({"operationId":id,"selection":selection,"collectionId":prepared["collection"]["collectionId"]}),
    );
    resume_tx.send(()).unwrap();
    worker.join().unwrap();
    let stopped = collection_rpc(
        &mut server,
        "read",
        json!({"operationId":id,"selection":selection}),
    );
    assert_eq!(stopped["collection"]["stage"], "cancelled");
    assert_eq!(stopped["collection"]["storageRetired"], false);
    assert_eq!(stopped["workerRunning"], false);
    server.shutdown();
}

#[test]
fn an_unconsumed_run_reply_reopens_the_same_completed_receipt_without_repeating_deletion() {
    let (fixture, _source, mut server, selection) = selected_reference();
    let (id, state) = filled(&mut server, &selection, b"original deletion operation");
    let prepared = collection_rpc(
        &mut server,
        "prepare",
        json!({"operationId":id,"selection":selection,"expectedUploadSequence":state["upload"]["sequence"]}),
    );
    server.send(json!({"jsonrpc":"2.0","id":334,"method":"migration/history/upload-collection/run","params":run_params(&prepared,&selection)}));
    let directory = fixture
        .profile
        .join("migrations/local-attachment-uploads")
        .join(&id);
    let receipt = directory.join("collection-complete.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !receipt.exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    // The original run response is deliberately never consumed before this transport closes.
    server.shutdown();
    let original = fs::read(&receipt).unwrap();
    let mut server = fixture.start();
    let recovered = collection_rpc(
        &mut server,
        "read",
        json!({"operationId":id,"selection":selection}),
    );
    assert_eq!(
        recovered["collection"]["collectionId"],
        prepared["collection"]["collectionId"]
    );
    assert_eq!(recovered["collection"]["stage"], "collected");
    assert_eq!(recovered["workerRunning"], false);
    assert_eq!(recovered["workerScheduled"], false);
    assert_eq!(fs::read(receipt).unwrap(), original);
    assert!(!directory.join("parts/part-0000.bin").exists());
    server.shutdown();
}
