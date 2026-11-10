use super::*;
mod desktop;
mod leased_versions;
mod task_capability_scope_control;
use futures::StreamExt;
use kcoder_config::CredentialBackend;
use kcoder_engine::WorkspaceRuntimeServices;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use std::sync::atomic::{AtomicUsize, Ordering};

struct NoOs;
impl CredentialBackend for NoOs {
    fn describe(&self) -> String {
        "actual-source-factory-fixture".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        anyhow::bail!("fixture never reads OS credentials")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        anyhow::bail!("fixture never writes OS credentials")
    }
    fn delete(&self, _: &str) -> Result<()> {
        anyhow::bail!("fixture never deletes OS credentials")
    }
}
#[derive(Debug)]
struct FamilyProvider {
    calls: AtomicUsize,
    nested: bool,
}
impl kcoder_api::Provider for FamilyProvider {
    fn name(&self) -> &'static str {
        "owned-source-family-fixture"
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let nested = self.nested;
        Ok(Box::pin(async_stream::stream! {
            if call==0 || (nested && call==1) {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index:0, content_block:kcoder_types::ContentBlock::ToolUse { id:"actual-spawn-call".into(), name:"spawn_agent".into(), input:serde_json::json!({"message":"return one visible owned result","agent_type":"general","context_mode":"none","max_turns":1,"run_in_background":false}) } });
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop { index:0 });
            } else {
                yield Ok(kcoder_types::StreamEvent::ContentBlockStart { index:0, content_block:kcoder_types::ContentBlock::Text {text:String::new()} });
                yield Ok(kcoder_types::StreamEvent::ContentBlockDelta {index:0,delta:kcoder_types::ContentDelta::TextDelta { text:if call==1 {"actual-child-visible-result"} else {"actual-root-visible-result"}.into() }});
                yield Ok(kcoder_types::StreamEvent::ContentBlockStop {index:0});
            }
            yield Ok(kcoder_types::StreamEvent::MessageStop);
        }))
    }
}
#[tokio::test]
async fn actual_factory_original_parent_frame_creates_real_child_accepted_scope_and_finishes_same_runtime()
-> Result<()> {
    run_actual_family(false).await
}

#[tokio::test]
async fn actual_child_role_cannot_gain_unregistered_spawn_tool_from_provider_name() -> Result<()> {
    run_actual_family(true).await
}

