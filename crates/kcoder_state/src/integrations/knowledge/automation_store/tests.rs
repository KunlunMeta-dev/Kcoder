use super::*;
use kcoder_types::{CronSchedule, integrations::core::IntegrationNullable};
pub(super) fn fixture_root() -> Result<tempfile::TempDir> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    Ok(root)
}
#[test]
fn unlocked_epoch_sample_reproduces_lost_link_after_real_store_atomic_publication() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let sampled = store
        .directory
        .open_single_link_regular_file(OsStr::new(FILE))?;
    let draft = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "explicit", &draft)?;
    std::thread::scope(|threads| -> Result<()> {
        threads
            .spawn(|| {
                store.save_subscription("actual-publish", 0, draft, &consent, Some(1000), 100)
            })
            .join()
            .unwrap()?;
        Ok(())
    })?;
    assert!(
        store
            .directory
            .portable_regular_handle_identity(&sampled)
            .is_err()
    );
    assert!(!store.observation_epoch()?.is_empty());
    Ok(())
}

#[test]
fn observation_epoch_holds_the_verified_reader_lock_through_sampling_and_real_publication()
-> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let writer = AutomationStore::open(&path, &actor)?;
    let draft = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "explicit", &draft)?;
    let before = store.observation_epoch()?;
    let sampled = store.observe_epoch(|file| {
        std::thread::scope(|threads| -> Result<()> {
            let write = threads.spawn(|| {
                writer.save_subscription(
                    "busy-publication",
                    0,
                    draft.clone(),
                    &consent,
                    Some(1000),
                    100,
                )
            });
            assert_eq!(
                write.join().unwrap().unwrap_err().to_string(),
                "AUTOMATION_BUSY"
            );
            assert!(
                store
                    .directory
                    .portable_regular_handle_identity(file)
                    .is_ok()
            );
            Ok(())
        })
    })?;
    assert_eq!(sampled, before);
    assert_eq!(store.observation_epoch()?, before);
    assert!(store.list_subscriptions(None)?.items.is_empty());
    writer.save_subscription(
        "actual-publication-after-read",
        0,
        draft,
        &consent,
        Some(1000),
        100,
    )?;
    let after = store.observation_epoch()?;
    assert_ne!(after, before);
    assert_eq!(
        AutomationStore::open(&path, &actor)?.observation_epoch()?,
        after
    );
    Ok(())
}

#[test]
fn observation_epoch_waits_only_the_existing_reader_deadline_and_never_publishes() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let original = std::fs::read(path.join(FILE))?;
    let lease = store
        .directory
        .try_existing_portable_lock(
            OsStr::new("automations.lock"),
            &store.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    let started = std::time::Instant::now();
    assert_eq!(
        store.observation_epoch().unwrap_err().to_string(),
        "AUTOMATION_BUSY"
    );
    assert!(started.elapsed() >= READ_LOCK_WAIT);
    drop(lease);
    assert!(!store.observation_epoch()?.is_empty());
    assert_eq!(std::fs::read(path.join(FILE))?, original);
    Ok(())
}

#[cfg(unix)]
#[test]
fn observation_epoch_rejects_uncooperative_rename_hardlink_and_atomic_replacement() -> Result<()> {
    for mutation in ["rename", "hardlink", "replace"] {
        let root = fixture_root()?;
        let actor = scope("alice");
        let path = root.path().join("private");
        let store = AutomationStore::create(&path, &actor)?;
        let original = std::fs::read(path.join(FILE))?;
        let result = store.observe_epoch(|_| {
            match mutation {
                "rename" => {
                    std::fs::rename(path.join(FILE), path.join("uncooperative-renamed.json"))?
                }
                "hardlink" => {
                    std::fs::hard_link(path.join(FILE), path.join("uncooperative-linked.json"))?
                }
                "replace" => store
                    .directory
                    .atomic_replace(OsStr::new(FILE), &original)?,
                _ => unreachable!(),
            }
            Ok(())
        });
        assert!(
            result.is_err(),
            "uncooperative {mutation} must not produce an epoch"
        );
    }
    Ok(())
}

