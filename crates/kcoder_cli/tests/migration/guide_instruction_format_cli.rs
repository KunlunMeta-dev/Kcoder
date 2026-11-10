//! Actual command processes distinguish original evidence from the confirmed compiler output.
use super::*;
use sha2::Digest;

fn result(d: &Dialog, kind: &str) -> Value {
    d.transcript
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .rfind(|frame| frame["type"] == kind)
        .unwrap()["result"]
        .clone()
}

#[test]
fn guided_static_v2_previews_raw_and_compiled_then_reads_both_after_source_removal() {
    let f = Fixture::new("claude-code");
    let root = source(&f, "claude-code", 1);
    let raw = "<!-- HUMAN_ONLY_SOURCE_NOTE -->\nUse @rules.md\n";
    let imported = "COMPILED_IMPORTED_GUIDE: keep ordinary project checks.\n";
    std::fs::write(root.join("CLAUDE.md"), raw).unwrap();
    std::fs::write(root.join("rules.md"), imported).unwrap();
    let original_settings = std::fs::read(f.profile.join("settings.json")).unwrap();
    let mut d = capture_dialog(&f, &root, "claude-code");
    let p = d.prompt("instruction_selection");
    assert!(!d.transcript.contains("HUMAN_ONLY_SOURCE_NOTE"));
    assert!(!d.transcript.contains("COMPILED_IMPORTED_GUIDE"));
    d.answer(&p, "details 1");
    let p = d.prompt("instruction_selection");
    let report = result(&d, "instruction_report");
    assert_eq!(report["sourceFormat"], "scoped-instructions/v2");
    assert_eq!(report["relativePath"], "CLAUDE.md");
    assert_eq!(report["completeAuthorizedStaticChain"], true);
    assert!(report.as_object().unwrap().len() <= 10);
    assert!(!report.to_string().contains(root.to_str().unwrap()));
    d.answer(&p, "body 1");
    let p = d.prompt("instruction_selection");
    assert_eq!(result(&d, "instruction_body")["representation"], "original");
    assert_eq!(result(&d, "instruction_body")["text"], raw);
    d.answer(&p, "preview 1");
    let p = d.prompt("instruction_selection");
    let compiled = result(&d, "instruction_body");
    assert_eq!(compiled["representation"], "compiled");
    let compiled_text = compiled["text"].as_str().unwrap().to_owned();
    assert!(compiled_text.contains(imported));
    assert!(!compiled_text.contains("HUMAN_ONLY_SOURCE_NOTE"));
    assert!(!compiled_text.contains("@rules.md"));
    assert_eq!(compiled["enabledByPreview"], false);
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    d.answer(&p, "toggle 1");
    let p = d.prompt("instruction_target_scope");
    d.answer(&p, ".");
    let p = d.prompt("instruction_selection");
    d.answer(&p, "done");
    let p = d.prompt("instruction_capture_confirm");
    assert_eq!(
        result(&d, "instruction_capture")["sourceFormat"],
        "scoped-instructions/v2"
    );
    d.answer(&p, "CAPTURE");
    let menu = d.prompt("menu");
    let job = d.state["job"]["jobId"].as_str().unwrap().to_owned();
    let request = result(&d, "instruction_capture")["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    d.answer(&menu, "select");
    let p = d.prompt("selection");
    d.answer(&p, "toggle 1");
    let p = d.prompt("target_name");
    d.answer(&p, "");
    let p = d.prompt("enable_asset");
    assert_eq!(p["default"], "no");
    d.answer(&p, "no");
    let p = d.prompt("selection");
    d.answer(&p, "preview");
    let p = d.prompt("reuse");
    d.answer(&p, "no");
    let menu = d.prompt("menu");
    let menu = operate(&mut d, &menu, "apply", "IMPORT");
    assert_eq!(d.state["job"]["status"], "completed");
    let store = ImportedContextStore::open(&f.profile).unwrap();
    let rows = store.list().unwrap();
    assert_eq!(rows.len(), 1);
    assert!(!rows[0].enabled);
    assert_eq!(rows[0].content, compiled_text);
    let provenance = rows[0].instruction_provenance.as_ref().unwrap();
    assert_eq!(
        provenance.source_sha256,
        format!("{:x}", sha2::Sha256::digest(raw))
    );
    assert!(provenance.source_file_identity.is_none());
    d.answer(&menu, "quit");
    d.finish();
    std::fs::rename(&root, root.with_extension("withheld")).unwrap();
    let mut d = Dialog::start(&f, "", None);
    let p = d.prompt("entry");
    d.answer(&p, "creation");
    let p = d.prompt("creation_request_id");
    d.answer(&p, &request);
    let menu = d.prompt("menu");
    assert_eq!(d.state["job"]["jobId"], job);
    d.answer(&menu, "instructions");
    let p = d.prompt("instruction_saved");
    d.answer(&p, "compiled 1");
    let p = d.prompt("instruction_saved");
    assert_eq!(result(&d, "instruction_body")["text"], compiled_text);
    assert_eq!(result(&d, "instruction_body")["representation"], "compiled");
    d.answer(&p, "1");
    let p = d.prompt("instruction_saved");
    assert_eq!(result(&d, "instruction_body")["text"], raw);
    assert_eq!(result(&d, "instruction_body")["representation"], "original");
    d.answer(&p, "back");
    let menu = d.prompt("menu");
    let menu = operate(&mut d, &menu, "undo", "UNDO");
    assert_eq!(d.state["job"]["status"], "rolled_back");
    d.answer(&menu, "quit");
    d.finish();
    assert!(store.list().unwrap().is_empty());
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original_settings
    );
    assert!(!f.root.path().join("model-requests").exists());
}

#[test]
fn guided_static_v2_declined_subset_does_not_capture_a_job_or_read_source_body() {
    let f = Fixture::new("claude-code");
    let root = source(&f, "claude-code", 1);
    let mut d = Dialog::start(&f, "", None);
    for (code, answer) in [
        ("entry", "instructions"),
        ("instruction_request_id", ""),
        ("instruction_source", "claude-code"),
        ("instruction_root", root.to_str().unwrap()),
        ("instruction_cwd", ""),
        ("instruction_source_consent", "yes"),
        ("instruction_descendants", "no"),
        ("instruction_static_subset", "no"),
    ] {
        let p = d.prompt(code);
        d.answer(&p, answer);
    }
    while let Ok(frame) = d.events.recv_timeout(Duration::from_secs(5)) {
        d.transcript.push_str(&frame.to_string());
        d.transcript.push('\n');
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = d.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "owned declined guide did not exit"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(!status.success());
    assert!(!d.transcript.contains("SCOPE_GUIDE"));
    assert!(!d.transcript.contains("instruction_capture\""));
    assert!(
        MigrationStore::open_existing(&f.profile)
            .unwrap()
            .records(None)
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert!(!f.root.path().join("model-requests").exists());
}
