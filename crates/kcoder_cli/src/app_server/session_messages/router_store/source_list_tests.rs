use super::*;
use kcoder_types::cross_session_messages::CrossSessionMessageReceiptListParams as Query;

fn query() -> Query {
    Query {
        limit: Some(4),
        ..Query::default()
    }
}
fn add(
    store: &NativePeerRouterStore,
    id: &str,
    source: &SessionAddressV1,
    terminal: bool,
) -> PeerRouterOperationV1 {
    let (_, mut intent) = request(store);
    intent.client_message_id = id.into();
    let operation = store
        .prepare_with_rate_policy(
            id,
            source.clone(),
            &intent,
            SourcePrepareRatePolicy {
                max_messages_per_minute: 256,
                max_source_messages_per_minute: 256,
            },
        )
        .unwrap();
    if terminal {
        store.mark_dispatching(id).unwrap();
        let mut receipt = receipt(&operation, AgentMessageStatus::Rejected, 2);
        receipt.message_id = format!("mid-{id}");
        store.record_receipt(id, receipt).unwrap()
    } else {
        operation
    }
}

#[test]
fn source_pages_recover_old_archives_and_hot_facts_without_cached_status_filtering_or_writes() {
    let (_root, parent, store) = owned();
    store
        .access_requiring_archive(|_, _| Ok(((), false)))
        .unwrap();
    let (source, _) = request(&store);
    let other = SessionAddressV1 {
        thread_id: "other-source".into(),
        ..source.clone()
    };
    let mut expected = std::collections::BTreeSet::new();
    for n in 0..45 {
        let id = format!("owned-{n}");
        add(&store, &id, &source, n < 40);
        expected.insert(id);
        add(&store, &format!("foreign-{n}"), &other, true);
    }
    drop(store);
    let store = NativePeerRouterStore::open_in(
        &parent,
        OsStr::new("peer-router-v1"),
        &RetentionPrincipalV1::LocalOs,
    )
    .unwrap()
    .unwrap();
    let before = read(&store.directory, DATA, MAX_DATA_BYTES).unwrap();
    let mut query = query();
    // No candidate has this cached status or timestamp. Only the caller's fresh
    // destination read may apply either of these filters.
    query.status = Some(AgentMessageStatus::Applied);
    query.created_after_ms = Some(1);
    let mut seen = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let page = store.source_operations_page(&source, &query).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 96 * 1024);
        for item in page.items {
            assert_eq!(item.operation.source_address, source);
            assert!(seen.insert(item.operation.operation_id.clone()));
            assert!(
                !serde_json::to_string(&item.operation)
                    .unwrap()
                    .contains("private body")
            );
        }
        pages += 1;
        query.cursor = page.next_cursor;
        if query.cursor.is_none() {
            break;
        }
        assert!(pages < 40, "bounded cursor must make progress");
    }
    assert_eq!(seen, expected);
    assert!(pages > 1);
    assert_eq!(
        read(&store.directory, DATA, MAX_DATA_BYTES).unwrap(),
        before
    );
}

#[test]
fn source_cursor_binds_original_source_namespace_and_filters_but_not_limit_or_receipt_refresh() {
    let (_root, _parent, store) = owned();
    let (source, _) = request(&store);
    for n in 0..4 {
        add(&store, &format!("cursor-{n}"), &source, false);
    }
    let first = store
        .source_operations_page(
            &source,
            &Query {
                limit: Some(1),
                ..query()
            },
        )
        .unwrap();
    let cursor = first.items[0].cursor.clone();
    let mut continuation = Query {
        cursor: Some(cursor.clone()),
        limit: Some(3),
        ..query()
    };
    let op = &first.items[0].operation;
    store.mark_dispatching(&op.operation_id).unwrap();
    store
        .record_receipt(&op.operation_id, receipt(op, AgentMessageStatus::Queued, 2))
        .unwrap();
    assert_eq!(
        store
            .source_operations_page(&source, &continuation)
            .unwrap()
            .items
            .len(),
        3
    );
    continuation.status = Some(AgentMessageStatus::Queued);
    assert!(
        store
            .source_operations_page(&source, &continuation)
            .is_err()
    );
    continuation.status = None;
    continuation.created_before_ms = Some(123);
    assert!(
        store
            .source_operations_page(&source, &continuation)
            .is_err()
    );
    continuation.created_before_ms = None;
    continuation.target_thread_id = Some("other".into());
    assert!(
        store
            .source_operations_page(&source, &continuation)
            .is_err()
    );
    continuation.target_thread_id = None;
    let other = SessionAddressV1 {
        thread_id: "another-source".into(),
        ..source.clone()
    };
    assert!(store.source_operations_page(&other, &continuation).is_err());
    let (_second_root, _second_parent, second) = owned();
    assert!(
        second
            .source_operations_page(&source, &continuation)
            .is_err()
    );
    let mut changed = cursor.into_bytes();
    changed[10] = if changed[10] == b'a' { b'b' } else { b'a' };
    continuation.cursor = Some(String::from_utf8(changed).unwrap());
    assert!(
        store
            .source_operations_page(&source, &continuation)
            .is_err()
    );
}

#[test]
fn source_cursor_survives_hot_to_archive_migration_and_empty_target_pages_continue() {
    let (_root, _parent, store) = owned();
    let (source, _) = request(&store);
    let first_op = add(&store, "migration-a", &source, false);
    add(&store, "migration-b", &source, false);
    let first = store
        .source_operations_page(
            &source,
            &Query {
                limit: Some(1),
                ..query()
            },
        )
        .unwrap();
    let after = first.items[0].cursor.clone();
    store
        .access_requiring_archive(|_, _| Ok(((), false)))
        .unwrap();
    store.mark_dispatching(&first_op.operation_id).unwrap();
    store
        .record_receipt(
            &first_op.operation_id,
            receipt(&first_op, AgentMessageStatus::Applied, 2),
        )
        .unwrap();
    let next = store
        .source_operations_page(
            &source,
            &Query {
                cursor: Some(after),
                ..query()
            },
        )
        .unwrap();
    assert_eq!(next.items.len(), 1);
    assert_ne!(
        next.items[0].operation.operation_id,
        first.items[0].operation.operation_id
    );
    for n in 0..35 {
        add(&store, &format!("nonmatching-{n}"), &source, true);
    }
    let empty = store
        .source_operations_page(
            &source,
            &Query {
                target_thread_id: Some("absent".into()),
                ..query()
            },
        )
        .unwrap();
    assert!(empty.items.is_empty());
    assert!(
        empty.next_cursor.is_some(),
        "bounded unmatched pages retain their continuation"
    );
}
