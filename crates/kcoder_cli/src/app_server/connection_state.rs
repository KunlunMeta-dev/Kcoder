//! Connection state: extracted from the app-server connection boundary.

use super::*;
use kcoder_host_transport::metadata::{
    ClientOptIns, advertise_requested, advertise_thread_capabilities,
};

pub(super) async fn cancel_active_turn_with_timeout(
    active: ActiveTurn,
    turn_state: &ResidentTurnState,
    background_projection: &Arc<Mutex<BackgroundProjectionState>>,
    background_followups: &Arc<BackgroundFollowupState>,
    timeout: Duration,
) -> bool {
    kcoder_app_events::resident_turn::cancel_active_turn_with_timeout(
        active,
        turn_state,
        background_projection,
        &background_followups.notify,
        timeout,
    )
    .await
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
/// A result that finished in a previous process but never reached the thread
/// still wakes it once (lean plan M2-3), for every background kind. The live
/// pump only reconciles jobs this process projected, so restored results are
/// queued here through the same eligibility checks and once-only queue.
/// Process-exit interruptions are reported by the recovery notice instead.
fn queue_restored_background_followups(
    engine: &QueryEngine,
    followups: &Arc<BackgroundFollowupState>,
) {
    let restored: Vec<(String, String)> = engine
        .state
        .tasks()
        .into_values()
        .filter(|task| {
            matches!(task.status, TaskStatus::Completed | TaskStatus::Failed)
                && task.output.as_deref() != Some(kcoder_state::PROCESS_EXIT_TASK_INTERRUPTION)
                && engine.background_task_wakes_parent(task)
                && !task.notification_injected_at_ms.is_some_and(|injected| {
                    injected >= task.run_started_at_ms.unwrap_or(task.created_at_ms)
                })
        })
        .filter_map(|task| {
            background_delivery::background_task_terminal_summary(&task)
                .map(|summary| (task.id.clone(), summary))
        })
        .collect();
    if restored.is_empty() {
        return;
    }
    let engine = engine.clone();
    let followups = Arc::clone(followups);
    tokio::spawn(async move {
        background_delivery::queue_recovered_background_followups(
            &engine,
            &followups,
            restored,
            |id| engine.background_job_triggers_followup(id),
        )
        .await;
    });
}

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
    queue_restored_background_followups(&engine, &background_followups);
    let lifecycle = lease.scheduler_lifecycle();
    #[cfg(test)]
    let lifecycle = lifecycle.or_else(|| engine.state.try_inspection_lifecycle_identity());
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
        lease.target().to_path_buf(),
        lifecycle,
        lease.owner_liveness(),
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

    #[cfg(test)]
    pub(super) fn initialize(&mut self, id: Value, params: &Value, engine: &QueryEngine) -> Value {
        self.initialize_with_workspace_authority(id, params, engine, false)
    }

    pub(super) fn attach_upload_admission(
        &self,
        response: &mut Value,
        admission: kcoder_app_protocol::RetentionUploadAdmissionV1,
    ) -> anyhow::Result<()> {
        let initialized: InitializeResult = serde_json::from_value(response["result"].clone())?;
        response["result"] =
            kcoder_app_rpc_codec::encode(kcoder_app_protocol::RetentionInitializeResultV1 {
                initialized,
                attachment_upload_admission: Some(admission),
            })?;
        Ok(())
    }

    pub(super) fn initialize_with_workspace_authority(
        &mut self,
        id: Value,
        params: &Value,
        engine: &QueryEngine,
        workspace_v2_ready: bool,
    ) -> Value {
        if self.initialized {
            return error_response(id, -32600, "Already initialized");
        }
        let params = match kcoder_app_rpc_codec::decode::<InitializeParams>(params.clone()) {
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
        let work_read_capability =
            kcoder_app_protocol::continuous_work::CAPABILITY_CONTINUOUS_WORK_READ_V1;
        self.continuous_work_read_v1 = engine.settings_persistence_path().is_some()
            && params.capabilities.experimental.get(work_read_capability) == Some(&true);
        capabilities
            .experimental
            .insert(work_read_capability.into(), self.continuous_work_read_v1);
        let partial_list_capability =
            kcoder_app_protocol::continuous_work::CAPABILITY_CONTINUOUS_WORK_PARTIAL_LIST_V1;
        self.continuous_work_partial_list_v1 = self.continuous_work_read_v1
            && params
                .capabilities
                .experimental
                .get(partial_list_capability)
                == Some(&true);
        capabilities.experimental.insert(
            partial_list_capability.into(),
            self.continuous_work_partial_list_v1,
        );
        // The draft mutation names stay unadvertised until a consumer exists.
        // Resolution keeps the read preconditions and the single advertisement
        // switch in one place, so a client sees an explicit `false` rather than
        // an absent key and never guesses that persistence implies consumption.
        for (name, enabled) in [
            (
                kcoder_app_protocol::continuous_work::CAPABILITY_CONTINUOUS_WORK_INPUT_V1,
                &mut self.continuous_work_input_v1,
            ),
            (
                kcoder_app_protocol::continuous_work::CAPABILITY_CONTINUOUS_WORK_CONTROL_V1,
                &mut self.continuous_work_control_v1,
            ),
        ] {
            let requested = params.capabilities.experimental.get(name);
            *enabled = continuous_work_mutation::negotiate(self.continuous_work_read_v1, requested);
            capabilities.experimental.insert(name.into(), *enabled);
        }
        for (name, enabled) in [
            (
                kcoder_app_protocol::CAPABILITY_WEB_SEARCH_STATUS_V1,
                &mut self.web_search_status_v1,
            ),
            (
                kcoder_app_protocol::CAPABILITY_WEB_SEARCH_PROBE_V1,
                &mut self.web_search_probe_v1,
            ),
        ] {
            *enabled = params
                .capabilities
                .experimental
                .get(name)
                .copied()
                .unwrap_or(false);
            capabilities.experimental.insert(name.into(), *enabled);
        }
        capabilities.experimental.insert(
            kcoder_app_protocol::CAPABILITY_TASK_DELIVERY_V1.into(),
            engine.durable_client_storage_root().is_some(),
        );
        let acp_inbound = kcoder_app_protocol::integrations::CAPABILITY_ACP_INBOUND_V1;
        if params.capabilities.experimental.get(acp_inbound) == Some(&true) {
            // CLI includes the inbound ACP bridge; no ACP session is started here.
            capabilities.experimental.insert(acp_inbound.into(), true);
        }
        let scope_requested = params
            .capabilities
            .experimental
            .get(kcoder_app_protocol::integrations::host::CAPABILITY_INTEGRATION_SCOPE_V1)
            .copied()
            .unwrap_or(false);
        if scope_requested {
            // Failed capture leaves ordinary sessions available and grants no integration authority.
            self.integration_context = integrations::core::capture_scope(engine).ok();
            if let Some(native) = self.integration_context.as_ref() {
                integrations::core::prepare_enabled_memory_for_connection(engine, native);
            }
            capabilities.experimental.insert(
                kcoder_app_protocol::integrations::host::CAPABILITY_INTEGRATION_SCOPE_V1.into(),
                self.integration_context.is_some(),
            );
        }
        let browser_profiles_capability =
            kcoder_app_protocol::browser_profiles::CAPABILITY_BROWSER_PROFILES_V1;
        self.browser_profiles_v1 = scope_requested
            && self.integration_context.is_some()
            && params
                .capabilities
                .experimental
                .get(browser_profiles_capability)
                == Some(&true);
        let sessions_capability =
            kcoder_app_protocol::browser_profiles::CAPABILITY_BROWSER_PROFILE_SESSIONS_V1;
        self.browser_profile_sessions_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            sessions_capability,
            scope_requested
                && self.integration_context.is_some()
                && cfg!(any(target_os = "linux", windows)),
        );
        if params
            .capabilities
            .experimental
            .contains_key(browser_profiles_capability)
        {
            capabilities
                .experimental
                .insert(browser_profiles_capability.into(), self.browser_profiles_v1);
        }
        self.integration_memory_v1 = scope_requested
            && self.integration_context.is_some()
            && params
                .capabilities
                .experimental
                .get(integrations::core::MEMORY_REVIEW_CAPABILITY)
                .copied()
                .unwrap_or(false);
        let task_state_capability =
            kcoder_app_protocol::integrations::host::CAPABILITY_INTEGRATION_TASK_STATE_V1;
        let code_service_capability =
            kcoder_app_protocol::integrations::code_services::CAPABILITY_NATIVE_CODE_SERVICES_V1;
        let code_account_supported = cfg!(target_os = "linux")
            && self
                .integration_context
                .as_ref()
                .is_some_and(|native| native.scope().organization_id.is_none());
        #[cfg(target_os = "linux")]
        let code_account_supported = code_account_supported
            && unsafe { libc::getuid() } != 0
            && unsafe { libc::getuid() } == unsafe { libc::geteuid() };
        self.native_code_services_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            code_service_capability,
            scope_requested && code_account_supported,
        );
        self.integration_task_state_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            task_state_capability,
            scope_requested && self.integration_context.is_some(),
        );
        self.integration_operations_v1 = scope_requested && self.integration_context.is_some()
            && params.capabilities.experimental.get(kcoder_app_protocol::integrations::host::CAPABILITY_INTEGRATION_OPERATION_RECEIPTS_V1).copied().unwrap_or(false);
        if params.capabilities.experimental.contains_key(
            kcoder_app_protocol::integrations::host::CAPABILITY_INTEGRATION_OPERATION_RECEIPTS_V1,
        ) {
            capabilities.experimental.insert(kcoder_app_protocol::integrations::host::CAPABILITY_INTEGRATION_OPERATION_RECEIPTS_V1.into(), self.integration_operations_v1);
        }
        if params
            .capabilities
            .experimental
            .contains_key(integrations::core::MEMORY_REVIEW_CAPABILITY)
        {
            capabilities.experimental.insert(
                integrations::core::MEMORY_REVIEW_CAPABILITY.into(),
                self.integration_memory_v1,
            );
        }
        integration_requests::negotiate_knowledge(
            self,
            engine,
            &params.capabilities.experimental,
            &mut capabilities.experimental,
        );
        let office_capability =
            kcoder_app_protocol::integrations::office::CAPABILITY_OFFICE_WORKSPACE_V1;
        let exact_control = kcoder_app_protocol::CAPABILITY_AGENT_EXACT_CONTROL_V1;
        let continuation = kcoder_app_protocol::CAPABILITY_AGENT_EXACT_CONTINUATION_V1;
        self.agent_exact_continuation_v1 =
            params.capabilities.experimental.get(continuation) == Some(&true);
        if params.capabilities.experimental.contains_key(continuation) {
            capabilities
                .experimental
                .insert(continuation.into(), self.agent_exact_continuation_v1);
        }
        self.agent_exact_control_v1 =
            params.capabilities.experimental.get(exact_control) == Some(&true);
        if params.capabilities.experimental.contains_key(exact_control) {
            capabilities
                .experimental
                .insert(exact_control.into(), self.agent_exact_control_v1);
        }
        let remote_control =
            kcoder_app_protocol::integrations::CAPABILITY_REMOTE_OPERATION_CONTROL_V1;
        self.integration_remote_operation_control_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            remote_control,
            scope_requested
                && self
                    .integration_context
                    .as_ref()
                    .is_some_and(|native| native.scope().organization_id.is_none()),
        );
        let settings_capability =
            kcoder_app_protocol::integrations::CAPABILITY_MODEL_POLICY_SETTINGS_V1;
        self.integration_model_policy_settings_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            settings_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let model_usage_capability = kcoder_app_protocol::integrations::CAPABILITY_MODEL_USAGE_V1;
        self.integration_model_usage_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            model_usage_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let model_health_capability = kcoder_app_protocol::integrations::CAPABILITY_MODEL_HEALTH_V1;
        self.integration_model_health_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            model_health_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let model_policies_capability =
            kcoder_app_protocol::integrations::CAPABILITY_MODEL_POLICIES_V1;
        self.integration_model_policies_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            model_policies_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let task_workspace_capability =
            kcoder_app_protocol::integrations::task_workspace::CAPABILITY_TASK_WORKSPACE_V1;
        self.integration_task_workspace_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            task_workspace_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let task_workspace_capability_scope_capability =
            kcoder_app_protocol::integrations::task_workspace::CAPABILITY_TASK_WORKSPACE_CAPABILITY_SCOPE_V1;
        self.integration_task_workspace_capability_scope_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            task_workspace_capability_scope_capability,
            self.integration_task_workspace_v1,
        );
        let task_capability_source_choices_capability =
            kcoder_app_protocol::integrations::task_capability_scope::CAPABILITY_TASK_CAPABILITY_SOURCE_CHOICES_V1;
        self.integration_task_capability_source_choices_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            task_capability_source_choices_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let office_settings_capability =
            kcoder_app_protocol::integrations::office_settings::CAPABILITY_OFFICE_SETTINGS_V1;
        let task_capability_scope_directory_capability =
            kcoder_app_protocol::integrations::task_capability_scope::CAPABILITY_TASK_CAPABILITY_SCOPE_DIRECTORY_V1;
        let connectivity_capability =
            integrations::connectivity::main_rpc::CAPABILITY_NATIVE_CONNECTIVITY_V1;
        self.integration_connectivity_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            connectivity_capability,
            scope_requested
                && self.integration_context.is_some()
                && self.integration_connectivity_resources.is_some()
                && (!self.direct_task_stdio || self.native_scope_host.is_some())
                && self.integration_runtime.is_some(),
        );
        self.integration_task_capability_scope_directory_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            task_capability_scope_directory_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let task_capability_scope_capability =
            kcoder_app_protocol::integrations::task_capability_scope::CAPABILITY_TASK_CAPABILITY_SCOPE_V1;
        self.integration_task_capability_scope_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            task_capability_scope_capability,
            scope_requested && self.integration_context.is_some(),
        );
        let resource_bindings_capability =
            kcoder_app_protocol::integrations::task_capability_scope::CAPABILITY_TASK_RESOURCE_BINDINGS_V1;
        self.integration_task_resource_bindings_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            resource_bindings_capability,
            self.integration_task_capability_scope_v1,
        );
        self.integration_office_settings_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            office_settings_capability,
            true,
        );
        let connectivity_settings_capability =
            kcoder_app_protocol::integrations::connectivity_settings::CAPABILITY_CONNECTIVITY_SETTINGS_V1;
        self.integration_connectivity_settings_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            connectivity_settings_capability,
            !self.native_source_dispatch && self.native_source_accepted.is_none(),
        );
        let knowledge_settings_capability =
            kcoder_app_protocol::integrations::knowledge_settings::CAPABILITY_KNOWLEDGE_SETTINGS_V1;
        self.integration_knowledge_settings_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            knowledge_settings_capability,
            !self.native_source_dispatch && self.native_source_accepted.is_none(),
        );
        self.integration_office_v1 = scope_requested
            && self.integration_context.is_some()
            && params.capabilities.experimental.get(office_capability) == Some(&true)
            && engine
                .settings
                .read()
                .is_ok_and(|settings| settings.integrations.office.enabled);
        let export_ack_capability =
            kcoder_app_protocol::integrations::office::CAPABILITY_OFFICE_EXPORT_ACKNOWLEDGEMENT_V1;
        self.integration_office_export_ack_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            export_ack_capability,
            self.integration_office_v1 && self.integration_automation_v1,
        );
        let receipt_capability =
            kcoder_app_protocol::integrations::office::CAPABILITY_OFFICE_EXPORT_RECEIPT_V1;
        self.integration_office_export_receipt_v1 = advertise_requested(
            &params.capabilities,
            &mut capabilities.experimental,
            receipt_capability,
            self.integration_office_v1,
        );
        if params
            .capabilities
            .experimental
            .contains_key(office_capability)
        {
            capabilities
                .experimental
                .insert(office_capability.into(), self.integration_office_v1);
        }
        let thread_opt_ins = advertise_thread_capabilities(
            &params.capabilities,
            &mut capabilities,
            workspace_v2_ready,
            self.tool_profiles_v1,
            engine.supports_target_default_model_selection(),
            engine.supports_target_default_model_selection(),
        );
        self.thread_presence_read_v1 = thread_opt_ins.thread_presence_read_v1;
        self.thread_goal_status_batch_v1 = thread_opt_ins.thread_goal_status_batch_v1;
        self.async_user_questions_v1 = thread_opt_ins.async_user_questions_v1;
        let result = InitializeResult {
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_info: ImplementationInfo {
                name: "kcoder-app-server".into(),
                version: kcoder_cli_commands::build_identity::version().into(),
            },
            capabilities,
            session_id: Some(engine.session_id()),
            cwd: Some(engine.state.cwd().to_string_lossy().into_owned()),
            model: Some(engine.client_model_selector()),
        };
        let opt_ins = ClientOptIns::read(&params.capabilities);
        self.isolated_widgets_v1 = opt_ins.isolated_widgets_v1;
        self.mcp_apps_v1 = opt_ins.mcp_apps_v1;
        self.agent_turn_configuration_v1 = opt_ins.agent_turn_configuration_v1;
        self.agent_definitions_v1 = opt_ins.agent_definitions_v1;
        self.studio_work_modes_v1 = opt_ins.studio_work_modes_v1;
        self.inline_widgets_v1 = opt_ins.inline_widgets_v1;
        self.tool_path_preview_v1 = opt_ins.tool_path_preview_v1;
        self.computer_use_session_authorization_v1 = opt_ins.computer_use_session_authorization_v1;
        self.computer_use_recovery_v1 = opt_ins.computer_use_recovery_v1;
        self.run_summary_v1 = opt_ins.run_summary_v1;
        self.thread_runtime_handoff_v1 = opt_ins.thread_runtime_handoff_v1;
        self.transcript_snapshot_v1 = opt_ins.transcript_snapshot_v1;
        self.transcript_observation_v1 = opt_ins.transcript_observation_v1;
        self.interaction_binding_v1 = opt_ins.interaction_binding_v1;
        self.interaction_status_read_v1 = opt_ins.interaction_status_read_v1;
        self.approval_tool_call_identity_v1 = opt_ins.approval_tool_call_identity_v1;
        self.client_questions = opt_ins.client_questions;
        self.temporary_mcp_servers_v1 = opt_ins.temporary_mcp_servers_v1;
        self.session_lifetime_v1 = opt_ins.session_lifetime_v1;
        self.stream_context_v1 = opt_ins.stream_context_v1;
        self.initialized = true;
        success_response(
            id,
            serde_json::to_value(result).expect("initialize result serializes"),
        )
    }
}

