//! Connection state: extracted from the app-server connection boundary.

use super::*;

impl BackgroundFollowupQueue {
    /// Insert a wake-up claim for one terminal run. Returns false when this
    /// exact run was already claimed.
    pub(super) fn claim_run(&mut self, id: &str, run_started_at_ms: Option<u64>) -> bool {
        self.claimed_terminal_ids
            .insert((id.to_string(), run_started_at_ms))
    }
}

impl ResidentTurnState {
    pub(super) fn new(
        outbound_tx: mpsc::Sender<Value>,
        permission_mode: kcoder_config::PermissionMode,
        next_question_id: Arc<AtomicU64>,
        next_approval_id: Arc<AtomicU64>,
        receipts: Arc<StdMutex<InteractionReceipts>>,
    ) -> Self {
        let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
        let question_context = Arc::new(StdMutex::new(None));
        let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
        let approval_context = Arc::new(StdMutex::new(None));
        let approval_artifact_dir = Arc::new(StdMutex::new(None));
        let permission_prompt = AppServerPermissionPrompt {
            mode: permission_mode,
            outbound_tx: outbound_tx.clone(),
            pending: Arc::clone(&pending_approvals),
            receipts: Arc::clone(&receipts),
            next_id: next_approval_id,
            context: Arc::clone(&approval_context),
            artifact_dir: approval_artifact_dir,
            response_timeout: approval_response_timeout(),
        };
        let user_questioner: Arc<dyn UserQuestioner> = Arc::new(AppServerQuestioner {
            outbound_tx,
            pending: Arc::clone(&pending_questions),
            receipts: Arc::clone(&receipts),
            next_id: next_question_id,
            context: Arc::clone(&question_context),
        });
        Self {
            interaction_receipts: receipts,
            accepting_turns: Arc::new(AtomicBool::new(true)),
            running: Arc::new(AtomicBool::new(false)),
            activity_gate: Arc::new(Mutex::new(())),
            active_turn: Arc::new(Mutex::new(None)),
            question_context,
            pending_questions,
            approval_context,
            pending_approvals,
            permission_prompt,
            user_questioner,
        }
    }

    pub(super) fn configure_for_engine(&mut self, engine: &QueryEngine) {
        // New sessions use the freshly loaded policy, not the bootstrap connection mode.
        self.permission_prompt.mode = engine
            .settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .permission_mode;
        *self
            .permission_prompt
            .artifact_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(
            engine
                .session_storage_dir_for(&engine.session_id())
                .join("approval-decisions"),
        );
    }

    pub(super) fn resolve_response(
        &self,
        response: &Value,
        require_binding: bool,
    ) -> InteractionReply {
        resolve_server_response(
            response,
            &self.pending_approvals,
            &self.pending_questions,
            &self.interaction_receipts,
            require_binding,
        )
    }

    pub(super) fn clear_pending(&self) {
        self.pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Must be called under `activity_gate`. A second closed-state check covers the
    /// interleaving window between shutdown and scheduler CAS, preventing a turn from
    /// starting after its runtime has been removed.
    pub(super) fn try_claim_turn(&self) -> bool {
        if !self.accepting_turns.load(Ordering::SeqCst)
            || self
                .running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return false;
        }
        if self.accepting_turns.load(Ordering::SeqCst) {
            true
        } else {
            self.running.store(false, Ordering::SeqCst);
            false
        }
    }

    /// Claim an idle runtime and retain the activity gate until the caller publishes the active handle.
    ///
    /// A very fast turn may finish immediately after `tokio::spawn` returns and reset
    /// `running`. Releasing the gate before publishing its handle would let the
    /// background scheduler register a new turn in that window, only to have its handle
    /// overwritten by the old one. Returning an owned guard makes claim-to-publish one critical section.
    pub(super) async fn claim_turn_registration(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        let guard = Arc::clone(&self.activity_gate).lock_owned().await;
        self.try_claim_turn().then_some(guard)
    }

    pub(super) fn stop_accepting_turns(&self) {
        self.accepting_turns.store(false, Ordering::SeqCst);
    }