#[test]
fn observation_epoch_keeps_scope_and_control_binding_checks() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    assert!(AutomationStore::open(&path, &scope("bob")).is_err());
    let original = std::fs::read(path.join(FILE))?;
    let mut foreign: serde_json::Value = serde_json::from_slice(&original)?;
    foreign["owner"]["accountId"] = "bob".into();
    store
        .directory
        .atomic_replace(OsStr::new(FILE), &serde_json::to_vec(&foreign)?)?;
    assert_eq!(
        store.observation_epoch().unwrap_err().to_string(),
        "AUTOMATION_SCOPE_MISMATCH"
    );
    store
        .directory
        .atomic_replace(OsStr::new(FILE), &original)?;
    let binding = std::fs::read(path.join("automation-binding.json"))?;
    store
        .directory
        .atomic_replace(OsStr::new("automation-binding.json"), &binding)?;
    assert!(store.observation_epoch().is_err());
    Ok(())
}
pub(super) fn scope(account: &str) -> IntegrationScope {
    IntegrationScope {
        account_id: account.into(),
        target_id: "local".into(),
        workspace_id: IntegrationNullable::Value("project".into()),
        identity_generation: "identity-1".into(),
        target_revision: "target-1".into(),
        organization_id: None,
    }
}
pub(super) fn draft() -> AutomationSubscriptionDraft {
    AutomationSubscriptionDraft {
        id: "weekly-report".into(),
        title: "项目周报".into(),
        workflow_id: "approved-flow".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({"project":"synthetic"}),
        schedule: Some(CronSchedule::Every { every_seconds: 60 }),
        event_source: None,
        maximum_tokens: 5000,
        period_budget: None,
        maximum_runtime_seconds: 120,
        delivery: AutomationDestination::Studio,
    }
}
#[test]
fn explicit_auto_intent_binds_original_consent_revision_reopen_and_run() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let legacy = draft();
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&actor, "legacy-consent", &legacy)?;
    store.save_subscription("legacy-save", 0, legacy.clone(), &consent, Some(1000), 100)?;
    let mut auto = legacy.clone();
    auto.model_selection = Some(IntegrationModelSelectionIntent::AutoPolicy {
        id: "personal-pool".into(),
        version: "original-policy-version".into(),
    });
    assert!(
        store
            .save_subscription("forged-reuse", 1, auto.clone(), &consent, Some(1000), 101)
            .is_err()
    );
    let approved = ApprovedAutomationConsent::from_explicit_user_action(
        &actor,
        "explicit-auto-consent",
        &auto,
    )?;
    assert!(
        store
            .save_subscription("legacy-save", 0, auto.clone(), &approved, Some(1000), 102)
            .is_err()
    );
    let saved =
        store.save_subscription("auto-save", 1, auto.clone(), &approved, Some(1000), 103)?;
    assert_eq!(saved.revision, 2);
    let mut changed = auto.clone();
    changed.model_selection = Some(IntegrationModelSelectionIntent::AutoPolicy {
        id: "personal-pool".into(),
        version: "different-policy-version".into(),
    });
    assert!(
        store
            .save_subscription(
                "changed-with-old-consent",
                2,
                changed,
                &approved,
                Some(1000),
                104
            )
            .is_err()
    );
    drop(store);
    let store = AutomationStore::open(&path, &actor)?;
    assert!(
        store
            .read_subscription_version(&legacy.id, 1)?
            .draft
            .model_selection
            .is_none()
    );
    assert_eq!(
        store.read_subscription(&auto.id)?.draft.model_selection,
        auto.model_selection
    );
    let run = store.prepare_run(
        &auto.id,
        2,
        "explicit-auto-trigger",
        json!({"due":1000}),
        Some(2000),
        1000,
    )?;
    assert_eq!(run.subscription_revision, 2);
    assert_eq!(
        store
            .read_subscription_version(&run.subscription_id, run.subscription_revision)?
            .draft
            .model_selection,
        auto.model_selection
    );
    assert_eq!(store.list_runs(None)?.items.len(), 1);
    Ok(())
}
#[test]
fn held_parent_creation_never_reopens_a_replaced_profile_path() -> Result<()> {
    let root = fixture_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let profile = parent.create_private_child(OsStr::new("profile"))?;
    std::fs::rename(root.path().join("profile"), root.path().join("old-profile"))?;
    parent.create_private_child(OsStr::new("profile"))?;
    AutomationStore::create_in(&profile, OsStr::new("private"), &scope("alice"))?;
    assert!(root.path().join("old-profile/private").is_dir());
    assert!(!root.path().join("profile/private").exists());
    assert!(
        AutomationStore::open_in(&profile, OsStr::new("private"), &scope("alice"))?
            .list_runs(None)?
            .items
            .is_empty()
    );
    Ok(())
}

