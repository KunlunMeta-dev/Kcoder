//! Client subscriptions own their resources and inputs, never the task runtime.
use super::*;
use crate::app_server::ConnectionState;
use std::sync::Weak;
use tokio_util::sync::CancellationToken;

pub(in crate::app_server) struct NativeUiTaskOwner {
    thread: String,
    server: String,
    runtime: String,
    owner: Weak<()>,
    ended: CancellationToken,
    retired: CancellationToken,
    mcp_apps: Arc<crate::app_server::mcp_apps_registry::AppRegistry>,
}
impl NativeUiTaskOwner {
    #[cfg(test)]
    pub(super) fn capture(
        state: &ConnectionState,
        manager: &ThreadManager,
        thread: &str,
        server: &str,
        retired: CancellationToken,
    ) -> Result<Arc<Self>> {
        Self::capture_presentation(state, manager, thread, server, retired)
    }
    pub(in crate::app_server) fn capture_presentation(
        state: &ConnectionState,
        manager: &ThreadManager,
        thread: &str,
        server: &str,
        retired: CancellationToken,
    ) -> Result<Arc<Self>> {
        let snapshot = manager.handoff_snapshot(thread, server);
        Ok(Arc::new(Self {
            thread: thread.into(),
            server: server.into(),
            runtime: snapshot
                .owner_ref
                .context("TASK_UI_ORIGINAL_RUNTIME_REQUIRED")?,
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            retired,
            mcp_apps: state.mcp_app_registry.clone(),
        }))
    }
    pub(super) fn verify(
        &self,
        state: &ConnectionState,
        manager: &ThreadManager,
        thread: &str,
        server: &str,
    ) -> Result<()> {
        ensure!(
            self.thread == thread
                && self.server == server
                && self
                    .owner
                    .ptr_eq(&Arc::downgrade(&state.source_management_owner))
                && self.owner.upgrade().is_some()
                && !self.ended.is_cancelled()
                && !self.retired.is_cancelled()
                && manager
                    .handoff_snapshot(thread, server)
                    .owner_ref
                    .as_deref()
                    == Some(self.runtime.as_str()),
            "TASK_UI_ORIGINAL_RUNTIME_REQUIRED"
        );
        Ok(())
    }
    pub(in crate::app_server) fn retired(&self) -> bool {
        self.retired.is_cancelled()
    }

    pub(in crate::app_server) fn same_resident(&self, other: &Self) -> bool {
        self.thread == other.thread && self.server == other.server && self.runtime == other.runtime
    }
}

#[derive(Default)]
pub(in crate::app_server) struct NativeUiTaskOwners {
    presentations: Vec<Arc<NativeUiTaskOwner>>,
}
impl NativeUiTaskOwners {
    pub(in crate::app_server) fn retain(&mut self, owner: Arc<NativeUiTaskOwner>) {
        self.presentations.push(owner);
    }
    pub(in crate::app_server) async fn retire_ended(
        &mut self,
        manager: &mut ThreadManager,
        engine: &mut kcoder_engine::QueryEngine,
        workspace: &kcoder_engine::QueryEngine,
    ) {
        let mut index = 0;
        while index < self.presentations.len() {
            let owner = &self.presentations[index];
            let current = manager
                .handoff_snapshot(&owner.thread, &owner.server)
                .owner_ref
                .as_deref()
                == Some(owner.runtime.as_str());
            if !current
                || owner.retired.is_cancelled()
                || owner.ended.is_cancelled()
                || owner.owner.upgrade().is_none()
            {
                let owner = self.presentations.swap_remove(index);
                owner.retired.cancel();
                // Session survival is enforced by the original task host.
                // Resource retirement cannot cancel a peer-observed turn.
                if current
                    && crate::app_server::mcp_apps_rpc::revoke_original_registry(
                        &owner.mcp_apps,
                        Some(&owner.thread),
                    )
                    .await
                    .is_err()
                {
                    tracing::warn!(
                        code = "TASK_UI_RESOURCE_RELEASE_UNCONFIRMED",
                        "Original UI resource release requires reconciliation; artifacts retained"
                    );
                }
                // Temporary threads are client resources, unlike persistent
                // tasks. Only their final exact subscription may dispose them.
                if current
                    && manager.is_ephemeral(&owner.thread)
                    && !self
                        .presentations
                        .iter()
                        .any(|peer| peer.same_resident(&owner))
                {
                    match manager.remove_ephemeral(&owner.thread) {
                        Ok(Some(runtime)) => {
                            if engine.session_id() == owner.thread {
                                *engine = workspace.clone();
                            }
                            runtime.shutdown().await;
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(%error, "temporary client runtime cleanup failed")
                        }
                    }
                }
            } else {
                index += 1;
            }
        }
        // Resident retention and eviction belong to ThreadManager. Ending a
        // subscription never releases a persistent task's State or SessionLease.
    }
}

