//! Actual command processes must freeze explicit target limits in the same Native batch.
use super::*;
use kcoder_migration::store::MigrationStore;
use kcoder_types::migration_resource::MigrationResourceLimits;
use sha2::{Digest, Sha256};

const FLAGS: [&str; 8] = [
    "--resource-max-total-bytes",
    "2097152",
    "--resource-max-payload-files",
    "13",
    "--resource-min-free-bytes",
    "1048576",
    "--resource-min-free-file-nodes",
    "0",
];
fn expected() -> MigrationResourceLimits {
    MigrationResourceLimits {
        max_total_bytes: 2 * 1024 * 1024,
        max_payload_files: 13,
        min_free_bytes: 1024 * 1024,
        min_free_file_nodes: 0,
    }
}
fn limits(f: &Fixture, id: &str) -> MigrationResourceLimits {
    MigrationStore::open_existing(&f.profile)
        .unwrap()
        .read(id)
        .unwrap()
        .batch
        .unwrap()
        .resource_limits
        .unwrap()
}
fn rejected(mut dialog: Dialog) {
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = dialog.child.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "owned rejected guide did not exit"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(!status.success());
    let errors = dialog.errors.take().unwrap().join().unwrap();
    assert!(String::from_utf8_lossy(&errors).contains("migration_resource_limits_create_only"));
    assert!(!String::from_utf8_lossy(&errors).contains(KEY));
}

#[test]
fn initial_resource_batch_scan_freezes_all_flags_and_omission_keeps_native_defaults() {
    let f = Fixture::new("codex");
    let mut arguments = vec![
        "migrate",
        "batch-scan",
        "--source",
        "codex",
        "--source-home",
        f.home.to_str().unwrap(),
        "--target-profile",
        f.profile.to_str().unwrap(),
    ];
    arguments.extend(FLAGS);
    let scanned = f.call(&arguments);
    assert_eq!(
        limits(&f, scanned["job"]["jobId"].as_str().unwrap()),
        expected()
    );
    let omitted = f.scan("codex");
    assert_eq!(
        limits(&f, omitted["job"]["jobId"].as_str().unwrap()),
        MigrationResourceLimits::default()
    );
}

#[test]
fn initial_resource_configure_preserves_user_or_project_destination_and_reopen_policy() {
    for scope in ["user", "current-workspace"] {
        let f = Fixture::new("codex");
        // A project destination requires a private profile, independently of workspace trust.
        kcoder_config::PrivateDirectory::open_or_create(&f.profile).unwrap();
        let workspace = f.root.path().join("workspace");
        std::fs::write(
            f.profile.join("trusted-folders.json"),
            json!({"trusted":[workspace],"never":[]}).to_string(),
        )
        .unwrap();
        let original = std::fs::read(f.profile.join("settings.json")).unwrap();
        let mut arguments = FLAGS.to_vec();
        arguments.extend(["--target-scope", scope]);
        let mut dialog = Dialog::start_arguments(&f, "codex", None, false, &arguments);
        dialog
            .transcript
            .push_str(&format!("phase=initial scope={scope}\n"));
        let menu = dialog.prompt("menu");
        let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
        let saved = MigrationStore::open_existing(&f.profile)
            .unwrap()
            .read(&id)
            .unwrap();
        assert_eq!(
            saved.batch.as_ref().unwrap().resource_limits,
            Some(expected())
        );
        assert_eq!(
            saved.project_target().is_some(),
            scope == "current-workspace"
        );
        if let Some(project) = saved.project_target() {
            assert_eq!(project.root(), workspace);
        }
        dialog.answer(&menu, "quit");
        dialog.finish();
        std::fs::rename(f.config.parent().unwrap(), f.home.join("vendor-withheld")).unwrap();
        let mut reopened = Dialog::start(&f, "", Some(&id));
        reopened
            .transcript
            .push_str(&format!("phase=source-gone-read scope={scope}\n"));
        let menu = reopened.prompt("menu");
        reopened.answer(&menu, "quit");
        reopened.finish();
        let mut changed = Dialog::start_arguments(&f, "", None, false, &FLAGS);
        changed
            .transcript
            .push_str(&format!("phase=record-choice scope={scope}\n"));
        let entry = changed.prompt("entry");
        changed.answer(&entry, "records");
        let records = changed.prompt("records");
        changed.answer(&records, "1");
        rejected(changed);
        assert_eq!(limits(&f, &id), expected());
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            original
        );
    }
}

