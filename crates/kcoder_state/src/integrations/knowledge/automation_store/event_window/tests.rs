use super::*;

#[test]
fn quarantine_pages_observe_original_facts_without_replaying_or_advancing_events() -> Result<()> {
    let (root, scope, store, _) = fixture()?;
    let now = MAX_EVENT_AGE_MS + 60_000;
    for index in 0..12 {
        assert!(admit(&store, 1, &format!("old-event-{index:02}"), 0, now).is_err());
    }
    assert!(admit(&store, 1, "future-event", now + MAX_FUTURE_SKEW_MS + 1, now).is_err());
    let path = root.path().join("automation");
    let before = std::fs::read(path.join(FILE))?;
    let first = store.list_quarantined_events(None)?;
    assert_eq!(first.items.len(), 10);
    let second = store.list_quarantined_events(first.next_cursor.as_deref())?;
    assert_eq!(second.items.len(), 3);
    assert!(second.next_cursor.is_none());
    let mut all = first.items.clone();
    all.extend(second.items.clone());
    assert!(all.windows(2).all(|pair| pair[0].id < pair[1].id));
    assert_eq!(
        all.iter()
            .filter(|event| event.reason_code == "AUTOMATION_EVENT_STALE_QUARANTINED")
            .count(),
        12
    );
    assert!(all.iter().any(
        |event| event.reason_code == "AUTOMATION_EVENT_CLOCK_QUARANTINED"
            && event.occurred_at_ms == now + MAX_FUTURE_SKEW_MS + 1
    ));
    assert!(
        all.iter()
            .filter(|event| event.event_id.starts_with("old-event"))
            .all(|event| event.occurred_at_ms == 0)
    );
    assert!(store.list_runs(None)?.items.is_empty());
    assert_eq!(
        store.next_event_sequence("sub", 1, "selected-file-source", "new-event")?,
        Some(1)
    );
    let serialized = serde_json::to_string(&all)?;
    assert!(!serialized.contains("factsSha256"));
    assert!(!serialized.contains("originatingSubscription"));
    assert_eq!(std::fs::read(path.join(FILE))?, before);
    drop(store);
    let reopened = AutomationStore::open(&path, &scope)?;
    assert_eq!(reopened.list_quarantined_events(None)?.items, first.items);
    assert!(
        admit(&reopened, 1, "old-event-00", 0, now)
            .unwrap_err()
            .to_string()
            .contains("QUARANTINED")
    );
    assert_eq!(std::fs::read(path.join(FILE))?, before);
    reopened.remove_subscription("remove-future-definition", "sub", 1)?;
    let after_removal = std::fs::read(path.join(FILE))?;
    assert_eq!(reopened.list_quarantined_events(None)?.items, first.items);
    assert!(reopened.list_runs(None)?.items.is_empty());
    assert_eq!(std::fs::read(path.join(FILE))?, after_removal);
    Ok(())
}

#[test]
fn malformed_original_quarantine_fact_is_not_a_successful_empty_page() -> Result<()> {
    let (_root, _scope, store, _) = fixture()?;
    assert!(admit(&store, 1, "old-event", 0, MAX_EVENT_AGE_MS + 1).is_err());
    store.access(true, |data| {
        data.quarantined_events
            .values_mut()
            .next()
            .unwrap()
            .intent
            .as_object_mut()
            .unwrap()
            .remove("occurredAtMs");
        Ok(())
    })?;
    assert!(
        store
            .list_quarantined_events(None)
            .unwrap_err()
            .to_string()
            .contains("FACT_INVALID")
    );
    Ok(())
}

fn fixture() -> Result<(
    tempfile::TempDir,
    IntegrationScope,
    AutomationStore,
    AutomationSubscription,
)> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let scope: IntegrationScope = serde_json::from_value(json!({"accountId":"event-owner",
        "targetId":"event-target","workspaceId":null,"identityGeneration":"1","targetRevision":"1"}))?;
    let store = AutomationStore::create(&root.path().join("automation"), &scope)?;
    let draft = AutomationSubscriptionDraft {
        id: "sub".into(),
        title: "Event test".into(),
        workflow_id: "fixed-workflow".into(),
        workflow_version: 1,
        model_selection: None,
        inputs: json!({}),
        schedule: None,
        event_source: Some("selected-file-source".into()),
        maximum_tokens: 100,
        period_budget: None,
        maximum_runtime_seconds: 30,
        delivery: AutomationDestination::Studio,
    };
    let consent = ApprovedAutomationConsent::from_explicit_user_action(&scope, "consent", &draft)?;
    let sub = store.save_subscription("save", 0, draft, &consent, None, 1000)?;
    Ok((root, scope, store, sub))
}
fn admit(store: &AutomationStore, sequence: u64, id: &str, at: u64, now: u64) -> Result<()> {
    store.admit_verified_event(
        "sub",
        1,
        "selected-file-source",
        sequence,
        id,
        at,
        &json!({"resourceRef":"approved-input"}),
        None,
        0,
        now,
    )
}
fn finish(store: &AutomationStore, sequence: u64, id: &str, at: u64) -> Result<()> {
    admit(store, sequence, id, at, at)?;
    let run = store.prepare_run(
        "sub",
        1,
        id,
        json!({"resourceRef":"approved-input"}),
        None,
        at,
    )?;
    store.checkpoint_event("sub", 1, "selected-file-source", sequence, id, &run.id)?;
    store.record_native_acceptance(&run.id, "native-thread", Some(id), at)?;
    store.record_native_status(
        &run.id,
        AutomationRunStatus::Completed,
        Some("Verified local fixture".into()),
        vec![],
        at,
    )?;
    Ok(())
}

