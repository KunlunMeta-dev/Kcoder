use super::*;

#[test]
fn model_stream_observation_admits_presentation_events_and_excludes_tool_input() {
    for event in [
        EngineEvent::AssistantMessageStarted,
        EngineEvent::AssistantTextDelta("text".into()),
        EngineEvent::AssistantThinkingDelta("thinking".into()),
        EngineEvent::AssistantStopReason { reason: "end_turn" },
        EngineEvent::AssistantMessageDone,
        EngineEvent::ToolInputReset,
    ] {
        assert!(is_model_stream_event(&event));
    }
    assert!(!is_model_stream_event(&EngineEvent::ToolInputProgress {
        id: "read-input".into(),
        name: "read".into(),
        chars: 8,
        lines: None,
    }));
    assert!(!is_model_stream_event(&EngineEvent::UserMessageAdded));
}

#[tokio::test]
async fn initial_registration_and_binding_share_one_source_observation() -> Result<()> {
    let f = Fixture::new().await?;
    f.facts.configs.lock().unwrap().push(config("source-C"));
    let before = f.facts.source_reads.load(Ordering::SeqCst);
    let binding = f
        .bind_registering(
            IntegrationTaskCapabilityScopeSelection {
                mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
                sources: vec![],
            },
            Some("initial-shared-observation"),
        )
        .await?;
    assert_eq!(f.facts.source_reads.load(Ordering::SeqCst) - before, 1);
    assert_eq!(
        binding
            .child_tool_snapshot(&f.context)?
            .effective_sources
            .len(),
        3
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn no_sources_binding_does_not_discover_connectors_even_with_registration() -> Result<()> {
    let f = Fixture::new().await?;
    f.facts.source_unavailable.store(true, Ordering::SeqCst);
    let before = f.facts.source_reads.load(Ordering::SeqCst);
    let binding = f
        .bind_registering(none(), Some("no-sources-registration"))
        .await?;
    assert_eq!(f.facts.source_reads.load(Ordering::SeqCst), before);
    assert!(
        binding
            .child_tool_snapshot(&f.context)?
            .effective_sources
            .is_empty()
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn registration_does_not_bypass_revocation_during_source_observation() -> Result<()> {
    let f = Fixture::new().await?;
    f.facts.pause_sources.store(true, Ordering::SeqCst);
    let registering = f.bind_registering(
        IntegrationTaskCapabilityScopeSelection {
            mode: IntegrationTaskCapabilityScopeMode::InheritCurrent,
            sources: vec![],
        },
        Some("revoked-registration"),
    );
    let revoking = async {
        f.facts.entered.notified().await;
        f.facts.management.store(false, Ordering::SeqCst);
        f.facts.release.notify_one();
    };
    let (result, ()) = tokio::join!(registering, revoking);
    assert!(result.is_err());
    let page = f.store.read_saved_directory(
        &f.context,
        &IntegrationTaskCapabilityScopeDirectoryReadParams {
            thread_id: None,
            cursor: None,
        },
    )?;
    assert!(
        page.entries.is_empty(),
        "revocation cannot commit a binding"
    );
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn warm_record_reads_one_current_index_and_rejects_later_corruption() -> Result<()> {
    let f = Fixture::new().await?;
    let binding = f.bind(none()).await?;
    let before = super::super::storage::index_reads();
    binding.child_tool_snapshot(&f.context)?;
    assert_eq!(super::super::storage::index_reads() - before, 1);
    let decodes = super::super::storage::record_decodes();
    binding.child_tool_snapshot(&f.context)?;
    assert_eq!(super::super::storage::index_reads() - before, 2);
    assert_eq!(super::super::storage::record_decodes(), decodes);
    let profile = f.context.profile()?;
    let domain = NativeDomainGuard::observe(
        profile,
        f.context.scope(),
        NativeDomain::ConnectivityTaskCapabilityScope,
    )?
    .unwrap();
    let directory = domain.directory(profile)?;
    let index = OsStr::new("task-sources-index.json");
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut directory.open_single_link_regular_file(index)?,
        &mut bytes,
    )?;
    directory.atomic_replace(index, &bytes)?;
    binding.child_tool_snapshot(&f.context)?;
    assert_eq!(super::super::storage::record_decodes(), decodes + 1);
    directory.atomic_replace(OsStr::new("task-sources-index.json"), b"{")?;
    assert!(binding.child_tool_snapshot(&f.context).is_err());
    assert!(NativeTaskCapabilityScopeBindingStore::observe(&f.context).is_err());
    f.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn child_output_reads_current_policy_once_after_observing_the_attempt_chain() -> Result<()> {
    use crate::app_server::integrations::core::NativeIdentity;
    use kcoder_types::integrations::core::IntegrationNullable;

    let f = Fixture::new().await?;
    let binding = f.bind(none()).await?;
    let root = f.facts.accepted_turn(&f.context, &f.facts.initial).await?;
    let session = "owned-output-child";
    let execution = NativeTaskCapabilityScopeExecution {
        scope: root.scope,
        task_key: binding.task_key()?,
        current_session_id: session.into(),
        root_session_directory_identity: root.session_directory_identity,
        root_state_epoch: root.state_epoch,
        root_attempt_chain: vec![root.record],
        current_attempt: Some(attempt_record(TurnAttemptIdentity {
            thread_id: session.into(),
            turn_id: "owned-output-turn".into(),
            attempt_id: "owned-output-attempt".into(),
        })),
        lineage: vec![NativeTaskCapabilityScopeLineageEdge {
            run: BackgroundRunKey {
                parent_session_id: f.facts.initial.thread_id.clone(),
                agent_id: "owned-output-agent".into(),
                run_id: "owned-output-run".into(),
            },
            child_session_id: session.into(),
        }],
        native_emitter_id: session.into(),
        emitter_source: None,
        boundary_id: None,
    };

    let full_snapshot = binding.snapshot(&f.context, f.facts.as_ref()).await?;
    let before = f.context.identity_checks();
    let index_before = super::super::storage::index_reads();
    let output_snapshot = f.context.observe_live_profile(|profile| {
        binding.snapshot_for_child_output_in_profile(&f.context, session, &execution, profile)
    })?;
    assert_eq!(output_snapshot, full_snapshot);
    assert_eq!(f.context.identity_checks() - before, 2);
    assert_eq!(super::super::storage::index_reads() - index_before, 1);
    assert!(
        binding
            .snapshot_for_child_output(&f.context, "another-session", &execution)
            .is_err()
    );

    let profile = f.context.profile()?;
    let mut global = f.context.scope().clone();
    global.workspace_id = IntegrationNullable::Null;
    let identity = NativeIdentity::observe(profile, &global)?.context("owned native identity")?;
    let revision = identity.snapshot(profile)?.revision;
    identity.disable(profile, "revoke-child-output", revision, 2_000)?;
    assert_eq!(
        binding
            .snapshot_for_child_output(&f.context, session, &execution)
            .unwrap_err()
            .to_string(),
        "INTEGRATION_IDENTITY_REVOKED"
    );
    f.shutdown().await;
    Ok(())
}