#[test]
fn held_parent_open_is_read_only_and_rejects_path_escape() -> Result<()> {
    let root = fixture_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    assert!(AutomationStore::open_in(&parent, OsStr::new("missing"), &scope("alice")).is_err());
    assert!(AutomationStore::create_in(&parent, OsStr::new("../escape"), &scope("alice")).is_err());
    assert_eq!(std::fs::read_dir(root.path())?.count(), 0);
    Ok(())
}
#[test]
fn exact_consent_revision_and_no_run_on_save() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let actor = scope("alice");
    let store = AutomationStore::create(&path, &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent-1", &d)?;
    let saved = store.save_subscription("save", 0, d.clone(), &consent, Some(1000), 100)?;
    assert_eq!(saved.revision, 1);
    assert!(store.list_runs(None)?.items.is_empty());
    let mut altered = d.clone();
    altered.inputs = json!({"project":"changed"});
    assert!(
        store
            .save_subscription("bad", 1, altered, &consent, Some(1000), 100)
            .is_err()
    );
    assert_eq!(
        store
            .save_subscription("save", 0, d, &consent, Some(1000), 200)?
            .revision,
        1
    );
    assert!(
        store
            .set_subscription_enabled("bad-rev", "weekly-report", 0, false, None, 300)
            .is_err()
    );
    assert!(
        !store
            .set_subscription_enabled("pause", "weekly-report", 1, false, None, 300)?
            .enabled
    );
    assert!(
        store
            .prepare_run("weekly-report", 2, "paused", json!({"at":1000}), None, 1000)
            .is_err()
    );
    drop(store);
    assert!(
        !AutomationStore::open(&path, &actor)?
            .read_subscription("weekly-report")?
            .enabled
    );
    assert!(AutomationStore::open(&path, &scope("bob")).is_err());
    Ok(())
}
#[test]
fn acceptance_and_delivery_unknown_do_not_fabricate_completion() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, Some(1000), 100)?;
    let first = store.prepare_run(
        "weekly-report",
        1,
        "due-1000",
        json!({"at":1000}),
        Some(2000),
        1000,
    )?;
    assert_eq!(first.status, AutomationRunStatus::Preparing);
    assert_eq!(
        store
            .record_unknown(&first.id, "NATIVE_RECEIPT_UNCONFIRMED", 1001)?
            .status,
        AutomationRunStatus::Unknown
    );
    assert_eq!(
        store
            .prepare_run(
                "weekly-report",
                1,
                "due-1000",
                json!({"at":1000}),
                Some(2000),
                1002
            )?
            .native_operation_id,
        first.native_operation_id
    );
    store.record_native_acceptance(&first.id, "actual-thread", Some("actual-turn"), 1003)?;
    store.record_native_status(&first.id, AutomationRunStatus::Running, None, vec![], 1004)?;
    assert_eq!(
        store
            .record_native_status(
                &first.id,
                AutomationRunStatus::Completed,
                None,
                vec![],
                1005
            )?
            .status,
        AutomationRunStatus::Unknown
    );
    assert_eq!(
        store
            .record_native_status(
                &first.id,
                AutomationRunStatus::Completed,
                Some("已生成实际摘要。".into()),
                vec![],
                1006
            )?
            .delivery_status,
        AutomationDeliveryStatus::StudioAvailable
    );
    assert_eq!(
        store
            .record_delivery(
                &first.id,
                "delivery-1",
                AutomationDeliveryStatus::Pending,
                1007
            )?
            .delivery_status,
        AutomationDeliveryStatus::Pending
    );
    assert_eq!(
        store
            .record_delivery(
                &first.id,
                "delivery-1",
                AutomationDeliveryStatus::Unknown,
                1008
            )?
            .delivery_status,
        AutomationDeliveryStatus::Unknown
    );
    assert!(
        store
            .record_delivery(
                &first.id,
                "another-delivery",
                AutomationDeliveryStatus::Accepted,
                1009
            )
            .is_err()
    );
    assert!(
        store
            .record_native_status(&first.id, AutomationRunStatus::Running, None, vec![], 1010)
            .is_err()
    );
    Ok(())
}
#[test]
fn hidden_history_keeps_dedup_and_immutable_definition() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d.clone(), &consent, Some(1000), 100)?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "event-1",
        json!({"sourceRevision":"1"}),
        Some(2000),
        1000,
    )?;
    store.hide_run("hide", &run.id)?;
    assert!(store.list_runs(None)?.items.is_empty());
    assert!(
        store
            .prepare_run(
                "weekly-report",
                1,
                "event-1",
                json!({"sourceRevision":"2"}),
                Some(2000),
                1001
            )
            .is_err()
    );
    let mut updated = d;
    updated.workflow_version = 2;
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent-2", &updated)?;
    store.save_subscription("update", 1, updated, &consent, Some(3000), 2000)?;
    assert_eq!(
        store
            .read_subscription_version("weekly-report", 1)?
            .draft
            .workflow_version,
        1
    );
    assert_eq!(
        store
            .read_subscription_version("weekly-report", 2)?
            .draft
            .workflow_version,
        2
    );
    store.remove_subscription("remove", "weekly-report", 2)?;
    assert!(store.read_subscription("weekly-report").is_err());
    assert_eq!(
        store.read_run(&run.id)?.native_operation_id,
        run.native_operation_id
    );
    assert_eq!(
        store
            .read_subscription_version("weekly-report", 1)?
            .draft
            .workflow_version,
        1
    );
    drop(store);
    assert_eq!(
        AutomationStore::open(&path, &actor)?.read_run(&run.id)?.id,
        run.id
    );
    Ok(())
}
#[test]
fn duplicate_stale_and_concurrent_triggers_are_bounded() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, Some(1000), 100)?;
    assert!(
        store
            .prepare_run("weekly-report", 1, "early", json!({}), Some(2000), 999)
            .is_err()
    );
    assert!(
        store
            .prepare_run(
                "weekly-report",
                1,
                "too-old",
                json!({}),
                Some(700000000),
                699999999
            )
            .is_err()
    );
    let first = store.prepare_run("weekly-report", 1, "due", json!({}), Some(2000), 1000)?;
    assert_eq!(
        store
            .prepare_run("weekly-report", 1, "due", json!({}), Some(2000), 1000)?
            .id,
        first.id
    );
    assert!(
        store
            .prepare_run("weekly-report", 1, "another", json!({}), Some(3000), 2000)
            .unwrap_err()
            .to_string()
            .contains("BUSY")
    );
    Ok(())
}

