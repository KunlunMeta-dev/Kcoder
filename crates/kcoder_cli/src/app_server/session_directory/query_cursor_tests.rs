// Included by the original discovery tests to reuse its owned re-exec fixture.
fn query_test_ids(count: usize) -> Vec<String> {
    (0..count).map(|i| format!("row-{i:04}")).collect()
}

fn query_test_target(id: &str, title: String) -> AgentMessageTarget {
    AgentMessageTarget {
        thread_id: id.into(),
        address: Some(kcoder_types::session_address::SessionAddressV1 {
            target_id: "owned-query-target".into(),
            workspace_id: "owned-query-workspace".into(),
            thread_id: id.into(),
        }),
        title: Some(title),
        status: ThreadStatus::Idle,
        active_turn_id: None,
        presence: AgentMessageTargetPresence::Resident,
        run_summary: None,
        last_turn: None,
        archived_at: None,
        last_history_update_at_ms: None,
        allowed_modes: Vec::new(),
    }
}

fn query_test_projection(
    entry: &session_directory::DirectoryEntry,
    history: Option<&AgentMessageTarget>,
) -> anyhow::Result<Option<AgentMessageTarget>> {
    let mut row = match entry {
        session_directory::DirectoryEntry::Resident(id) => {
            query_test_target(id, format!("Peer {id}"))
        }
        session_directory::DirectoryEntry::Historical(row) => row.as_ref().clone(),
    };
    if let Some(history) = history {
        row.title = history.title.clone();
        row.archived_at = history.archived_at.clone();
    }
    row.address = Some(kcoder_types::session_address::SessionAddressV1 {
        target_id: "owned-query-target".into(),
        workspace_id: "owned-query-workspace".into(),
        thread_id: row.thread_id.clone(),
    });
    Ok(Some(row))
}

