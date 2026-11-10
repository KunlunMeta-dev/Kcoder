//! App-origin execution uses the same Engine Hooks, permissions and ordering gate.
use crate::{AppActionTool, mcp_apps_runtime::AppConnection};
use anyhow::{Context, Result, ensure};
use kcoder_app_interactions::{
    AppServerPermissionPrompt, ApprovalContext, PendingApprovalResponses,
};
use kcoder_app_protocol::{
    McpAppOperationStatus as Status, McpAppReadParams, McpAppToolCallParams, McpAppToolCallResult,
    method,
};
use kcoder_engine::QueryEngine;
use kcoder_host_transport::protocol_io::notification;
use kcoder_mcp_app_storage::{
    hex_sha256,
    ledger::{OperationGuard, OperationStore},
};
use kcoder_permissions::PermissionDecision;
use kcoder_tools::{Tool, ToolRegistry};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

pub struct AppCallConnection {
    pub entry: Arc<AppConnection>,
    pub source_reader: Arc<kcoder_engine::integrations::core::NativeResourceReadAuthority>,
}

pub async fn execute(
    engine: QueryEngine,
    permission_prompt: AppServerPermissionPrompt,
    connection: AppCallConnection,
    session: PathBuf,
    params: McpAppToolCallParams,
    server_id: String,
    pending: PendingApprovalResponses,
) -> Result<McpAppToolCallResult> {
    let AppCallConnection {
        entry,
        source_reader,
    } = connection;
    let _lease = entry.lease.read().await;
    ensure!(entry.live(), "MCP App connection is no longer live");
    let _gate = tokio::select! {biased;_=entry.cancel.cancelled()=>anyhow::bail!("MCP App connection was revoked"),gate=entry.action_gate.lock()=>gate};
    ensure!(entry.live(), "MCP App connection is no longer live");
    let binding = McpAppReadParams {
        thread_id: params.thread_id.clone(),
        widget_id: params.widget_id.clone(),
        revision: params.revision,
        connection_id: params.connection_id.clone(),
    };
    let inner = entry
        .tools
        .get(&params.name)
        .filter(|tool| tool.is_app_visible())
        .context("MCP App tool is not allowed by this conversation")?
        .clone();
    ensure!(
        serde_json::to_vec(&params.arguments)?.len() <= 128 * 1024,
        "MCP App arguments exceed budget"
    );
    let digest = hex_sha256(&serde_json::to_vec(
        &json!({"binding":binding,"name":params.name,"arguments":params.arguments}),
    )?);
    let store = OperationStore::open(&session)?;
    if let Some(mut receipt) = store.prepare(&binding, &params.operation_id, &digest)? {
        if matches!(receipt.status, Status::Prepared | Status::Executing) {
            receipt.status = Status::OutcomeUnknown;
            receipt.error_code = Some("mcp_app_receipt_unavailable".into());
        }
        return Ok(receipt);
    }
    let _operation = OperationGuard {
        session: session.clone(),
        binding: binding.clone(),
        operation: params.operation_id.clone(),
    };
    let name = inner.name();
    let mut tools = ToolRegistry::new();
    tools.try_register(Arc::new(AppActionTool::new(
        inner,
        session.clone(),
        binding.clone(),
        params.operation_id.clone(),
        source_reader,
    )))?;
    let engine = engine
        .with_turn_tools(tools)
        .with_client_presentation(Some(kcoder_types::ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(kcoder_types::StudioWorkMode::Kworker),
            inline_widgets: true,
            isolated_widgets: true,
        }))
        .with_cancel_token(entry.cancel.child_token());
    let operation_turn = format!("mcp-app-{}", params.operation_id);
    let mut prompt = permission_prompt;
    prompt.pending = pending;
    prompt.context = Arc::new(StdMutex::new(Some(ApprovalContext {
        server_id,
        thread_id: binding.thread_id.clone(),
        turn_id: operation_turn.clone(),
    })));
    prompt.artifact_dir = Arc::new(StdMutex::new(Some(session.join("approval-decisions"))));
    let _interactions = OperationInteractions {
        prompt: prompt.clone(),
        thread_id: binding.thread_id.clone(),
        turn_id: operation_turn,
    };
    let result = tokio::select! {biased;
        _=entry.cancel.cancelled()=>Err(anyhow::anyhow!("MCP App connection was revoked")),
        result=tokio::time::timeout(Duration::from_secs(120),engine.execute_app_tool(&params.operation_id,&name,params.arguments,&prompt))=>result.context("MCP App operation timed out").and_then(|result|result),
    };
    let receipt = store.read(&binding, &params.operation_id)?;
    match receipt.status {
        Status::Prepared => {
            let denied = result
                .as_ref()
                .is_ok_and(|(_, decision, _, _)| *decision == PermissionDecision::Deny);
            store.transition(
                &binding,
                &params.operation_id,
                if denied {
                    Status::Denied
                } else {
                    Status::NotSent
                },
                None,
                Some(if denied {
                    "mcp_app_permission_denied"
                } else {
                    "mcp_app_not_dispatched"
                }),
            )
        }
        Status::Executing => store.transition(
            &binding,
            &params.operation_id,
            Status::OutcomeUnknown,
            None,
            Some("mcp_app_receipt_unavailable"),
        ),
        _ => Ok(receipt),
    }
}