pub(in crate::app_server) trait NativeUiTaskTurnAuthority:
    Send + Sync
{
    fn verify(&self, state: &ConnectionState, input: &NativeUiTaskCall) -> Result<()>;
}
pub(in crate::app_server) struct NativeUiTaskTurnRequest {
    pub state: ConnectionState,
    pub input: NativeUiTaskCall,
    pub owner: Arc<NativeUiTaskOwner>,
    pub id: Value,
    pub outbound: mpsc::Sender<Value>,
    pub authority: Arc<dyn NativeUiTaskTurnAuthority>,
    pub reply: oneshot::Sender<(ConnectionState, Result<()>)>,
}
pub(in crate::app_server) struct NativeUiTaskTurnDispatch<'a> {
    pub engine: &'a mut kcoder_engine::QueryEngine,
    pub factory: &'a crate::app_server::AppServerEngineFactory,
    pub manager: &'a mut ThreadManager,
    pub server: &'a str,
    pub sequence: &'a Arc<std::sync::atomic::AtomicU64>,
    pub interactions: &'a Arc<std::sync::atomic::AtomicU64>,
    pub attachments: &'a mut crate::app_server::AttachmentDirectories,
    #[cfg(target_os = "linux")]
    pub interruptions: &'a mut crate::app_server::turn_interrupt::NativeInterruptJobs,
}
impl NativeUiTaskTurnDispatch<'_> {
    pub(in crate::app_server) async fn dispatch(&mut self, mut request: NativeUiTaskTurnRequest) {
        let admission = request
            .authority
            .verify(&request.state, &request.input)
            .and_then(|()| {
                request.owner.verify(
                    &request.state,
                    self.manager,
                    request.input.thread_id(),
                    self.server,
                )
            })
            .and_then(|()| {
                // A presentation owner cannot borrow the platform actor. Only
                // a verified retained configuration plus this initialized UI
                // source can reach the ordinary per-input Native admission.
                let ledger_control = matches!(
                    &request.input,
                    NativeUiTaskCall::AsyncQuestion(input)
                        if matches!(
                            &input.operation,
                            kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskAsyncQuestionOperation::List(_)
                                | kcoder_app_protocol::integrations::channel_peer::ChannelPeerTaskAsyncQuestionOperation::Cancel(_)
                        )
                );
                ensure!(
                    matches!(&request.input, NativeUiTaskCall::Interrupt(_) | NativeUiTaskCall::Expert(_) | NativeUiTaskCall::Command(_))
                        || ledger_control
                        || crate::app_server::integrations::connectivity::task_ui::prepare_resident_input(
                            &request.state, self.manager, request.input.thread_id(),
                        )?.is_some(),
                    "TASK_UI_RESIDENT_INPUT_NOT_ADMITTED"
                );
                request.input.original()
            });
        let result = match admission {
            Ok((method, params)) => {
                // All original interruption jobs remain owned by the actual
                // Core connection, even when the requesting UI disappears.
                #[cfg(target_os = "linux")]
                if method == "turn/interrupt" {
                    std::mem::swap(&mut request.state.native_interrupts, self.interruptions);
                }
                let result = if matches!(&request.input, NativeUiTaskCall::Command(_)) {
                    Box::pin(super::ui_task_commands::dispatch(
                        method,
                        request.id,
                        params,
                        self.engine,
                        &request.outbound,
                        self.manager,
                        &mut request.state,
                    ))
                    .await
                } else if crate::app_server::async_question_requests::supports(method) {
                    Box::pin(crate::app_server::async_question_requests::dispatch(
                        method,
                        request.id,
                        params,
                        self.engine,
                        self.factory,
                        &request.outbound,
                        self.manager,
                        self.server,
                        self.sequence,
                        &mut request.state,
                        self.attachments,
                        self.interactions,
                        None,
                    ))
                    .await
                    .map(|_| ())
                } else if method == kcoder_app_protocol::METHOD_THREAD_EXPERT {
                    Box::pin(crate::app_server::task_expert_requests::dispatch(
                        request.id,
                        params,
                        self.engine,
                        self.manager,
                        &request.state,
                        &request.outbound,
                    ))
                    .await
                } else {
                    Box::pin(crate::app_server::turn_requests::dispatch(
                        method,
                        request.id,
                        params,
                        self.engine,
                        self.factory,
                        &request.outbound,
                        self.manager,
                        self.server,
                        self.sequence,
                        &mut request.state,
                        self.attachments,
                        None,
                    ))
                    .await
                    .map(|_| ())
                };
                #[cfg(target_os = "linux")]
                if method == "turn/interrupt" {
                    std::mem::swap(&mut request.state.native_interrupts, self.interruptions);
                }
                result
            }
            Err(error) => Err(error.context(super::NativeUiTaskResumeRejected)),
        };
        let result = result.and_then(|()| request.authority.verify(&request.state, &request.input));
        let _ = request.reply.send((request.state, result));
    }
}
impl NativeRuntimeClient {
    pub(in crate::app_server) fn queue_ui_task_turn(
        &self,
        request: NativeUiTaskTurnRequest,
    ) -> std::result::Result<(), Box<NativeUiTaskTurnRequest>> {
        self.sender
            .try_send(Control::UiTaskTurn(Box::new(request)))
            .map_err(|error| match error.into_inner() {
                Control::UiTaskTurn(request) => request,
                _ => unreachable!("original UI turn request"),
            })
    }
}
impl NativeRuntimePump {
    pub(in crate::app_server) fn ui_task_owners(&mut self) -> &mut NativeUiTaskOwners {
        &mut self.ui_task_owners
    }
    pub(in crate::app_server) async fn retire_ended_ui_tasks(
        &mut self,
        manager: &mut ThreadManager,
        engine: &mut kcoder_engine::QueryEngine,
        workspace: &kcoder_engine::QueryEngine,
    ) {
        self.ui_task_owners
            .retire_ended(manager, engine, workspace)
            .await;
    }
    pub(in crate::app_server) fn next_ui_task_turn(&mut self) -> Option<NativeUiTaskTurnRequest> {
        self.ui_task_turns.pop_front().map(|value| *value)
    }
}
pub(super) fn unavailable(request: NativeUiTaskTurnRequest) {
    let _ = request.reply.send((
        request.state,
        Err(anyhow::anyhow!("TASK_UI_ORIGINAL_DISPATCH_UNAVAILABLE")
            .context(super::NativeUiTaskResumeRejected)),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::thread_runtime::test_support::test_runtime;
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn last_client_detach_keeps_the_host_runtime_and_releases_only_client_inputs()
    -> Result<()> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-multiple-ui-lifetime-test")?;
        let runtime = test_runtime("shared", &temporary.path().join("shared.jsonl"));
        let original = runtime.engine();
        let thread = original.session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let first = ConnectionState::default();
        let second = ConnectionState::default();
        let creator = NativeUiTaskOwner::capture(
            &first,
            &manager,
            &thread,
            "server",
            CancellationToken::new(),
        )?;
        let attached = NativeUiTaskOwner::capture_presentation(
            &second,
            &manager,
            &thread,
            "server",
            CancellationToken::new(),
        )?;
        let expected = manager.handoff_snapshot(&thread, "server").owner_ref;
        let second_input = CancellationToken::new();

        let mut clients = NativeUiTaskOwners::default();
        clients.retain(creator.clone());
        clients.retain(attached.clone());
        let mut active = original.clone();
        first.input_ended.cancel();
        clients
            .retire_ended(&mut manager, &mut active, &original)
            .await;
        ensure!(
            creator.retired() && !attached.retired() && !second_input.is_cancelled(),
            "One client's detach affected another client's input"
        );
        attached.verify(&second, &manager, &thread, "server")?;
        ensure!(
            manager.handoff_snapshot(&thread, "server").owner_ref == expected
                && manager
                    .engine(&thread)
                    .is_some_and(|engine| engine.state.shares_state_with(&original.state)),
            "Client detach replaced the original task runtime or State"
        );
        second.input_ended.cancel();
        clients
            .retire_ended(&mut manager, &mut active, &original)
            .await;
        ensure!(
            attached.retired() && !second_input.is_cancelled() && manager.owns(&thread),
            "The last client changed the host runtime or retained its own input"
        );
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        Ok(())
    }
    #[tokio::test]
    async fn creator_ui_eof_preserves_a_turn_accepted_from_another_owner() -> Result<()> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-ui-creator-transfer-test")?;
        let runtime = test_runtime("owned", &temporary.path().join("history.jsonl"));
        let original = runtime.engine();
        let thread = original.session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let ui = ConnectionState::default();
        let owner =
            NativeUiTaskOwner::capture(&ui, &manager, &thread, "server", CancellationToken::new())?;
        let other = ConnectionState::default();
        let cancel = CancellationToken::new();
        let (release, waiting) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _ = waiting.await;
        });
        let turn = manager
            .turn_state(&thread)
            .context("Original turn state absent")?;
        *turn.active_turn.lock().await = Some(crate::app_server::ActiveTurn {
            desktop_owner: None,
            attempt: None,
            origin: crate::app_server::request_origin::RequestOrigin::Unverified,
            input_owner: Some(Arc::downgrade(&other.source_management_owner)),
            handle,
            cancel: cancel.clone(),
            thread_id: thread.clone(),
            turn_id: "other-input".into(),
        });
        turn.running.store(true, Ordering::SeqCst);
        let mut owners = NativeUiTaskOwners::default();
        owners.retain(owner.clone());
        ui.input_ended.cancel();
        let mut current = original.clone();
        owners
            .retire_ended(&mut manager, &mut current, &original)
            .await;
        let preserved = manager.owns(&thread)
            && owner.retired()
            && !cancel.is_cancelled()
            && current.state.shares_state_with(&original.state);
        let _ = release.send(());
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        ensure!(
            preserved,
            "Creator UI EOF cancelled another accepted input or replaced the original runtime"
        );
        Ok(())
    }

    #[tokio::test]
    async fn attached_ui_eof_preserves_the_exact_independent_runtime_and_state() -> Result<()> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-ui-presentation-test")?;
        let runtime = test_runtime("owned", &temporary.path().join("history.jsonl"));
        let original = runtime.engine();
        let thread = original.session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let state = ConnectionState::default();
        let presentation = NativeUiTaskOwner::capture_presentation(
            &state,
            &manager,
            &thread,
            "server",
            CancellationToken::new(),
        )?;
        let second_state = ConnectionState::default();
        let second = NativeUiTaskOwner::capture_presentation(
            &second_state,
            &manager,
            &thread,
            "server",
            CancellationToken::new(),
        )?;
        let mut owners = NativeUiTaskOwners::default();
        owners.retain(presentation.clone());
        owners.retain(second.clone());
        let first_input = CancellationToken::new();
        let independent_input = CancellationToken::new();

        state.input_ended.cancel();
        let mut active = original.clone();
        owners
            .retire_ended(&mut manager, &mut active, &original)
            .await;
        assert!(presentation.retired());
        assert!(!first_input.is_cancelled());
        assert!(!independent_input.is_cancelled());
        let late_input = CancellationToken::new();

        assert!(!late_input.is_cancelled());
        assert!(!independent_input.is_cancelled());
        second.verify(&second_state, &manager, &thread, "server")?;
        assert!(
            manager
                .engine(&thread)
                .unwrap()
                .state
                .shares_state_with(&original.state)
        );
        assert!(active.state.shares_state_with(&original.state));
        second_state.input_ended.cancel();
        owners
            .retire_ended(&mut manager, &mut active, &original)
            .await;
        assert!(manager.owns(&thread) && second.retired());
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        Ok(())
    }
    #[tokio::test]
    async fn stale_ui_owner_cannot_retire_a_current_runtime_for_the_same_task() -> Result<()> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-owned-ui-runtime-test")?;
        let mut manager = ThreadManager::default();
        manager
            .insert(test_runtime(
                "owned",
                &temporary.path().join("history.jsonl"),
            ))
            .map_err(|_| anyhow::anyhow!("owned fixture insertion failed"))?;
        let thread = manager.sole_thread_id().context("owned task missing")?;
        let state = ConnectionState::default();
        let owner = NativeUiTaskOwner::capture(
            &state,
            &manager,
            &thread,
            "server",
            CancellationToken::new(),
        )?;
        owner.verify(&state, &manager, &thread, "server")?;
        assert!(
            owner
                .verify(&ConnectionState::default(), &manager, &thread, "server")
                .is_err()
        );
        assert!(
            owner
                .verify(&state, &manager, &thread, "different-server")
                .is_err()
        );
        let stale = Arc::new(NativeUiTaskOwner {
            thread: thread.clone(),
            server: "server".into(),
            runtime: "previous-runtime".into(),
            owner: owner.owner.clone(),
            ended: owner.ended.clone(),
            retired: CancellationToken::new(),
            mcp_apps: state.mcp_app_registry.clone(),
        });
        assert!(stale.verify(&state, &manager, &thread, "server").is_err());
        let mut owners = NativeUiTaskOwners::default();
        owners.retain(stale.clone());
        let workspace = manager.engine(&thread).unwrap();
        let mut active = workspace.clone();
        owners
            .retire_ended(&mut manager, &mut active, &workspace)
            .await;
        assert!(stale.retired() && manager.owns(&thread));
        owner.verify(&state, &manager, &thread, "server")?;
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        Ok(())
    }
    #[tokio::test]
    async fn ui_eof_releases_its_subscription_without_retiring_either_task() -> Result<()> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-owned-ui-runtime-test")?;
        let mut manager = ThreadManager::default();
        manager
            .insert(test_runtime("first", &temporary.path().join("first.jsonl")))
            .map_err(|_| anyhow::anyhow!("owned fixture insertion failed"))?;
        let first = manager.sole_thread_id().unwrap();
        manager
            .insert(test_runtime(
                "second",
                &temporary.path().join("second.jsonl"),
            ))
            .map_err(|_| anyhow::anyhow!("owned fixture insertion failed"))?;
        let first_state = ConnectionState::default();
        let first_owner = NativeUiTaskOwner::capture(
            &first_state,
            &manager,
            &first,
            "server",
            CancellationToken::new(),
        )?;
        let mut owners = NativeUiTaskOwners::default();
        owners.retain(first_owner.clone());
        let workspace = manager.engine(&first).unwrap();
        let mut active = workspace.clone();
        first_state.input_ended.cancel();
        owners
            .retire_ended(&mut manager, &mut active, &workspace)
            .await;
        assert!(manager.owns(&first) && first_owner.retired());
        assert_eq!(manager.resident_engines().len(), 2);
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        Ok(())
    }

    #[tokio::test]
    async fn temporary_runtime_is_released_as_a_client_resource() -> Result<()> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-ephemeral-client-test")?;
        let runtime =
            test_runtime("temporary", &temporary.path().join("temporary.jsonl")).with_ephemeral();
        let original = runtime.engine();
        let thread = original.session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let state = ConnectionState::default();
        let owner = NativeUiTaskOwner::capture(
            &state,
            &manager,
            &thread,
            "server",
            CancellationToken::new(),
        )?;
        let mut owners = NativeUiTaskOwners::default();
        owners.retain(owner.clone());
        state.input_ended.cancel();
        let mut selected = original.clone();
        owners
            .retire_ended(&mut manager, &mut selected, &original)
            .await;
        assert!(owner.retired() && !manager.owns(&thread));
        Ok(())
    }

    #[tokio::test]
    async fn ending_a_web_subscription_releases_resources_without_deciding_session_survival()
    -> Result<()> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-per-input-lifetime-test")?;
        let runtime = test_runtime("shared", &temporary.path().join("shared.jsonl"));
        let original = runtime.engine();
        let thread = original.session_id();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let ui = ConnectionState::default();
        let owner =
            NativeUiTaskOwner::capture(&ui, &manager, &thread, "server", CancellationToken::new())?;
        let web_turn = CancellationToken::new();

        let channel_turn = CancellationToken::new();
        let turn = manager
            .turn_state(&thread)
            .context("original task missing")?;
        *turn.active_turn.lock().await = Some(crate::app_server::ActiveTurn {
            desktop_owner: None,
            attempt: None,
            origin: crate::app_server::request_origin::RequestOrigin::NativeSource,
            input_owner: None,
            handle: tokio::spawn(std::future::pending()),
            cancel: channel_turn.clone(),
            thread_id: thread.clone(),
            turn_id: "next-channel-turn".into(),
        });
        turn.running.store(true, Ordering::SeqCst);
        let mut owners = NativeUiTaskOwners::default();
        owners.retain(owner.clone());
        drop(ui);
        let mut selected = original.clone();
        owners
            .retire_ended(&mut manager, &mut selected, &original)
            .await;
        assert!(!web_turn.is_cancelled());
        assert!(!channel_turn.is_cancelled());
        assert!(manager.owns(&thread));
        // A delayed cleanup must not address a later input by task ID.
        owners
            .retire_ended(&mut manager, &mut selected, &original)
            .await;
        assert!(!channel_turn.is_cancelled());
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
        Ok(())
    }
}