#[test]
fn initial_resource_instruction_capture_freezes_the_same_policy_in_original_intent_and_batch() {
    let f = Fixture::new("codex");
    let source = f.root.path().join("scoped-source");
    std::fs::create_dir_all(source.join(".git")).unwrap();
    std::fs::write(
        source.join("AGENTS.md"),
        "Keep the original scope and budget.",
    )
    .unwrap();
    let workspace = f.root.path().join("workspace");
    std::fs::write(
        f.profile.join("trusted-folders.json"),
        json!({"trusted":[source,workspace],"never":[]}).to_string(),
    )
    .unwrap();
    let mut dialog = Dialog::start_arguments(&f, "", None, false, &FLAGS);
    let request = uuid::Uuid::new_v4().to_string();
    for (code, answer) in [
        ("entry", "instructions"),
        ("instruction_request_id", request.as_str()),
        ("instruction_source", "codex"),
        ("instruction_root", source.to_str().unwrap()),
        ("instruction_cwd", ""),
        ("instruction_source_consent", "yes"),
        ("instruction_descendants", "no"),
        ("instruction_static_subset", "yes"),
        ("instruction_selection", "toggle 1"),
        ("instruction_target_scope", "."),
        ("instruction_selection", "done"),
        ("instruction_capture_confirm", "CAPTURE"),
    ] {
        let prompt = dialog.prompt(code);
        dialog.answer(&prompt, answer);
    }
    let menu = dialog.prompt("menu");
    let id = dialog.state["job"]["jobId"].as_str().unwrap().to_owned();
    dialog.answer(&menu, "quit");
    dialog.finish();
    assert_eq!(limits(&f, &id), expected());
    let store = MigrationStore::open_existing(&f.profile).unwrap();
    let creation = store.read_batch_creation(&request).unwrap();
    assert_eq!(creation.job_id, id);
    assert_eq!(
        creation.stage,
        kcoder_migration::store::BatchCreationStage::Published
    );
    assert!(creation.job.is_some());
    let target = kcoder_migration::instruction_sources::InstructionDestination::capture(
        &f.profile, &workspace,
    )
    .unwrap();
    let mapped =
        kcoder_migration::instruction_sources::ScopedInstructionDestination::capture(&target, "")
            .unwrap();
    let proof = format!("{:x}", Sha256::digest(serde_json::to_vec(&mapped).unwrap()));
    let snapshot = kcoder_migration::instruction_sources::InstructionSourceGrant::capture(
        &f.profile,
        &source,
        &source,
        kcoder_types::migration::MigrationSourceKind::Codex,
    )
    .unwrap()
    .capture_static_sources(&Default::default(), true, |_| true)
    .unwrap();
    let public_intent = json!({"kind":"terminal-scoped-instructions/2","profile":f.profile,
        "source":"codex","root":source,"cwd":source,"includeDescendants":false,
        "parserRevision":snapshot.semantic_revision().unwrap(),"selection":[["AGENTS.md","",proof]],
        "targetWorkspace":workspace,"staticSubsetConfirmed":false,"resourceLimits":expected()});
    let expected_intent =
        kcoder_migration::store::BatchCreateIntent::new(&request, &public_intent).unwrap();
    assert_eq!(
        store.batch_creation_intent(&request).unwrap(),
        expected_intent
    );
    let mut changed = public_intent;
    changed["resourceLimits"]["maxTotalBytes"] = json!(4 * 1024 * 1024);
    let wrong = kcoder_migration::store::BatchCreateIntent::new(&request, &changed).unwrap();
    assert!(store.lookup_batch_creation(&wrong).is_err());
    std::fs::rename(&source, f.root.path().join("source-withheld")).unwrap();
    let mut reopened = Dialog::start(&f, "", Some(&id));
    let menu = reopened.prompt("menu");
    reopened.answer(&menu, "quit");
    reopened.finish();
    let mut changed = Dialog::start_arguments(&f, "", None, false, &FLAGS);
    let entry = changed.prompt("entry");
    changed.answer(&entry, "instructions");
    let original = changed.prompt("instruction_request_id");
    changed.answer(&original, &request);
    rejected(changed);
    assert_eq!(limits(&f, &id), expected());
}

#[test]
fn initial_resource_invalid_values_are_rejected_before_scan_or_configure_creates_a_job() {
    for operation in ["batch-scan", "configure"] {
        let f = Fixture::new("codex");
        let result = f.invoke(&[
            "migrate",
            operation,
            "--source",
            "codex",
            "--source-home",
            f.home.to_str().unwrap(),
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--resource-max-total-bytes",
            "0",
        ]);
        assert!(!result.status.success());
        assert!(
            String::from_utf8_lossy(&result.stderr).contains("migration_invalid_resource_limits")
        );
        assert!(!f.profile.join("migrations").exists());
    }
}
