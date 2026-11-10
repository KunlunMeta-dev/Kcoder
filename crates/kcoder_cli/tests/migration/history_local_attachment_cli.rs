//! Actual command processes share the native upload journal and never send source paths in RPC.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};

struct LocalFixture {
    f: Fixture,
    job: String,
    view: String,
    file: PathBuf,
    payload: Vec<u8>,
    tool: bool,
}
impl LocalFixture {
    fn new() -> Self {
        Self::kind(false)
    }
    fn kind(tool: bool) -> Self {
        let f = Fixture::new();
        let id = uuid::Uuid::new_v4().to_string();
        let source = f.source(&id);
        let attachment = json!({"type":"document","path":"/NEVER_READ/original.pdf","media_type":"application/pdf"});
        if tool {
            let mut rows = fs::read_to_string(&source)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>();
            rows[2]["message"]["content"][0]["content"] =
                json!([{"type":"text","text":"before"},attachment]);
            fs::write(
                &source,
                rows.iter()
                    .map(|row| format!("{row}\n"))
                    .collect::<String>(),
            )
            .unwrap();
        } else {
            use std::io::Write;
            writeln!(fs::OpenOptions::new().append(true).open(&source).unwrap(),"{}",json!({"type":"user","uuid":"local","parentUuid":"c","sessionId":id,"version":"2.1.301","message":{"role":"user","content":[attachment]}})).unwrap();
        }
        let job = uuid::Uuid::new_v4().to_string();
        f.selected(&id, &job);
        f.call(&["run", "--job-id", &job, "--expected-sequence", "0"]);
        let branch = f.call(&["branch", "--job-id", &job]);
        let view = branch["progress"]["viewId"].as_str().unwrap().to_owned();
        let chosen = f.root.path().join("private-chosen-files");
        kcoder_config::PrivateDirectory::open_or_create(&chosen).unwrap();
        let file = chosen.join("explicit-document.txt");
        let mut payload = b"PRIVATE_UPLOAD_BODY_NEVER_PRINT ".repeat(13000);
        payload.truncate(400000);
        fs::write(&file, &payload).unwrap();
        Self {
            f,
            job,
            view,
            file,
            payload,
            tool,
        }
    }
    fn chosen(&self) -> Vec<&str> {
        let mut args = vec![
            "--job-id",
            &self.job,
            "--view-id",
            &self.view,
            "--position",
            if self.tool { "2" } else { "3" },
            "--block",
            "0",
        ];
        if self.tool {
            args.extend(["--tool-item-index", "0"]);
        }
        args
    }
    fn prepare(&self, id: &str) -> Value {
        let mut args = vec!["local-attachment", "prepare"];
        args.extend(self.chosen());
        args.extend(["--request-id", id]);
        self.f.call(&args)
    }
    fn upload(&self, id: &str, sequence: u64, confirm: bool) -> Output {
        let sequence = sequence.to_string();
        let mut args = vec!["local-attachment", "upload"];
        args.extend(self.chosen());
        args.extend([
            "--request-id",
            id,
            "--expected-sequence",
            &sequence,
            "--file",
            self.file.to_str().unwrap(),
        ]);
        if confirm {
            args.push("--confirm")
        };
        self.f.invoke(&args)
    }
    fn phase(&self, phase: &str, id: &str, sequence: u64) -> Value {
        self.f.call(&[
            "local-attachment",
            phase,
            "--operation-id",
            id,
            "--expected-sequence",
            &sequence.to_string(),
        ])
    }
}

