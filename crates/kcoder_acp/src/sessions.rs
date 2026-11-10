//! Session execution reuses app-server receipts; it never replays an unknown write.
use crate::permissions::{Permissions, request_for};
use crate::projection::TurnProjection;
use crate::queue::WireSender;
use crate::upstream::{AppServerConfig, Upstream};
use agent_client_protocol::schema::v1::{
    ContentBlock, NewSessionRequest, PromptRequest, PromptResponse, StopReason,
};
use anyhow::{Result, bail, ensure};
use kcoder_app_protocol::{
    ApprovalDecision, ApprovalRequestParams, ApprovalResponse, InitializeResult, ThreadStartResult,
    TurnCompletedParams, TurnStartResult, TurnStatus,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

pub(crate) struct Session {
    pub(crate) id: String,
    thread: String,
    upstream: Upstream,
    lifecycle: crate::diagnostics::Lifecycle,
    native_presentation: Option<kcoder_types::ClientPresentationV1>,
    native_binding: Option<crate::native_binding::NativeBinding>,
}

struct PendingApproval {
    rpc_id: Value,
    cancellation: CancellationToken,
}
impl Drop for PendingApproval {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}
struct ApprovalReply {
    rpc_id: Value,
    approval_id: String,
    decision: ApprovalDecision,
}

impl Session {
    pub(crate) async fn create_from_native(
        id: String,
        request: NewSessionRequest,
        mut prepared: crate::native_binding::PreparedNative,
        cancelled: &CancellationToken,
    ) -> Result<Self> {
        let result = async {
            prepared.validate_session(&request)?;
            prepared.reconcile(cancelled).await?;
            prepared.validate_session(&request)?;
            // The held backend already started in the ACP process's actual cwd.
            // No JSON path is sent as a replacement workspace for this thread.
            let result: ThreadStartResult = serde_json::from_value(
                prepared
                    .upstream
                    .call("thread/start", json!({"mcpServers":[]}))
                    .await?,
            )?;
            let native_presentation = result
                .thread
                .studio_work_mode
                .filter(|mode| *mode == kcoder_types::StudioWorkMode::Kworker)
                .map(|mode| kcoder_types::ClientPresentationV1 {
                    version: 1,
                    studio_work_mode: Some(mode),
                    inline_widgets: false,
                    isolated_widgets: false,
                });
            ensure!(
                native_presentation.is_none()
                    || prepared
                        .initialized
                        .capabilities
                        .experimental
                        .get(kcoder_app_protocol::CAPABILITY_STUDIO_WORK_MODES_V1)
                        == Some(&true),
                "Owned app-server did not negotiate its selected Studio mode"
            );
            Ok::<_, anyhow::Error>((result.thread.id, native_presentation))
        };
        let result = tokio::select! { biased;
            _ = cancelled.cancelled() => Err(anyhow::anyhow!("REMOTE_ORIGINAL_SESSION_CANCELLED")),
            result = result => result,
        };
        match result {
            Ok((thread, native_presentation)) => {
                let lifecycle = prepared
                    .upstream
                    .lifecycle
                    .session(&id)
                    .native(&thread, None);
                Ok(Self {
                    id,
                    thread,
                    upstream: prepared.upstream,
                    lifecycle,
                    native_presentation,
                    native_binding: Some(prepared.binding),
                })
            }
            Err(error) => {
                prepared.shutdown().await;
                Err(error)
            }
        }
    }
    #[cfg(test)]
    pub(crate) async fn create(
        id: String,
        request: NewSessionRequest,
        config: &AppServerConfig,
        cancelled: &CancellationToken,
    ) -> Result<Self> {
        Self::create_traced(
            id.clone(),
            request,
            config,
            cancelled,
            crate::diagnostics::Lifecycle::default().session(&id),
        )
        .await
    }

    pub(crate) async fn create_traced(
        id: String,
        request: NewSessionRequest,
        config: &AppServerConfig,
        cancelled: &CancellationToken,
        lifecycle: crate::diagnostics::Lifecycle,
    ) -> Result<Self> {
        lifecycle.record("session_create", "client_request", "started");
        ensure!(
            request.cwd.is_absolute(),
            "session/new.cwd must be absolute"
        );
        ensure!(
            request.additional_directories.is_empty(),
            "Additional workspace roots are not supported yet"
        );
        let servers = crate::mcp::stdio_servers(request.mcp_servers)?;
        let resolve = async {
            let cwd = tokio::fs::canonicalize(&request.cwd)
                .await
                .map_err(|_| anyhow::anyhow!("session/new.cwd must be an accessible directory"))?;
            let metadata = tokio::fs::metadata(&cwd)
                .await
                .map_err(|_| anyhow::anyhow!("session/new.cwd must be an accessible directory"))?;
            ensure!(metadata.is_dir(), "session/new.cwd must be a directory");
            Ok::<_, anyhow::Error>(cwd)
        };
        let cwd = tokio::select! {
            biased;
            _ = cancelled.cancelled() => bail!("ACP session creation cancelled during cwd verification"),
            result = tokio::time::timeout(Duration::from_secs(30), resolve) => {
                result.map_err(|_| anyhow::anyhow!("session/new.cwd verification timed out after 30s"))??
            }
        };
        let mut upstream = Upstream::spawn_traced(config, &cwd, lifecycle)?;
        let lifecycle = upstream.lifecycle.clone();
        let setup = async {
            let native = initialize_upstream(&upstream, !servers.is_empty()).await?;
            let result: ThreadStartResult = serde_json::from_value(
                upstream
                    .call_with_timeout(
                        "thread/start",
                        json!({"cwd":cwd,"mcpServers":servers}),
                        Duration::from_secs(
                            20 * kcoder_app_protocol::THREAD_MCP_SERVER_LIMIT as u64 + 30,
                        ),
                    )
                    .await?,
            )?;
            // Only the owned Native thread's actual choice is carried forward.
            // ACP metadata cannot select a mode, enable widgets or install tools.
            let native_presentation = result
                .thread
                .studio_work_mode
                .filter(|mode| *mode == kcoder_types::StudioWorkMode::Kworker)
                .map(|mode| kcoder_types::ClientPresentationV1 {
                    version: 1,
                    studio_work_mode: Some(mode),
                    inline_widgets: false,
                    isolated_widgets: false,
                });
            ensure!(
                native_presentation.is_none()
                    || native
                        .capabilities
                        .experimental
                        .get(kcoder_app_protocol::CAPABILITY_STUDIO_WORK_MODES_V1)
                        == Some(&true),
                "Owned app-server did not negotiate its selected Studio mode"
            );
            Ok::<_, anyhow::Error>((result.thread.id, native_presentation))
        };
        let result = tokio::select! {
            _ = cancelled.cancelled() => Err(anyhow::anyhow!("ACP session creation cancelled")),
            result = setup => result,
        };
        match result {
            Ok((thread, native_presentation)) => {
                let lifecycle = lifecycle.native(&thread, None);
                lifecycle.record("session_create", "native_receipt", "ready");
                Ok(Self {
                    id,
                    thread,
                    upstream,
                    lifecycle,
                    native_presentation,
                    native_binding: None,
                })
            }
            Err(error) => {
                lifecycle.record(
                    "session_create",
                    if cancelled.is_cancelled() {
                        "parent_task"
                    } else {
                        "native_failure"
                    },
                    "failed",
                );
                upstream.shutdown().await;
                Err(error)
            }
        }
    }

    pub(crate) async fn prompt(
        &mut self,
        request: PromptRequest,
        cancelled: &CancellationToken,
        output: &WireSender,
        permissions: &Permissions,
    ) -> Result<Value> {
        if let Some(binding) = &mut self.native_binding {
            binding.validate_prompt(&request, cancelled)?;
        }
        let input = prompt_input(request)?;
        let result = self.execute(input, cancelled, output, permissions).await;
        if result.is_err()
            && !self
                .native_binding
                .as_ref()
                .is_some_and(|binding| binding.retains_actual_original_owner())
        {
            self.upstream.shutdown().await;
        }
        // A captured Native owner may still answer its one retained close.
        // Prompt admission remains frozen and cannot dispatch another task.
        result
    }

    async fn execute(
        &mut self,
        input: Vec<Value>,
        cancelled: &CancellationToken,
        output: &WireSender,
        permissions: &Permissions,
    ) -> Result<Value> {
        ensure!(
            !self.upstream.is_closed(),
            "ACP session is closed; create a new session instead of replaying blindly"
        );
        let receipt = {
            let mut params = json!({"threadId":self.thread,"input":input});
            if let Some(presentation) = &self.native_presentation {
                params["clientPresentation"] = serde_json::to_value(presentation)?;
            }
            let acceptance = self.upstream.call("turn/start", params);
            tokio::pin!(acceptance);
            // If cancellation races acceptance, wait briefly for the authoritative identity.
            tokio::select! {
                result = &mut acceptance => result,
                _ = cancelled.cancelled() => {
                    match tokio::time::timeout(Duration::from_secs(5), &mut acceptance).await {
                        Ok(result) => result,
                        Err(_) => Err(anyhow::anyhow!("Cancelled before a native receipt; execution effects are unknown")),
                    }
                }
            }
        };
        let receipt = receipt?;
        let turn: TurnStartResult = serde_json::from_value(receipt)?;
        ensure!(
            turn.turn.thread_id == self.thread,
            "Native turn receipt belongs to another thread"
        );
        self.lifecycle = self.lifecycle.native(&self.thread, Some(&turn.turn.id));
        self.lifecycle.record("turn", "native_receipt", "accepted");
        let cancellation = self.upstream.supervise_cancellation(
            &self.thread,
            &turn.turn.id,
            cancelled.clone(),
            self.native_binding
                .as_ref()
                .map(|binding| binding.close_handoff()),
        );
        let mut projection =
            TurnProjection::new(self.id.clone(), self.thread.clone(), turn.turn.id.clone());
        let result = self
            .stream_turn(
                &turn.turn.id,
                cancelled,
                output,
                &mut projection,
                permissions,
            )
            .await;
        drop(cancellation);
        self.lifecycle.record(
            "turn",
            if cancelled.is_cancelled() {
                "parent_task"
            } else {
                "native_receipt"
            },
            if result.is_ok() {
                "settled"
            } else {
                "failed_or_unknown"
            },
        );
        // Tool rows reach a truthful terminal state before the prompt reply.
        for update in projection.finish()? {
            output
                .send(json!({"jsonrpc":"2.0","method":"session/update","params":update}))
                .await?;
        }
        result.map(|reason| {
            serde_json::to_value(PromptResponse::new(reason)).expect("serializable ACP response")
        })
    }

    async fn stream_turn(
        &mut self,
        turn: &str,
        cancelled: &CancellationToken,
        output: &WireSender,
        projection: &mut TurnProjection,
        permissions: &Permissions,
    ) -> Result<StopReason> {
        let mut approval_tasks = JoinSet::<ApprovalReply>::new();
        let mut approvals = BTreeMap::<String, PendingApproval>::new();
        let mut cancellation_deadline = None;
        let mut stop_reason = StopReason::EndTurn;
        loop {
            let wait_for_deadline = async {
                match cancellation_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            };
            let frame = tokio::select! {
                biased;
                _ = cancelled.cancelled(), if cancellation_deadline.is_none() => {
                    self.lifecycle.record("cancel", "parent_task", "native_interrupt_requested");
                    cancellation_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(5));
                    // The independent supervisor interrupts even if output is blocked.
                    continue;
                }
                _ = wait_for_deadline => {
                    self.lifecycle.record("cancel", "runtime_deadline", "native_outcome_unknown");
                    bail!("Native turn did not settle after cancellation; external effects may be unknown");
                },
                reply=approval_tasks.join_next(), if !approval_tasks.is_empty()=>{
                    let reply=reply.expect("pending approval task")?;
                    if approvals.remove(&reply.approval_id).is_some() {
                        let decision=if cancelled.is_cancelled() {ApprovalDecision::Cancel} else {reply.decision};
                        self.upstream.reply_approval(reply.rpc_id,ApprovalResponse {
                            decision,approval_id:Some(reply.approval_id),thread_id:Some(self.thread.clone()),turn_id:Some(turn.into()),
                        }).await?;
                    }
                    continue;
                }
                frame = self.upstream.events.recv() => frame.ok_or_else(|| anyhow::anyhow!("Owned app-server disconnected during the turn; results may be unknown"))?,
            };
            let frame: Value = serde_json::from_slice(&frame.bytes)?;
            if frame.get("id").is_some() {
                if frame["method"] != "approval/request" || !frame["id"].is_u64() {
                    self.upstream.reject_request(&frame).await?;
                    continue;
                }
                let request =
                    serde_json::from_value::<ApprovalRequestParams>(frame["params"].clone());
                let Ok(request) = request else {
                    self.upstream.reject_request(&frame).await?;
                    continue;
                };
                if let Some(existing) = approvals.get(&request.approval_id) {
                    if existing.rpc_id != frame["id"] {
                        self.upstream.reject_request(&frame).await?;
                    }
                    continue;
                }
                let prepare = (|| -> Result<_> {
                    ensure!(approvals.len() < 16, "Native approval capacity exceeded");
                    let mut params = request_for(&self.id, &request)?;
                    let updates = projection.register_permission_call(&request)?;
                    params.tool_call.tool_call_id = projection.approval_tool_id(&request)?.into();
                    Ok((params, updates))
                })();
                let Ok((params, updates)) = prepare else {
                    self.upstream.reject_request(&frame).await?;
                    continue;
                };
                for update in updates {
                    output
                        .send(json!({"jsonrpc":"2.0","method":"session/update","params":update}))
                        .await?;
                }
                let token = cancelled.child_token();
                let rpc_id = frame["id"].clone();
                approvals.insert(
                    request.approval_id.clone(),
                    PendingApproval {
                        rpc_id: rpc_id.clone(),
                        cancellation: token.clone(),
                    },
                );
                let bridge = permissions.clone();
                let approval_id = request.approval_id;
                approval_tasks.spawn(async move {
                    let decision = bridge
                        .request(params, &token)
                        .await
                        .unwrap_or(ApprovalDecision::Decline);
                    ApprovalReply {
                        rpc_id,
                        approval_id,
                        decision,
                    }
                });
                continue;
            }
            let params = &frame["params"];
            if params["threadId"] != self.thread || params["turnId"] != turn {
                continue;
            }
            if frame["method"] == "approval/resolved"
                && let Some(id) = params["approvalId"].as_str()
                && approvals
                    .get(id)
                    .is_some_and(|pending| pending.rpc_id == params["requestId"])
            {
                approvals.remove(id);
            }
            if frame["method"] == "item/event" {
                match params["event"]["type"].as_str() {
                    Some("max_turns_reached") => stop_reason = StopReason::MaxTurnRequests,
                    Some("stream_aborted") if !cancelled.is_cancelled() => {
                        bail!("Model stream aborted; this is not a completed answer")
                    }
                    _ => {}
                }
            }
            for update in projection.project(&frame)? {
                output
                    .send(json!({"jsonrpc":"2.0","method":"session/update","params":update}))
                    .await?;
            }
            if frame["method"] == "turn/completed" {
                let terminal: TurnCompletedParams =
                    serde_json::from_value(frame["params"].clone())?;
                ensure!(
                    terminal.turn.id == turn && terminal.turn.thread_id == self.thread,
                    "Native terminal receipt belongs to another turn"
                );
                return match terminal.turn.status {
                    TurnStatus::Completed if terminal.error.is_none() => {
                        projection.completion_reason(stop_reason)
                    }
                    TurnStatus::Interrupted if cancelled.is_cancelled() => {
                        Ok(StopReason::Cancelled)
                    }
                    TurnStatus::Interrupted => Err(anyhow::anyhow!(
                        "Native turn interrupted without an ACP cancellation"
                    )),
                    TurnStatus::Failed => Err(crate::failures::provider_failure(&frame["params"])
                        .unwrap_or_else(|| anyhow::anyhow!(
                            "Native model/tool turn failed; do not treat this as a completed answer"
                        ))),
                    _ => Err(anyhow::anyhow!(
                        "Native turn terminal receipt is inconsistent"
                    )),
                };
            }
        }
    }

    pub(crate) async fn shutdown(&mut self) {
        self.upstream.shutdown().await;
    }
    pub(crate) async fn close_native_original(
        &mut self,
        frame: &kcoder_types::integrations::core::NativeRemoteControlFrameV1,
    ) -> Result<Value> {
        let binding = self
            .native_binding
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("REMOTE_ORIGINAL_ACCEPTED_REQUIRED"))?;
        crate::native_binding::close::close_owned(binding, &mut self.upstream, frame).await
    }

    pub(crate) fn begin_shutdown(&self) {
        self.upstream.begin_shutdown();
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.upstream.is_closed()
    }
}

