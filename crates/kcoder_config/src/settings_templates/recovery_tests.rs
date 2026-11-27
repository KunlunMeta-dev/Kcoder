use super::transaction::FAIL_STEP;
use super::*;
fn store(root: &Path) -> SettingsTemplateStore {
    SettingsTemplateStore::open(root).unwrap()
}
fn save(store: &SettingsTemplateStore, body: &str) -> Result<SettingsTemplateSaveResult> {
    store.save(&SettingsTemplateSaveParams {
        id: Some("alpha".into()),
        name: "Alpha".into(),
        description: None,
        content: body.into(),
    })
}
const BEFORE: &str = "{\"permission_mode\":\"ask\"}";
const AFTER: &str = "{\"permission_mode\":\"auto\"}";
#[test]
fn imports_require_positive_receipts_preserve_defaults_and_never_reinstall_after_undo() {
    let root = tempfile::tempdir().unwrap();
    let service = store(root.path());
    let reference = service
        .prepare_owned("alpha", "Alpha", None, BEFORE)
        .unwrap();
    assert!(!service.root().exists());
    assert_eq!(
        service.install_owned(&reference, BEFORE).unwrap(),
        TemplateImportState::Committed
    );
    assert_eq!(
        service.import_state(&reference).unwrap(),
        Some(TemplateImportState::Committed)
    );
    let original = std::fs::read(service.root().join("index.json")).unwrap();
    assert_eq!(
        service.install_owned(&reference, BEFORE).unwrap(),
        TemplateImportState::Committed
    );
    assert_eq!(
        std::fs::read(service.root().join("index.json")).unwrap(),
        original
    );
    service.set_default(Some("alpha")).unwrap();
    assert!(
        service
            .undo_owned(&reference)
            .unwrap_err()
            .to_string()
            .contains("referenced")
    );
    service.set_default(None).unwrap();
    assert_eq!(
        service.undo_owned(&reference).unwrap(),
        TemplateImportState::Undone
    );
    assert_eq!(
        service.undo_owned(&reference).unwrap(),
        TemplateImportState::Undone
    );
    assert!(service.install_owned(&reference, BEFORE).is_err());
    assert!(service.list().unwrap().templates.is_empty());
    assert!(!service.root().join("alpha.jsonc").exists());
    let unowned = service
        .prepare_owned("alpha", "Alpha", None, BEFORE)
        .unwrap();
    save(&service, BEFORE).unwrap();
    assert!(service.install_owned(&unowned, BEFORE).is_err());
    assert_eq!(service.read("alpha").unwrap().content, BEFORE);
}
#[test]
fn user_saves_manual_edits_and_copied_profiles_cannot_transfer_import_ownership() {
    for manual in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let service = store(root.path());
        let reference = service
            .prepare_owned("alpha", "Alpha", None, BEFORE)
            .unwrap();
        service.install_owned(&reference, BEFORE).unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::create_dir(other.path().join("templates")).unwrap();
        for name in ["alpha.jsonc", "index.json"] {
            std::fs::copy(
                service.root().join(name),
                other.path().join("templates").join(name),
            )
            .unwrap();
        }
        assert!(store(other.path()).undo_owned(&reference).is_err());
        if manual {
            std::fs::write(service.root().join("alpha.jsonc"), AFTER).unwrap();
        } else {
            save(&service, BEFORE).unwrap();
        }
        assert!(service.undo_owned(&reference).is_err());
        assert_eq!(
            service.read("alpha").unwrap().content,
            if manual { AFTER } else { BEFORE }
        );
    }
}
#[test]
fn coordinated_reads_recover_before_and_after_publication_without_replaying_writes() {
    for step in 1..=4 {
        for operation in ["replace", "create", "delete", "import", "undo"] {
            let root = tempfile::tempdir().unwrap();
            let service = store(root.path());
            let reference = service
                .prepare_owned("alpha", "Alpha", None, BEFORE)
                .unwrap();
            if matches!(operation, "replace" | "delete") {
                save(&service, BEFORE).unwrap();
            }
            if operation == "undo" {
                service.install_owned(&reference, BEFORE).unwrap();
            }
            FAIL_STEP.with(|fail| fail.set(step));
            let failed = match operation {
                "replace" | "create" => save(&service, AFTER).map(|_| ()),
                "delete" => service.delete("alpha").map(|_| ()),
                "import" => service.install_owned(&reference, BEFORE).map(|_| ()),
                "undo" => service.undo_owned(&reference).map(|_| ()),
                _ => unreachable!(),
            };
            FAIL_STEP.with(|fail| fail.set(0));
            assert!(failed.is_err(), "{operation} step {step}");
            assert!(
                service.root().join(".transaction.json").exists(),
                "{operation} step {step}: {failed:?}"
            );
            let journal =
                std::fs::read_to_string(service.root().join(".transaction.json")).unwrap();
            assert!(!journal.contains("permission_mode"));
            let listed = service.list().unwrap();
            let present = match operation {
                "create" | "import" => step == 4,
                "delete" | "undo" => step != 4,
                _ => true,
            };
            assert_eq!(
                listed.templates.len(),
                usize::from(present),
                "{operation} step {step}"
            );
            if present {
                let expected = if operation == "replace" && step == 4 || operation == "create" {
                    AFTER
                } else {
                    BEFORE
                };
                assert_eq!(
                    service.read("alpha").unwrap().content,
                    expected,
                    "{operation} step {step}"
                );
            }
            assert!(!service.root().join(".transaction.json").exists());
            assert!(!std::fs::read_dir(service.root()).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".staging-")
            }));
            if operation == "import" {
                assert_eq!(
                    service.import_state(&reference).unwrap(),
                    Some(if step == 4 {
                        TemplateImportState::Committed
                    } else {
                        TemplateImportState::Staged
                    })
                );
            }
            if operation == "undo" {
                assert_eq!(
                    service.import_state(&reference).unwrap(),
                    Some(if step == 4 {
                        TemplateImportState::Undone
                    } else {
                        TemplateImportState::Committed
                    })
                );
            }
        }
    }
}
#[test]
fn recovery_preserves_user_replacements_and_rejects_unsafe_or_oversized_files() {
    let root = tempfile::tempdir().unwrap();
    let service = store(root.path());
    save(&service, BEFORE).unwrap();
    FAIL_STEP.with(|fail| fail.set(3));
    assert!(save(&service, AFTER).is_err());
    FAIL_STEP.with(|fail| fail.set(0));
    let replacement = service.root().join("replacement");
    std::fs::write(&replacement, "{\"model\":\"user-edit\"}").unwrap();
    std::fs::rename(&replacement, service.root().join("alpha.jsonc")).unwrap();
    assert!(service.list().is_err());
    assert_eq!(
        std::fs::read_to_string(service.root().join("alpha.jsonc")).unwrap(),
        "{\"model\":\"user-edit\"}"
    );
    let root = tempfile::tempdir().unwrap();
    let service = store(root.path());
    save(&service, BEFORE).unwrap();
    let alias = service.root().join("alias");
    std::fs::hard_link(service.root().join("alpha.jsonc"), &alias).unwrap();
    assert!(service.read("alpha").is_err());
    assert!(save(&service, AFTER).is_err());
    std::fs::remove_file(alias).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(service.root().join("alpha.jsonc"))
        .unwrap()
        .set_len(MAX_TEMPLATE_BYTES as u64 + 1)
        .unwrap();
    assert!(service.list().is_err());
}