#[test]
fn real_cli_upload_finishes_without_source_and_explicit_binding_creates_idle_kcoder() {
    let fixture = LocalFixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let no_confirm = fixture.upload(&id, 0, false);
    assert!(!no_confirm.status.success());
    let prepared = fixture.prepare(&id);
    let uploaded = fixture.upload(&id, prepared["upload"]["sequence"].as_u64().unwrap(), true);
    assert!(
        uploaded.status.success(),
        "{}",
        String::from_utf8_lossy(&uploaded.stderr)
    );
    let stdout = String::from_utf8(uploaded.stdout).unwrap();
    assert!(!stdout.contains(fixture.file.to_str().unwrap()));
    assert!(!stdout.contains("PRIVATE_UPLOAD_BODY_NEVER_PRINT"));
    let uploaded: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(uploaded["upload"]["receivedBytes"], 400000);
    assert_eq!(uploaded["upload"]["receivedParts"], 3);
    fs::remove_file(&fixture.file).unwrap();
    let finished = fixture.phase(
        "finish",
        &id,
        uploaded["upload"]["sequence"].as_u64().unwrap(),
    );
    let saved = fixture.phase(
        "run",
        &id,
        finished["upload"]["localJob"]["state"]["sequence"]
            .as_u64()
            .unwrap(),
    );
    assert_eq!(saved["upload"]["localJob"]["state"]["stage"], "ready");
    assert_eq!(
        saved["upload"]["localJob"]["historicalContentVerified"],
        false
    );
    let binding = serde_json::to_string(&saved["binding"]).unwrap();
    let first = fixture.f.call(&[
        "local-attachment",
        "chunk",
        "--binding",
        &binding,
        "--confirm",
    ]);
    let bytes = STANDARD
        .decode(first["dataBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, fixture.payload[..262144]);
    let second = fixture.f.call(&[
        "local-attachment",
        "chunk",
        "--binding",
        &binding,
        "--offset",
        "262144",
        "--confirm",
    ]);
    assert_eq!(
        STANDARD
            .decode(second["dataBase64"].as_str().unwrap())
            .unwrap(),
        fixture.payload[262144..]
    );
    assert_eq!(
        fixture.f.call(&[
            "check",
            "--job-id",
            &fixture.job,
            "--view-id",
            &fixture.view,
            "--local-attachment-binding",
            &binding,
            "--confirm-local-attachments"
        ])["report"]["contextCompiled"],
        true
    );
    let key = uuid::Uuid::new_v4().to_string();
    let args = [
        "continue",
        "--job-id",
        &fixture.job,
        "--view-id",
        &fixture.view,
        "--request-id",
        &key,
        "--local-attachment-binding",
        &binding,
        "--confirm-local-attachments",
    ];
    let imported = fixture.f.call(&args);
    assert_eq!(imported["job"]["stage"], "imported");
    assert_eq!(imported["job"]["options"]["studioWorkMode"], "kcoder");
    assert_eq!(
        imported["job"]["options"]["localAttachments"][0],
        saved["binding"]
    );
    assert_eq!(fixture.f.call(&args)["job"], imported["job"]);
    let mut changed = saved["binding"].clone();
    changed["receipt"]["sha256"] = json!("a".repeat(64));
    assert!(
        !fixture
            .f
            .invoke(&[
                "continue",
                "--job-id",
                &fixture.job,
                "--view-id",
                &fixture.view,
                "--request-id",
                &key,
                "--local-attachment-binding",
                &changed.to_string(),
                "--confirm-local-attachments"
            ])
            .status
            .success()
    );
    let bad = fixture.f.invoke(&[
        "check",
        "--job-id",
        &fixture.job,
        "--view-id",
        &fixture.view,
        "--local-attachment-binding",
        r#"{"unexpected":"NEVER_ECHO_BINDING_SECRET"}"#,
        "--confirm-local-attachments",
    ]);
    assert!(!bad.status.success());
    assert!(!String::from_utf8_lossy(&bad.stderr).contains("NEVER_ECHO_BINDING_SECRET"));
    assert!(!fixture.f.workspace.join("NEVER_REPLAY").exists());
    let requests = fixture.f.workspace.join("model-requests");
    assert!(!requests.exists() || fs::read_dir(requests).unwrap().next().is_none());
}

#[test]
fn cancelled_cli_upload_keeps_its_manifest_and_records_are_ten_per_page() {
    let fixture = LocalFixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let uploaded = fixture.upload(&id, 0, true);
    assert!(
        uploaded.status.success(),
        "{}",
        String::from_utf8_lossy(&uploaded.stderr)
    );
    let before: Value = serde_json::from_slice(&uploaded.stdout).unwrap();
    let cancelled = fixture
        .f
        .call(&["local-attachment", "cancel", "--operation-id", &id]);
    assert_eq!(cancelled["upload"]["stage"], "cancelled");
    assert!(
        !fixture
            .f
            .invoke(&[
                "local-attachment",
                "resume",
                "--operation-id",
                &id,
                "--expected-sequence",
                &before["upload"]["sequence"].to_string()
            ])
            .status
            .success()
    );
    let resumed = fixture.phase(
        "resume",
        &id,
        cancelled["upload"]["sequence"].as_u64().unwrap(),
    );
    let sequence = resumed["upload"]["sequence"].as_u64().unwrap();
    fs::write(&fixture.file, vec![b'x'; fixture.payload.len()]).unwrap();
    let wrong = fixture.upload(&id, sequence, true);
    assert!(!wrong.status.success());
    assert!(!String::from_utf8_lossy(&wrong.stdout).contains(fixture.file.to_str().unwrap()));
    fs::write(&fixture.file, &fixture.payload).unwrap();
    let continued = fixture.upload(&id, sequence, true);
    assert!(
        continued.status.success(),
        "{}",
        String::from_utf8_lossy(&continued.stderr)
    );
    let continued: Value = serde_json::from_slice(&continued.stdout).unwrap();
    assert_eq!(continued["upload"]["receivedParts"], 3);
    for _ in 0..11 {
        fixture.prepare(&uuid::Uuid::new_v4().to_string());
    }
    let mut args = vec!["local-attachment", "list"];
    args.extend(fixture.chosen());
    let page = fixture.f.call(&args);
    assert_eq!(page["items"].as_array().unwrap().len(), 10);
    args.extend(["--cursor", page["nextCursor"].as_str().unwrap()]);
    assert_eq!(fixture.f.call(&args)["items"].as_array().unwrap().len(), 2);
}

#[test]
fn typed_tool_attachment_catalog_and_explicit_local_item_use_the_same_terminal_flow() {
    let fixture = LocalFixture::kind(true);
    let base = [
        "--job-id",
        &fixture.job,
        "--view-id",
        &fixture.view,
        "--position",
        "2",
        "--block",
        "0",
    ];
    let mut catalog = vec!["local-attachment", "catalog"];
    catalog.extend(base);
    let mut catalog_read = vec!["local-attachment", "catalog-read"];
    catalog_read.extend(base);
    assert!(fixture.f.call(&catalog_read)["job"].is_null());
    let catalogued = fixture.f.call(&catalog);
    assert_eq!(catalogued["job"]["stage"], "catalogued");
    assert_eq!(fixture.f.call(&catalog_read)["job"], catalogued["job"]);
    let mut items = vec!["local-attachment", "items"];
    items.extend(base);
    assert_eq!(fixture.f.call(&items)["items"].as_array().unwrap().len(), 1);
    let id = uuid::Uuid::new_v4().to_string();
    let uploaded = fixture.upload(&id, 0, true);
    assert!(
        uploaded.status.success(),
        "{}",
        String::from_utf8_lossy(&uploaded.stderr)
    );
    let uploaded: Value = serde_json::from_slice(&uploaded.stdout).unwrap();
    let finished = fixture.phase(
        "finish",
        &id,
        uploaded["upload"]["sequence"].as_u64().unwrap(),
    );
    let ready = fixture.phase(
        "run",
        &id,
        finished["upload"]["localJob"]["state"]["sequence"]
            .as_u64()
            .unwrap(),
    );
    assert_eq!(ready["binding"]["selection"]["toolItemIndex"], 0);
    assert_eq!(
        fixture.f.call(&[
            "check",
            "--job-id",
            &fixture.job,
            "--view-id",
            &fixture.view,
            "--local-attachment-binding",
            &ready["binding"].to_string(),
            "--confirm-local-attachments"
        ])["report"]["contextCompiled"],
        true
    );
}

#[test]
fn explicit_resume_of_a_cancelled_authorized_copy_can_run_through_the_real_host() {
    let fixture = LocalFixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let uploaded = fixture.upload(&id, 0, true);
    assert!(
        uploaded.status.success(),
        "{}",
        String::from_utf8_lossy(&uploaded.stderr)
    );
    let uploaded: Value = serde_json::from_slice(&uploaded.stdout).unwrap();
    fixture.phase(
        "finish",
        &id,
        uploaded["upload"]["sequence"].as_u64().unwrap(),
    );
    let cancelled = fixture
        .f
        .call(&["local-attachment", "cancel", "--operation-id", &id]);
    assert_eq!(
        cancelled["upload"]["localJob"]["state"]["stage"],
        "cancelled"
    );
    let resumed = fixture.phase(
        "resume",
        &id,
        cancelled["upload"]["sequence"].as_u64().unwrap(),
    );
    let ready = fixture.phase(
        "run",
        &id,
        resumed["upload"]["localJob"]["state"]["sequence"]
            .as_u64()
            .unwrap(),
    );
    assert_eq!(ready["upload"]["localJob"]["state"]["stage"], "ready");
    assert_eq!(ready["upload"]["cancelRequested"], false);
}