pub(crate) async fn initialize_upstream(
    upstream: &Upstream,
    has_mcp: bool,
) -> Result<InitializeResult> {
    initialize_owned_upstream(upstream, has_mcp, false).await
}

pub(crate) async fn initialize_native_upstream(upstream: &Upstream) -> Result<InitializeResult> {
    use kcoder_app_protocol::integrations::host::{
        CAPABILITY_INTEGRATION_SCOPE_V1, INTEGRATION_SCOPE_READ,
    };
    let native = initialize_owned_upstream(upstream, false, true).await?;
    ensure!(
        native
            .capabilities
            .experimental
            .get(CAPABILITY_INTEGRATION_SCOPE_V1)
            == Some(&true),
        "REMOTE_RECEIVER_NATIVE_SCOPE_UNAVAILABLE"
    );
    let scope: kcoder_types::integrations::core::IntegrationScope =
        serde_json::from_value(upstream.call(INTEGRATION_SCOPE_READ, json!({})).await?)?;
    scope.validate().map_err(anyhow::Error::msg)?;
    Ok(native)
}

async fn initialize_owned_upstream(
    upstream: &Upstream,
    has_mcp: bool,
    private_native: bool,
) -> Result<InitializeResult> {
    let mut params = json!({
        "protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,
        "clientInfo":{"name":"kcoder-acp", "version":env!("CARGO_PKG_VERSION")},
        "capabilities":{"experimental":{"residentThreads":true,"threadMcpServersV1":true,"interactionBindingV1":true,"approvalToolCallIdentityV1":true,"disableUserElicitationV1":true,"studioWorkModesV1":true}}
    });
    if private_native {
        params["capabilities"]["experimental"]
            [kcoder_app_protocol::integrations::host::CAPABILITY_INTEGRATION_SCOPE_V1] =
            json!(true);
    }
    let native: InitializeResult =
        serde_json::from_value(upstream.call("initialize", params).await?)?;
    ensure!(
        native.protocol_version == kcoder_app_protocol::PROTOCOL_VERSION,
        "Owned app-server protocol is incompatible"
    );
    ensure!(
        native.capabilities.experimental.get("residentThreads") == Some(&true),
        "Owned app-server lacks residentThreads"
    );
    ensure!(
        native.capabilities.approvals
            && native
                .capabilities
                .experimental
                .get(kcoder_app_protocol::CAPABILITY_APPROVAL_TOOL_CALL_IDENTITY_V1)
                == Some(&true)
            && native
                .capabilities
                .experimental
                .get(kcoder_app_protocol::CAPABILITY_INTERACTION_BINDING_V1)
                == Some(&true),
        "Owned app-server lacks bound tool approval support"
    );
    ensure!(
        native
            .capabilities
            .experimental
            .get(kcoder_app_protocol::CAPABILITY_DISABLE_USER_ELICITATION_V1)
            == Some(&true),
        "Owned app-server cannot disable unsupported user elicitation"
    );
    ensure!(
        !has_mcp
            || native
                .capabilities
                .experimental
                .get(kcoder_app_protocol::CAPABILITY_THREAD_MCP_SERVERS_V1)
                == Some(&true),
        "Owned app-server does not support threadMcpServersV1"
    );
    Ok(native)
}

