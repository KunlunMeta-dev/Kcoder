use super::*;
use crate::app_server::integrations::connectivity::task_capability_scope_directory::read_saved_task_capability_scope_bindings;

fn request(
    context: &NativeIntegrationContext,
    params: &IntegrationTaskCapabilityScopeDirectoryReadParams,
) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "owned-saved-directory".into(),
        scope: context.scope().clone(),
        operation_id: None,
        expected_revision: None,
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: serde_json::to_value(params)
            .unwrap()
            .as_object()
            .unwrap()
            .clone(),
    }
}
fn caller(context: &NativeIntegrationContext) -> crate::app_server::ConnectionState {
    crate::app_server::ConnectionState {
        integration_context: Some(context.recapture_for_owned_service().unwrap()),
        ..Default::default()
    }
}
fn unfiltered() -> IntegrationTaskCapabilityScopeDirectoryReadParams {
    IntegrationTaskCapabilityScopeDirectoryReadParams {
        thread_id: None,
        cursor: None,
    }
}
fn directory_files(path: &std::path::Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn collect(
        root: &std::path::Path,
        path: &std::path::Path,
        out: &mut BTreeMap<PathBuf, Vec<u8>>,
    ) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                collect(root, &entry.path(), out)
            } else {
                out.insert(
                    entry.path().strip_prefix(root).unwrap().to_path_buf(),
                    std::fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    let mut entries = BTreeMap::new();
    collect(path, path, &mut entries);
    entries
}
#[tokio::test]
async fn saved_directory_missing_store_is_unknown_and_read_never_creates_storage() -> Result<()> {
    let (_temp, context) = crate::app_server::integrations::connectivity::lease::tests::fixture()?;
    let before = directory_files(context.profile_path()?);
    let state = caller(&context);
    let page = read_saved_task_capability_scope_bindings(&state, &request(&context, &unfiltered()))
        .await?;
    assert_eq!(
        page.observation_state,
        IntegrationTaskCapabilityScopeDirectoryState::Unknown
    );
    assert_eq!(
        page.reason_code.as_deref(),
        Some("TASK_CAPABILITY_SCOPE_BINDINGS_NOT_OBSERVED")
    );
    assert!(page.entries.is_empty());
    assert!(NativeTaskCapabilityScopeBindingStore::observe(&context)?.is_none());
    assert_eq!(directory_files(context.profile_path()?), before);
    Ok(())
}
#[tokio::test]
async fn saved_directory_projects_original_tuple_without_claiming_live_authority_or_private_values()
-> Result<()> {
    let f = Fixture::new().await?;
    let binding = f.bind(none()).await?;
    let before = directory_files(f.context.profile_path()?);
    let task_count = f.facts.engine.state.tasks().len();
    let state = caller(&f.context);
    let page =
        read_saved_task_capability_scope_bindings(&state, &request(&f.context, &unfiltered()))
            .await?;
    assert_eq!(page.entries.len(), 1);
    assert_eq!(
        page.entries[0].target.as_ref(),
        Some(&binding.accepted().control_target())
    );
    assert_eq!(
        page.entries[0]
            .saved_snapshot
            .as_ref()
            .unwrap()
            .selection
            .mode,
        IntegrationTaskCapabilityScopeMode::None
    );
    assert_eq!(
        page.entries[0].observation_state,
        IntegrationTaskCapabilityScopeDirectoryState::SavedOnly
    );
    assert_eq!(
        page.entries[0].reason_code.as_deref(),
        Some("TASK_CAPABILITY_SCOPE_LIVE_AUTHORITY_NOT_OBSERVED")
    );
    let encoded = serde_json::to_string(&page)?;
    for forbidden in [
        "authorization",
        "fingerprint",
        "nativeOwnerEpoch",
        "subjectSha256",
        "lockIdentity",
        f.context.profile_path()?.to_str().unwrap(),
    ] {
        assert!(!encoded.contains(forbidden));
    }
    assert_eq!(f.facts.engine.state.tasks().len(), task_count);
    assert_eq!(directory_files(f.context.profile_path()?), before);
    f.shutdown().await;
    Ok(())
}
async fn another_original_binding(f: &Fixture, index: usize) -> Result<()> {
    let identity = TurnAttemptIdentity {
        thread_id: f.facts.engine.session_id(),
        turn_id: format!("directory-turn-{index}"),
        attempt_id: format!("directory-attempt-{index}"),
    };
    TurnAttemptStore::open_existing(&f.facts.session, &identity.thread_id)?
        .unwrap()
        .begin(attempt_record(identity.clone()))?;
    // This explicit fixture's authority follows this actual newly accepted
    // tuple. The production directory never manufactures or executes a TI.
    let facts = ActualFacts {
        engine: f.facts.engine.clone(),
        scope: f.facts.scope.clone(),
        initial: identity.clone(),
        session: f.facts.session.clone(),
        configs: Mutex::new(f.facts.configs.lock().unwrap().clone()),
        settings: Mutex::new(f.facts.settings.lock().unwrap().clone()),
        emitter_sources: Mutex::new(BTreeMap::new()),
        emitter_objects: Mutex::new(vec![]),
        management: AtomicBool::new(true),
        boundary: AtomicBool::new(true),
        wrong_epoch: AtomicBool::new(false),
        pause_sources: AtomicBool::new(false),
        source_unavailable: AtomicBool::new(false),
        source_reads: AtomicUsize::new(0),
        entered: Default::default(),
        release: Default::default(),
    };
    let accepted =
        NativeAcceptedTaskIdentity::capture_studio(&f.context, &identity, &facts).await?;
    f.facts
        .engine
        .state
        .history_attempt_scope(identity)?
        .run(async {
            let witness = f.facts.engine.native_tool_execution_witness();
            f.store
                .bind_accepted(
                    &f.context,
                    accepted,
                    &format!("directory-original-{index}"),
                    none(),
                    &f.catalog,
                    None,
                    &facts,
                    &NativeTaskCapabilityScopeCallback {
                        session_id: witness.session_id(),
                        native_witness: &witness,
                    },
                )
                .await?;
            Ok::<_, anyhow::Error>(())
        })
        .await
}
#[tokio::test]
async fn saved_directory_bounds_scans_and_empty_filtered_page_keeps_its_cursor() -> Result<()> {
    let f = Fixture::new().await?;
    for index in 0..11 {
        another_original_binding(&f, index).await?;
    }
    let before = super::super::storage::index_reads();
    let identities_before = f.context.identity_checks();
    let first = f.store.read_saved_directory(&f.context, &unfiltered())?;
    assert_eq!(super::super::storage::index_reads() - before, 1);
    assert_eq!(f.context.identity_checks() - identities_before, 3);
    assert_eq!(first.entries.len(), 10);
    let second = f.store.read_saved_directory(
        &f.context,
        &IntegrationTaskCapabilityScopeDirectoryReadParams {
            thread_id: None,
            cursor: first.next_cursor.clone(),
        },
    )?;
    assert_eq!(second.entries.len(), 1);
    assert!(second.next_cursor.is_none());
    assert!(
        first
            .entries
            .iter()
            .all(|one| one.reference_id != second.entries[0].reference_id)
    );
    let filtered = f.store.read_saved_directory(
        &f.context,
        &IntegrationTaskCapabilityScopeDirectoryReadParams {
            thread_id: Some("unrelated-thread".into()),
            cursor: None,
        },
    )?;
    assert!(filtered.entries.is_empty());
    assert!(filtered.next_cursor.is_some());
    assert!(
        f.store
            .read_saved_directory(
                &f.context,
                &IntegrationTaskCapabilityScopeDirectoryReadParams {
                    thread_id: Some("unrelated-thread".into()),
                    cursor: first.next_cursor.clone()
                }
            )
            .is_err()
    );
    another_original_binding(&f, 12).await?;
    assert!(
        f.store
            .read_saved_directory(
                &f.context,
                &IntegrationTaskCapabilityScopeDirectoryReadParams {
                    thread_id: None,
                    cursor: first.next_cursor
                }
            )
            .is_err()
    );
    f.shutdown().await;
    Ok(())
}
#[tokio::test]
async fn saved_directory_unreadable_birth_remains_unknown_instead_of_empty_or_none() -> Result<()> {
    let f = Fixture::new().await?;
    let binding = f.bind(none()).await?;
    let guard = NativeDomainGuard::observe(
        f.context.profile()?,
        f.context.scope(),
        NativeDomain::ConnectivityTaskCapabilityScope,
    )?
    .unwrap();
    let directory = guard.directory(f.context.profile()?)?;
    directory.atomic_replace(
        OsStr::new(&format!("source-binding-{}.json", binding.task_key()?)),
        b"{",
    )?;
    let page = f.store.read_saved_directory(&f.context, &unfiltered())?;
    assert_eq!(page.entries.len(), 1);
    assert_eq!(
        page.entries[0].observation_state,
        IntegrationTaskCapabilityScopeDirectoryState::Unknown
    );
    assert!(page.entries[0].target.is_none());
    assert!(page.entries[0].saved_snapshot.is_none());
    f.shutdown().await;
    Ok(())
}
#[tokio::test]
async fn saved_directory_wrong_scope_or_disconnected_public_caller_is_denied() -> Result<()> {
    let f = Fixture::new().await?;
    f.bind(none()).await?;
    let state = caller(&f.context);
    let mut changed = request(&f.context, &unfiltered());
    changed.scope.target_revision.push_str("-changed");
    assert!(
        read_saved_task_capability_scope_bindings(&state, &changed)
            .await
            .is_err()
    );
    state.input_ended.cancel();
    assert!(
        read_saved_task_capability_scope_bindings(&state, &request(&f.context, &unfiltered()))
            .await
            .is_err()
    );
    assert!(
        super::super::super::task_capability_scope_control::NativeTaskCapabilityScopeControlMethod::from_wire(
            "readSavedTaskSourceBindings"
        )
        .is_none()
    );
    f.shutdown().await;
    Ok(())
}
