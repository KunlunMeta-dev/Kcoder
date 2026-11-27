//! Public management calls retain the connection owner and keep its event loop available.
use super::*;
use integrations::knowledge::{
    NativeKnowledgeRpcMethod, native_knowledge_capabilities, request_knowledge_automation,
};
use kcoder_app_protocol::integrations::knowledge_host::{
    CAPABILITY_AUTOMATION_PERIOD_BUDGETS_V1, CAPABILITY_AUTOMATION_TASK_MODELS_V1,
    CAPABILITY_AUTOMATION_TEMPLATES_V1, CAPABILITY_KNOWLEDGE_PUBLICATIONS_V1,
};
use kcoder_types::integrations::core::{IntegrationPort, IntegrationRequest};

pub(super) async fn dispatch_task_state(
    method: &str,
    id: &Value,
    params: &Value,
    outbound: &mpsc::Sender<Value>,
    state: &ConnectionState,
) -> Result<bool> {
    if method != kcoder_app_protocol::integrations::host::INTEGRATION_TASK_STATE_READ {
        return Ok(false);
    }
    let result = read_task_state(params.clone(), state);
    send(
        outbound,
        match result.and_then(|observation| serde_json::to_value(observation).map_err(Into::into)) {
            Ok(value) => success_response(id.clone(), value),
            Err(_) => error_response(id.clone(), -32074, "INTEGRATION_TASK_STATE_UNAVAILABLE"),
        },
    )
    .await?;
    Ok(true)
}

fn read_task_state(
    params: Value,
    state: &ConnectionState,
) -> Result<kcoder_types::integrations::core::IntegrationTaskStateObservation> {
    ensure!(
        state.integration_task_state_v1
            && !state.input_ended.is_cancelled()
            && !state.native_source_dispatch
            && state.native_source_accepted.is_none(),
        "INTEGRATION_TASK_STATE_UNAVAILABLE"
    );
    let params: kcoder_types::integrations::core::IntegrationTaskStateReadParams =
        serde_json::from_value(params)?;
    params.validate()?;
    let context = state
        .integration_context
        .as_ref()
        .context("INTEGRATION_SCOPE_UNAVAILABLE")?;
    context.validate_scope(&params.scope)?;
    // Open only the existing canonical store. Reading cannot recover, enqueue,
    // create a namespace, or appoint this connection to run an original task.
    let driver = integrations::core::runtime_driver::NativeRuntimeDriver::load(context)?
        .context("RUNTIME_UNAVAILABLE")?;
    let observation = driver.read_task_state(context, &params.reference)?;
    context.validate_scope(&params.scope)?;
    Ok(observation)
}

pub(super) fn memory_context_for_turn(
    engine: &QueryEngine,
    original: Option<&integrations::core::NativeIntegrationContext>,
) -> Result<Option<integrations::core::NativeIntegrationContext>> {
    let enabled = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("MEMORY_TURN_CONTEXT_UNAVAILABLE"))?
        .integrations
        .knowledge
        .memory_center_enabled;
    if !enabled {
        return Ok(None);
    }
    let mut native = original
        .context("MEMORY_TURN_CONTEXT_UNAVAILABLE")?
        .recapture_for_owned_service()?;
    native.refresh_configuration_revision(engine.active_model_configuration_summary()?.revision)?;
    Ok(Some(native))
}

pub(super) fn negotiate_knowledge(
    state: &mut ConnectionState,
    engine: &QueryEngine,
    client: &BTreeMap<String, bool>,
    advertised: &mut BTreeMap<String, bool>,
) {
    let ready = state
        .integration_context
        .as_ref()
        .and_then(|native| native_knowledge_capabilities(engine, native).ok())
        .unwrap_or_default();
    for (capability, enabled) in [
        (
            CAPABILITY_KNOWLEDGE_PUBLICATIONS_V1,
            &mut state.integration_knowledge_v1,
        ),
        (
            CAPABILITY_AUTOMATION_TEMPLATES_V1,
            &mut state.integration_automation_v1,
        ),
        (
            CAPABILITY_AUTOMATION_TASK_MODELS_V1,
            &mut state.integration_automation_task_models_v1,
        ),
        (
            CAPABILITY_AUTOMATION_PERIOD_BUDGETS_V1,
            &mut state.integration_automation_period_budgets_v1,
        ),
    ] {
        *enabled = client.get(capability) == Some(&true)
            && ready.contains(&capability)
            && (!matches!(
                capability,
                CAPABILITY_AUTOMATION_TASK_MODELS_V1 | CAPABILITY_AUTOMATION_PERIOD_BUDGETS_V1
            ) || client.get(CAPABILITY_AUTOMATION_TEMPLATES_V1) == Some(&true));
        if client.contains_key(capability) {
            advertised.insert(capability.into(), *enabled);
        }
    }
}