#[test]
fn missing_committed_ledger_cannot_reset_subscription_or_trigger_dedup() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let actor = scope("alice");
    assert!(AutomationStore::open(&path, &actor).is_err());
    assert!(!path.exists());
    let store = AutomationStore::create(&path, &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, Some(1000), 100)?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "original-trigger",
        json!({}),
        Some(2000),
        1000,
    )?;
    std::fs::remove_file(path.join(FILE))?;
    assert!(store.read_run(&run.id).is_err());
    assert!(
        store
            .prepare_run(
                "weekly-report",
                1,
                "original-trigger",
                json!({}),
                Some(3000),
                2000
            )
            .is_err()
    );
    assert!(AutomationStore::open(&path, &actor).is_err());
    assert!(AutomationStore::create(&path, &actor).is_err());
    assert!(!path.join(FILE).exists());
    Ok(())
}
#[test]
fn missing_or_replaced_control_lock_is_not_recreated() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let actor = scope("alice");
    let store = AutomationStore::create(&path, &actor)?;
    let bytes = std::fs::read(path.join(FILE))?;
    std::fs::remove_file(path.join("automations.lock"))?;
    assert!(store.list_runs(None).is_err());
    assert!(!path.join("automations.lock").exists());
    let _replacement = store
        .directory
        .open_read_write_file(OsStr::new("automations.lock"), true)?;
    assert!(store.list_subscriptions(None).is_err());
    assert!(AutomationStore::open(&path, &actor).is_err());
    assert_eq!(std::fs::read(path.join(FILE))?, bytes);
    Ok(())
}

#[test]
fn pure_reader_waits_for_the_original_live_writer_and_returns_the_existing_record() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let draft = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "explicit", &draft)?;
    let saved = store.save_subscription("save", 0, draft, &consent, Some(1000), 100)?;
    let lease = store
        .directory
        .try_existing_portable_lock(
            OsStr::new("automations.lock"),
            &store.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    std::thread::scope(|threads| -> Result<()> {
        let (started, ready) = std::sync::mpsc::channel();
        let reader_store = &store;
        let reader = threads.spawn(move || {
            started.send(()).unwrap();
            reader_store.read_subscription("weekly-report")
        });
        ready.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        drop(lease);
        let read = reader.join().unwrap()?;
        assert_eq!(read.revision, saved.revision);
        assert_eq!(read.draft.inputs, saved.draft.inputs);
        assert!(read.enabled);
        Ok(())
    })?;
    Ok(())
}

#[test]
fn pure_reader_deadline_stays_busy_without_creating_empty_state() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let original = std::fs::read(path.join(FILE))?;
    let _lease = store
        .directory
        .try_existing_portable_lock(
            OsStr::new("automations.lock"),
            &store.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    let start = std::time::Instant::now();
    let error = store.list_runs(None).unwrap_err();
    assert_eq!(error.to_string(), "AUTOMATION_BUSY");
    assert!(start.elapsed() >= READ_LOCK_WAIT);
    assert_eq!(std::fs::read(path.join(FILE))?, original);
    Ok(())
}