#[test]
#[ignore = "isolated subprocess helper; parent tests own its environment, deadline and termination"]
fn process_worker() {
    let root = std::path::PathBuf::from(std::env::var_os("KCODER_TEST_TEMPLATE_ROOT").unwrap());
    let service = store(&root);
    if let Ok(step) = std::env::var("KCODER_TEST_TEMPLATE_STEP") {
        FAIL_STEP.with(|fail| fail.set(step.parse().unwrap()));
        super::transaction::BLOCK_ON_FAIL
            .with(|value| *value.borrow_mut() = Some(root.join("ready")));
        save(&service, AFTER).unwrap();
    } else {
        let id = std::env::var("KCODER_TEST_TEMPLATE_ID").unwrap();
        let started = std::time::Instant::now();
        loop {
            match service.save(&SettingsTemplateSaveParams {
                id: Some(id.clone()),
                name: id.clone(),
                description: None,
                content: BEFORE.into(),
            }) {
                Ok(_) => return,
                Err(error)
                    if error.to_string() == "settings_template_busy"
                        && started.elapsed() < std::time::Duration::from_secs(10) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(error) => panic!("{error}"),
            }
        }
    }
}
fn worker(root: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "settings_templates::recovery_tests::process_worker",
            "--ignored",
        ])
        .env_clear()
        .env("KCODER_TEST_TEMPLATE_ROOT", root)
        .env("HOME", root)
        .env("USERPROFILE", root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}
