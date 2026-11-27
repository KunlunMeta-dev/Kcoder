use anyhow::Context as _;

#[tokio::test]
async fn state_only_directory_view_reads_saved_peers_without_engine() -> anyhow::Result<()> {
    if !owned_case("state_only_directory_view_reads_saved_peers_without_engine")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let peer = cold_peer(&fixture)?;
    last_attempt(&peer, TurnAttemptStatus::Failed)?;
    let peer_id = peer.session_id();
    let peer_history = peer.state.history_path().unwrap();
    let peer_state = peer.state.session_state_path().context("peer sidecar")?;
    let storage = peer.client_storage_root();
    drop(peer);
    let state = kcoder_state::AppState::new(&fixture.workspace);
    let parent_path = storage.join(state.session_id());
    let parent = kcoder_config::PrivateDirectory::open_existing(&storage)?
        .create_private_child(std::ffi::OsStr::new(&state.session_id()))?;
    parent.verify_private_directory()?;
    state.with_history_path(parent_path.join(format!("{}.jsonl", state.session_id())));
    state.add_message(Message::user_text("Owned State-only source"));
    state.save_history()?;
    let lifecycle = state.try_inspection_lifecycle_identity().unwrap();
    let view = session_directory::DirectorySourceView::from_state(&state, &lifecycle, &storage);
    let mut directory = session_directory::SessionDirectory::default();
    let page = directory.page_view(&view, None, &[], &HashSet::new())?;
    let targets = page
        .entries
        .into_iter()
        .filter_map(|entry| match entry {
            session_directory::DirectoryEntry::Historical(target) => Some(*target),
            session_directory::DirectoryEntry::Resident(_) => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].thread_id, peer_id);
    assert_eq!(targets[0].status, ThreadStatus::Unknown);
    assert_eq!(
        targets[0].last_turn.as_ref().unwrap().status,
        TurnStatus::Failed
    );
    assert!(fixture.manager.resident_engines().is_empty());
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    page.scope.verify_view(&view)?;
    let exact = directory
        .lookup_view(&view, &peer_id, &HashSet::new())?
        .context("exact saved peer")?;
    assert_eq!(exact.thread_id, peer_id);
    assert_eq!(exact.last_turn.as_ref().unwrap().status, TurnStatus::Failed);
    assert!(
        directory
            .lookup_view(&view, "unrecorded-target", &HashSet::new())?
            .is_none()
    );
    assert!(
        directory
            .lookup_view(&view, &peer_id, &HashSet::from([peer_id.clone()]))
            .is_err()
    );
    let history = state.history_path().unwrap();
    let host_verify = || Ok(());
    let host_view = session_directory::DirectorySourceView::from_host(
        &fixture.workspace,
        &storage,
        history.parent(),
        "owned-remote-source-with-same-thread-id",
        &host_verify,
    )?;
    let host_page = directory.page_view(&host_view, None, &[], &HashSet::new())?;
    assert!(host_page.entries.iter().any(|entry| matches!(entry,
        session_directory::DirectoryEntry::Historical(target) if target.thread_id == state.session_id()
    )), "a remote same-name source never excludes a local peer");
    std::fs::write(&peer_state, b"{not-valid-sidecar")?;
    assert!(
        directory
            .lookup_view(&view, &peer_id, &HashSet::new())
            .is_err()
    );
    std::fs::remove_file(peer_history)?;
    assert!(
        directory
            .lookup_view(&view, &peer_id, &HashSet::new())
            .is_err(),
        "remaining artifacts never prove a missing history was an absent session"
    );
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn private_host_directory_view_checks_authority_and_binds_cursor() -> anyhow::Result<()> {
    if !owned_case("private_host_directory_view_checks_authority_and_binds_cursor")? {
        return Ok(());
    }
    let fixture = Fixture::new()?;
    let mut storage = None;
    let mut history_parent = None;
    for _ in 0..12 {
        let peer = cold_peer(&fixture)?;
        storage = Some(peer.client_storage_root());
        history_parent = peer
            .state
            .history_path()
            .and_then(|path| path.parent().map(Path::to_owned));
    }
    let storage = storage.unwrap();
    let active = std::sync::atomic::AtomicBool::new(true);
    let checks = AtomicUsize::new(0);
    let verify = || {
        checks.fetch_add(1, Ordering::SeqCst);
        anyhow::ensure!(active.load(Ordering::SeqCst), "owned route revoked");
        Ok(())
    };
    let view = session_directory::DirectorySourceView::from_host(
        &fixture.workspace,
        &storage,
        history_parent.as_deref(),
        "actual-private-source-route-a",
        &verify,
    )?;
    let mut directory = session_directory::SessionDirectory::default();
    let first = directory.page_view(&view, None, &[], &HashSet::new())?;
    assert_eq!(first.entries.len(), 10);
    let cursor = first
        .next_cursor
        .as_deref()
        .context("remaining host page")?;
    assert!(
        checks.load(Ordering::SeqCst) >= 4,
        "fresh authorization at capture, prepare and publication"
    );
    active.store(false, Ordering::SeqCst);
    assert!(first.scope.verify_view(&view).is_err());
    assert!(
        directory
            .page_view(&view, Some(cursor), &[], &HashSet::new())
            .is_err()
    );
    active.store(true, Ordering::SeqCst);
    let different_source = session_directory::DirectorySourceView::from_host(
        &fixture.workspace,
        &storage,
        history_parent.as_deref(),
        "actual-private-source-route-b",
        &verify,
    )?;
    assert!(
        directory
            .page_view(&different_source, Some(cursor), &[], &HashSet::new())
            .is_err()
    );
    let second = directory.page_view(&view, Some(cursor), &[], &HashSet::new())?;
    assert_eq!(second.entries.len(), 2);
    assert!(second.next_cursor.is_none());
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    assert!(fixture.manager.resident_engines().is_empty());
    fixture.shutdown().await;
    Ok(())
}
// Persistent discovery uses the same owned process/real host fixture as resident discovery.
fn cold_peer(fixture: &Fixture) -> anyhow::Result<QueryEngine> {
    fixture.engine(
        &fixture.workspace,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )
}

#[tokio::test]
async fn saved_failed_interrupted_archived_sessions_are_discovered_without_activation()
-> anyhow::Result<()> {
    if !owned_case("saved_failed_interrupted_archived_sessions_are_discovered_without_activation")?
    {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let mut peers = Vec::new();
    for status in [
        TurnAttemptStatus::Completed,
        TurnAttemptStatus::Failed,
        TurnAttemptStatus::Interrupted,
    ] {
        let peer = cold_peer(&fixture)?;
        last_attempt(&peer, status)?;
        thread_metadata::update_thread_metadata(
            &peer,
            ThreadMetadataUpdateParams {
                thread_id: peer.session_id(),
                title: MetadataUpdate::Set("Saved peer".into()),
                archived_at: MetadataUpdate::Set("2026-11-12T12:00:00Z".into()),
                ..Default::default()
            },
            &HashSet::new(),
            true,
        )?;
        peers.push(peer);
    }
    let before = files(&source.client_storage_root())?;
    let page = fixture.list(&source, json!({})).await?;
    assert_eq!(
        page.coverage,
        AgentMessageDiscoveryCoverage::WorkspaceHistory
    );
    assert_eq!(
        page.completeness,
        AgentMessageDiscoveryCompleteness::Complete
    );
    assert_eq!(page.issue_count, Some(0));
    assert_eq!(page.targets.len(), 3);
    for (peer, expected) in peers.iter().zip([
        TurnStatus::Completed,
        TurnStatus::Failed,
        TurnStatus::Interrupted,
    ]) {
        let row = page
            .targets
            .iter()
            .find(|row| row.thread_id == peer.session_id())
            .expect("saved peer present");
        assert_eq!(
            row.status,
            ThreadStatus::Unknown,
            "saved completion is not current activity"
        );
        assert_eq!(
            row.presence,
            AgentMessageTargetPresence::Unknown,
            "missing ownership lease proves no liveness"
        );
        assert_eq!(row.last_turn.as_ref().unwrap().status, expected);
        assert!(row.last_history_update_at_ms.is_some());
        assert_eq!(row.title.as_deref(), Some("Saved peer"));
        assert!(row.archived_at.is_some());
        assert!(row.allowed_modes.is_empty());
    }
    assert_eq!(
        fixture.manager.resident_engines().len(),
        1,
        "no cold peer was restored"
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    assert_eq!(before, files(&source.client_storage_root())?);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn cold_foreign_or_corrupt_metadata_never_becomes_a_complete_empty_observation()
-> anyhow::Result<()> {
    if !owned_case("cold_foreign_or_corrupt_metadata_never_becomes_a_complete_empty_observation")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let valid = cold_peer(&fixture)?;
    let bad = cold_peer(&fixture)?;
    let state = bad.state.session_state_path().unwrap();
    std::fs::write(&state, b"{invalid sidecar")?;
    let foreign = fixture.root.path().join("foreign-cold-workspace");
    std::fs::create_dir(&foreign)?;
    let foreign = fixture.engine(
        &foreign,
        fixture.services.clone(),
        Fixture::settings(),
        fixture.provider.clone(),
    )?;
    let page = fixture.list(&source, json!({})).await?;
    assert_eq!(
        page.completeness,
        AgentMessageDiscoveryCompleteness::Partial
    );
    assert!(page.issue_count.unwrap_or_default() > 0);
    assert!(
        page.targets
            .iter()
            .any(|row| row.thread_id == valid.session_id())
    );
    assert!(
        !page
            .targets
            .iter()
            .any(|row| row.thread_id == bad.session_id() || row.thread_id == foreign.session_id())
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn explicit_source_revocation_invalidates_pending_results_and_history_cursors()
-> anyhow::Result<()> {
    if !owned_case("explicit_source_revocation_invalidates_pending_results_and_history_cursors")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    for _ in 0..13 {
        cold_peer(&fixture)?;
    }
    let first = fixture.list(&source, json!({})).await?;
    assert_eq!(first.targets.len(), AGENT_MESSAGE_TARGET_PAGE_SIZE);
    let cursor = first.next_cursor.expect("bounded historical page cursor");
    let task = fixture.start_call(&source, json!({"cursor":cursor}));
    let request = fixture.requests.recv().await.unwrap();
    let mut jobs = DiscoveryJobs::default();
    jobs.start(request, &fixture.manager, &mut fixture.pages);
    let completed = jobs.next().await.unwrap();
    source
        .permissions
        .write()
        .unwrap()
        .deny_for_session("ListSessions");
    publish(completed, &fixture.manager);
    assert!(
        task.await?.is_err(),
        "late result cannot retain a revoked allow verdict"
    );
    let task = fixture.start_call(&source, json!({"cursor":cursor}));
    let request = fixture.requests.recv().await.unwrap();
    dispatch(request, &fixture.manager, &mut fixture.pages).await;
    assert!(
        task.await?.is_err(),
        "cursor does not bypass current explicit deny"
    );
    jobs.finish().await;
    fixture.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn unsettled_or_unordered_attempts_leave_last_turn_unknown_and_large_history_stays_unread()
-> anyhow::Result<()> {
    if !owned_case(
        "unsettled_or_unordered_attempts_leave_last_turn_unknown_and_large_history_stays_unread",
    )? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let peer = cold_peer(&fixture)?;
    peer.state.add_message(Message::user_text(
        "bounded historical payload ".repeat(300_000),
    ));
    peer.state.save_history()?;
    last_attempt(&peer, TurnAttemptStatus::Failed)?;
    let single_before = files(&source.client_storage_root())?;
    let single = fixture.list(&source, json!({})).await?;
    assert_eq!(
        single
            .targets
            .iter()
            .find(|row| row.thread_id == peer.session_id())
            .context("single confirmed terminal peer")?
            .last_turn
            .as_ref()
            .context("single confirmed terminal fact")?
            .status,
        TurnStatus::Failed
    );
    assert_eq!(single_before, files(&source.client_storage_root())?);
    let directory = peer.session_storage_dir_for(&peer.session_id());
    let store = TurnAttemptStore::open(&directory, &peer.session_id())?;
    store.begin(TurnAttemptRecord {
        client_presentation: None,
        version: 1,
        identity: TurnAttemptIdentity {
            thread_id: peer.session_id(),
            turn_id: "new-active-turn".into(),
            attempt_id: "new-active-attempt".into(),
        },
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 50,
        input_context_hash: "b".repeat(64),
        request_fingerprint: None,
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    })?;
    std::fs::write(
        directory.join("turn-attempts").join("large.model.json"),
        vec![b'x'; 4 * 1024 * 1024],
    )?;
    let before = files(&source.client_storage_root())?;
    #[cfg(target_os = "linux")]
    fn read_bytes() -> u64 {
        std::fs::read_to_string("/proc/self/io")
            .unwrap()
            .lines()
            .find_map(|line| {
                line.strip_prefix("rchar: ")
                    .and_then(|value| value.trim().parse().ok())
            })
            .unwrap()
    }
    #[cfg(target_os = "linux")]
    let reads = read_bytes();
    for _ in 0..2 {
        let page = fixture.list(&source, json!({})).await?;
        let row = page
            .targets
            .iter()
            .find(|row| row.thread_id == peer.session_id())
            .expect("cold peer not restored or discarded");
        assert!(
            row.last_turn.is_none(),
            "a newer unsettled attempt prevents a last-turn claim"
        );
        assert_eq!(row.status, ThreadStatus::Unknown);
    }
    #[cfg(target_os = "linux")]
    assert!(
        read_bytes().saturating_sub(reads) < 1024 * 1024,
        "warm metadata pages must not read/hash the multi-MiB conversation or model snapshot"
    );
    assert_eq!(before, files(&source.client_storage_root())?);
    store.finish(
        &TurnAttemptIdentity {
            thread_id: peer.session_id(),
            turn_id: "new-active-turn".into(),
            attempt_id: "new-active-attempt".into(),
        },
        TurnAttemptCompletion {
            status: TurnAttemptStatus::Completed,
            finished_at_ms: 75,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )?;
    let unordered = fixture.list(&source, json!({})).await?;
    assert!(
        unordered
            .targets
            .iter()
            .find(|row| row.thread_id == peer.session_id())
            .context("unordered terminal peer")?
            .last_turn
            .is_none(),
        "multiple terminal records and a backwards wall clock do not prove the last turn"
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}

struct ExternalLeaseProcess(std::process::Child);
impl Drop for ExternalLeaseProcess {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
#[test]
#[ignore = "executed only as an owned child by external_process_lease_does_not_become_idle_or_completion"]
fn external_lease_holder_fixture() -> anyhow::Result<()> {
    let root = PathBuf::from(
        std::env::var_os("KCODER_DISCOVERY_LEASE_ROOT").context("missing owned lease root")?,
    );
    let target = PathBuf::from(
        std::env::var_os("KCODER_DISCOVERY_LEASE_TARGET").context("missing owned lease target")?,
    );
    let nonce = std::env::var("KCODER_DISCOVERY_LEASE_NONCE")?;
    kcoder_config::PrivateDirectory::open_existing(&root)?.verify_private_directory()?;
    anyhow::ensure!(
        target.starts_with(&root) && std::fs::read_to_string(root.join("lease-owner"))? == nonce,
        "lease fixture owner mismatch"
    );
    let _lease = SessionLease::open(&target, false)?;
    std::fs::write(root.join("lease-ready"), &nonce)?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !root.join("lease-stop").exists() {
        anyhow::ensure!(Instant::now() < deadline, "owned lease fixture timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
#[tokio::test]
async fn external_process_lease_does_not_become_idle_or_completion() -> anyhow::Result<()> {
    use anyhow::Context;
    use std::process::{Command, Stdio};
    if !owned_case("external_process_lease_does_not_become_idle_or_completion")? {
        return Ok(());
    }
    let mut fixture = Fixture::new()?;
    let source = fixture.add()?;
    let peer = cold_peer(&fixture)?;
    last_attempt(&peer, TurnAttemptStatus::Completed)?;
    drop(SessionLease::acquire(&peer.session_lease_target())?);
    let nonce = uuid::Uuid::new_v4().to_string();
    std::fs::write(fixture.root.path().join("lease-owner"), &nonce)?;
    let full_name = format!("{}::external_lease_holder_fixture", module_path!());
    let exact = full_name.split_once("::").unwrap().1;
    let mut command = Command::new(std::env::current_exe()?);
    command.env_clear();
    for key in [
        "PATH",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = ExternalLeaseProcess(
        command
            .args(["--ignored", "--exact", exact, "--nocapture"])
            .env("KCODER_DISCOVERY_LEASE_ROOT", fixture.root.path())
            .env("KCODER_DISCOVERY_LEASE_TARGET", peer.session_lease_target())
            .env("KCODER_DISCOVERY_LEASE_NONCE", &nonce)
            .env("RUST_MIN_STACK", "16777216")
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fixture.root.path().join("lease-ready").exists() {
        anyhow::ensure!(
            child.0.try_wait()?.is_none(),
            "owned lease holder exited before readiness"
        );
        anyhow::ensure!(
            Instant::now() < deadline,
            "owned lease holder did not become ready"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("lease-ready"))?,
        nonce
    );
    let page = fixture.list(&source, json!({})).await?;
    let target = page
        .targets
        .iter()
        .find(|target| target.thread_id == peer.session_id())
        .context("external saved peer missing")?;
    assert_eq!(target.presence, AgentMessageTargetPresence::Unknown);
    assert_eq!(
        target.status,
        ThreadStatus::Unknown,
        "another process's lease is not this manager's live activity"
    );
    assert_eq!(
        target.last_turn.as_ref().unwrap().status,
        TurnStatus::Completed,
        "an older terminal receipt remains separate from current ownership"
    );
    std::fs::write(fixture.root.path().join("lease-stop"), b"stop")?;
    assert!(child.0.wait()?.success());
    let page = fixture.list(&source, json!({})).await?;
    let target = page
        .targets
        .iter()
        .find(|target| target.thread_id == peer.session_id())
        .unwrap();
    assert_eq!(target.presence, AgentMessageTargetPresence::NotResident);
    assert_eq!(
        target.status,
        ThreadStatus::Unknown,
        "an available lease does not prove idle or success"
    );
    assert_eq!(fixture.provider.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
    Ok(())
}