#[test]
fn waiting_reader_rejects_lock_replacement_and_foreign_scope() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let original = std::fs::read(path.join(FILE))?;
    assert!(AutomationStore::open(&path, &scope("bob")).is_err());
    let _lease = store
        .directory
        .try_existing_portable_lock(
            OsStr::new("automations.lock"),
            &store.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    std::thread::scope(|threads| -> Result<()> {
        let (started, ready) = std::sync::mpsc::channel();
        let reader_store = &store;
        let reader = threads.spawn(move || {
            started.send(()).unwrap();
            reader_store.list_runs(None)
        });
        ready.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        store
            .directory
            .remove_regular_file(OsStr::new("automations.lock"))?;
        let replacement = store
            .directory
            .open_read_write_file(OsStr::new("automations.lock"), true)?;
        replacement.sync_all()?;
        let error = reader.join().unwrap().unwrap_err();
        assert!(
            matches!(
                error.to_string().as_str(),
                "AUTOMATION_STORE_LOCK_CHANGED"
                    | "portable lease ownership, links or mode is unsafe"
            ),
            "unexpected original-lock rejection: {error:#}"
        );
        Ok(())
    })?;
    assert_eq!(std::fs::read(path.join(FILE))?, original);
    Ok(())
}

#[test]
fn pure_reader_rejects_missing_original_lock_without_repair() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let original = std::fs::read(path.join(FILE))?;
    let binding = std::fs::read(path.join("automation-binding.json"))?;
    store
        .directory
        .remove_regular_file(OsStr::new("automations.lock"))?;
    assert_eq!(
        store.list_runs(None).unwrap_err().to_string(),
        "AUTOMATION_STORE_LOCK_CHANGED"
    );
    assert!(
        !path.join("automations.lock").exists(),
        "a reader cannot recreate a missing owner lock"
    );
    assert_eq!(std::fs::read(path.join(FILE))?, original);
    assert_eq!(
        std::fs::read(path.join("automation-binding.json"))?,
        binding
    );
    Ok(())
}

#[test]
fn contended_write_is_not_waited_or_replayed_by_the_read_policy() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let draft = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "explicit", &draft)?;
    store.save_subscription("save", 0, draft, &consent, Some(1000), 100)?;
    let original = std::fs::read(path.join(FILE))?;
    let lease = store
        .directory
        .try_existing_portable_lock(
            OsStr::new("automations.lock"),
            &store.binding.lock_identity,
            PrivateLeaseMode::Shared,
        )?
        .unwrap();
    assert_eq!(
        store
            .set_subscription_enabled("not-replayed", "weekly-report", 1, false, None, 200)
            .unwrap_err()
            .to_string(),
        "AUTOMATION_BUSY"
    );
    drop(lease);
    assert_eq!(std::fs::read(path.join(FILE))?, original);
    assert!(store.read_subscription("weekly-report")?.enabled);
    assert!(store.access(false, |data| Ok(
        !data.receipts.contains_key("not-replayed")
    ))?);
    Ok(())
}