/// The prompt owns a separate context while sharing reply routing with the resident
/// thread. Cancellation settles only this operation's outstanding approvals.
struct OperationInteractions {
    prompt: AppServerPermissionPrompt,
    thread_id: String,
    turn_id: String,
}
impl Drop for OperationInteractions {
    fn drop(&mut self) {
        let mut receipts = self
            .prompt
            .receipts
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let pending = receipts.outstanding_for_turn(&self.thread_id, &self.turn_id);
        let app_server_epoch = receipts.app_server_epoch.clone();
        for (id, binding) in pending {
            self.prompt
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            let frame = notification(
                method::APPROVAL_RESOLVED,
                json!({"requestId":id,"approvalId":binding.interaction_id,"threadId":binding.thread_id,"turnId":binding.turn_id,"appServerEpoch":app_server_epoch,"decision":"cancel","reason":"cancelled"}),
            );
            receipts.record(id, frame.clone());
            let _ = self.prompt.outbound_tx.try_send(frame);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_app_events::resident_turn::ResidentTurnState;
    use kcoder_app_interactions::{InteractionBinding, InteractionReceipts};
    use kcoder_app_protocol::{
        InteractionStatusKindV1 as Kind, InteractionStatusReadParamsV1, InteractionStatusV1,
    };
    use std::{collections::HashMap, sync::atomic::AtomicU64};
    use tokio::sync::{mpsc, oneshot};

    #[tokio::test]
    async fn owner_operation_cancel_keeps_epoch_and_resolves_exact_interaction_status() {
        use kcoder_permissions::{PermissionPrompt, PermissionRequestContext, PermissionRisk};

        let app_server_epoch = "owner-operation-epoch";
        let (outbound_tx, mut outbound_rx) = mpsc::channel(4);
        let receipts = Arc::new(StdMutex::new(InteractionReceipts::new(
            app_server_epoch.into(),
        )));
        let turn_state = ResidentTurnState::new(
            outbound_tx,
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(47)),
            Arc::clone(&receipts),
        );
        let mcp_app_pending = Arc::new(StdMutex::new(HashMap::new()));
        let mut prompt = turn_state.permission_prompt.clone();
        prompt.pending = Arc::clone(&mcp_app_pending);
        prompt.context = Arc::new(StdMutex::new(Some(ApprovalContext {
            server_id: "server-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "mcp-app-operation-1".into(),
        })));
        let unrelated_binding = InteractionBinding {
            interaction_id: "approval-unrelated".into(),
            server_id: "server-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "another-operation".into(),
            kind: Kind::Approval,
        };
        let unrelated_request_id = 48;
        let (unrelated_tx, _unrelated_rx) = oneshot::channel();
        mcp_app_pending
            .lock()
            .unwrap()
            .insert(unrelated_request_id, unrelated_tx);
        receipts.lock().unwrap().track_request(
            unrelated_request_id,
            unrelated_binding.clone(),
            json!({"method":"approval/request", "params":{"appServerEpoch":app_server_epoch}}),
        );

        let interactions = OperationInteractions {
            prompt: prompt.clone(),
            thread_id: "thread-1".into(),
            turn_id: "mcp-app-operation-1".into(),
        };
        let request_context = PermissionRequestContext {
            tool_name: "mcp_app_action".into(),
            description: "MCP App action requires approval".into(),
            input: json!({"action":"write"}),
            risk: PermissionRisk::Medium,
            detail_lines: vec!["test operation".into()],
        };
        let request_task = tokio::spawn(async move { prompt.ask_context(&request_context).await });
        let request = outbound_rx.recv().await.unwrap();
        assert_eq!(request["method"], method::APPROVAL_REQUEST);
        let request_id = request["id"].as_u64().unwrap();
        assert_eq!(request["params"]["appServerEpoch"], app_server_epoch);
        let request_binding = InteractionBinding {
            interaction_id: request["params"]["approvalId"].as_str().unwrap().into(),
            server_id: request["params"]["serverId"].as_str().unwrap().into(),
            thread_id: request["params"]["threadId"].as_str().unwrap().into(),
            turn_id: request["params"]["turnId"].as_str().unwrap().into(),
            kind: Kind::Approval,
        };
        let selector =
            |request_id: u64, binding: &InteractionBinding| InteractionStatusReadParamsV1 {
                server_id: binding.server_id.clone(),
                thread_id: binding.thread_id.clone(),
                turn_id: binding.turn_id.clone(),
                request_id,
                app_server_epoch: app_server_epoch.into(),
                kind: binding.kind,
                approval_id: Some(binding.interaction_id.clone()),
                question_id: None,
            };
        let request_selector = selector(request_id, &request_binding);
        let runtime_pending =
            turn_state.pending_interaction_matches(&request_selector, &mcp_app_pending);
        assert_eq!(runtime_pending, Some(true));
        assert_eq!(
            receipts
                .lock()
                .unwrap()
                .read_status(&request_selector, runtime_pending),
            InteractionStatusV1::Pending,
            "connection-level MCP App approvals must appear pending in the exact status read"
        );
        let unrelated_selector = selector(unrelated_request_id, &unrelated_binding);
        assert_eq!(
            turn_state.pending_interaction_matches(&unrelated_selector, &mcp_app_pending),
            Some(true)
        );
        assert_eq!(
            receipts
                .lock()
                .unwrap()
                .read_status(&unrelated_selector, Some(true)),
            InteractionStatusV1::Pending,
            "a second pending approval in the same thread must remain separately addressable"
        );
        let mut wrong_request = request_selector.clone();
        wrong_request.request_id = unrelated_request_id;
        assert_eq!(
            receipts
                .lock()
                .unwrap()
                .read_status(&wrong_request, Some(true)),
            InteractionStatusV1::Unknown,
            "reusing another pending request id cannot authorize this operation's selector"
        );
        let mut wrong_interaction = request_selector.clone();
        wrong_interaction.approval_id = Some("approval-from-another-request".into());
        assert_eq!(
            receipts
                .lock()
                .unwrap()
                .read_status(&wrong_interaction, Some(true)),
            InteractionStatusV1::Unknown,
            "the request id must remain bound to the exact interaction id"
        );

        request_task.abort();
        let _ = request_task.await;
        drop(interactions);

        let resolved = outbound_rx.try_recv().unwrap();
        assert_eq!(resolved["method"], method::APPROVAL_RESOLVED);
        assert_eq!(resolved["params"]["requestId"], request_id);
        assert_eq!(
            resolved["params"]["approvalId"],
            request_binding.interaction_id
        );
        assert_eq!(resolved["params"]["appServerEpoch"], app_server_epoch);

        let ledger = receipts.lock().unwrap();
        assert_eq!(
            ledger.read_status(&request_selector, None),
            InteractionStatusV1::Resolved,
            "the owner cancellation must produce a terminal receipt for the exact request"
        );
        assert_eq!(
            ledger.read_status(
                &selector(unrelated_request_id, &unrelated_binding),
                Some(true)
            ),
            InteractionStatusV1::Pending,
            "dropping one operation must leave another turn's approval untouched"
        );
    }
}
