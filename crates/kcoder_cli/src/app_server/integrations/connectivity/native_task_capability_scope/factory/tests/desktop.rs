use super::*;
use kcoder_engine::integrations::core::NativeToolAuthorization;
use kcoder_types::computer_use::DesktopOwner;
use std::time::Duration;

#[derive(Debug)]
struct DesktopProvider(AtomicUsize);
impl kcoder_api::Provider for DesktopProvider {
    fn name(&self) -> &'static str {
        "owned-desktop-authority-fixture"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        Ok(Box::pin(async_stream::stream! {
            if first {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index:0, content_block:kcoder_types::ContentBlock::ToolUse { id:"desktop-fixture-call".into(), name:kcoder_mcp::mcp_tool_name("kcoder_computer_use", "Snapshot"), input:serde_json::json!({}) } });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index:0 });
            } else {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index:0, content_block:kcoder_types::ContentBlock::Text { text:"desktop-fixture-finished".into() } });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index:0 });
            }
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}

#[tokio::test]
async fn actual_native_factory_late_desktop_with_selected_source_publishes_tool_events()
-> Result<()> {
    let (temp, context) = crate::app_server::integrations::connectivity::lease::tests::fixture()?;
    let context = Arc::new(context);
    let workspace = temp.path().join("workspace");
    let storage = Arc::new(kcoder_config::create_private_temp_dir(
        "native-source-family-owned",
    )?);
    let services = WorkspaceRuntimeServices::new(&workspace, "native-source-family-owned")
        .with_private_client_storage(storage.clone());
    let settings = kcoder_config::Settings {
        mcp_servers: vec![serde_json::from_value(
            serde_json::json!({"name":"selected-unused-source","transport":"stdio","command":"owned-never-launched"}),
        )?],
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let provider = Arc::new(DesktopProvider(AtomicUsize::new(0)));
    let configuration = AppServerEngineFactory::new(
        provider.clone(),
        kcoder_tools::default_registry(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        workspace.clone(),
        None,
        true,
        services,
        Some(context.profile_path()?.join("settings.json")),
        context.profile_path()?.join("source-short-ids.json"),
    );
    let raw = configuration.create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    ensure!(
        raw.client_storage_root().starts_with(storage.path()),
        "fixture session storage must stay owned"
    );
    let target = raw.session_lease_target();
    PrivateDirectory::open_or_create(target.parent().context("fixture target parent")?)?;
    let lease = SessionLease::acquire(&target)?;
    raw.state.add_message(kcoder_types::Message::user_text(
        "run the isolated actual source family",
    ));
    let initial = TurnAttemptIdentity {
        thread_id: raw.session_id(),
        turn_id: "actual-root-turn".into(),
        attempt_id: "actual-root-attempt".into(),
    };
    TurnAttemptStore::open(
        &raw.session_storage_dir_for(&raw.session_id()),
        &raw.session_id(),
    )?
    .begin(TurnAttemptRecord {
        client_presentation: None,
        version: 1,
        identity: initial.clone(),
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: digest(&raw.state.messages())?,
        request_fingerprint: None,
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
    })?;
    let real = Arc::new(NativeTaskCapabilityScopeFactory::capture(
        context.clone(),
        &raw,
        &lease,
        configuration,
        Arc::new(NoOs),
    )?);
    let accepted =
        NativeAcceptedTaskIdentity::capture_studio(&context, &initial, real.as_ref()).await?;
    let catalog = Arc::new(NativeConnectivitySourceCatalog::initialize(
        &context,
        "desktop-source-catalog",
    )?);
    let sources = real.sources(&context).await?;
    assert!(!sources.is_empty());
    catalog.register(&context, "desktop-source-selection", &sources)?;
    let selection = IntegrationTaskCapabilityScopeSelection {
        mode: IntegrationTaskCapabilityScopeMode::Selected,
        sources: catalog.current_choices(&context, &sources)?,
    };
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "desktop-source-request".into(),
        scope: context.scope().clone(),
        operation_id: Some("desktop-source-operation".into()),
        expected_revision: None,
        timeout_ms: 30_000,
        cancellation_ref: None,
        payload: Default::default(),
    };
    let connection = crate::app_server::ConnectionState {
        integration_context: Some(context.recapture_for_owned_service()?),
        ..Default::default()
    };
    let management = crate::app_server::integrations::core::task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit::from_public_control(
        &connection, &raw, &lease, &request, &accepted.task_key()?, &selection)?;
    real.install_public_management(&management)?;
    let store = Arc::new(NativeTaskCapabilityScopeBindingStore::initialize(
        &context,
        "desktop-source-bindings",
    )?);
    let boundary = real.claim_root_boundary()?;
    let binding = raw
        .state
        .history_attempt_scope(initial.clone())?
        .run(async {
            let witness = raw.native_tool_execution_witness();
            store
                .bind_accepted(
                    &context,
                    accepted,
                    "desktop-source-operation",
                    selection,
                    &catalog,
                    None,
                    real.as_ref(),
                    &NativeTaskCapabilityScopeCallback {
                        session_id: witness.session_id(),
                        native_witness: &witness,
                    },
                )
                .await
        })
        .await?;
    drop(boundary);
    let guard = Arc::new(NativeTaskCapabilityScopeGuard::pending(
        context.clone(),
        NativeTaskCapabilityScopePendingTarget::StudioTurn(initial.clone()),
        catalog,
        real.clone(),
    )?);
    assert!(
        !binding
            .snapshot(&context, real.as_ref())
            .await?
            .effective_sources
            .is_empty()
    );
    guard.bind(Arc::new(binding)).await?;
    let owner = DesktopOwner {
        client_instance: "actual-desktop-fixture".into(),
        thread_id: raw.session_id(),
        turn_id: initial.turn_id.clone(),
    };
    let (session, serving) = super::super::super::tests::desktop::session(owner.clone()).await;
    let definition: kcoder_mcp::model::McpToolDefinition = serde_json::from_value(
        serde_json::json!({"name":"Snapshot","description":"owned no-GUI fixture","inputSchema":{"type":"object"}}),
    )?;
    let other = real
        .configuration
        .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?;
    assert!(other.bind_desktop_turn(owner.clone()).is_err());
    assert!(
        crate::app_server::desktop_attachment::attach(
            &other,
            session.clone(),
            vec![definition.clone()]
        )
        .is_err()
    );
    // Use the same pure attachment helper as the Windows host, after factory capture.
    let authorized = raw.clone().with_native_tool_authorization(guard.clone());
    let (engine, desktop_binding) = crate::app_server::desktop_attachment::attach(
        &authorized,
        session.clone(),
        vec![definition],
    )?;
    let frames = engine
        .state
        .history_attempt_scope(initial.clone())?
        .run(async {
            engine
                .run_native_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 2)
                .collect::<Vec<_>>()
                .await
        })
        .await;
    assert!(frames.iter().any(|frame| matches!(frame.event(), kcoder_engine::EngineEvent::ToolResult {output,..} if !output.is_error)), "{:?}", frames.iter().map(|f|f.event()).collect::<Vec<_>>());
    for frame in frames.iter().filter(|frame| frame.has_tool_identity()) {
        guard.authorize_event(frame).await?;
    }
    session.note_host_failure("lease_revoked");
    for frame in frames.iter().filter(|frame| frame.has_tool_identity()) {
        assert!(guard.authorize_event(frame).await.is_err());
    }
    drop(desktop_binding);
    session
        .stop()
        .await
        .map_err(|error| anyhow::anyhow!("fixture cleanup: {error:?}"))?;
    drop(frames);
    drop(authorized);
    drop(engine);
    drop(session);
    tokio::time::timeout(Duration::from_secs(2), serving).await??;
    Ok(())
}