#[test]
fn enabled_event_source_inventory_keeps_explicit_consents_and_excludes_schedules_and_disabled()
-> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let scheduled = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(
        &actor,
        "scheduled-consent",
        &scheduled,
    )?;
    store.save_subscription("scheduled-save", 0, scheduled, &consent, Some(1000), 100)?;
    assert!(store.enabled_event_source_refs()?.is_empty());
    let mut event = draft();
    event.id = "explicit-file-event".into();
    event.schedule = None;
    event.event_source = Some("native-selected-source".into());
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&actor, "file-consent", &event)?;
    store.save_subscription("event-save", 0, event, &consent, None, 100)?;
    assert_eq!(
        AutomationStore::open(&path, &actor)?.enabled_event_source_refs()?,
        vec!["native-selected-source"]
    );
    store.set_subscription_enabled(
        "explicit-disable",
        "explicit-file-event",
        1,
        false,
        None,
        200,
    )?;
    assert!(store.enabled_event_source_refs()?.is_empty());
    Ok(())
}
#[test]
fn lost_write_ack_keeps_original_subscription_receipt() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let actor = scope("alice");
    let store = AutomationStore::create(&path, &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store
        .ack_loss
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        store
            .save_subscription("save", 0, d.clone(), &consent, Some(1000), 100)
            .unwrap_err()
            .to_string(),
        "AUTOMATION_WRITE_UNCONFIRMED"
    );
    assert_eq!(store.read_subscription("weekly-report")?.revision, 1);
    assert_eq!(
        store
            .save_subscription("save", 0, d, &consent, Some(1000), 200)?
            .revision,
        1
    );
    Ok(())
}
#[test]
fn event_cursor_advances_only_after_durable_trigger_and_survives_reopen() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let mut d = draft();
    d.schedule = None;
    d.event_source = Some("approved-business-feed".into());
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, None, 100)?;
    assert!(
        store
            .validate_event_sequence("weekly-report", 1, "approved-business-feed", 2, "event-2")
            .is_err()
    );
    assert!(
        store
            .checkpoint_event(
                "weekly-report",
                1,
                "approved-business-feed",
                1,
                "event-1",
                "missing-run"
            )
            .is_err()
    );
    store.validate_event_sequence("weekly-report", 1, "approved-business-feed", 1, "event-1")?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "event-1",
        json!({"businessId":"fixture"}),
        None,
        200,
    )?;
    store.checkpoint_event(
        "weekly-report",
        1,
        "approved-business-feed",
        1,
        "event-1",
        &run.id,
    )?;
    assert!(store.claim_native_submission(&run.id)?);
    assert!(!store.claim_native_submission(&run.id)?);
    assert_eq!(store.unsettled_runs()?.len(), 1);
    assert_eq!(
        store.read_run_trigger_facts(&run.id)?,
        json!({"businessId":"fixture"})
    );
    let reopened = AutomationStore::open(&path, &actor)?;
    assert!(!reopened.claim_native_submission(&run.id)?);
    reopened.validate_event_sequence("weekly-report", 1, "approved-business-feed", 1, "event-1")?;
    assert!(
        reopened
            .validate_event_sequence("weekly-report", 1, "approved-business-feed", 1, "different")
            .is_err()
    );
    reopened.validate_event_sequence("weekly-report", 1, "approved-business-feed", 2, "event-2")?;
    assert!(
        reopened
            .validate_event_sequence("weekly-report", 1, "approved-business-feed", 3, "event-3")
            .is_err()
    );
    Ok(())
}
#[test]
fn subscription_receipt_reconciles_after_its_original_once_time_has_passed() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let mut d = draft();
    d.schedule = Some(CronSchedule::At {
        at: "2026-10-24T00:00:00Z".into(),
    });
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    let first = store.save_subscription("save", 0, d.clone(), &consent, Some(2000), 1000)?;
    assert_eq!(
        serde_json::to_value(store.save_subscription("save", 0, d, &consent, None, 3000)?)?,
        serde_json::to_value(first)?
    );
    Ok(())
}
#[test]
fn artifact_only_result_requires_frozen_native_revisions_for_external_delivery() -> Result<()> {
    use kcoder_types::integrations::core::{IntegrationEntityKind, IntegrationEntityRef};
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, Some(2000), 1000)?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "scheduled-2000",
        json!({}),
        Some(3000),
        2000,
    )?;
    store.record_native_acceptance(&run.id, "native-thread", Some("turn"), 2000)?;
    let mut artifact = IntegrationEntityRef {
        kind: IntegrationEntityKind::Artifact,
        id: "native-artifact".into(),
        revision: None,
    };
    assert!(
        store
            .record_artifact_manifests(&run.id, vec![artifact.clone()])
            .is_err()
    );
    artifact.revision = Some("immutable-v1".into());
    store.record_artifact_manifests(&run.id, vec![artifact.clone()])?;
    store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        None,
        vec![artifact.id.clone()],
        2001,
    )?;
    assert_eq!(store.read_artifact_manifests(&run.id)?, vec![artifact]);
    Ok(())
}
#[test]
fn full_native_acceptance_is_immutable_and_survives_reopen() -> Result<()> {
    use kcoder_types::integrations::core::{IntegrationRuntimeAcceptance, IntegrationTaskState};
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, Some(2000), 1000)?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "scheduled-2000",
        json!({}),
        Some(3000),
        2000,
    )?;
    let mut acceptance = IntegrationRuntimeAcceptance {
        thread_id: "actual-thread".into(),
        turn_id: None,
        task_id: None,
        state: IntegrationTaskState::Queued,
    };
    assert!(
        store
            .record_native_acceptance_receipt(&run.id, &acceptance, 2000)
            .is_err()
    );
    acceptance.task_id = Some("actual-task".into());
    store.record_native_acceptance_receipt(&run.id, &acceptance, 2000)?;
    let reopened = AutomationStore::open(&path, &actor)?;
    assert_eq!(
        reopened.read_native_acceptance(&run.id)?,
        Some(acceptance.clone())
    );
    acceptance.task_id = Some("another-task".into());
    assert!(
        reopened
            .record_native_acceptance_receipt(&run.id, &acceptance, 2001)
            .is_err()
    );
    Ok(())
}
#[test]
fn native_output_preview_has_an_exact_encoded_budget_and_keeps_native_reference() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, Some(2000), 1000)?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "scheduled-2000",
        json!({}),
        Some(3000),
        2000,
    )?;
    store.record_native_acceptance(&run.id, "actual-thread", Some("actual-turn"), 2000)?;
    let full = "\u{0001}".repeat(100000);
    let completed = store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some(full.clone()),
        vec![],
        2001,
    )?;
    assert_eq!(completed.status, AutomationRunStatus::Completed);
    let preview = completed.output.unwrap();
    assert!(preview.len() < full.len());
    assert!(serde_json::to_vec(&preview)?.len() <= 64 * 1024);
    assert_eq!(
        store
            .read_native_acceptance(&run.id)?
            .unwrap()
            .turn_id
            .as_deref(),
        Some("actual-turn")
    );

    Ok(())
}
#[test]
fn delayed_delivery_observation_cannot_resurrect_confirmed_cancellation() -> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let d = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&actor, "consent", &d)?;
    store.save_subscription("save", 0, d, &consent, Some(2000), 1000)?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "scheduled-2000",
        json!({}),
        Some(3000),
        2000,
    )?;
    store.record_native_acceptance(&run.id, "actual-thread", Some("actual-turn"), 2000)?;
    store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some("Actual fixture output".into()),
        vec![],
        2001,
    )?;
    store.record_delivery(
        &run.id,
        "delivery",
        AutomationDeliveryStatus::Cancelled,
        2002,
    )?;
    assert!(
        store
            .record_delivery(&run.id, "delivery", AutomationDeliveryStatus::Pending, 2003)
            .is_err()
    );
    assert_eq!(
        store.read_run(&run.id)?.delivery_status,
        AutomationDeliveryStatus::Cancelled
    );
    Ok(())
}