async fn run_actual_family(nested: bool) -> Result<()> {
    run_actual_family_with_control(nested, ControlCase::None).await
}
#[tokio::test]
async fn actual_public_task_capability_scope_control_survives_return_disconnect_and_same_operation_ack()
-> Result<()> {
    run_actual_family_with_control(false, ControlCase::Public).await
}
enum ControlCase {
    None,
    Public,
}
async fn run_actual_family_with_control(nested: bool, with_control: ControlCase) -> Result<()> {
    // The actual app-server family builds very large futures in debug builds,
    // more than the 2 MiB test thread stack holds; run it on a larger one.
    tokio::task::spawn_blocking(move || {
        std::thread::Builder::new()
            .name("native-source-family".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(run_actual_family_body(nested, with_control))
            })?
            .join()
            .map_err(|_| anyhow::anyhow!("native source family test thread panicked"))?
    })
    .await?
}
async fn run_actual_family_body(nested: bool, with_control: ControlCase) -> Result<()> {
    let (temp, context) = crate::app_server::integrations::connectivity::lease::tests::fixture()?;
    let context = Arc::new(context);
    let workspace = temp.path().join("workspace");
    let storage = Arc::new(kcoder_config::create_private_temp_dir(
        "native-source-family-owned",
    )?);
    let services = WorkspaceRuntimeServices::new(&workspace, "native-source-family-owned")
        .with_private_client_storage(storage.clone());
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let provider = Arc::new(FamilyProvider {
        calls: AtomicUsize::new(0),
        nested,
    });
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
    let selection = IntegrationTaskCapabilityScopeSelection {
        mode: IntegrationTaskCapabilityScopeMode::None,
        sources: Vec::new(),
    };
    let request = IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "actual-source-control-request".into(),
        scope: context.scope().clone(),
        operation_id: Some("owned-test-creation".into()),
        expected_revision: None,
        timeout_ms: 30_000,
        cancellation_ref: None,
        payload: Default::default(),
    };
    let connection = crate::app_server::ConnectionState {
        integration_context: Some(context.recapture_for_owned_service()?),
        ..Default::default()
    };
    let management = crate::app_server::integrations::core::task_capability_scope_control::NativeTaskCapabilityScopeManagementPermit::from_public_control(&connection,&raw,&lease,&request,&accepted.task_key()?,&selection)?;
    real.install_public_management(&management)?;
    assert!(
        management
            .verify(
                context.scope(),
                &accepted.task_key()?,
                "another-operation",
                &selection
            )
            .is_err()
    );
    assert!(
        management
            .verify(
                context.scope(),
                "another-native-task",
                "owned-test-creation",
                &selection
            )
            .is_err()
    );

    let catalog = Arc::new(NativeConnectivitySourceCatalog::initialize(
        &context,
        "source-family-test-catalog",
    )?);
    let store = Arc::new(NativeTaskCapabilityScopeBindingStore::initialize(
        &context,
        "source-family-test-bindings",
    )?);
    // Existing output-only work and planning records cannot issue connector
    // calls, so the next root binding must neither stop nor adopt them.
    let mut output_job = kcoder_state::Task::new("existing-output-job", "background command");
    output_job.managed = true;
    output_job.status = kcoder_state::TaskStatus::Running;
    output_job.output_path = Some(storage.path().join("background-output"));
    raw.state.upsert_task(output_job);
    raw.state
        .upsert_task(kcoder_state::Task::new("existing-plan", "plan"));
    let boundary = real.claim_root_boundary()?;
    let binding = raw
        .state
        .history_attempt_scope(initial.clone())?
        .run(async {
            let witness = raw.native_tool_execution_witness();
            let callback = NativeTaskCapabilityScopeCallback {
                session_id: witness.session_id(),
                native_witness: &witness,
            };
            store
                .bind_accepted(
                    &context,
                    accepted,
                    "owned-test-creation",
                    IntegrationTaskCapabilityScopeSelection {
                        mode: IntegrationTaskCapabilityScopeMode::None,
                        sources: Vec::new(),
                    },
                    &catalog,
                    None,
                    real.as_ref(),
                    &callback,
                )
                .await
        })
        .await?;
    drop(boundary);
    assert_eq!(
        raw.state.task("existing-output-job").unwrap().status,
        kcoder_state::TaskStatus::Running
    );
    assert_eq!(
        raw.state.task("existing-plan").unwrap().status,
        kcoder_state::TaskStatus::Pending
    );
    raw.state.remove_task("existing-output-job");
    raw.state.remove_task("existing-plan");
    assert!(
        real.authorize_selection(
            &context,
            binding.accepted(),
            "owned-test-creation",
            &selection
        )
        .await
        .is_ok()
    );
    drop(management);
    assert!(
        real.authorize_selection(
            &context,
            binding.accepted(),
            "owned-test-creation",
            &selection
        )
        .await
        .is_err(),
        "weak request proof cannot turn a completed public call into later management authority"
    );
    let binding = Arc::new(binding);
    match with_control {
        ControlCase::None => {}
        ControlCase::Public => {
            task_capability_scope_control::verify_public_control(
                &context,
                &raw,
                &lease,
                &connection,
                &binding,
                &real,
                &catalog,
            )
            .await?
        }
    }
    let guard = Arc::new(NativeTaskCapabilityScopeGuard::pending(
        context.clone(),
        NativeTaskCapabilityScopePendingTarget::StudioTurn(initial.clone()),
        catalog.clone(),
        real.clone(),
    )?);
    guard.bind(binding.clone()).await?;
    let engine = raw
        .with_native_tool_authorization(guard)
        .with_native_tool_ceiling(&["spawn_agent".into(), "read".into()])?;
    let events = engine
        .state
        .history_attempt_scope(initial.clone())?
        .run(async {
            engine
                .run_turn_stream_with_max_turns(&kcoder_permissions::AutoAllowPrompt, 2)
                .collect::<Vec<_>>()
                .await
        })
        .await;
    assert!(events.iter().any(|event|matches!(event,kcoder_engine::EngineEvent::AssistantTextDelta(text) if text=="actual-root-visible-result")),"{events:?}");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    let nodes = real.children.lock().unwrap();
    assert_eq!(
        nodes.len(),
        1,
        "one actual existing runtime child, no replacement runner"
    );
    let child = &nodes[0];
    assert_eq!(child.parent_attempt, initial);

    assert_ne!(child.identity.thread_id, initial.thread_id);
    assert!(child.identity.turn_id.ends_with(&child.run.run_id));
    let record = read_child_record(child)?;
    if nested {
        assert_eq!(record.status, TurnAttemptStatus::Failed);
        assert!(events.iter().any(|event| matches!(event, kcoder_engine::EngineEvent::ToolResult {output,..} if output.is_error && output.content.iter().any(|block| matches!(block,kcoder_types::ContentBlock::Text{text} if text.contains("NATIVE_TASK_AUTHORITY_DENIED"))))));
        // General's real role registry excludes spawn_agent. The provider's
        // unsolicited name cannot widen that registry or create a grandchild.
        assert_eq!(nodes.len(), 1);
    } else {
        assert_eq!(record.status, TurnAttemptStatus::Completed);
        assert_eq!(
            record
                .completion
                .as_ref()
                .map(|completion| completion.status.clone()),
            Some(TurnAttemptStatus::Completed)
        );
        assert!(child.state.messages().iter().any(|message| {
            message
                .preview(1024)
                .contains("actual-child-visible-result")
        }));
    }
    drop(nodes);
    drop(lease);
    assert!(
        real.verify(&context).is_err(),
        "ending native owner cannot be extended by facts handles"
    );
    Ok(())
}

