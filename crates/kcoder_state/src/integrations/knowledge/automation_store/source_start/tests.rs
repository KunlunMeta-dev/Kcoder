//! Controlled native witnesses exercise the original storage transaction, not OS/source authorization.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
struct Witness {
    owner: KnowledgeOwner,
    after: u64,
    valid: AtomicBool,
}
impl VerifiedAutomationSourceStart for Witness {
    fn verify_for_owner(&self, owner: &KnowledgeOwner) -> Result<()> {
        ensure!(
            *owner == self.owner && self.valid.load(Ordering::SeqCst),
            "CONTROLLED_SOURCE_REVOKED"
        );
        Ok(())
    }
    fn source_ref(&self) -> &str {
        "connection-event-unit-source"
    }
    fn after_sequence(&self) -> u64 {
        self.after
    }
}
fn fixture() -> Result<(
    tempfile::TempDir,
    AutomationStore,
    IntegrationScope,
    AutomationSubscriptionDraft,
)> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let scope: IntegrationScope = serde_json::from_value(
        json!({"accountId":"owned","targetId":"native","workspaceId":null,"identityGeneration":"1","targetRevision":"1"}),
    )?;
    let store = AutomationStore::create(&root.path().join("automation"), &scope)?;
    let draft = AutomationSubscriptionDraft {
        id: "original-subscription".into(),
        title: "Business source".into(),
        workflow_id: "fixed".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({}),
        schedule: None,
        event_source: Some("connection-event-unit-source".into()),
        maximum_tokens: 100,
        period_budget: None,
        maximum_runtime_seconds: 30,
        delivery: AutomationDestination::Studio,
    };
    Ok((root, store, scope, draft))
}
fn witness(scope: &IntegrationScope, after: u64) -> Arc<Witness> {
    Arc::new(Witness {
        owner: scope.into(),
        after,
        valid: AtomicBool::new(true),
    })
}
fn facts(sequence: u64) -> Value {
    json!({"kind":"connection_business_event","sourceRef":"connection-event-unit-source","inboxSequence":sequence})
}
#[test]
fn native_source_start_is_saved_per_revision_and_old_records_never_activate_a_new_revision()
-> Result<()> {
    let (root, store, scope, draft) = fixture()?;
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&scope, "explicit", &draft)?;
    assert!(
        store
            .save_subscription("no-native-start", 0, draft.clone(), &consent, None, 1000)
            .is_err()
    );
    let start = witness(&scope, 17);
    let consent = consent.with_native_source_start(start)?;
    let sub = store.save_subscription("original-save", 0, draft.clone(), &consent, None, 1000)?;
    assert!(matches!(
        store.observe_inbox_event(
            &draft.id,
            1,
            "connection-event-unit-source",
            "before",
            &facts(17)
        )?,
        AutomationInboxEventDisposition::BeforeStart
    ));
    assert!(
        store
            .admit_verified_inbox_event(
                &draft.id,
                1,
                "connection-event-unit-source",
                "before",
                1000,
                &facts(17),
                None,
                0,
                1000
            )
            .unwrap_err()
            .to_string()
            .contains("BEFORE_SUBSCRIPTION")
    );
    assert_eq!(
        store
            .admit_verified_inbox_event(
                &draft.id,
                1,
                "connection-event-unit-source",
                "after",
                1000,
                &facts(18),
                None,
                0,
                1000
            )?
            .0,
        1
    );
    let run = store.prepare_run(&draft.id, 1, "after", facts(18), None, 1000)?;
    store.checkpoint_event(
        &draft.id,
        1,
        "connection-event-unit-source",
        1,
        "after",
        &run.id,
    )?;
    let paused =
        store.set_subscription_enabled("pause", &draft.id, sub.revision, false, None, 1100)?;
    assert!(!paused.enabled);
    assert!(
        store
            .set_subscription_enabled(
                "missing-enable-source",
                &draft.id,
                paused.revision,
                true,
                None,
                1200
            )
            .is_err()
    );
    let enabled = store.set_subscription_enabled_with_source_start(
        "enable",
        &draft.id,
        paused.revision,
        true,
        None,
        1200,
        Some(witness(&scope, 99)),
    )?;
    assert_eq!(enabled.revision, 3);
    match store.observe_inbox_event(
        &draft.id,
        3,
        "connection-event-unit-source",
        "after",
        &facts(18),
    )? {
        AutomationInboxEventDisposition::Existing(original) => assert_eq!(original.id, run.id),
        _ => panic!("original receipt was not retained"),
    }
    assert!(matches!(
        store.observe_inbox_event(
            &draft.id,
            3,
            "connection-event-unit-source",
            "during-pause",
            &facts(99)
        )?,
        AutomationInboxEventDisposition::BeforeStart
    ));
    assert_eq!(
        store
            .admit_verified_inbox_event(
                &draft.id,
                3,
                "connection-event-unit-source",
                "new-generation",
                1200,
                &facts(100),
                None,
                0,
                12_000
            )?
            .0,
        1
    );
    let reopened = AutomationStore::open(&root.path().join("automation"), &scope)?;
    assert!(
        reopened
            .verify_inbox_source_start(&draft.id, 3, "connection-event-unit-source", 99)
            .is_err()
    );
    reopened.verify_inbox_source_start(&draft.id, 3, "connection-event-unit-source", 100)?;
    assert_eq!(reopened.list_runs(None)?.items.len(), 1);
    Ok(())
}
#[test]
fn operation_replay_keeps_its_original_start_and_revoked_witness_cannot_commit() -> Result<()> {
    let (root, store, scope, draft) = fixture()?;
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&scope, "explicit", &draft)?
        .with_native_source_start(witness(&scope, 17))?;
    store.save_subscription("same-save", 0, draft.clone(), &consent, None, 1000)?;
    let later = ApprovedAutomationConsent::from_explicit_user_action(&scope, "explicit", &draft)?
        .with_native_source_start(witness(&scope, 999))?;
    assert_eq!(
        store
            .save_subscription("same-save", 0, draft.clone(), &later, None, 2000)?
            .revision,
        1
    );
    store.verify_inbox_source_start(&draft.id, 1, "connection-event-unit-source", 18)?;
    let changed = witness(&scope, 1000);
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&scope, "explicit-edit", &draft)?
            .with_native_source_start(changed.clone())?;
    changed.valid.store(false, Ordering::SeqCst);
    let before = std::fs::read(root.path().join("automation").join(FILE))?;
    assert!(
        store
            .save_subscription(
                "revoke-before-commit",
                1,
                draft.clone(),
                &consent,
                None,
                3000
            )
            .is_err()
    );
    assert_eq!(
        before,
        std::fs::read(root.path().join("automation").join(FILE))?
    );
    assert_eq!(store.read_subscription(&draft.id)?.revision, 1);
    Ok(())
}