    pub(super) fn resume_accepting_turns(&self) {
        self.accepting_turns.store(true, Ordering::SeqCst);
    }

    pub(super) fn clear_matching_turn(&self, thread_id: &str, turn_id: &str) {
        let clear_questions = {
            let mut context = self
                .question_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let matches = context.as_ref().is_some_and(|context| {
                context.thread_id == thread_id && context.turn_id == turn_id
            });
            if matches {
                *context = None;
            }
            matches
        };
        if clear_questions {
            self.pending_questions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
        let clear_approvals = {
            let mut context = self
                .approval_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let matches = context.as_ref().is_some_and(|context| {
                context.thread_id == thread_id && context.turn_id == turn_id
            });
            if matches {
                *context = None;
            }
            matches
        };
        if clear_approvals {
            self.pending_approvals
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
    }

    pub(super) fn clear_all_turn_state(&self) {
        self.clear_pending();
        *self
            .question_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .approval_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.running.store(false, Ordering::SeqCst);
    }
}

impl ActiveTurn {
    pub(super) fn matches(&self, thread_id: Option<&str>, turn_id: Option<&str>) -> bool {
        thread_id == Some(self.thread_id.as_str()) && turn_id == Some(self.turn_id.as_str())
    }
}

pub(super) async fn cancel_active_turn_with_timeout(
    mut active: ActiveTurn,
    turn_state: &ResidentTurnState,
    background_projection: &Arc<Mutex<BackgroundProjectionState>>,
    background_followups: &Arc<BackgroundFollowupState>,
    timeout: Duration,
) -> bool {
    let thread_id = active.thread_id.clone();
    let turn_id = active.turn_id.clone();
    active.cancel.cancel();
    {
        let _gate = turn_state.activity_gate.lock().await;
        let has_newer_turn = turn_state
            .active_turn
            .lock()
            .await
            .as_ref()
            .is_some_and(|current| !current.matches(Some(&thread_id), Some(&turn_id)));
        if !has_newer_turn {
            // Release this turn's interaction waiters first; otherwise question/approval
            // futures may prevent cooperative cancellation from finishing within the bound.
            turn_state.clear_pending();
            turn_state.clear_matching_turn(&thread_id, &turn_id);
        }
    }
    // A dropped/panicked turn cannot publish its normal terminal notification.
    let forced = match tokio::time::timeout(timeout, &mut active.handle).await {
        Ok(Ok(())) => false,
        Ok(Err(_)) => true,
        Err(_) => {
            active.handle.abort();
            let _ = active.handle.await;
            true
        }
    };
    let _gate = turn_state.activity_gate.lock().await;
    let mut current = turn_state.active_turn.lock().await;
    if current
        .as_ref()
        .is_some_and(|active| !active.matches(Some(&thread_id), Some(&turn_id)))
    {
        return forced;
    }
    if current
        .as_ref()
        .is_some_and(|active| active.matches(Some(&thread_id), Some(&turn_id)))
    {
        current.take();
    }
    drop(current);
    turn_state.clear_pending();
    turn_state.clear_matching_turn(&thread_id, &turn_id);
    clear_active_background_projection(background_projection, &thread_id, &turn_id).await;
    turn_state.running.store(false, Ordering::SeqCst);
    background_followups.notify.notify_waiters();
    forced
}

pub(super) async fn cancel_active_turn_bounded(
    active: ActiveTurn,
    turn_state: &ResidentTurnState,
    background_projection: &Arc<Mutex<BackgroundProjectionState>>,
    background_followups: &Arc<BackgroundFollowupState>,
) -> bool {
    cancel_active_turn_with_timeout(
        active,
        turn_state,
        background_projection,
        background_followups,
        ACTIVE_TURN_SHUTDOWN_TIMEOUT,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_resident_thread_runtime(
    engine: QueryEngine,
    lease: SessionLease,
    volatile_turn_count: usize,
    turn_state: ResidentTurnState,
    outbound_tx: mpsc::Sender<Value>,
    server_id: String,
    sequence: Arc<AtomicU64>,
) -> ThreadRuntime {
    let background_projection = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let background_followups = Arc::new(BackgroundFollowupState::default());
    background_followups
        .client_turn_count
        .reset(volatile_turn_count);
    let background_pump = BackgroundEventPump::spawn(
        &engine,
        Arc::clone(&background_projection),
        Arc::clone(&background_followups),
        outbound_tx.clone(),
    );
    let background_followup_scheduler = BackgroundFollowupScheduler::spawn(
        &engine,
        Arc::clone(&background_followups),
        Arc::clone(&turn_state.activity_gate),
        Arc::clone(&turn_state.accepting_turns),
        Arc::clone(&turn_state.running),
        Arc::clone(&turn_state.active_turn),
        Arc::clone(&background_projection),
        outbound_tx,
        server_id,
        sequence,
        Arc::clone(&turn_state.question_context),
        Arc::clone(&turn_state.pending_questions),
        Arc::clone(&turn_state.approval_context),
        Arc::clone(&turn_state.pending_approvals),
        turn_state.permission_prompt.clone(),
    );
    ThreadRuntime::new(
        engine,
        lease,
        background_projection,
        background_followups,
        (background_pump, background_followup_scheduler),
        turn_state,
    )
}

impl ConnectionState {
    pub(super) fn configure_turn_engine(
        &self,
        engine: &QueryEngine,
        cancel: CancellationToken,
    ) -> QueryEngine {
        engine
            .clone()
            .with_cancel_token(cancel)
            .with_tool_path_previews(self.tool_path_preview_v1)
    }

    pub(super) fn require_initialized(&self, id: Value) -> Option<Value> {
        (!self.initialized).then(|| error_response(id, NOT_INITIALIZED, "Not initialized"))
    }

    pub(super) fn initialize(&mut self, id: Value, params: &Value, engine: &QueryEngine) -> Value {
        if self.initialized {
            return error_response(id, -32600, "Already initialized");
        }
        let params = match serde_json::from_value::<InitializeParams>(params.clone()) {
            Ok(params) => params,
            Err(error) => return error_response(id, -32602, &error.to_string()),
        };
        if params.protocol_version != PROTOCOL_VERSION {
            return error_response(
                id,
                -32602,
                &format!(
                    "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                    params.protocol_version
                ),
            );
        }
        let mut capabilities = server_capabilities(engine.state.history_path().is_some());
        capabilities.experimental.insert(
            kcoder_app_protocol::CAPABILITY_TOOL_PROFILES_V1.into(),
            self.tool_profiles_v1,
        );
        capabilities.experimental.insert(
            "modelSelectionModeV1".into(),
            engine.supports_target_default_model_selection(),
        );
        capabilities.experimental.insert(
            kcoder_app_protocol::CAPABILITY_RETRY_MODEL_CONFIGURATION_V1.into(),
            engine.supports_target_default_model_selection(),
        );
        let result = InitializeResult {
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_info: ImplementationInfo {
                name: "kcoder-app-server".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities,
            session_id: Some(engine.session_id()),
            cwd: Some(engine.state.cwd().to_string_lossy().into_owned()),
            model: Some(engine.client_model_selector()),
        };
        self.tool_path_preview_v1 = params
            .capabilities
            .experimental
            .get("toolPathPreviewV1")
            .copied()
            .unwrap_or(false);
        self.run_summary_v1 = params
            .capabilities
            .experimental
            .get(kcoder_app_protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1)
            .copied()
            .unwrap_or(false);
        self.interaction_binding_v1 = params
            .capabilities
            .experimental
            .get(kcoder_app_protocol::CAPABILITY_INTERACTION_BINDING_V1)
            .copied()
            .unwrap_or(false);
        self.initialized = true;
        success_response(
            id,
            serde_json::to_value(result).expect("initialize result serializes"),
        )
    }
}

pub(super) fn server_capabilities(thread_resume: bool) -> ServerCapabilities {
    ServerCapabilities {
        approvals: true,
        questions: true,
        thread_resume,
        experimental: BTreeMap::from([
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_HTML_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_FILES_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_INGEST_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_KNOWLEDGE_CATALOG_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_COMPUTER_USE_TURN_V1.to_string(),
                cfg!(windows),
            ),
            (
                kcoder_app_protocol::CAPABILITY_COMPUTER_USE_STATUS_V1.to_string(),
                true,
            ),
            ("toolPathPreviewV1".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_TRANSFORM_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_INTERACTIONS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_FAILURE_POLICY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_SUBGRAPH_LOOPS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_SUBWORKFLOW_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_TOOL_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_NODE_CONTRACTS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CODE_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CANVAS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_LAYOUT_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_CONVERSATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_RUNS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_GRAPH_V2.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WORKFLOW_SWITCH_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_GOAL_CANCELLATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_INTERACTION_BINDING_V1.to_string(),
                true,
            ),
            // The client declares this one, but it is answered here as well: a
            // client reads the negotiated set before it decides whether it may
            // send `resubmit`, and an unanswered declaration looks like a server
            // that would refuse the field.
            (
                kcoder_app_protocol::CAPABILITY_TURN_SUBMISSION_V1.to_string(),
                true,
            ),
            ("toolsCatalog".to_string(), true),
            ("settingsTemplatesV1".to_string(), true),
            ("storageDiagnosticsV1".to_string(), true),
            ("browserAttachments".to_string(), true),
            ("browserPreflight".to_string(), true),
            ("ephemeralThreads".to_string(), true),
            (
                "browserSessions".to_string(),
                browser::browser_sessions_available(),
            ),
            ("terminalSessions".to_string(), true),
            ("workspaceFiles".to_string(), true),
            ("workspaceRegistry".to_string(), true),
            ("sidebarRootPinning".to_string(), true),
            ("residentThreads".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_FAILED_TURN_CONTINUATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_RETRY_OPERATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_ATTEMPT_RETRY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_CREATION_RECEIPTS_V1.to_string(),
                thread_resume,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_RECEIPTS_V1.to_string(),
                true,
            ),
            ("threadListCompleteness".to_string(), true),
            ("threadHistoryIndexRefresh".to_string(), true),
            ("threadIndexedPagesV1".to_string(), true),
            ("serverResourceSnapshotV1".to_string(), true),
            ("serverIdleShutdownV1".to_string(), true),
            ("goalContinuation".to_string(), true),
            ("sessionModes".to_string(), true),
            ("agentSteering".to_string(), true),
            ("plugins".to_string(), true),
            ("providerConfiguration".to_string(), true),
            ("providerConnectionValidation".to_string(), true),
            ("providerTemplates".to_string(), true),
            ("providerAuthenticationPolicy".to_string(), true),
            ("providerModelCapabilities".to_string(), true),
            ("qualifiedModelSelectionV1".to_string(), true),
            ("providerDeletion".to_string(), true),
            ("marketplaces".to_string(), true),
            ("pluginDownloadProxy".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_WORKBUDDY_MARKETPLACE.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_PLUGIN_PROXY_DISCOVERY.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TRAE_CN_MARKETPLACE.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_HOSTED_PLUGIN_MARKETPLACES.to_string(),
                true,
            ),
            ("marketplaceDirectoryTrust".to_string(), true),
            (
                kcoder_app_protocol::HOOK_CONFIGURATION_CAPABILITY.to_string(),
                true,
            ),
            ("pluginTrustManagement".to_string(), true),
            ("pluginInstallCancellation".to_string(), true),
            ("backgroundRunIdentityV1".to_string(), true),
            ("pluginIcons".to_string(), true),
            ("marketplaceGitRefresh".to_string(), true),
            ("turnPermissions".to_string(), true),
            ("scheduledTasks".to_string(), true),
            ("projectAutomations".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_CRON_TIMEZONE_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_CRON_PREVIEW_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_CRON_DELIVERY_DIAGNOSTICS_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_STORAGE_SCAN_CANCELLATION_V1.to_string(),
                true,
            ),
            ("agentArtifactsV1".to_string(), true),
            ("usageHistory".to_string(), true),
        ]),
    }
}