pub(super) fn server_capabilities(thread_resume: bool) -> ServerCapabilities {
    kcoder_host_transport::metadata::server_capabilities(
        thread_resume,
        browser::browser_sessions_available(),
    )
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    #[test]
    fn office_export_acknowledgement_requires_its_own_office_and_automation_opt_ins() {
        let fixture = integrations::core::runtime_driver::test_support::Fixture::new();
        let engine = super::super::tests::catalog_list_test_engine(&fixture.workspace)
            .with_settings_persistence_path(fixture.profile.join("settings.json"));
        {
            let mut settings = engine.settings.write().unwrap();
            settings.integrations.office.enabled = true;
            settings.integrations.knowledge.business_automation_enabled = true;
        }
        for (office, automation, ack) in [
            (true, true, None),
            (true, true, Some(false)),
            (false, true, Some(true)),
            (true, false, Some(true)),
            (true, true, Some(true)),
        ] {
            let mut state = ConnectionState::default();
            let mut params = json!({"protocolVersion":PROTOCOL_VERSION,"clientInfo":{"name":"owned-export-ack","version":"1"},
                "capabilities":{"experimental":{"integrationScopeV1":true,"officeWorkspaceV1":office,"automationTemplatesV1":automation}}});
            if let Some(value) = ack {
                params["capabilities"]["experimental"]["officeExportAcknowledgementV1"] =
                    json!(value);
            }
            let response = state.initialize(json!(1), &params, &engine);
            assert!(response.get("error").is_none(), "{response}");
            let expected =
                state.integration_context.is_some() && office && automation && ack == Some(true);
            assert_eq!(state.integration_office_export_ack_v1, expected);
            assert_eq!(
                response["result"]["capabilities"]["experimental"]["officeExportAcknowledgementV1"],
                ack.map(|_| json!(expected)).unwrap_or(Value::Null)
            );
        }
    }

    #[test]
    fn native_code_service_capability_is_explicit_and_never_inherited_by_legacy_clients() {
        let fixture = integrations::core::runtime_driver::test_support::Fixture::new();
        let engine = super::super::tests::catalog_list_test_engine(&fixture.workspace)
            .with_settings_persistence_path(fixture.profile.join("settings.json"));
        for offered in [None, Some(false), Some(true)] {
            let mut state = ConnectionState::default();
            let mut params = json!({"protocolVersion":PROTOCOL_VERSION,"clientInfo":{"name":"native-code-negotiation","version":"1"},
                "capabilities":{"experimental":{"integrationScopeV1":true}}});
            if let Some(offered) = offered {
                params["capabilities"]["experimental"]["nativeCodeServicesV1"] = json!(offered);
            }
            let response = state.initialize(json!(1), &params, &engine);
            assert!(response.get("error").is_none(), "{response}");
            let supported = cfg!(target_os = "linux") && state.integration_context.is_some();
            #[cfg(target_os = "linux")]
            let supported = supported
                && unsafe { libc::getuid() } != 0
                && unsafe { libc::getuid() } == unsafe { libc::geteuid() };
            let expected = supported && offered == Some(true);
            assert_eq!(state.native_code_services_v1, expected);
            assert_eq!(
                response["result"]["capabilities"]["experimental"]["nativeCodeServicesV1"]
                    .as_bool(),
                offered.map(|_| expected)
            );
            assert_eq!(
                state.initialize(json!(2), &params, &engine)["error"]["code"],
                -32600
            );
            assert_eq!(state.native_code_services_v1, expected);
        }
    }

    #[test]
    fn task_state_initialize_requires_explicit_scope_and_boolean_opt_in() {
        let fixture = integrations::core::runtime_driver::test_support::Fixture::new();
        let engine = super::super::tests::catalog_list_test_engine(&fixture.workspace)
            .with_settings_persistence_path(fixture.profile.join("settings.json"));
        for scope in [false, true] {
            for offered in [None, Some(false), Some(true)] {
                let mut state = ConnectionState::default();
                assert!(!state.integration_task_state_v1);
                let mut params = json!({"protocolVersion":PROTOCOL_VERSION,
                    "clientInfo":{"name":"task-state-test","version":"1"},
                    "capabilities":{"experimental":{"integrationScopeV1":scope}}});
                if let Some(offered) = offered {
                    params["capabilities"]["experimental"]["integrationTaskStateV1"] =
                        json!(offered);
                }
                let response = state.initialize(json!(1), &params, &engine);
                assert!(response.get("error").is_none(), "{response}");
                let expected = scope && offered == Some(true);
                assert_eq!(state.integration_task_state_v1, expected);
                let advertised =
                    &response["result"]["capabilities"]["experimental"]["integrationTaskStateV1"];
                assert_eq!(advertised.as_bool(), offered.map(|_| expected));
                assert_eq!(
                    state.initialize(json!(2), &params, &engine)["error"]["code"],
                    -32600
                );
                assert_eq!(state.integration_task_state_v1, expected);
            }
        }
    }

    #[test]
    fn transcript_observation_initialize_requires_boolean_true_and_freezes_independently() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = super::super::tests::catalog_list_test_engine(workspace.path());
        for offered in [None, Some(false), Some(true)] {
            let mut state = ConnectionState::default();
            let mut params = json!({"protocolVersion":PROTOCOL_VERSION,"clientInfo":{"name":"observation-test","version":"1"}});
            if let Some(offered) = offered {
                params["capabilities"] =
                    json!({"experimental":{"threadTranscriptObservationV1":offered}});
            }
            let response = state.initialize(json!(1), &params, &engine);
            assert!(response.get("error").is_none(), "{response}");
            assert_eq!(
                response["result"]["capabilities"]["experimental"]["threadTranscriptObservationV1"],
                true
            );
            assert_eq!(state.transcript_observation_v1, offered == Some(true));
            assert!(!state.transcript_snapshot_v1);
            params["capabilities"] =
                json!({"experimental":{"threadTranscriptObservationV1":offered != Some(true)}});
            assert_eq!(
                state.initialize(json!(2), &params, &engine)["error"]["code"],
                -32600
            );
            assert_eq!(state.transcript_observation_v1, offered == Some(true));
        }
        for offered in [json!("true"), json!(1), json!(null)] {
            let mut state = ConnectionState::default();
            let params = json!({"protocolVersion":PROTOCOL_VERSION,"clientInfo":{"name":"observation-test","version":"1"},"capabilities":{"experimental":{"threadTranscriptObservationV1":offered}}});
            assert_eq!(
                state.initialize(json!(1), &params, &engine)["error"]["code"],
                -32602
            );
            assert!(!state.initialized);
            assert!(!state.transcript_observation_v1);
        }
    }

    #[test]
    fn transcript_snapshot_initialize_is_explicit_frozen_and_invalid_initialize_does_not_opt_in() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = super::super::tests::catalog_list_test_engine(workspace.path());
        for offered in [None, Some(false), Some(true)] {
            let mut state = ConnectionState::default();
            let mut params = json!({"protocolVersion":PROTOCOL_VERSION,"clientInfo":{"name":"snapshot-test","version":"1"}});
            if let Some(offered) = offered {
                params["capabilities"] =
                    json!({"experimental":{"threadTranscriptSnapshotV1":offered}});
            }
            let response = state.initialize(json!(1), &params, &engine);
            assert!(response.get("error").is_none(), "{response}");
            assert_eq!(
                response["result"]["capabilities"]["experimental"]["threadTranscriptSnapshotV1"],
                true
            );
            assert_eq!(state.transcript_snapshot_v1, offered == Some(true));
            params["capabilities"] =
                json!({"experimental":{"threadTranscriptSnapshotV1":offered != Some(true)}});
            assert_eq!(
                state.initialize(json!(2), &params, &engine)["error"]["code"],
                -32600
            );
            assert_eq!(state.transcript_snapshot_v1, offered == Some(true));
        }
        for offered in [json!("true"), json!(1)] {
            let mut state = ConnectionState::default();
            let params = json!({"protocolVersion":PROTOCOL_VERSION,"clientInfo":{"name":"snapshot-test","version":"1"},"capabilities":{"experimental":{"threadTranscriptSnapshotV1":offered}}});
            assert_eq!(
                state.initialize(json!(1), &params, &engine)["error"]["code"],
                -32602
            );
            assert!(!state.initialized);
            assert!(!state.transcript_snapshot_v1);
        }
    }
}

#[cfg(test)]
mod interaction_allocator_tests {
    use super::*;

    #[test]
    fn resident_turn_state_constructs_approval_and_question_handlers_from_one_allocator() {
        let allocator = Arc::new(AtomicU64::new(1_000_000));
        let (outbound_tx, _outbound_rx) = mpsc::channel(1);
        let state = ResidentTurnState::new(
            outbound_tx,
            kcoder_config::PermissionMode::Ask,
            Arc::clone(&allocator),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );

        assert!(Arc::ptr_eq(&state.permission_prompt.next_id, &allocator));
        assert_eq!(Arc::strong_count(&allocator), 3);
    }
}
