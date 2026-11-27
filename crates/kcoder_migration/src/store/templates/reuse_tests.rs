use super::*;
use crate::batch::{BatchActionKind, BatchPlanPolicy};

fn reuse_plan(f: &Fixture, name: &str) -> Result<MigrationJob> {
    let job = f.scan();
    let mut choices = Fixture::choices(&job);
    if let BatchResolution::Template(choice) = &mut choices[0] {
        choice.target_name = name.into();
    }
    f.store.prepare_batch_with_policy(
        &job.job_id,
        job.sequence,
        &choices,
        &f.targets(),
        &BatchPlanPolicy {
            reuse_existing: true,
            ..Default::default()
        },
    )
}
fn saved_bytes(f: &Fixture) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        fs::read(f.profile.join("settings.json")).unwrap(),
        fs::read(f.profile.join("templates/imported-review.jsonc")).unwrap(),
        fs::read(f.profile.join("templates/index.json")).unwrap(),
    )
}
fn rename_as_user(f: &Fixture) {
    let native = SettingsTemplateStore::open(&f.profile).unwrap();
    let saved = native.read("imported-review").unwrap();
    native
        .save(
            &kcoder_types::settings_templates::SettingsTemplateSaveParams {
                id: Some("imported-review".into()),
                name: "User report".into(),
                description: None,
                content: saved.content,
            },
        )
        .unwrap();
}

#[test]
fn reused_templates_have_no_new_writes_or_ownership_and_keep_their_original_dependencies() {
    let f = Fixture::new("");
    let original = f.run(&f.plan(), false).unwrap();
    let before = saved_bytes(&f);
    let planned = reuse_plan(&f, "imported-review").unwrap();
    assert_eq!(
        saved_bytes(&f),
        before,
        "reuse previews must not prepare another native import"
    );
    let reused = f.run(&planned, false).unwrap();
    assert_eq!(reused.receipts.len(), 2);
    assert!(
        reused
            .receipts
            .iter()
            .all(|receipt| !receipt.ownership_confirmed)
    );
    assert!(
        reused
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .all(|action| action.status == ItemStatus::Skipped)
    );
    assert_eq!(saved_bytes(&f), before);
    let blocked = f.run(&original, true).unwrap();
    assert_eq!(blocked.status, JobStatus::RollbackConflict);
    assert_eq!(saved_bytes(&f), before);
    fs::remove_dir_all(&f.source).unwrap();
    let reopened = MigrationStore::open_existing(&f.profile).unwrap();
    let undone_reference = reopened
        .run_batch(
            &reused.job_id,
            reused.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "undo",
            reused.sequence,
            true,
            &f.targets(),
        )
        .unwrap();
    assert_eq!(undone_reference.status, JobStatus::RolledBack);
    assert_eq!(saved_bytes(&f), before);
    assert_eq!(f.run(&blocked, true).unwrap().status, JobStatus::RolledBack);
    assert!(!f.profile.join("templates/imported-review.jsonc").exists());
}

#[test]
fn an_identical_body_saved_by_the_user_is_not_reclaimed_as_an_import() {
    let f = Fixture::new("");
    f.run(&f.plan(), false).unwrap();
    rename_as_user(&f);
    let before = saved_bytes(&f);
    assert!(reuse_plan(&f, "imported-review").is_err());
    assert_eq!(saved_bytes(&f), before);
    assert_eq!(
        SettingsTemplateStore::open(&f.profile)
            .unwrap()
            .read("imported-review")
            .unwrap()
            .summary
            .name,
        "User report"
    );
}

#[test]
fn late_user_template_edits_fail_the_reference_without_overwriting_the_current_version() {
    let f = Fixture::new("");
    f.run(&f.plan(), false).unwrap();
    let planned = reuse_plan(&f, "imported-review").unwrap();
    rename_as_user(&f);
    let before = saved_bytes(&f);
    let result = f.run(&planned, false).unwrap();
    let action = result.batch.as_ref().unwrap().actions.iter().find(|action| {
        matches!(&action.action, BatchActionKind::Reuse {proof} if proof.dependency_action_id.is_some())
    }).unwrap();
    assert_eq!(action.status, ItemStatus::Failed);
    assert_eq!(
        action.error.as_deref(),
        Some("migration_reuse_target_changed")
    );
    assert_eq!(saved_bytes(&f), before);
}

#[test]
fn a_late_connection_change_prevents_a_template_reference_from_reporting_success() {
    let f = Fixture::new("");
    f.run(&f.plan(), false).unwrap();
    let planned = reuse_plan(&f, "imported-review").unwrap();
    let settings = kcoder_config::ProfileSettingsFile::new(
        kcoder_config::PrivateDirectory::open_existing(&f.profile).unwrap(),
    )
    .unwrap();
    settings
        .update(|value| {
            value["providers"]["ImportedOffice"]["default_model"] = "user-model".into();
            Ok(())
        })
        .unwrap();
    let before = saved_bytes(&f);
    let result = f.run(&planned, false).unwrap();
    assert!(
        result
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .all(|action| action.status != ItemStatus::Skipped)
    );
    assert!(
        result
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .any(|action| action.error.as_deref() == Some("migration_template_dependency_pending"))
    );
    assert_eq!(saved_bytes(&f), before);
}