#[test]
fn million_unit_subscription_budget_round_trips_without_rewriting_existing_budget_or_starting_work()
-> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let actor = scope("alice");
    let store = AutomationStore::create(&path, &actor)?;
    let original = draft();
    let consent = ApprovedAutomationConsent::from_explicit_user_action(
        &actor,
        "original-budget-consent",
        &original,
    )?;
    let old = store.save_subscription(
        "save-original-budget",
        0,
        original,
        &consent,
        Some(1000),
        100,
    )?;
    let mut large = draft();
    large.id = "new-million-budget".into();
    large.maximum_tokens = 1_000_000;
    AutomationStore::validate_subscription_draft(&large)?;
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&actor, "new-budget-consent", &large)?;
    let saved = store.save_subscription(
        "save-new-million-budget",
        0,
        large.clone(),
        &consent,
        Some(1000),
        100,
    )?;
    assert_eq!(saved.draft.maximum_tokens, 1_000_000);
    assert_eq!(
        store.read_subscription(&old.draft.id)?.draft.maximum_tokens,
        5000
    );
    assert!(store.list_runs(None)?.items.is_empty());
    drop(store);
    let reopened = AutomationStore::open(&path, &actor)?;
    assert_eq!(
        reopened
            .read_subscription("new-million-budget")?
            .draft
            .maximum_tokens,
        1_000_000
    );
    assert_eq!(
        reopened
            .read_subscription(&old.draft.id)?
            .draft
            .maximum_tokens,
        5000
    );
    assert_eq!(
        reopened
            .read_subscription_version(&old.draft.id, old.revision)?
            .draft
            .maximum_tokens,
        5000
    );
    assert!(reopened.list_runs(None)?.items.is_empty());
    Ok(())
}