#[test]
fn admission_replay_reopen_and_minimum_interval_preserve_original_cursor() -> Result<()> {
    let (root, scope, store, _) = fixture()?;
    finish(&store, 1, "event-1", 1000)?;
    admit(&store, 1, "event-1", 1000, 1001)?;
    assert!(
        admit(&store, 2, "event-2", 1001, 1001)
            .unwrap_err()
            .to_string()
            .contains("MIN_INTERVAL")
    );
    assert_eq!(
        store.next_event_sequence("sub", 1, "selected-file-source", "event-2")?,
        Some(2)
    );
    drop(store);
    let store = AutomationStore::open(&root.path().join("automation"), &scope)?;
    admit(&store, 1, "event-1", 1000, 1002)?;
    finish(&store, 2, "event-2", 11_000)?;
    assert_eq!(store.list_runs(None)?.items.len(), 2);
    assert_eq!(
        store.next_event_sequence("sub", 1, "selected-file-source", "event-2")?,
        None
    );
    Ok(())
}

#[test]
fn storm_window_is_durable_and_does_not_acknowledge_rejected_events() -> Result<()> {
    let (root, scope, store, _) = fixture()?;
    for (index, at) in [1000, 11_000, 21_000, 31_000].into_iter().enumerate() {
        finish(&store, index as u64 + 1, &format!("event-{index}"), at)?;
    }
    drop(store);
    let store = AutomationStore::open(&root.path().join("automation"), &scope)?;
    assert!(
        admit(&store, 5, "event-next", 41_000, 41_000)
            .unwrap_err()
            .to_string()
            .contains("STORM_BACKPRESSURE")
    );
    assert_eq!(
        store.next_event_sequence("sub", 1, "selected-file-source", "event-next")?,
        Some(5)
    );
    finish(&store, 5, "event-next", 61_000)?;
    assert_eq!(store.list_runs(None)?.items.len(), 5);
    Ok(())
}

#[test]
fn stale_and_future_events_are_quarantined_without_payload_or_task_creation() -> Result<()> {
    let (root, scope, store, _) = fixture()?;
    let secret_facts = json!({"resourceRef":"sensitive-not-persisted"});
    let call = |now| {
        store.admit_verified_event(
            "sub",
            1,
            "selected-file-source",
            1,
            "old-event",
            1,
            &secret_facts,
            None,
            0,
            now,
        )
    };
    assert!(
        call(MAX_EVENT_AGE_MS + 2)
            .unwrap_err()
            .to_string()
            .contains("STALE_QUARANTINED")
    );
    assert!(
        call(2)
            .unwrap_err()
            .to_string()
            .contains("STALE_QUARANTINED")
    );
    assert!(
        !std::fs::read_to_string(root.path().join("automation/automations.json"))?
            .contains("sensitive-not-persisted")
    );
    assert!(
        admit(&store, 1, "future-event", 40_000, 1000)
            .unwrap_err()
            .to_string()
            .contains("CLOCK_QUARANTINED")
    );
    drop(store);
    let store = AutomationStore::open(&root.path().join("automation"), &scope)?;
    assert!(
        admit(&store, 1, "future-event", 40_000, 40_000)
            .unwrap_err()
            .to_string()
            .contains("CLOCK_QUARANTINED")
    );
    assert!(store.list_runs(None)?.items.is_empty());
    Ok(())
}