fn prompt_input(request: PromptRequest) -> Result<Vec<Value>> {
    ensure!(
        !request.prompt.is_empty(),
        "session/prompt.prompt cannot be empty"
    );
    request.prompt.into_iter().map(|block| match block {
        ContentBlock::Text(text) => Ok(json!({"type":"text","text":text.text})),
        ContentBlock::ResourceLink(resource) => {
            // Preserve reference metadata without claiming that its contents were read.
            Ok(json!({"type":"text", "text":format!("Resource reference (contents not yet read):\n{}", serde_json::to_string(&resource)?)}))
        }
        _ => Err(anyhow::anyhow!("Unsupported prompt content; only text and resource_link are enabled")),
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cwd_preflight_honors_parent_cancellation_and_rejects_files_before_spawn() {
        let root = tempfile::tempdir().unwrap();
        let config = AppServerConfig {
            executable: root.path().join("must-not-execute"),
            args: vec![],
            environment: Some(BTreeMap::new()),
        };
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let request: NewSessionRequest =
            serde_json::from_value(json!({"cwd":root.path().join("not-needed"),"mcpServers":[]}))
                .unwrap();
        let Err(error) = Session::create("cancelled".into(), request, &config, &cancelled).await
        else {
            panic!("cancelled creation must stop before workspace IO");
        };
        assert!(
            error
                .to_string()
                .contains("cancelled during cwd verification")
        );
        let file = root.path().join("ordinary-file");
        std::fs::write(&file, "fixture").unwrap();
        let request: NewSessionRequest =
            serde_json::from_value(json!({"cwd":file,"mcpServers":[]})).unwrap();
        let Err(error) = Session::create(
            "not-directory".into(),
            request,
            &config,
            &CancellationToken::new(),
        )
        .await
        else {
            panic!("ordinary files cannot become workspaces");
        };
        assert!(error.to_string().contains("cwd must be a directory"));
    }

    #[test]
    fn resource_reference_survives_and_unsupported_content_is_not_silently_dropped() {
        let request = serde_json::from_value(json!({"sessionId":"s","prompt":[{"type":"resource_link","name":"Brief","uri":"file:///brief.md","description":"Read this"}]})).unwrap();
        let input = prompt_input(request).unwrap();
        assert!(
            input[0]["text"]
                .as_str()
                .unwrap()
                .contains("file:///brief.md")
        );
        assert!(
            input[0]["text"]
                .as_str()
                .unwrap()
                .contains("contents not yet read")
        );
        let request = serde_json::from_value(json!({"sessionId":"s","prompt":[{"type":"image","data":"abc","mimeType":"image/png"}]})).unwrap();
        assert!(prompt_input(request).is_err());
    }
}