pub(super) async fn dispatch_knowledge(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if method == kcoder_app_protocol::integrations::knowledge_host::IntegrationAutomationMethod::SelectFileEventSource.wire_name() {
        let prepared = (|| -> Result<_> {
            ensure!(state.knowledge_rpc_tasks.len() < 64, "KNOWLEDGE_RPC_BUSY");
            let request: IntegrationRequest = serde_json::from_value(params.clone())?;
            let budget = Duration::from_millis(request.timeout_ms);
            let control = integrations::knowledge::NativeFileEventSelectionControl::from_public_control(state, engine, request)?;
            Ok((control, budget))
        })();
        let (control, budget) = match prepared {
            Ok(prepared) => prepared,
            Err(_) => {
                send(outbound, error_response(id.clone(), -32073, "AUTOMATION_FILE_SELECTION_UNAVAILABLE")).await?;
                return Ok(true);
            }
        };
        let cancel = state.input_ended.child_token();
        let outbound = outbound.clone();
        let id = id.clone();
        state.knowledge_rpc_tasks.spawn(async move {
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => None,
                result = tokio::time::timeout(budget, control.run()) => result.ok(),
            };
            let response = match result.and_then(|reply| serde_json::to_value(reply).ok()) {
                Some(reply) => success_response(id, reply),
                None => error_response(id, -32073, "AUTOMATION_FILE_SELECTION_UNCONFIRMED"),
            };
            let _ = send(&outbound, response).await;
        });
        return Ok(true);
    }
    let Some(kind) = NativeKnowledgeRpcMethod::parse(method) else {
        return Ok(false);
    };
    let prepared = (|| -> Result<_> {
        let opted_in = match kind.port() {
            IntegrationPort::Knowledge => state.integration_knowledge_v1,
            IntegrationPort::Automation => state.integration_automation_v1,
            _ => false,
        };
        ensure!(opted_in, "KNOWLEDGE_RPC_CAPABILITY_UNAVAILABLE");
        ensure!(state.knowledge_rpc_tasks.len() < 64, "KNOWLEDGE_RPC_BUSY");
        let request: IntegrationRequest = serde_json::from_value(params.clone())?;
        request.validate(kind.mutation())?;
        ensure!(
            state.integration_automation_task_models_v1
                || !matches!(
                    method,
                    "integrations/automation/previewSubscription"
                        | "integrations/automation/saveSubscription"
                )
                || request
                    .payload
                    .get("draft")
                    .and_then(|draft| draft.get("modelSelection"))
                    .is_none_or(Value::is_null),
            "AUTOMATION_TASK_MODELS_CAPABILITY_REQUIRED"
        );
        ensure!(
            state.integration_automation_period_budgets_v1
                || !matches!(
                    method,
                    "integrations/automation/previewSubscription"
                        | "integrations/automation/saveSubscription"
                )
                || request
                    .payload
                    .get("draft")
                    .and_then(|draft| draft.get("periodBudget"))
                    .is_none_or(Value::is_null),
            "AUTOMATION_PERIOD_BUDGET_CAPABILITY_REQUIRED"
        );
        let native = state
            .integration_context
            .as_ref()
            .context("INTEGRATION_SCOPE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        Ok((native, Duration::from_millis(request.timeout_ms)))
    })();
    let (mut native, budget) = match prepared {
        Ok(prepared) => prepared,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32073, "KNOWLEDGE_RPC_UNAVAILABLE"),
            )
            .await?;
            return Ok(true);
        }
    };
    let cache = state.integration_knowledge.clone();
    let runtime = state.integration_runtime.clone();
    let office = integrations::knowledge::AutomationOfficeFactory::capture(state);
    let engine = engine.clone();
    let outbound = outbound.clone();
    let id = id.clone();
    let params = params.clone();
    let method = method.to_owned();
    let cancel = state.input_ended.child_token();
    // Only this authenticated public management route supplies the user-action
    // fact. Neither a model tool nor a private channel Port can reach this path.
    let explicit_user_action = kind.mutation();
    state.knowledge_rpc_tasks.spawn(async move {
        let operation = async {
            let mut cache = {
                let mut shared = cache.lock().await;
                if !shared.has_native_runtime_binding()
                    && let Some(runtime) = runtime
                {
                    let port = integrations::knowledge::NativeAutomationRuntimePort::capture(
                        &native,
                        &engine,
                        Arc::downgrade(&cache),
                        runtime,
                        None,
                    )?
                    .with_office(office);
                    shared.bind_native_runtime(Arc::new(port));
                }
                shared.request_fork(&mut native, &engine)?
            };
            request_knowledge_automation(
                &method,
                params,
                &engine,
                &mut native,
                &mut cache,
                explicit_user_action,
                &cancel,
            )
            .await
        };
        let reply = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            result = tokio::time::timeout(budget, operation) => result.ok().and_then(Result::ok),
        };
        let response = match reply.and_then(|reply| serde_json::to_value(reply).ok()) {
            Some(reply) => success_response(id, reply),
            None => error_response(id, -32073, "KNOWLEDGE_RPC_RESULT_UNCONFIRMED"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}

pub(super) async fn dispatch_memory_snapshot(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    manager: &ThreadManager,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    if method != "integrations/memory/readTaskSnapshot" {
        return Ok(false);
    }
    let reply = (|| -> Result<Value> {
        ensure!(state.integration_memory_v1, "MEMORY_SNAPSHOT_UNAVAILABLE");
        let request: IntegrationRequest = serde_json::from_value(params.clone())?;
        request.validate(false)?;
        let thread = request
            .payload
            .get("threadId")
            .and_then(Value::as_str)
            .context("MEMORY_SNAPSHOT_THREAD_REQUIRED")?;
        let owned = if thread == engine.session_id() {
            Some(engine.clone())
        } else {
            manager.engine(thread)
        }
        .context("MEMORY_SNAPSHOT_THREAD_UNAVAILABLE")?;
        let mut native = state
            .integration_context
            .as_ref()
            .context("MEMORY_SNAPSHOT_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native
            .refresh_configuration_revision(owned.active_model_configuration_summary()?.revision)?;
        serde_json::to_value(integrations::knowledge::request_native_memory_snapshot(
            &request, &owned, &native,
        ))
        .map_err(Into::into)
    })();
    send(
        outbound,
        match reply {
            Ok(reply) => success_response(id.clone(), reply),
            Err(_) => error_response(id.clone(), -32074, "MEMORY_SNAPSHOT_UNAVAILABLE"),
        },
    )
    .await?;
    Ok(true)
}