#[test]
fn same_event_intent_conflicts_and_own_output_or_deep_causation_is_rejected() -> Result<()> {
    let (_root, _scope, store, _sub) = fixture()?;
    admit(&store, 1, "event-1", 1000, 1000)?;
    assert!(
        store
            .admit_verified_event(
                "sub",
                1,
                "selected-file-source",
                1,
                "event-1",
                1000,
                &json!({"resourceRef":"different"}),
                None,
                0,
                1000
            )
            .unwrap_err()
            .to_string()
            .contains("TRIGGER_CONFLICT")
    );
    for (origin, depth) in [(Some("sub"), 0), (None, 9)] {
        assert!(
            store
                .admit_verified_event(
                    "sub",
                    1,
                    "selected-file-source",
                    1,
                    "loop",
                    1000,
                    &json!({}),
                    origin,
                    depth,
                    1000
                )
                .unwrap_err()
                .to_string()
                .contains("LOOP_REJECTED")
        );
    }
    let paused = store.set_subscription_enabled("pause", "sub", 1, false, None, 1001)?;
    assert_eq!(paused.revision, 2);
    assert!(
        admit(&store, 1, "event-1", 1000, 1002)
            .unwrap_err()
            .to_string()
            .contains("DISABLED")
    );
    Ok(())
}

#[test]
fn inbox_projection_admission_reuses_original_sequence_and_waits_for_pending_checkpoint()
-> Result<()> {
    let (root, scope, store, _) = inbox_fixture()?;
    let first_facts = json!({"inboxSequence":17,"eventId":"original-first"});
    let second_facts = json!({"inboxSequence":91,"eventId":"original-second"});
    let admit_inbox = |store: &AutomationStore, id: &str, facts: &Value, now| {
        store.admit_verified_inbox_event(
            "sub",
            1,
            "selected-file-source",
            id,
            1000,
            facts,
            None,
            0,
            now,
        )
    };
    assert_eq!(admit_inbox(&store, "first", &first_facts, 1000)?.0, 1);
    assert_eq!(admit_inbox(&store, "first", &first_facts, 1001)?.0, 1);
    assert!(
        admit_inbox(&store, "second", &second_facts, 11_000)
            .unwrap_err()
            .to_string()
            .contains("ADMISSION_PENDING")
    );
    let reopened = AutomationStore::open(&root.path().join("automation"), &scope)?;
    assert_eq!(admit_inbox(&reopened, "first", &first_facts, 1002)?.0, 1);
    assert!(admit_inbox(&reopened, "second", &second_facts, 11_000).is_err());
    assert!(store.list_runs(None)?.items.is_empty());
    let first = store.prepare_run("sub", 1, "first", first_facts.clone(), None, 1000)?;
    assert!(
        admit_inbox(&reopened, "second", &second_facts, 11_000)
            .unwrap_err()
            .to_string()
            .contains("ADMISSION_PENDING")
    );
    store.checkpoint_event("sub", 1, "selected-file-source", 1, "first", &first.id)?;
    assert_eq!(
        admit_inbox(&reopened, "second", &second_facts, 11_000)?.0,
        2
    );
    assert_eq!(
        admit_inbox(&store, "first", &first_facts, 12_000)?,
        (1, true)
    );
    assert!(admit_inbox(&store, "first", &second_facts, 12_000).is_err());
    assert_eq!(store.read_run_trigger_facts(&first.id)?, first_facts);
    // The original file-event path still rejects a noncontiguous caller sequence.
    assert!(
        admit(&store, 99, "cannot-skip", 1000, 21_000)
            .unwrap_err()
            .to_string()
            .contains("CURSOR_GAP")
    );
    Ok(())
}

#[test]
fn concurrent_inbox_projection_retries_share_the_original_locked_admission_sequence() -> Result<()>
{
    let (root, scope, _, _) = inbox_fixture()?;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(6));
    let jobs: Vec<_> = (0..6)
        .map(|_| {
            let directory = root.path().join("automation");
            let scope = scope.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || -> Result<(u64, bool)> {
                let store = AutomationStore::open(&directory, &scope)?;
                barrier.wait();
                store.admit_verified_inbox_event(
                    "sub",
                    1,
                    "selected-file-source",
                    "original",
                    1000,
                    &json!({"inboxSequence":700}),
                    None,
                    0,
                    1000,
                )
            })
        })
        .collect();
    let mut accepted = 0;
    for job in jobs {
        match job.join().unwrap() {
            Ok((sequence, checkpointed)) => {
                assert_eq!(sequence, 1);
                assert!(!checkpointed);
                accepted += 1;
            }
            Err(error) => assert!(error.to_string().contains("AUTOMATION_BUSY")),
        }
    }
    assert!(accepted > 0);
    let store = AutomationStore::open(&root.path().join("automation"), &scope)?;
    assert_eq!(
        store.admit_verified_inbox_event(
            "sub",
            1,
            "selected-file-source",
            "original",
            1000,
            &json!({"inboxSequence":700}),
            None,
            0,
            1001
        )?,
        (1, false)
    );
    assert!(store.list_runs(None)?.items.is_empty());
    assert_eq!(
        store.next_event_sequence("sub", 1, "selected-file-source", "not-admitted")?,
        Some(1)
    );
    Ok(())
}