#[test]
fn feed_start_reads_only_enabled_revision_origins_without_advancing_or_replaying() -> Result<()> {
    let (root, store, scope, draft) = fixture()?;
    assert_eq!(
        store.inbox_source_feed_start("connection-event-unit-source")?,
        None
    );
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&scope, "first-explicit", &draft)?
            .with_native_source_start(witness(&scope, 17))?;
    store.save_subscription("first-save", 0, draft.clone(), &consent, None, 1000)?;
    let mut second = draft.clone();
    second.id = "second-subscription".into();
    let consent =
        ApprovedAutomationConsent::from_explicit_user_action(&scope, "second-explicit", &second)?
            .with_native_source_start(witness(&scope, 99))?;
    store.save_subscription("second-save", 0, second.clone(), &consent, None, 1001)?;
    let before = std::fs::read(root.path().join("automation").join(FILE))?;
    assert_eq!(
        store.inbox_source_feed_start("connection-event-unit-source")?,
        Some(17)
    );
    assert_eq!(
        before,
        std::fs::read(root.path().join("automation").join(FILE))?
    );
    store.set_subscription_enabled("pause-first", &draft.id, 1, false, None, 1002)?;
    assert_eq!(
        store.inbox_source_feed_start("connection-event-unit-source")?,
        Some(99)
    );
    store.set_subscription_enabled("pause-second", &second.id, 1, false, None, 1003)?;
    assert_eq!(
        store.inbox_source_feed_start("connection-event-unit-source")?,
        None
    );
    assert!(store.list_runs(None)?.items.is_empty());
    Ok(())
}