#[tokio::test]
async fn directory_query_finds_sparse_residents_and_binds_cursor_filters_and_limit()
-> anyhow::Result<()> {
    if !owned_case("directory_query_finds_sparse_residents_and_binds_cursor_filters_and_limit")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let source = cold_peer(&fixture)?;
    let lifecycle = source.state.try_inspection_lifecycle_identity().unwrap();
    let view = session_directory::DirectorySourceView::from_state(
        &source.state,
        &lifecycle,
        &source.client_storage_root(),
    );
    let ids = query_test_ids(400);
    let query = SessionDiscoveryQuery {
        title: Some("中文".into()),
        query: Some("needle".into()),
        target_id: Some("owned-query-target".into()),
        status: Some(ThreadStatus::Idle),
        presence: Some(AgentMessageTargetPresence::Resident),
        limit: Some(2),
        ..Default::default()
    };
    let project = |entry: &session_directory::DirectoryEntry,
                   _history: Option<&AgentMessageTarget>| {
        let session_directory::DirectoryEntry::Resident(id) = entry else {
            anyhow::bail!("unexpected history")
        };
        let title = if ["row-0129", "row-0300", "row-0301"].contains(&id.as_str()) {
            "Needle 中文 peer".into()
        } else {
            format!("Other {id}")
        };
        Ok(Some(query_test_target(id, title)))
    };
    let mut directory = session_directory::SessionDirectory::default();
    let first = directory.page_view_query(&view, None, &ids, &HashSet::new(), &query, project)?;
    assert_eq!(
        first
            .targets
            .iter()
            .map(|r| r.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["row-0129", "row-0300"]
    );
    let cursor = first
        .next_cursor
        .as_deref()
        .context("sparse continuation")?;
    let next = directory.page_view_query(
        &view,
        Some(cursor),
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery::default(),
        project,
    )?;
    assert_eq!(next.targets[0].thread_id, "row-0301");
    assert_eq!(next.query, query);
    assert!(next.next_cursor.is_none());
    let replay = directory.page_view_query(
        &view,
        Some(cursor),
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery::default(),
        project,
    )?;
    assert_eq!(replay.targets, next.targets);
    assert!(
        directory
            .page_view_query(
                &view,
                Some(cursor),
                &ids,
                &HashSet::new(),
                &SessionDiscoveryQuery {
                    title: Some("different".into()),
                    ..Default::default()
                },
                project
            )
            .is_err()
    );
    let changed = directory.page_view_query(
        &view,
        Some(cursor),
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery {
            limit: Some(1),
            ..Default::default()
        },
        project,
    )?;
    assert_eq!(changed.targets.len(), 1);
    let inherited = directory.page_view_query(
        &view,
        changed.next_cursor.as_deref(),
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery::default(),
        project,
    )?;
    assert_eq!(inherited.query.page_size(), 1);
    assert!(inherited.targets.is_empty());
    assert!(inherited.next_cursor.is_none());
    let modes = directory.page_view_query(
        &view,
        None,
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery {
            allowed_mode: Some(AgentMessageMode::WakeIfIdle),
            limit: Some(2),
            ..Default::default()
        },
        |entry, _| {
            let session_directory::DirectoryEntry::Resident(id) = entry else {
                anyhow::bail!("unexpected history")
            };
            let mut row = query_test_target(id, format!("Peer {id}"));
            if ["row-0129", "row-0300"].contains(&id.as_str()) {
                row.allowed_modes.push(AgentMessageMode::WakeIfIdle);
            }
            Ok(Some(row))
        },
    )?;
    assert_eq!(
        modes
            .targets
            .iter()
            .map(|row| row.thread_id.as_str())
            .collect::<Vec<_>>(),
        ["row-0129", "row-0300"]
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn directory_query_respects_256_rows_and_frame_budget_without_consuming_deferred_row()
-> anyhow::Result<()> {
    if !owned_case(
        "directory_query_respects_256_rows_and_frame_budget_without_consuming_deferred_row",
    )? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let source = cold_peer(&fixture)?;
    let lifecycle = source.state.try_inspection_lifecycle_identity().unwrap();
    let view = session_directory::DirectorySourceView::from_state(
        &source.state,
        &lifecycle,
        &source.client_storage_root(),
    );
    let mut directory = session_directory::SessionDirectory::default();
    let ids = query_test_ids(300);
    let first = directory.page_view_query(
        &view,
        None,
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery {
            limit: Some(256),
            ..Default::default()
        },
        query_test_projection,
    )?;
    assert_eq!(first.targets.len(), 256);
    assert!(serde_json::to_vec(&first.targets)?.len() <= 96 * 1024);
    let ids = query_test_ids(6);
    let mut cursor = None;
    let mut observed = Vec::new();
    loop {
        let page = directory.page_view_query(
            &view,
            cursor.as_deref(),
            &ids,
            &HashSet::new(),
            &SessionDiscoveryQuery {
                limit: Some(256),
                ..Default::default()
            },
            |entry, _| {
                let session_directory::DirectoryEntry::Resident(id) = entry else {
                    anyhow::bail!("unexpected history")
                };
                Ok(Some(query_test_target(id, "x".repeat(48 * 1024))))
            },
        )?;
        assert_eq!(page.targets.len(), 1);
        assert!(serde_json::to_vec(&page.targets)?.len() <= 96 * 1024);
        assert_eq!(page.issue_count, 0);
        observed.extend(page.targets.into_iter().map(|r| r.thread_id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(observed, ids);
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn directory_query_uses_saved_title_without_reading_conversation_body() -> anyhow::Result<()>
{
    if !owned_case("directory_query_uses_saved_title_without_reading_conversation_body")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let source = cold_peer(&fixture)?;
    let peer = cold_peer(&fixture)?;
    thread_metadata::update_thread_metadata(
        &peer,
        ThreadMetadataUpdateParams {
            thread_id: peer.session_id(),
            title: MetadataUpdate::Set("Saved 中文 title".into()),
            ..Default::default()
        },
        &HashSet::new(),
        true,
    )?;
    let peer_id = peer.session_id();
    // This owned fault injection would fail transcript decoding if a search loaded the body.
    std::fs::write(
        peer.state.history_path().unwrap(),
        b"NOT_A_JSONL_CONVERSATION_BODY",
    )?;
    drop(peer);
    let lifecycle = source.state.try_inspection_lifecycle_identity().unwrap();
    let view = session_directory::DirectorySourceView::from_state(
        &source.state,
        &lifecycle,
        &source.client_storage_root(),
    );
    let mut directory = session_directory::SessionDirectory::default();
    let page = directory.page_view_query(
        &view,
        None,
        &[],
        &HashSet::new(),
        &SessionDiscoveryQuery {
            title: Some("中文 TITLE".into()),
            ..Default::default()
        },
        query_test_projection,
    )?;
    assert_eq!(page.targets.len(), 1);
    assert_eq!(page.targets[0].thread_id, peer_id);
    assert_eq!(page.targets[0].title.as_deref(), Some("Saved 中文 title"));
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn directory_query_sparse_saved_titles_defer_history_and_attempt_io() -> anyhow::Result<()> {
    if !owned_case("directory_query_sparse_saved_titles_defer_history_and_attempt_io")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let source = cold_peer(&fixture)?;
    let mut matched = None;
    for index in 0..122 {
        let peer = cold_peer(&fixture)?;
        thread_metadata::update_thread_metadata(
            &peer,
            ThreadMetadataUpdateParams {
                thread_id: peer.session_id(),
                title: MetadataUpdate::Set(if index == 121 {
                    "Late 中文 Needle".into()
                } else {
                    format!("Other saved peer {index}")
                }),
                ..Default::default()
            },
            &HashSet::new(),
            true,
        )?;
        if index == 121 {
            last_attempt(&peer, TurnAttemptStatus::Failed)?;
            matched = Some(peer);
        }
    }
    let matched = matched.context("late matching saved peer")?;
    let lifecycle = source.state.try_inspection_lifecycle_identity().unwrap();
    let view = session_directory::DirectorySourceView::from_state(
        &source.state,
        &lifecycle,
        &source.client_storage_root(),
    );
    let mut directory = session_directory::SessionDirectory::default();
    let query = SessionDiscoveryQuery {
        title: Some("中文 NEEDLE".into()),
        ..Default::default()
    };
    session_directory::take_observation_counts();
    let page = directory.page_view_query(
        &view,
        None,
        &[],
        &HashSet::new(),
        &query,
        query_test_projection,
    )?;
    assert_eq!(page.targets.len(), 1);
    assert_eq!(page.targets[0].thread_id, matched.session_id());
    assert_eq!(
        page.targets[0].last_turn.as_ref().unwrap().status,
        TurnStatus::Failed
    );
    assert_eq!(page.issue_count, 0);
    assert!(page.next_cursor.is_none());
    assert_eq!(
        session_directory::take_observation_counts(),
        (1, 1),
        "122 saved titles require full history/lease facts and an attempt scan only for the match"
    );
    let denied_mode = directory.page_view_query(
        &view,
        None,
        &[],
        &HashSet::new(),
        &SessionDiscoveryQuery {
            allowed_mode: Some(AgentMessageMode::WakeIfIdle),
            ..query.clone()
        },
        query_test_projection,
    )?;
    assert!(denied_mode.targets.is_empty());
    assert_eq!(denied_mode.issue_count, 0);
    assert_eq!(session_directory::take_observation_counts(), (1, 0));
    // A positive title match cannot bypass corrupt current history metadata.
    std::fs::write(
        matched.state.session_state_path().unwrap(),
        b"{invalid owned sidecar",
    )?;
    let corrupted = directory.page_view_query(
        &view,
        None,
        &[],
        &HashSet::new(),
        &query,
        query_test_projection,
    )?;
    assert!(corrupted.targets.is_empty());
    assert_eq!(corrupted.issue_count, 1);
    assert_eq!(
        corrupted.completeness,
        AgentMessageDiscoveryCompleteness::Partial
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn directory_query_replay_counts_a_corrupt_candidate_only_once() -> anyhow::Result<()> {
    if !owned_case("directory_query_replay_counts_a_corrupt_candidate_only_once")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let source = cold_peer(&fixture)?;
    let peer = cold_peer(&fixture)?;
    let sidecar = peer.state.session_state_path().unwrap();
    let peer_id = peer.session_id();
    drop(peer);
    let lifecycle = source.state.try_inspection_lifecycle_identity().unwrap();
    let view = session_directory::DirectorySourceView::from_state(
        &source.state,
        &lifecycle,
        &source.client_storage_root(),
    );
    let residents = vec![
        "00000000-0000-0000-0000-000000000000".into(),
        "zzzz-peer".into(),
    ];
    let mut directory = session_directory::SessionDirectory::default();
    let query = SessionDiscoveryQuery {
        limit: Some(1),
        ..Default::default()
    };
    let first = directory.page_view_query(
        &view,
        None,
        &residents,
        &HashSet::new(),
        &query,
        query_test_projection,
    )?;
    assert_eq!(first.targets[0].thread_id, residents[0]);
    std::fs::write(sidecar, b"{invalid-owned-sidecar")?;
    let cursor = first
        .next_cursor
        .as_deref()
        .context("corrupt peer continuation")?;
    let observed = directory.page_view_query(
        &view,
        Some(cursor),
        &residents,
        &HashSet::new(),
        &SessionDiscoveryQuery::default(),
        query_test_projection,
    )?;
    let replay = directory.page_view_query(
        &view,
        Some(cursor),
        &residents,
        &HashSet::new(),
        &SessionDiscoveryQuery::default(),
        query_test_projection,
    )?;
    assert_eq!(observed.targets[0].thread_id, residents[1]);
    assert!(observed.targets.iter().all(|r| r.thread_id != peer_id));
    assert_eq!(observed.issue_count, 1);
    assert_eq!(replay.issue_count, observed.issue_count);
    assert_eq!(replay.targets, observed.targets);
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn directory_query_cursor_rechecks_authority_and_source_binding() -> anyhow::Result<()> {
    if !owned_case("directory_query_cursor_rechecks_authority_and_source_binding")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let source = cold_peer(&fixture)?;
    let active = std::sync::atomic::AtomicBool::new(true);
    let verify = || {
        anyhow::ensure!(
            active.load(Ordering::SeqCst),
            "owned query authority withdrawn"
        );
        Ok(())
    };
    let history = source.state.history_path().unwrap();
    let storage = source.client_storage_root();
    let view = session_directory::DirectorySourceView::from_host(
        &fixture.workspace,
        &storage,
        history.parent(),
        "query-source-a",
        &verify,
    )?;
    let ids = query_test_ids(12);
    let mut directory = session_directory::SessionDirectory::default();
    let first = directory.page_view_query(
        &view,
        None,
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery {
            limit: Some(4),
            ..Default::default()
        },
        query_test_projection,
    )?;
    let cursor = first
        .next_cursor
        .as_deref()
        .context("authority continuation")?;
    active.store(false, Ordering::SeqCst);
    assert!(
        directory
            .page_view_query(
                &view,
                Some(cursor),
                &ids,
                &HashSet::new(),
                &SessionDiscoveryQuery::default(),
                query_test_projection
            )
            .is_err()
    );
    active.store(true, Ordering::SeqCst);
    let other = session_directory::DirectorySourceView::from_host(
        &fixture.workspace,
        &storage,
        history.parent(),
        "query-source-b",
        &verify,
    )?;
    assert!(
        directory
            .page_view_query(
                &other,
                Some(cursor),
                &ids,
                &HashSet::new(),
                &SessionDiscoveryQuery::default(),
                query_test_projection
            )
            .is_err()
    );
    let next = directory.page_view_query(
        &view,
        Some(cursor),
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery::default(),
        query_test_projection,
    )?;
    assert_eq!(next.targets.len(), 4);
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn directory_query_concurrent_core_reads_replay_and_keep_the_successor_usable()
-> anyhow::Result<()> {
    if !owned_case("directory_query_concurrent_core_reads_replay_and_keep_the_successor_usable")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let source = cold_peer(&fixture)?;
    let lifecycle = source.state.try_inspection_lifecycle_identity().unwrap();
    let view = session_directory::DirectorySourceView::from_state(
        &source.state,
        &lifecycle,
        &source.client_storage_root(),
    );
    let ids = query_test_ids(12);
    let query = SessionDiscoveryQuery {
        limit: Some(4),
        ..Default::default()
    };
    let directory = StdMutex::new(session_directory::SessionDirectory::default());
    let first = directory.lock().unwrap().page_view_query(
        &view,
        None,
        &ids,
        &HashSet::new(),
        &query,
        query_test_projection,
    )?;
    let cursor = first
        .next_cursor
        .as_deref()
        .context("concurrent core cursor")?;
    // Core snapshots serialize here; this does not opt the public tool into concurrent execution.
    let pages = std::thread::scope(|scope| {
        let one = scope.spawn(|| {
            directory.lock().unwrap().page_view_query(
                &view,
                Some(cursor),
                &ids,
                &HashSet::new(),
                &SessionDiscoveryQuery::default(),
                query_test_projection,
            )
        });
        let two = scope.spawn(|| {
            directory.lock().unwrap().page_view_query(
                &view,
                Some(cursor),
                &ids,
                &HashSet::new(),
                &SessionDiscoveryQuery::default(),
                query_test_projection,
            )
        });
        [one.join().unwrap(), two.join().unwrap()]
    });
    let [one, two] = pages;
    let one = one?;
    let two = two?;
    assert_eq!(one.targets, two.targets);
    assert_eq!(one.next_cursor, two.next_cursor);
    let last = directory.lock().unwrap().page_view_query(
        &view,
        one.next_cursor.as_deref(),
        &ids,
        &HashSet::new(),
        &SessionDiscoveryQuery::default(),
        query_test_projection,
    )?;
    assert_eq!(last.targets.len(), 4);
    assert!(last.next_cursor.is_none());
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}