#[test]
fn changed_reasoning_needs_a_new_target_and_never_silently_reuses_old_semantics() {
    let f = Fixture::new("");
    f.run(&f.plan(), false).unwrap();
    let before = saved_bytes(&f);
    fs::write(
        f.source.join("review.config.toml"),
        "model='review-model'\nmodel_reasoning_effort='medium'\n",
    )
    .unwrap();
    assert_eq!(
        reuse_plan(&f, "imported-review").unwrap_err().to_string(),
        "migration_source_updated"
    );
    assert_eq!(saved_bytes(&f), before);
    let second = f
        .run(&reuse_plan(&f, "revised-review").unwrap(), false)
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(
        &fs::read(f.profile.join("templates/revised-review.jsonc")).unwrap(),
    )
    .unwrap();
    assert_eq!(body["model_reasoning_effort"], "medium");
    assert_eq!(f.run(&second, true).unwrap().status, JobStatus::RolledBack);
    assert!(f.profile.join("templates/imported-review.jsonc").exists());
}

#[test]
fn the_derived_index_is_upgraded_before_reusing_previously_unindexed_templates() {
    let f = Fixture::new("");
    f.run(&f.plan(), false).unwrap();
    f.store.reuse_candidates().unwrap();
    let path = f.profile.join("migrations/.reuse-index.json");
    let mut index: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    index.as_object_mut().unwrap().remove("version");
    for job in index["jobs"].as_object_mut().unwrap().values_mut() {
        job["candidates"]
            .as_array_mut()
            .unwrap()
            .retain(|proof| proof["targetName"] != "imported-review");
    }
    fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
    let result = f
        .run(&reuse_plan(&f, "imported-review").unwrap(), false)
        .unwrap();
    assert!(
        result
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .all(|action| action.status == ItemStatus::Skipped)
    );
}

#[test]
fn lost_reference_receipts_reconcile_after_source_removal_without_native_writes() {
    let f = Fixture::new("");
    let original = f.run(&f.plan(), false).unwrap();
    let planned = reuse_plan(&f, "imported-review").unwrap();
    let before = saved_bytes(&f);
    super::super::super::batch::FAIL_AFTER_TEMPLATE_PUBLICATION.with(|fail| fail.set(true));
    assert!(f.run(&planned, false).is_err());
    let interrupted = f.store.read(&planned.job_id).unwrap();
    assert_eq!(interrupted.receipts.len(), 1);
    assert_eq!(
        f.run(&original, true).unwrap().status,
        JobStatus::RollbackConflict
    );
    fs::remove_dir_all(&f.source).unwrap();
    let reopened = MigrationStore::open_existing(&f.profile).unwrap();
    let restored = reopened
        .run_batch(
            &planned.job_id,
            planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "apply",
            planned.sequence,
            false,
            &f.targets(),
        )
        .unwrap();
    assert!(
        restored
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .all(|action| action.status == ItemStatus::Skipped)
    );
    assert_eq!(restored.receipts.len(), 2);
    assert_eq!(saved_bytes(&f), before);
}

#[test]
fn reusing_a_default_template_preserves_the_users_default_and_never_gains_delete_authority() {
    let f = Fixture::new("");
    let original = f.run(&f.plan(), false).unwrap();
    let native = SettingsTemplateStore::open(&f.profile).unwrap();
    native.set_default(Some("imported-review")).unwrap();
    let before = saved_bytes(&f);
    let reused = f
        .run(&reuse_plan(&f, "imported-review").unwrap(), false)
        .unwrap();
    assert_eq!(f.run(&reused, true).unwrap().status, JobStatus::RolledBack);
    assert_eq!(saved_bytes(&f), before);
    assert_eq!(
        native.list().unwrap().default_id.as_deref(),
        Some("imported-review")
    );
    assert_eq!(
        f.run(&original, true).unwrap().status,
        JobStatus::RollbackConflict
    );
    assert!(f.profile.join("templates/imported-review.jsonc").exists());
}

#[test]
fn template_and_provider_names_can_match_without_colliding_in_the_reuse_index() {
    let f = Fixture::new("");
    fs::write(f.source.join("config.toml"), "model_provider='review.config.toml'\n[model_providers.'review.config.toml']\nbase_url='https://example.invalid/v1'\nwire_api='responses'\n").unwrap();
    let scanned = f.scan();
    let mut choices = Fixture::choices(&scanned);
    if let BatchResolution::Provider(choice) = &mut choices[1] {
        choice.target_name = "imported-review".into();
    }
    let first = f
        .store
        .prepare_batch(
            &scanned.job_id,
            scanned.sequence,
            &choices[1..],
            &f.targets(),
        )
        .unwrap();
    f.run(&first, false).unwrap();
    let scanned = f.scan();
    let mut choices = Fixture::choices(&scanned);
    if let BatchResolution::Provider(choice) = &mut choices[1] {
        choice.target_name = "imported-review".into();
    }
    let second = f
        .store
        .prepare_batch_with_policy(
            &scanned.job_id,
            scanned.sequence,
            &choices,
            &f.targets(),
            &BatchPlanPolicy {
                reuse_existing: true,
                ..Default::default()
            },
        )
        .unwrap();
    let second = f.run(&second, false).unwrap();
    assert!(
        second
            .batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .any(|action| action.status == ItemStatus::Skipped)
    );
    assert!(f.profile.join("templates/imported-review.jsonc").exists());
}

#[test]
fn invalid_template_names_return_an_actionable_preflight_error_without_publication() {
    let f = Fixture::new("");
    let error = reuse_plan(&f, "Invalid Template").unwrap_err();
    assert_eq!(error.to_string(), "migration_invalid_template_name");
    assert!(!f.profile.join("templates/Invalid Template.jsonc").exists());
}