#[tokio::test]
async fn actual_stdio_connection_origin_maps_original_tool_arc_and_close_revokes_the_same_object()
-> Result<()> {
    let (temp, context) = crate::app_server::integrations::connectivity::lease::tests::fixture()?;
    let peer = temp.path().join("owned-origin-peer");
    PrivateDirectory::open_or_create(&peer)?;
    let script = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("../kcoder_mcp/tests/fixtures/lifecycle_server.py");
    let config: kcoder_types::McpServerConfig = serde_json::from_value(
        serde_json::json!({"name":"actual-origin-peer","transport":"stdio","command":"python3","args":[script,"ping",peer]}),
    )?;
    let credential_context = kcoder_mcp::server_policy::CredentialContext {
        config_dir: context.profile_path()?.to_path_buf(),
        mode: kcoder_config::CredentialStoreMode::File,
    };
    let (handle, definitions) = kcoder_mcp::connect_server_with_private_values_in(
        &config,
        None,
        Arc::new(kcoder_mcp::tool::PrivateValues::default()),
        Some(&credential_context),
    )
    .await?;
    let actual = kcoder_mcp::McpTool::new(
        &config.name,
        handle.clone(),
        definitions
            .into_iter()
            .next()
            .context("real tools/list definition")?,
    )
    .with_credential_context(credential_context);
    let origin = actual
        .native_origin()
        .context("actual connected origin")?
        .clone();
    assert!(origin.matches_profile(context.profile()?)?);
    assert_eq!(origin.private_config().command, "python3");
    let tool: Arc<dyn kcoder_tools::Tool> = Arc::new(actual);
    let registry = kcoder_tools::ToolRegistry::new().register_arc(tool.clone());
    let engine = leased_versions::engine(
        &context,
        &temp.path().join("workspace"),
        registry.clone(),
        Default::default(),
    )?;
    let registered = RegisteredSources::capture(&context, &registry, &engine)?;
    {
        let entries = registered.0.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(Arc::ptr_eq(&entries[0].tool.upgrade().unwrap(), &tool));
        assert!(Arc::ptr_eq(&entries[0].origin.upgrade().unwrap(), &origin));
    }
    let original = NativeMcpSourceFact::from_registered_tool(&context, &tool)?;
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "actual-origin-catalog")?;
    let settings = kcoder_config::Settings {
        credential_store: kcoder_config::CredentialStoreMode::File,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let current = NativeMcpSourceFact::from_resolved(&context, &settings, &config, None, &NoOs)?;
    catalog.register(
        &context,
        "actual-current-origin",
        std::slice::from_ref(&current),
    )?;
    let choices = catalog.current_choices(&context, std::slice::from_ref(&current))?;
    assert_eq!(choices.len(), 1);
    catalog.resolve_choice(&context, &choices[0], std::slice::from_ref(&original))?;
    assert_eq!(
        std::fs::read_to_string(peer.join("launches.jsonl"))?
            .lines()
            .count(),
        1
    );
    handle.lock().await.close();
    assert!(!origin.is_live());
    assert!(!tool.is_model_visible());
    assert!(NativeMcpSourceFact::from_registered_tool(&context, &tool).is_err());
    assert!(
        !peer.join("called").exists(),
        "provenance observation never invokes a business tool"
    );
    drop(handle);
    Ok(())
}
