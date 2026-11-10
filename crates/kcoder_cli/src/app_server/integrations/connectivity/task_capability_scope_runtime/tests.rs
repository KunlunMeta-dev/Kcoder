//! Actual private queue -> ordinary turn dispatch -> owned Accepted -> Provider.
//! The source policy is an explicit revocable fixture, never a production provider.
use super::*;
use crate::app_server::{
    integrations::core::{runtime_driver::*, runtime_pump::*},
    *,
};
use kcoder_engine::integrations::core::{
    NativeEngineEventFrame, NativeToolAuthorization, NativeToolAuthorizationError,
    NativeToolAuthorizationRequest, NativeToolExecutionWitness,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

mod ct85_owned;
mod interrupt_rebind;

#[derive(Clone, Copy)]
enum Ct85Case {
    Relabel,
    Fork(bool),
    SensitiveError,
    Concurrent,
    GateRevocation,
}

struct ProbeProvider {
    context: Arc<NativeIntegrationContext>,
    operation: String,
    calls: Arc<AtomicUsize>,
    release: Option<Arc<tokio::sync::Notify>>,
}
impl kcoder_api::Provider for ProbeProvider {
    fn name(&self) -> &'static str {
        "native-source-original-ticket-test"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        request: kcoder_types::MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        if serde_json::to_string(&request.messages)
            .unwrap()
            .contains("ct85 independent foreground request")
        {
            self.calls.fetch_add(1, Ordering::SeqCst);
            return Ok(probe_response());
        }
        let driver = NativeRuntimeDriver::load(&self.context).unwrap().unwrap();
        let receipt = driver
            .read_operation(&self.context, &self.operation)
            .unwrap()
            .unwrap();
        let accepted = receipt.runtime_acceptance.unwrap();
        // The private origin needs its real source binding independently of
        // the optional public source-management capability.
        {
            let store = NativeTaskCapabilityScopeBindingStore::observe(&self.context)
                .unwrap()
                .expect("original private source binding must precede Provider");
            let directory = store
                .read_saved_directory(
                    &self.context,
                    &IntegrationTaskCapabilityScopeDirectoryReadParams {
                        thread_id: Some(accepted.thread_id.clone()),
                        cursor: None,
                    },
                )
                .unwrap();
            assert_eq!(directory.entries.len(), 1);
            let original = directory.entries[0].target.as_ref().unwrap();
            assert_eq!(
                original.runtime_operation_id.as_deref(),
                Some(self.operation.as_str())
            );
            assert_eq!(
                Some(original.initial_attempt.turn_id.as_str()),
                accepted.turn_id.as_deref()
            );
            // An empty source ceiling stays durable in the original binding,
            // without appending a no-op source-registration receipt per turn.
            use crate::app_server::integrations::core::{NativeDomain, NativeDomainGuard};
            use std::io::Read;
            let profile = self.context.profile().unwrap();
            let catalog = NativeDomainGuard::observe(
                profile,
                self.context.scope(),
                NativeDomain::ConnectivitySources,
            )
            .unwrap()
            .unwrap()
            .directory(profile)
            .unwrap();
            let mut bytes = Vec::new();
            catalog
                .open_single_link_regular_file(std::ffi::OsStr::new("native-sources.json"))
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            let document: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(document["operations"].as_object().unwrap().is_empty());
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(release) = self.release.clone() {
            use futures::StreamExt as _;
            Ok(Box::pin(
                futures::stream::once(async move {
                    release.notified().await;
                    probe_response()
                })
                .flatten(),
            ))
        } else {
            Ok(probe_response())
        }
    }
}
fn probe_response() -> kcoder_api::ProviderStream {
    Box::pin(futures::stream::iter([
        Ok(kcoder_types::StreamEvent::ContentBlockStart {
            index: 0,
            content_block: kcoder_types::ContentBlock::Text {
                text: String::new(),
            },
        }),
        Ok(kcoder_types::StreamEvent::ContentBlockDelta {
            index: 0,
            delta: kcoder_types::ContentDelta::TextDelta {
                text: "Original runtime receipt and source proven before Provider.".into(),
            },
        }),
        Ok(kcoder_types::StreamEvent::ContentBlockStop { index: 0 }),
        Ok(kcoder_types::StreamEvent::MessageStop),
    ]))
}
struct RevocableAuthority {
    enabled: AtomicBool,
    provider_checks: AtomicUsize,
    admission_checks: AtomicUsize,
    async_current: Option<CurrentSourceFixture>,
}
// This controlled gate tests original queue timing; it is not a channel PDP.
struct CurrentSourceFixture {
    allowed: bool,
    calls: AtomicUsize,
}
#[async_trait::async_trait]
impl NativeRuntimeCurrentSource for CurrentSourceFixture {
    async fn verify_current_source(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        cancel: &CancellationToken,
    ) -> Result<()> {
        context.validate_scope(&request.scope)?;
        prepared.validate()?;
        tokio::task::yield_now().await;
        self.calls.fetch_add(1, Ordering::SeqCst);
        ensure!(
            self.allowed && !cancel.is_cancelled(),
            "EXPLICIT_ASYNC_CURRENT_SOURCE_REVOKED"
        );
        Ok(())
    }
}
impl NativeRuntimeAuthority for RevocableAuthority {
    fn current_source(&self) -> Option<&dyn NativeRuntimeCurrentSource> {
        self.async_current
            .as_ref()
            .map(|gate| gate as &dyn NativeRuntimeCurrentSource)
    }
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.validate_scope(&request.scope)?;
        prepared.validate()?;
        self.admission_checks.fetch_add(1, Ordering::SeqCst);
        ensure!(
            self.enabled.load(Ordering::SeqCst),
            "EXPLICIT_SOURCE_FIXTURE_REVOKED_PRIVATE_MARKER"
        );
        Ok(())
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        self
    }
}
impl NativeRuntimePolicyInstaller for RevocableAuthority {
    fn install(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine> {
        self.verify_admission(context, request, prepared)?;
        Ok(engine)
    }
}
struct OriginalGuard {
    authority: Arc<RevocableAuthority>,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for OriginalGuard {
    async fn authorize_provider(
        &self,
        _: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.authority
            .provider_checks
            .fetch_add(1, Ordering::SeqCst);
        if self.authority.enabled.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Unavailable)
        }
    }
    async fn authorize_event(
        &self,
        _: &NativeEngineEventFrame,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        if self.authority.enabled.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Unavailable)
        }
    }
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
}