fn inbox_fixture() -> Result<(
    tempfile::TempDir,
    IntegrationScope,
    AutomationStore,
    AutomationSubscription,
)> {
    let (root, scope, store, sub) = fixture()?;
    store.access(true, |data| {
        data.native_source_starts.insert(
            version_key("sub", 1)?,
            serde_json::from_value(json!({"sourceRef":"selected-file-source","afterSequence":0}))?,
        );
        Ok(())
    })?;
    Ok((root, scope, store, sub))
}

#[test]
fn native_inbox_storm_retry_keeps_original_facts_and_contiguous_projection_after_backpressure()
-> Result<()> {
    let (root, scope, store, _) = inbox_fixture()?;
    for (index, at) in [1000, 11_000, 21_000, 31_000].into_iter().enumerate() {
        let id = format!("native-{index}");
        let facts = json!({"inboxSequence":10*(index+1),"originalEvent":id});
        let (sequence, _) = store.admit_verified_inbox_event(
            "sub",
            1,
            "selected-file-source",
            &id,
            at,
            &facts,
            None,
            0,
            at,
        )?;
        let run = store.prepare_run("sub", 1, &id, facts, None, at)?;
        store.checkpoint_event("sub", 1, "selected-file-source", sequence, &id, &run.id)?;
        store.record_native_acceptance(&run.id, &format!("thread-{index}"), Some(&id), at)?;
        store.record_native_status(
            &run.id,
            AutomationRunStatus::Completed,
            Some("declared State receipt fixture".into()),
            vec![],
            at,
        )?;
    }
    let facts = json!({"inboxSequence":999,"originalEvent":"original-fifth"});
    assert!(
        store
            .admit_verified_inbox_event(
                "sub",
                1,
                "selected-file-source",
                "original-fifth",
                41_000,
                &facts,
                None,
                0,
                41_000
            )
            .unwrap_err()
            .to_string()
            .contains("STORM_BACKPRESSURE")
    );
    assert_eq!(
        store.inbox_source_feed_start("selected-file-source")?,
        Some(0)
    );
    assert_eq!(
        store.next_event_sequence("sub", 1, "selected-file-source", "original-fifth")?,
        Some(5)
    );
    let reopened = AutomationStore::open(&root.path().join("automation"), &scope)?;
    assert_eq!(
        reopened.admit_verified_inbox_event(
            "sub",
            1,
            "selected-file-source",
            "original-fifth",
            41_000,
            &facts,
            None,
            0,
            61_000
        )?,
        (5, false)
    );
    let run = reopened.prepare_run("sub", 1, "original-fifth", facts.clone(), None, 61_000)?;
    reopened.checkpoint_event(
        "sub",
        1,
        "selected-file-source",
        5,
        "original-fifth",
        &run.id,
    )?;
    assert_eq!(reopened.read_run_trigger_facts(&run.id)?, facts);
    assert_eq!(
        reopened.admit_verified_inbox_event(
            "sub",
            1,
            "selected-file-source",
            "original-fifth",
            41_000,
            &facts,
            None,
            0,
            62_000
        )?,
        (5, true)
    );
    assert_eq!(reopened.list_runs(None)?.items.len(), 5);
    Ok(())
}

#[test]
fn recorded_resource_observation_keeps_original_position_after_reopen_and_later_events()
-> Result<()> {
    let (root, scope, store, _) = fixture()?;
    assert!(
        store
            .recorded_event_position("sub", 1, "selected-file-source", "revision-a")?
            .is_none()
    );
    admit(&store, 1, "revision-a", 1000, 1000)?;
    assert_eq!(
        store.recorded_event_position("sub", 1, "selected-file-source", "revision-a")?,
        Some((1, 1000, false))
    );
    finish(&store, 1, "revision-a", 1000)?;
    finish(&store, 2, "revision-b", 11_000)?;
    drop(store);
    let store = AutomationStore::open(&root.path().join("automation"), &scope)?;
    assert_eq!(
        store.recorded_event_position("sub", 1, "selected-file-source", "revision-a")?,
        Some((1, 1000, true))
    );
    assert!(
        store
            .recorded_event_position("sub", 1, "other-source", "revision-a")
            .is_err()
    );
    assert_eq!(store.list_runs(None)?.items.len(), 2);
    Ok(())
}