#[test]
fn native_budget_observation_keeps_original_running_and_failed_facts_without_releasing_or_replaying()
-> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let original = draft();
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&actor, "explicit-budget", &original)?;
    store.save_subscription("save-budget-run", 0, original, &consent, Some(1000), 100)?;
    let run = store.prepare_run(
        "weekly-report",
        1,
        "original-trigger",
        json!({"due":1000}),
        Some(2000),
        1000,
    )?;
    assert!(
        store
            .record_observed_budget_exhaustion(&run.id, 1001)
            .is_err()
    );
    assert!(store.claim_native_submission(&run.id)?);
    // State trusts its native consumer; this fixture is metadata, never proof of
    // an actual Core acceptance. The CLI regression supplies that real receipt.
    let acceptance = kcoder_types::integrations::core::IntegrationRuntimeAcceptance {
        thread_id: "original-thread".into(),
        turn_id: None,
        task_id: Some("original-workflow".into()),
        state: kcoder_types::integrations::core::IntegrationTaskState::Queued,
    };
    store.record_native_acceptance_receipt(&run.id, &acceptance, 1001)?;
    let observed = store.record_observed_budget_exhaustion(&run.id, 1002)?;
    assert_eq!(observed.status, AutomationRunStatus::Accepted);
    assert_eq!(
        observed.error_code.as_deref(),
        Some("AUTOMATION_BUDGET_EXHAUSTED")
    );
    let running =
        store.record_native_status(&run.id, AutomationRunStatus::Running, None, vec![], 1003)?;
    assert_eq!(running.error_code, observed.error_code);
    let failed =
        store.record_native_status(&run.id, AutomationRunStatus::Failed, None, vec![], 1004)?;
    assert_eq!(failed.error_code, observed.error_code);
    assert_eq!(failed.status, AutomationRunStatus::Failed);
    assert_eq!(store.list_runs(None)?.items.len(), 1);
    assert_eq!(
        store.read_native_acceptance(&run.id)?.as_ref(),
        Some(&acceptance)
    );
    assert!(!store.claim_native_submission(&run.id)?);
    Ok(())
}

#[test]
fn explicit_period_configuration_is_bound_to_original_consent_and_cannot_reset_its_window()
-> Result<()> {
    let root = fixture_root()?;
    let actor = scope("period-owner");
    let store = AutomationStore::create(&root.path().join("private"), &actor)?;
    let mut original = draft();
    let before = serde_json::to_value(&original)?;
    assert!(before.get("periodBudget").is_none());
    original.period_budget = Some(
        kcoder_types::integrations::knowledge::AutomationPeriodBudget {
            window_seconds: 60,
            maximum_tokens: 1000,
            maximum_model_calls: 5,
        },
    );
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&actor, "explicit-period", &original)?;
    let saved = store.save_subscription(
        "save-period",
        0,
        original.clone(),
        &consent,
        Some(2000),
        1000,
    )?;
    assert!(store.list_runs(None)?.items.is_empty());
    let mut changed = original.clone();
    changed.period_budget.as_mut().unwrap().maximum_tokens = 2000;
    assert!(
        store
            .save_subscription(
                "wrong-consent",
                saved.revision,
                changed.clone(),
                &consent,
                Some(3000),
                2000
            )
            .is_err()
    );
    changed.period_budget.as_mut().unwrap().window_seconds = 30;
    assert!(store.validate_period_configuration(&changed).is_err());
    changed.period_budget = None;
    assert!(store.validate_period_configuration(&changed).is_err());
    store.remove_subscription("remove-period", &original.id, saved.revision)?;
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&actor, "recreate-period", &original)?;
    assert!(
        store
            .save_subscription("recreate-period", 0, original, &consent, Some(3000), 2000)
            .is_err()
    );
    Ok(())
}

#[test]
fn delivery_polling_reopens_legacy_current_versions_without_rewriting_the_original_result()
-> Result<()> {
    let root = fixture_root()?;
    let actor = scope("alice");
    let path = root.path().join("private");
    let store = AutomationStore::create(&path, &actor)?;
    let mut selected = draft();
    selected.delivery = AutomationDestination::Channel {
        destination_ref: "original-destination".into(),
        destination_revision: "1".into(),
    };
    let consent = ApprovedAutomationConsent::from_explicit_user_action(
        &actor,
        "explicit-legacy-consent",
        &selected,
    )?;
    store.save_subscription(
        "original-save",
        0,
        selected.clone(),
        &consent,
        Some(1000),
        100,
    )?;
    let run = store.prepare_run(
        &selected.id,
        1,
        "original-event",
        json!({}),
        Some(2000),
        1000,
    )?;
    store.record_native_acceptance(
        &run.id,
        "declared-legacy-fixture-thread",
        Some("declared-legacy-fixture-turn"),
        1001,
    )?;
    store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some("Declared legacy result fixture".into()),
        vec![],
        1002,
    )?;
    let mut legacy: Value = serde_json::from_slice(&std::fs::read(path.join(FILE))?)?;
    assert!(
        legacy
            .as_object_mut()
            .unwrap()
            .remove("subscriptionVersions")
            .is_some()
    );
    store
        .directory
        .atomic_replace(OsStr::new(FILE), &serde_json::to_vec(&legacy)?)?;
    let reopened = AutomationStore::open(&path, &actor)?;
    let before = std::fs::read(path.join(FILE))?;
    let page = reopened.pending_delivery_runs(None)?;
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, run.id);
    assert_eq!(page.items[0].status, AutomationRunStatus::Completed);
    assert_eq!(before, std::fs::read(path.join(FILE))?);
    Ok(())
}
