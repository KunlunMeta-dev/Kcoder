//! Owned synthetic static notes exercise discovery, mapped publication and CAS recovery.
use super::{TestAppServer, Value, json, rpc};

#[test]
fn memory_rpc_pages_inactive_imports_reconciles_controls_and_undo_uses_original_owner() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let source = root.path().join("claude");
    for path in [&workspace, &profile, &source] {
        std::fs::create_dir(path).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let body = format!(
        "---\ntype: feedback\n---\nUNVERIFIED_BODY_ONLY_ON_EXPLICIT_READ\n{}",
        "owned note. ".repeat(1000)
    );
    for index in 0..11 {
        let memory = source.join(format!("projects/opaque-{index:02}/memory"));
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::write(memory.join("feedback.md"), &body).unwrap();
    }
    std::fs::write(
        source.join("auth.json"),
        "SYNTHETIC_AUTH_MUST_NOT_LEAVE_SOURCE",
    )
    .unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&workspace, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for (key, value) in [
            ("HOME", root.path()),
            ("USERPROFILE", root.path()),
            ("CLAUDE_CONFIG_DIR", source.as_path()),
            ("CODEX_HOME", root.path()),
        ] {
            builder
                .extra_env
                .push((key.into(), value.as_os_str().into()));
        }
        builder.spawn()
    };
    let init = |server: &mut TestAppServer| {
        rpc(
            server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-memory-rpc","version":"test"}}),
        )
    };
    let mut server = start();
    assert_eq!(
        init(&mut server)["capabilities"]["experimental"]["migrationMemoryV1"],
        true
    );
    let old = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    assert!(!old.to_string().contains("memory"));
    let first = rpc(
        &mut server,
        3,
        "migration/memory/discover",
        json!({"source":"claude-code"}),
    );
    assert_eq!(first["items"].as_array().unwrap().len(), 10);
    let second = rpc(
        &mut server,
        4,
        "migration/memory/sources",
        json!({"catalogId":first["catalogId"],"cursor":first["nextCursor"]}),
    );
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["nextCursor"], Value::Null);
    for page in [&first, &second] {
        assert!(!page.to_string().contains("UNVERIFIED_BODY"));
        assert!(!page.to_string().contains("SYNTHETIC_AUTH"));
    }
    let ids = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["items"].as_array().unwrap())
        .map(|v| v["sourceId"].clone())
        .collect::<Vec<_>>();
    let scanned = rpc(
        &mut server,
        5,
        "migration/batch/scan",
        json!({"sourceIds":ids}),
    );
    let job = scanned["job"]["jobId"].clone();
    assert!(
        scanned["batch"]["defaultItemIds"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let mut choices = Vec::new();
    for page_index in 0..2 {
        let page = rpc(
            &mut server,
            6,
            "migration/items",
            json!({"jobId":job,"pageIndex":page_index}),
        );
        for (at, item) in page["items"].as_array().unwrap().iter().enumerate() {
            choices.push(json!({"kind":"asset","itemId":item["id"],"targetName":format!("reviewed-note-{}",page_index*10+at),"enableAfterImport":false,"memoryMapping":"global"}));
        }
    }
    let planned = rpc(
        &mut server,
        7,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],"choices":choices}),
    );
    let plan = planned["batch"]["planId"].clone();
    let published = rpc(
        &mut server,
        8,
        "migration/batch/apply",
        json!({"jobId":job,"expectedSequence":planned["job"]["sequence"],"planId":plan,"requestId":"memory-import"}),
    );
    assert_eq!(published["job"]["committedItems"], 11);
    let list = rpc(&mut server, 9, "migration/memory/list", json!({}));
    let last = rpc(
        &mut server,
        10,
        "migration/memory/list",
        json!({"pageIndex":1}),
    );
    assert_eq!(list["items"].as_array().unwrap().len(), 10);
    assert_eq!(last["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["totalRecords"], 11);
    let record = list["items"][0].clone();
    assert_eq!(record["enabled"], false);
    assert_eq!(record["provenance"]["factsVerified"], false);
    assert_eq!(record["provenance"]["migrationJobId"], job);
    assert!(!list.to_string().contains("memoryWorkspaceIdentity"));
    assert!(!list.to_string().contains("UNVERIFIED_BODY"));
    let text = rpc(
        &mut server,
        11,
        "migration/memory/read",
        json!({"id":record["id"]}),
    );
    assert!(text["text"].as_str().unwrap().len() <= 8192);
    let next = rpc(
        &mut server,
        12,
        "migration/memory/read",
        json!({"id":record["id"],"offset":text["nextOffset"]}),
    );
    assert_eq!(
        format!(
            "{}{}",
            text["text"].as_str().unwrap(),
            next["text"].as_str().unwrap()
        ),
        body
    );
    let request = json!({"requestId":"memory-enable-owned","id":record["id"],"ownerOperationId":record["ownerOperationId"],"expectedRevision":record["revision"],"enabled":true,"confirmUnverifiedNotes":true});
    let enabled = rpc(&mut server, 13, "migration/memory/control", request.clone());
    assert_eq!(enabled["current"]["enabled"], true);
    std::fs::rename(&source, root.path().join("withheld-source")).unwrap();
    drop(server);
    let mut server = start();
    init(&mut server);
    let reconciled = rpc(
        &mut server,
        14,
        "migration/memory/control/read",
        json!({"requestId":"memory-enable-owned"}),
    );
    assert_eq!(reconciled, enabled);
    assert_eq!(
        rpc(&mut server, 15, "migration/memory/control", request.clone()),
        enabled
    );
    let mut wrong = request.clone();
    wrong["requestId"] = json!("wrong-owner");
    wrong["ownerOperationId"] = json!("peer-operation");
    server
        .send(json!({"jsonrpc":"2.0","id":16,"method":"migration/memory/control","params":wrong}));
    assert!(server.response(16).get("error").is_some());
    let mut disable = request;
    disable["requestId"] = json!("memory-disable-owned");
    disable["enabled"] = json!(false);
    disable["confirmUnverifiedNotes"] = json!(false);
    disable["expectedRevision"] = enabled["current"]["revision"].clone();
    let disabled = rpc(&mut server, 17, "migration/memory/control", disable);
    assert_eq!(disabled["current"]["enabled"], false);
    let old_receipt = rpc(
        &mut server,
        18,
        "migration/memory/control/read",
        json!({"requestId":"memory-enable-owned"}),
    );
    assert_eq!(old_receipt["receipt"], enabled["receipt"]);
    assert_eq!(old_receipt["current"]["enabled"], false);
    let current = rpc(&mut server, 19, "migration/read", json!({"jobId":job}));
    let undone = rpc(
        &mut server,
        20,
        "migration/batch/rollback",
        json!({"jobId":job,"expectedSequence":current["job"]["sequence"],"planId":plan,"requestId":"memory-undo-owned"}),
    );
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert_eq!(
        rpc(&mut server, 21, "migration/memory/list", json!({}))["totalRecords"],
        0
    );
    assert_eq!(
        rpc(
            &mut server,
            22,
            "migration/memory/control/read",
            json!({"requestId":"memory-enable-owned"})
        )["current"],
        Value::Null
    );
    assert!(!root.path().join("model-requests").exists());
}
