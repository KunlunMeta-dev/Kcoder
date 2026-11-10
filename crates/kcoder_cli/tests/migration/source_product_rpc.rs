//! An isolated profile exercises the real product worker and explicit source selection.
use super::{TestAppServer, Value, json, rpc};
use kcoder_migration::source_upload::SourceUploads;
use kcoder_types::{
    migration::MigrationSourceKind,
    migration_source_upload::{SourceUploadFile, SourceUploadManifest},
};
use sha2::{Digest, Sha256};

#[test]
fn uploaded_product_selection_never_falls_back_and_can_publish_reopen_and_undo() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let workspace = root.path().join("workspace");
    let ambient = root.path().join("ambient-claude");
    for directory in [&profile, &workspace, &ambient] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    std::fs::write(
        ambient.join("settings.json"),
        json!({"env":{"ANTHROPIC_MODEL":"AmbientMustNotBeRead"}}).to_string(),
    )
    .unwrap();
    let history_id = uuid::Uuid::new_v4().to_string();
    let history = format!(
        "{}\n",
        json!({"type":"user","uuid":"message-1","sessionId":history_id,"message":{"role":"user","content":"Uploaded historical request"}})
    );
    let files = [
        ("settings.json".to_string(), json!({"env":{"ANTHROPIC_BASE_URL":"https://example.invalid/v1","ANTHROPIC_MODEL":"UploadedOnlyModel"}}).to_string()),
        ("CLAUDE.md".into(), "User supplied static office instructions.\n".into()),
        (format!("projects/opaque/{history_id}.jsonl"), history),
    ];
    let store = SourceUploads::open(&profile).unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let digest = store
        .prepare(
            &operation,
            SourceUploadManifest {
                version: 1,
                source: MigrationSourceKind::ClaudeCode,
                files: files
                    .iter()
                    .map(|(path, body)| SourceUploadFile {
                        relative_path: path.clone(),
                        bytes: body.len() as u64,
                        sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
                    })
                    .collect(),
            },
        )
        .unwrap()
        .manifest_sha256;
    for (index, (_, body)) in files.iter().enumerate() {
        store
            .part(&operation, 0, index, 0, body.as_bytes())
            .unwrap();
    }
    store.finish(&operation, 0, |_, _| true).unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for (key, path) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", ambient.as_path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((key.into(), path.as_os_str().into()));
        }
        builder.spawn()
    };
    let initialize = |server: &mut TestAppServer| {
        let result = rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-uploaded-product","version":"test"}}),
        );
        assert_eq!(
            result["capabilities"]["experimental"]["migrationSourceUploadedV1"],
            true
        );
    };
    let locator = json!({"operationId":operation,"manifestSha256":digest});
    let mut server = start();
    initialize(&mut server);
    server.send(
        json!({"jsonrpc":"2.0","id":2,"method":"migration/source/upload/select","params":locator}),
    );
    assert!(server.response(2).get("error").is_some());
    server.send(json!({"jsonrpc":"2.0","id":3,"method":"migration/discover","params":{"sources":["claude-code"]}}));
    assert_eq!(
        server.response(3)["error"]["message"],
        "source_upload_product_selection_unavailable"
    );
    rpc(
        &mut server,
        4,
        "migration/source/upload/product/run",
        json!({"operationId":operation,"manifestSha256":digest,"expectedSequence":0,"cancelWatermark":0}),
    );
    let mut finished = false;
    for _ in 0..200 {
        let response = rpc(
            &mut server,
            5,
            "migration/source/upload/product/read",
            locator.clone(),
        );
        if response["materialization"]["stage"] == "ready"
            && response["materialization"]["workerState"] == "stopped"
        {
            finished = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        finished,
        "the owned preparation worker must settle before using or removing its data"
    );
    let selected = rpc(
        &mut server,
        6,
        "migration/source/upload/select",
        locator.clone(),
    );
    assert_eq!(selected["origin"], "user_supplied");
    assert_eq!(selected["source"], "claude-code");
    let found = rpc(
        &mut server,
        7,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    let rows = found["sources"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let config = rows.iter().find(|row| row["scope"] == "user").unwrap();
    let asset = rows
        .iter()
        .find(|row| row["sourceId"] != config["sourceId"])
        .unwrap();
    let scan = rpc(
        &mut server,
        8,
        "migration/scan",
        json!({"sourceId":config["sourceId"]}),
    );
    let native = kcoder_migration::store::MigrationStore::open_existing(&profile).unwrap();
    let saved = native.read(scan["job"]["jobId"].as_str().unwrap()).unwrap();
    assert_eq!(
        saved
            .inventory
            .items
            .iter()
            .find_map(|item| item.provider.as_ref())
            .unwrap()
            .model
            .as_deref(),
        Some("UploadedOnlyModel")
    );
    let batch = rpc(
        &mut server,
        9,
        "migration/batch/scan",
        json!({"sourceIds":[asset["sourceId"]]}),
    );
    let job = batch["job"]["jobId"].clone();
    let page = rpc(
        &mut server,
        10,
        "migration/items",
        json!({"jobId":job,"pageIndex":0}),
    );
    let item = page["items"][0]["id"].clone();
    assert_ne!(item, Value::Null);
    let planned = rpc(
        &mut server,
        11,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":batch["job"]["sequence"],
        "choices":[{"kind":"asset","itemId":item,"targetName":"uploaded-office-notes","enableAfterImport":false}]}),
    );
    let committed = rpc(
        &mut server,
        12,
        "migration/batch/apply",
        json!({"jobId":job,"expectedSequence":planned["job"]["sequence"],"planId":planned["batch"]["planId"],"requestId":"uploaded-office-apply"}),
    );
    assert_eq!(committed["job"]["committedItems"], 1);
    let history = rpc(
        &mut server,
        13,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    drop(server);
    let mut server = start();
    initialize(&mut server);
    let reopened = rpc(&mut server, 2, "migration/batch/read", json!({"jobId":job}));
    assert_eq!(reopened["workerRunning"], false);
    assert_eq!(reopened["state"]["job"]["committedItems"], 1);
    let rolled = rpc(
        &mut server,
        3,
        "migration/batch/rollback",
        json!({"jobId":job,"expectedSequence":reopened["state"]["job"]["sequence"],"planId":planned["batch"]["planId"],"requestId":"uploaded-office-undo"}),
    );
    assert_eq!(rolled["job"]["status"], "rolled_back");
    assert_eq!(std::fs::read(profile.join("settings.json")).unwrap(), b"{}");
}
