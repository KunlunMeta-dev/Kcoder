//! Actual stdio requests keep passive source data separate from runtime stores and source lifetime.
use super::{TestAppServer, json, rpc};
use base64::{Engine as _, engine::general_purpose::STANDARD};
#[test]
fn definitions_rpc_static_report_and_owned_pending_publication_survive_reopen_without_source() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let profile = root.path().join("profile");
    let source = root.path().join("claude");
    for path in [&workspace, &profile, &source.join("agents")] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let overlay = workspace.join("overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let body = format!(
        "---\nname: fixture\ndescription: fixture\nmodel: fixture-only\ntools: Bash\npermissionMode: bypassPermissions\nskills: [never-load]\nmcpServers: [never-connect]\nhooks: {{}}\nmemory: project\nbackground: true\nSYNTHETIC_UNKNOWN_NAME: secret-value\n---\n正文仅明确预览。{}",
        "文字".repeat(12000)
    );
    std::fs::write(source.join("agents/review.md"), &body).unwrap();
    std::fs::write(source.join("agents/opaque.md"), [0xff, 0x00, 0xfe]).unwrap();
    std::fs::write(source.join("settings.json"),r#"{"env":{"ANTHROPIC_API_KEY":"SYNTHETIC_NONHOOK_SECRET"},"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"never-run"}]}]}}"#).unwrap();
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
        let mut server = builder.spawn();
        let init = rpc(
            &mut server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-definition-rpc","version":"test"}}),
        );
        assert_eq!(
            init["capabilities"]["experimental"]["migrationDefinitionsV1"],
            true
        );
        server
    };
    let mut server = start();
    let skills = || {
        let mut names = std::fs::read_dir(profile.join("skills"))
            .map(|rows| rows.map(|row| row.unwrap().file_name()).collect::<Vec<_>>())
            .unwrap_or_default();
        names.sort();
        names
    };
    let original_skills = skills();
    let old = rpc(
        &mut server,
        2,
        "migration/discover",
        json!({"sources":["claude-code"]}),
    );
    assert!(
        old["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["scope"] != "user-agents")
    );
    let definitions = rpc(
        &mut server,
        3,
        "migration/definitions/discover",
        json!({"sources":["claude-code"]}),
    );
    assert!(definitions["sources"].as_array().unwrap().len() <= 10);
    assert!(!definitions.to_string().contains("SYNTHETIC_NONHOOK_SECRET"));
    let ids = definitions["sources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["sourceId"].clone())
        .collect::<Vec<_>>();
    let scanned = rpc(
        &mut server,
        4,
        "migration/batch/scan",
        json!({"sourceIds":ids}),
    );
    let job = scanned["job"]["jobId"].clone();
    assert_eq!(scanned["batch"]["defaultItemIds"], json!([]));
    let items = rpc(&mut server, 5, "migration/items", json!({"jobId":job}));
    let items = items["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    let review = items
        .iter()
        .find(|item| item["sourceName"] == "review.md")
        .unwrap()["id"]
        .clone();
    let opaque = items
        .iter()
        .find(|item| item["sourceName"] == "opaque.md")
        .unwrap()["id"]
        .clone();
    let report = rpc(
        &mut server,
        6,
        "migration/definitions/report",
        json!({"jobId":job,"itemId":review}),
    );
    assert_eq!(report["report"]["fields"].as_array().unwrap().len(), 10);
    assert_eq!(report["nextPage"], 1);
    assert_eq!(report["report"]["executionAllowed"], false);
    assert!(!report.to_string().contains("SYNTHETIC_UNKNOWN_NAME"));
    assert!(!report.to_string().contains("secret-value"));
    let report2 = rpc(
        &mut server,
        7,
        "migration/definitions/report",
        json!({"jobId":job,"itemId":review,"pageIndex":1}),
    );
    assert!(report2["report"]["fields"].as_array().unwrap().len() <= 10);
    let choices=items.iter().enumerate().map(|(i,item)|json!({"kind":"asset","itemId":item["id"],"targetName":format!("pending-{i}"),"enableAfterImport":false})).collect::<Vec<_>>();
    let planned = rpc(
        &mut server,
        8,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],"choices":choices}),
    );
    let plan = planned["batch"]["planId"].clone();
    let published = rpc(
        &mut server,
        9,
        "migration/batch/apply",
        json!({"jobId":job,"planId":plan,"requestId":"save-pending","expectedSequence":planned["job"]["sequence"]}),
    );
    assert_eq!(published["job"]["committedItems"], 3);
    drop(server);
    std::fs::rename(&source, root.path().join("source-withheld")).unwrap();
    let mut server = start();
    let saved = rpc(
        &mut server,
        10,
        "migration/definitions/report",
        json!({"jobId":job,"itemId":review}),
    );
    assert_eq!(saved, report);
    let mut offset = 0;
    let mut received = Vec::new();
    loop {
        let part = rpc(
            &mut server,
            11,
            "migration/definitions/body",
            json!({"jobId":job,"itemId":review,"offset":offset}),
        );
        assert_eq!(part["encoding"], "utf8");
        let bytes = STANDARD
            .decode(part["bytesBase64"].as_str().unwrap())
            .unwrap();
        assert!(bytes.len() <= 16 * 1024);
        assert_eq!(std::str::from_utf8(&bytes).unwrap(), part["text"]);
        received.extend(bytes);
        if part["nextOffset"].is_null() {
            break;
        }
        offset = part["nextOffset"].as_u64().unwrap();
    }
    assert_eq!(received, body.as_bytes());
    let binary = rpc(
        &mut server,
        12,
        "migration/definitions/body",
        json!({"jobId":job,"itemId":opaque}),
    );
    assert_eq!(binary["encoding"], "binary");
    assert!(binary.get("text").is_none());
    assert_eq!(
        STANDARD
            .decode(binary["bytesBase64"].as_str().unwrap())
            .unwrap(),
        [0xff, 0, 0xfe]
    );
    let current = rpc(&mut server, 13, "migration/read", json!({"jobId":job}));
    let undone = rpc(
        &mut server,
        14,
        "migration/batch/rollback",
        json!({"jobId":job,"planId":plan,"requestId":"undo-pending","expectedSequence":current["job"]["sequence"]}),
    );
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert_eq!(skills(), original_skills);
    for index in 0..3 {
        assert!(!profile.join(format!("skills/pending-{index}")).exists());
    }
    assert_eq!(
        std::fs::read_to_string(profile.join("settings.json")).unwrap(),
        "{}"
    );
}