#[test]
fn actual_process_termination_restores_a_complete_pair_at_every_publication_boundary() {
    for step in 1..=4 {
        let root = tempfile::tempdir().unwrap();
        let service = store(root.path());
        save(&service, BEFORE).unwrap();
        service.set_default(Some("alpha")).unwrap();
        let mut child = Child(
            worker(root.path())
                .env("KCODER_TEST_TEMPLATE_STEP", step.to_string())
                .spawn()
                .unwrap(),
        );
        let start = std::time::Instant::now();
        while !root.path().join("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "worker exited before boundary {step}"
            );
            assert!(
                start.elapsed() < std::time::Duration::from_secs(10),
                "worker did not reach boundary {step}"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
        let reopened = store(root.path());
        let read = reopened.read("alpha").unwrap();
        assert_eq!(read.content, if step == 4 { AFTER } else { BEFORE });
        assert_eq!(read.default_id.as_deref(), Some("alpha"));
        assert_eq!(
            read.summary.revision_sha256,
            hex_sha256(read.content.as_bytes())
        );
        assert!(!reopened.root().join(".transaction.json").exists());
    }
}
#[test]
fn independent_process_writers_keep_each_others_index_entries_and_the_default() {
    let root = tempfile::tempdir().unwrap();
    let service = store(root.path());
    save(&service, BEFORE).unwrap();
    service.set_default(Some("alpha")).unwrap();
    let mut children = ["beta", "gamma", "delta"]
        .into_iter()
        .map(|id| {
            Child(
                worker(root.path())
                    .env("KCODER_TEST_TEMPLATE_ID", id)
                    .spawn()
                    .unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let start = std::time::Instant::now();
    for child in &mut children {
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(start.elapsed() < std::time::Duration::from_secs(15));
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let listed = service.list().unwrap();
    assert_eq!(listed.templates.len(), 4);
    assert_eq!(listed.default_id.as_deref(), Some("alpha"));
}

#[test]
fn nested_credential_values_and_url_credentials_never_enter_templates_or_journals() {
    let root = tempfile::tempdir().unwrap();
    let service = store(root.path());
    for content in [
        r#"{"mcp_servers":[{"name":"private","command":"not-run","env":{"VENDOR_API_KEY":"PRIVATE_TEMPLATE_CANARY"}}]}"#,
        r#"{"mcp_servers":[{"name":"private","transport":"http","url":"https://example.invalid","headers":{"Authorization":"Bearer PRIVATE_TEMPLATE_CANARY"}}]}"#,
        r#"{"base_url":"https://user:PRIVATE_TEMPLATE_CANARY@example.invalid"}"#,
        r#"{"base_url":"https://example.invalid?access_token=PRIVATE_TEMPLATE_CANARY"}"#,
    ] {
        assert!(
            service
                .prepare_owned("alpha", "Alpha", None, content)
                .is_err()
        );
        let error = save(&service, content).unwrap_err().to_string();
        assert!(!error.contains("PRIVATE_TEMPLATE_CANARY"));
        assert!(!service.root().exists());
    }
}