/// The real app-server dispatch future exceeds libtest's default 2 MiB thread
/// stack in debug builds. Production runs it on 16 MiB runtime threads, so the
/// test builds and polls it on one owned thread with the same stack size.
fn on_dispatch_stack<F, Fut>(body: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<()>>,
{
    let joined = std::thread::Builder::new()
        .name("owned-original-runtime-dispatch".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(body())
                .unwrap()
        })
        .unwrap()
        .join();
    if let Err(panic) = joined {
        std::panic::resume_unwind(panic);
    }
}

#[test]
fn actual_private_ticket_commits_original_runtime_source_before_provider_and_reconciles_response() {
    on_dispatch_stack(|| run_original_runtime(false, false, false));
}
#[test]
fn actual_private_ticket_lost_response_preserves_accepted_receipt_without_replaying_provider() {
    on_dispatch_stack(|| run_original_runtime(true, false, false));
}
#[test]
fn actual_private_ticket_revoked_before_owned_accepted_never_borrows_studio_origin() {
    on_dispatch_stack(|| run_original_runtime(false, true, false));
}

#[test]
fn actual_private_ticket_rejects_replaced_request_despite_matching_operation_label() {
    on_dispatch_stack(|| run_original_runtime(false, false, true));
}

async fn run_original_runtime(
    lose_response: bool,
    revoke: bool,
    corrupt_request: bool,
) -> Result<()> {
    run_original_runtime_mode(
        lose_response,
        revoke,
        corrupt_request,
        None,
        true,
        false,
        None,
    )
    .await
}
#[test]
fn async_original_source_is_checked_before_provider_with_task_capability_scope_capability() {
    on_dispatch_stack(|| {
        run_original_runtime_mode(false, false, false, Some(true), true, false, None)
    });
}
#[test]
fn async_original_source_is_checked_before_provider_without_task_capability_scope_capability() {
    on_dispatch_stack(|| {
        run_original_runtime_mode(false, false, false, Some(true), false, false, None)
    });
}
#[test]
fn async_source_revoke_keeps_original_accepted_and_runs_no_provider() {
    on_dispatch_stack(|| {
        run_original_runtime_mode(false, false, false, Some(false), false, false, None)
    });
}
#[test]
fn d33_original_runtime_source_target_observes_both_real_owner_readers() {
    on_dispatch_stack(|| run_original_runtime_mode(false, false, false, None, true, true, None));
}
async fn run_original_runtime_mode(
    lose_response: bool,
    revoke: bool,
    corrupt_request: bool,
    current: Option<bool>,
    source_capability: bool,
    observe_enrichment: bool,
    ct85_case: Option<Ct85Case>,
) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let profile = temp.path().join("profile");
    let workspace = temp.path().join("workspace");
    kcoder_config::PrivateDirectory::open_or_create(&profile)?;
    std::fs::create_dir(&workspace)?;
    if ct85_case.is_some() {
        kcoder_config::set_user_only_dir_permissions(&workspace)?;
        crate::app_server::ct85_test_support::prepare_workspace(&workspace);
    }
    let native = Arc::new(NativeIntegrationContext::capture(
        &profile,
        &workspace,
        "native-private-test",
        "model-1",
    )?);
    let operation = "original-private-runtime-source";
    let calls = Arc::new(AtomicUsize::new(0));
    let release = matches!(ct85_case, Some(Ct85Case::Concurrent))
        .then(|| Arc::new(tokio::sync::Notify::new()));
    let authority = Arc::new(RevocableAuthority {
        enabled: AtomicBool::new(true),
        provider_checks: AtomicUsize::new(0),
        admission_checks: AtomicUsize::new(0),
        async_current: current.map(|allowed| CurrentSourceFixture {
            allowed,
            calls: AtomicUsize::new(0),
        }),
    });
    let settings = kcoder_config::Settings {
        history_enabled: false,
        permission_mode: kcoder_config::PermissionMode::Bypass,
        max_retries: 0,
        ..crate::test_fixtures::settings_with_default_provider()
    };
    let owner = Arc::new(kcoder_config::create_private_temp_dir(
        "native-ticket-source-test",
    )?);
    // Construct test services without a Tokio runtime on the worker thread so
    // this fixture does not start unrelated shell or scheduler processes.
    let services = if ct85_case.is_some() {
        let workspace = workspace.clone();
        std::thread::spawn(move || {
            kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "native-ticket-source-test")
        })
        .join()
        .expect("owned service setup")
    } else {
        kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "native-ticket-source-test")
    };
    let factory = AppServerEngineFactory::new(
        Arc::new(ProbeProvider {
            context: native.clone(),
            operation: operation.into(),
            calls: calls.clone(),
            release: release.clone(),
        }),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        kcoder_plugins::EffectivePluginSnapshot::default(),
        workspace.clone(),
        None,
        true,
        services.with_private_client_storage(owner),
        None,
        profile.join("short-ids"),
    );
    let mut engine = factory
        .create_new_thread(Arc::new(kcoder_tools::DenyAllUserQuestioner))?
        .with_native_tool_authorization(Arc::new(OriginalGuard {
            authority: authority.clone(),
        }));
    let thread = engine.session_id();
    engine
        .state
        .with_history_path(profile.join(format!("{thread}.jsonl")));
    engine.state.save_history()?;
    let lease = SessionLease::acquire(&engine.session_lease_target())?;
    let (outbound, mut notifications) = mpsc::channel(256);
    let sequence = Arc::new(AtomicU64::new(1));
    let turn_state = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Bypass,
        Arc::new(AtomicU64::new(2_000_000)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    let resident = build_resident_thread_runtime(
        engine.clone(),
        lease,
        0,
        turn_state,
        outbound.clone(),
        "native-source-ticket-test".into(),
        sequence.clone(),
    );
    let mut manager = ThreadManager::default();
    assert!(manager.insert(resident).is_ok());
    // Keep a real viewing client attached; native input is not an attachment.
    let viewing_client = ConnectionState::default();
    manager
        .followups(&thread)
        .context("original task activity missing")?
        .session_activity
        .attach(
            &viewing_client,
            &uuid::Uuid::new_v4().to_string(),
            &uuid::Uuid::new_v4().to_string(),
        )?;
    let spec = PreparedRuntimeTask {
        input: vec![kcoder_app_protocol::UserInput::Text {
            text: "Return the original runtime result.".into(),
        }],
        studio_work_mode: kcoder_types::StudioWorkMode::Kcoder,
        existing_thread_id: Some(thread.clone()),
        client_presentation: None,
        configuration: RuntimeExecutionConfiguration {
            model: IntegrationModelResolutionResult {
                selection_kind: IntegrationModelSelectionKind::InheritCurrent,
                model: engine.active_model_configuration_summary()?,
                policy_ref: IntegrationNullable::Null,
                budget: IntegrationModelBudget {
                    reservation_state: IntegrationBudgetReservationState::NotReserved,
                    cost_known: false,
                },
            },
            allowed_tools: Some(vec![]),
            external_send: RuntimeExternalSend::Deny,
            workflow: None,
        },
    };
    let request = IntegrationRequest { contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "original-native-accept".into(), scope: native.scope().clone(), operation_id: Some(operation.into()),
        expected_revision: None, timeout_ms: 30_000, cancellation_ref: None,
        payload: serde_json::json!({"source":{"kind":"office_assistant","assistantId":"fixed-fixture","version":1},"message":{"text":"Return the original runtime result."}}).as_object().unwrap().clone() };
    let (mut pump, client) = NativeRuntimePump::new();
    let observer_runtime = client.clone();
    let queued_native = Arc::new(native.recapture_for_owned_service()?);
    let queued_authority = authority.clone();
    let caller = tokio::spawn(async move {
        client
            .accept(queued_native, request, spec, queued_authority)
            .await
    });
    let generated = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if let Some(generated) = pump.next_request(&mut manager)? {
                return Ok::<_, anyhow::Error>(generated);
            }
            let event = pump.receive().await;
            pump.observe(event, &outbound, &manager).await?;
        }
    })
    .await??;
    assert_eq!(generated.method, "turn/start");
    assert!(generated.accepted_observer.is_some());
    if revoke {
        authority.enabled.store(false, Ordering::SeqCst);
    }
    let mut state = ConnectionState {
        integration_context: Some(native.recapture_for_owned_service()?),
        integration_task_capability_scope_v1: source_capability,
        native_source_dispatch: true,
        native_source_accepted: generated.accepted_observer.clone(),
        ..Default::default()
    };
    let mut attachments = AttachmentDirectories::default();
    let messages_before_dispatch = serde_json::to_value(engine.state.messages())?;
    let mut dispatch_params = generated.params;
    if corrupt_request {
        dispatch_params["input"] = serde_json::json!([{"type":"text","text":"A replaced request cannot borrow the original private ticket."}]);
    }
    let revocation_job = if matches!(ct85_case, Some(Ct85Case::GateRevocation)) {
        let turn = manager
            .turn_state(&thread)
            .context("original turn owner missing")?;
        let gate = Arc::clone(&turn.activity_gate).lock_owned().await;
        let before = authority.admission_checks.load(Ordering::SeqCst);
        let authority = authority.clone();
        Some(tokio::spawn(async move {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while authority.admission_checks.load(Ordering::SeqCst) == before {
                    tokio::task::yield_now().await;
                }
            })
            .await?;
            authority.enabled.store(false, Ordering::SeqCst);
            drop(gate);
            Ok::<_, anyhow::Error>(())
        }))
    } else {
        None
    };
    crate::app_server::turn_requests::dispatch(
        generated.method,
        serde_json::json!(generated.ticket.id()),
        dispatch_params,
        &mut engine,
        &factory,
        &generated.outbound,
        &mut manager,
        "native-source-ticket-test",
        &sequence,
        &mut state,
        &mut attachments,
        None,
    )
    .await?;
    state.native_source_dispatch = false;
    state.native_source_accepted = None;
    if let Some(revocation_job) = revocation_job {
        revocation_job.await??;
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let event = pump.receive().await;
                if matches!(&event, RuntimePumpEvent::PrivateFrame(frame) if frame["id"] == generated.ticket.id()) {
                    return Ok::<_, anyhow::Error>(event);
                }
                pump.observe(event, &outbound, &manager).await?;
            }
        }).await??;
        let RuntimePumpEvent::PrivateFrame(frame) = &event else {
            unreachable!()
        };
        assert_eq!(frame["error"]["code"], -32022, "{frame}");
        assert_eq!(
            frame["error"]["message"],
            "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"
        );
        assert!(!frame.to_string().contains("PRIVATE_MARKER"));
        assert_eq!(
            serde_json::to_value(engine.state.messages())?,
            messages_before_dispatch
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let records =
            TurnAttemptStore::open_existing(&engine.session_storage_dir_for(&thread), &thread)?
                .map(|store| store.list())
                .transpose()?
                .unwrap_or_default();
        assert!(records.is_empty(), "revocation must precede Accepted");
        pump.observe(event, &outbound, &manager).await?;
        caller.abort();
        let _ = caller.await;
        pump.close().await;
        for resident in manager.drain() {
            resident.shutdown().await;
        }
        return Ok(());
    }
    if matches!(ct85_case, Some(Ct85Case::Concurrent)) {
        ct85_owned::check_active_native_turn(ct85_owned::RelabelFixture {
            engine: &mut engine,
            factory: &factory,
            manager: &mut manager,
            outbound: &outbound,
            notifications: &mut notifications,
            sequence: &sequence,
            thread: &thread,
            authority: &authority,
            calls: &calls,
            case: Ct85Case::Concurrent,
        })
        .await?;
        release
            .as_ref()
            .context("owned Provider gate missing")?
            .notify_one();
    }
    if revoke || corrupt_request {
        let mut rejected_original_request = false;
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let event = pump.receive().await;
                if let RuntimePumpEvent::PrivateFrame(frame) = &event
                    && frame["id"] == generated.ticket.id()
                {
                    assert_eq!(frame["error"]["code"], -32022);
                    assert_eq!(
                        frame["error"]["message"],
                        "NATIVE_INPUT_SOURCE_ADMISSION_REQUIRED"
                    );
                    assert!(!frame.to_string().contains("PRIVATE_MARKER"));
                    rejected_original_request = true;
                }
                pump.observe(event, &outbound, &manager).await?;
                if rejected_original_request && caller.is_finished() {
                    break;
                }
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        assert!(rejected_original_request);
        // The driver conservatively retains an unconfirmed operation. That
        // projection is not execution success or permission to retry it.
        assert_eq!(caller.await??.status, IntegrationStatus::Unknown);
        let receipt = NativeRuntimeDriver::load(&native)?
            .unwrap()
            .read_operation(&native, operation)?
            .unwrap();
        assert!(receipt.runtime_acceptance.is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(authority.provider_checks.load(Ordering::SeqCst), 0);
        assert!(NativeTaskCapabilityScopeBindingStore::observe(&native)?.is_none());
        assert_eq!(
            serde_json::to_value(engine.state.messages())?,
            messages_before_dispatch,
            "rejected private input cannot enter conversation history"
        );
        while let Ok(frame) = notifications.try_recv() {
            assert!(
                frame["method"] != "turn/started" && frame["method"] != "turn/completed",
                "rejection before Owned Accepted cannot invent a turn terminal"
            );
        }
        pump.close().await;
        for resident in manager.drain() {
            resident.shutdown().await;
        }
        return Ok(());
    }
    if lose_response {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        pump.dispatch_failed(&generated.ticket);
    }
    let terminal = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            while let Ok(frame) = notifications.try_recv() {
                if frame["method"] == "turn/completed" {
                    return Ok::<_, anyhow::Error>(frame);
                }
            }
            let event = pump.receive().await;
            pump.observe(event, &outbound, &manager).await?;
        }
    })
    .await??;
    assert_eq!(
        terminal["params"]["turn"]["status"],
        if revoke || corrupt_request || current == Some(false) {
            "failed"
        } else {
            "completed"
        },
        "{terminal}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        usize::from(!revoke && !corrupt_request && current != Some(false))
    );
    if current == Some(false) {
        let receipt = NativeRuntimeDriver::load(&native)?
            .unwrap()
            .read_operation(&native, operation)?
            .unwrap();
        assert!(receipt.runtime_acceptance.is_some());
        assert!(NativeTaskCapabilityScopeBindingStore::observe(&native)?.is_none());
        caller.abort();
    } else if !revoke && !corrupt_request {
        assert!(authority.provider_checks.load(Ordering::SeqCst) > 0);
        let accepted = caller.await??;
        assert_eq!(accepted.status, IntegrationStatus::Accepted);
        let driver = NativeRuntimeDriver::load(&native)?.unwrap();
        assert!(
            driver
                .read_operation(&native, operation)?
                .unwrap()
                .runtime_acceptance
                .is_some()
        );
        if observe_enrichment {
            let store = NativeTaskCapabilityScopeBindingStore::observe(&native)?
                .context("original source store missing")?;
            let directory = store.read_saved_directory(
                &native,
                &IntegrationTaskCapabilityScopeDirectoryReadParams {
                    thread_id: Some(thread.clone()),
                    cursor: None,
                },
            )?;
            assert_eq!(directory.entries.len(), 1);
            let target = directory.entries[0]
                .target
                .as_ref()
                .context("original source target missing")?
                .clone();
            let observer = crate::app_server::integrations::core::task_workspace::spawn_task_capability_scope_enrichment_probe(
                &state,&manager,&factory,target.clone(),observer_runtime,
            )?;
            let value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                while !observer.is_finished() {
                    let event = pump.receive().await;
                    pump.observe(event, &outbound, &manager).await?;
                }
                observer
                    .await
                    .context("owned source enrichment observer failed")?
            })
            .await??;
            assert_eq!(value["target"], serde_json::json!(target));
            assert_eq!(value["runtime"]["threadId"], thread);
            assert!(value["sourceSelection"].is_object());
        }
    } else {
        let directory = NativeTaskCapabilityScopeBindingStore::observe(&native)?;
        assert!(directory.is_none());
        caller.abort();
    }
    if let Some(gate) = &authority.async_current {
        assert!(gate.calls.load(Ordering::SeqCst) > 0);
    }
    if let Some(case @ (Ct85Case::Relabel | Ct85Case::Fork(_))) = ct85_case {
        ct85_owned::reject_relabelled_public_turn(ct85_owned::RelabelFixture {
            engine: &mut engine,
            factory: &factory,
            manager: &mut manager,
            outbound: &outbound,
            notifications: &mut notifications,
            sequence: &sequence,
            thread: &thread,
            authority: &authority,
            calls: &calls,
            case,
        })
        .await?;
    }
    pump.close().await;
    for resident in manager.drain() {
        resident.shutdown().await;
    }
    Ok(())
}
