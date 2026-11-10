//! Interaction requests: extracted from the app-server connection boundary.
#[path = "interaction_requests/answer_lists.rs"]
mod answer_lists;
#[cfg(test)]
#[path = "interaction_requests/response_kind_tests.rs"]
mod response_kind_tests;

use super::*;
use anyhow::Result;
use async_trait::async_trait;
use kcoder_app_protocol::{
    ApprovalAction, ApprovalDecision, ApprovalRequestParams, ApprovalResolvedParams,
    JSONRPC_VERSION, Question, QuestionOption, QuestionRequestParams, QuestionResolvedParams,
    method,
};
use kcoder_cli_storage::{
    private_files::{hex_sha256, write_private_artifact_file},
    transcript_artifact_journal,
};
use kcoder_cli_support::HeadlessPermissionPrompt;
use kcoder_host_transport::protocol_io::{notification, send};
use kcoder_permissions::{PermissionPrompt, PermissionRequestContext, PermissionResponse};
use kcoder_tools::{UserQuestionRequest, UserQuestionResponse, UserQuestioner};
use kcoder_transcript::ApprovalDecisionArtifact;
use serde_json::json;
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::{
    sync::atomic::Ordering,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn approval_response_timeout() -> Duration {
    #[cfg(debug_assertions)]
    {
        let configured = std::env::var(E2E_APPROVAL_TIMEOUT_ENV).ok();
        if let Some(timeout) = parse_e2e_approval_timeout(configured.as_deref()) {
            return timeout;
        }
        if configured.is_some() {
            tracing::warn!(
                variable = E2E_APPROVAL_TIMEOUT_ENV,
                "ignoring invalid E2E approval timeout and using the production default"
            );
        }
    }
    DEFAULT_APPROVAL_RESPONSE_TIMEOUT
}

fn allocate_interaction_request_id(next_id: &AtomicU64) -> Option<u64> {
    next_id
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
            current.checked_add(1)
        })
        .ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractionStatusReadError {
    Unsupported,
    InvalidParams,
}

pub fn read_interaction_status(
    negotiated: bool,
    raw_params: Value,
    receipts: &InteractionReceipts,
    runtime_pending: impl FnOnce(&kcoder_app_protocol::InteractionStatusReadParamsV1) -> Option<bool>,
) -> Result<kcoder_app_protocol::InteractionStatusReadResultV1, InteractionStatusReadError> {
    if !negotiated {
        return Err(InteractionStatusReadError::Unsupported);
    }
    let params =
        serde_json::from_value::<kcoder_app_protocol::InteractionStatusReadParamsV1>(raw_params)
            .map_err(|_| InteractionStatusReadError::InvalidParams)?;
    if params.validate().is_err() {
        return Err(InteractionStatusReadError::InvalidParams);
    }
    let status = receipts.read_status(&params, runtime_pending(&params));
    Ok(kcoder_app_protocol::InteractionStatusReadResultV1::from((
        &params, status,
    )))
}

#[cfg(any(debug_assertions, test, feature = "test-oracle"))]
pub fn parse_e2e_approval_timeout(raw: Option<&str>) -> Option<Duration> {
    let milliseconds = raw?.parse::<u64>().ok()?;
    (10..=30_000)
        .contains(&milliseconds)
        .then(|| Duration::from_millis(milliseconds))
}

#[async_trait]
impl PermissionPrompt for AppServerPermissionPrompt {
    async fn ask_explicit_context_with_edit(
        &self,
        request: &PermissionRequestContext,
    ) -> kcoder_permissions::PermissionDialogResult {
        let mut interactive = self.clone();
        interactive.mode = kcoder_config::PermissionMode::Ask;
        interactive.ask_context_with_edit(request).await
    }
    fn bind_tool_call(&self, tool_call_id: &str) -> Option<Arc<dyn PermissionPrompt>> {
        Some(Arc::new(Self {
            tool_call_id: Some(tool_call_id.to_owned()),
            ..self.clone()
        }))
    }
    async fn ask(&self, tool_name: &str, description: String, input: &Value) -> PermissionResponse {
        self.ask_context(&PermissionRequestContext {
            tool_name: tool_name.to_string(),
            description,
            input: input.clone(),
            risk: kcoder_permissions::PermissionRisk::None,
            detail_lines: Vec::new(),
        })
        .await
    }

    async fn ask_context(&self, request: &PermissionRequestContext) -> PermissionResponse {
        if self.mode != kcoder_config::PermissionMode::Ask {
            return HeadlessPermissionPrompt::new(self.mode)
                .ask_context(request)
                .await;
        }

        let Some(context) = self
            .context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            tracing::warn!(tool = %request.tool_name, "app-server permission requested outside an active turn");
            return PermissionResponse::DenyOnce;
        };
        let Some(request_id) = allocate_interaction_request_id(&self.next_id) else {
            tracing::error!(tool = %request.tool_name, "app-server interaction request id space exhausted");
            return PermissionResponse::DenyOnce;
        };
        let approval_id = format!("approval-{request_id}");
        let app_server_epoch = self
            .receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .app_server_epoch
            .clone();
        let params = ApprovalRequestParams {
            tool_call_id: self
                .tool_call_identity_enabled
                .then(|| self.tool_call_id.clone())
                .flatten(),
            server_id: context.server_id,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            approval_id,
            app_server_epoch: Some(app_server_epoch.clone()),
            action: approval_action_for(request),
            reason: request.description.clone(),
        };
        let requested_at_ms = unix_timestamp_ms();
        let resolved_approval_id = params.approval_id.clone();
        let resolved_thread_id = params.thread_id.clone();
        let resolved_turn_id = params.turn_id.clone();
        let (response_tx, response_rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request_id, response_tx);
        let request_frame = json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": method::APPROVAL_REQUEST,
            "params": params,
        });
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .track_request(
                request_id,
                InteractionBinding {
                    interaction_id: params.approval_id.clone(),
                    server_id: params.server_id.clone(),
                    thread_id: params.thread_id.clone(),
                    turn_id: params.turn_id.clone(),
                    kind: kcoder_app_protocol::InteractionStatusKindV1::Approval,
                },
                request_frame.clone(),
            );
        if self.outbound_tx.send(request_frame).await.is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            self.receipts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .forget_request(request_id);
            tracing::warn!(tool = %request.tool_name, "app-server connection closed while requesting approval");
            return PermissionResponse::DenyOnce;
        }

        let response = tokio::time::timeout(self.response_timeout, response_rx).await;
        // `resolve_server_response` normally removes the response path first. Perform
        // idempotent cleanup here on timeout or sender failure so long-lived connections
        // do not accumulate stale approvals.
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&request_id);
        let (permission, decision, reason) = match response {
            Err(_) => {
                tracing::warn!(tool = %request.tool_name, "app-server approval request timed out");
                (
                    PermissionResponse::DenyOnce,
                    ApprovalDecision::Decline,
                    "timeout",
                )
            }
            Ok(Ok(Ok(response))) => {
                let permission = match &response.decision {
                    ApprovalDecision::Accept => PermissionResponse::AllowOnce,
                    ApprovalDecision::AcceptForSession => PermissionResponse::AllowForSession,
                    ApprovalDecision::Decline | ApprovalDecision::Cancel => {
                        PermissionResponse::DenyOnce
                    }
                };
                (permission, response.decision, "client_response")
            }
            Ok(Ok(Err(error))) => {
                tracing::warn!(tool = %request.tool_name, %error, "app-server approval request failed");
                (
                    PermissionResponse::DenyOnce,
                    ApprovalDecision::Cancel,
                    "response_error",
                )
            }
            Ok(Err(_)) => {
                tracing::warn!(tool = %request.tool_name, "app-server approval request was cancelled");
                (
                    PermissionResponse::DenyOnce,
                    ApprovalDecision::Cancel,
                    "cancelled",
                )
            }
        };
        if let Err(error) = self.persist_decision(ApprovalDecisionArtifact {
            tool_call_id: params.tool_call_id.clone(),
            version: 1,
            artifact_id: hex_sha256(
                format!(
                    "{}\0{}\0{}\0{}",
                    params.thread_id, params.turn_id, params.approval_id, requested_at_ms
                )
                .as_bytes(),
            ),
            thread_id: params.thread_id.clone(),
            turn_id: params.turn_id.clone(),
            approval_id: params.approval_id.clone(),
            action: params.action.clone(),
            reason: params.reason.clone(),
            decision: decision.clone(),
            resolution_reason: reason.into(),
            requested_at_ms,
            resolved_at_ms: unix_timestamp_ms(),
        }) {
            tracing::warn!(%error, approval_id = %params.approval_id, "failed to persist app-server approval decision");
        }
        let resolved = notification(
            method::APPROVAL_RESOLVED,
            kcoder_app_rpc_codec::encode(ApprovalResolvedParams {
                request_id,
                approval_id: resolved_approval_id,
                thread_id: resolved_thread_id,
                turn_id: resolved_turn_id,
                app_server_epoch: Some(app_server_epoch),
                decision,
                reason: reason.into(),
            })
            .expect("approval resolution serializes"),
        );
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record_terminal(request_id, resolved.clone());
        let _ = self.outbound_tx.send(resolved).await;
        permission
    }
}

impl AppServerPermissionPrompt {
    pub fn persist_decision(&self, artifact: ApprovalDecisionArtifact) -> Result<()> {
        let Some(artifact_dir) = self
            .artifact_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            return Ok(());
        };
        transcript_artifact_journal::write(
            &artifact_dir,
            &artifact.thread_id,
            transcript_artifact_journal::Kind::ApprovalDecisions,
            || {
                write_private_artifact_file(
                    &artifact_dir.join(format!("{}.json", artifact.artifact_id)),
                    &serde_json::to_vec_pretty(&artifact)?,
                )
            },
        )
    }
}

pub fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub fn approval_action_for(request: &PermissionRequestContext) -> ApprovalAction {
    let normalized = request.tool_name.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "bash" | "bashtool" | "powershell" | "powershelltool" | "repl" | "repltool"
    ) && let Some(command) = request.input.get("command").and_then(Value::as_str)
    {
        return ApprovalAction::Command {
            command: command.to_string(),
        };
    }
    if matches!(
        normalized.as_str(),
        "write" | "filewritetool" | "edit" | "fileedittool"
    ) && let Some(path) = request
        .input
        .get("file_path")
        .or_else(|| request.input.get("path"))
        .and_then(Value::as_str)
    {
        return ApprovalAction::FileChange {
            path: path.to_string(),
        };
    }
    // apply_patch carries no `file_path`/`path` key; classify single-file
    // patches as FileChange and let multi-file patches fall through to the
    // generic Tool action (its input carries the full patch text).
    if matches!(normalized.as_str(), "apply_patch" | "applypatchtool")
        && let Some(patch) = request.input.get("patch").and_then(Value::as_str)
    {
        let paths = kcoder_tools::apply_patch::patch_affected_paths(patch);
        if paths.len() == 1 {
            return ApprovalAction::FileChange {
                path: paths[0].clone(),
            };
        }
    }
    ApprovalAction::Tool {
        name: request.tool_name.clone(),
        input: request.input.clone(),
    }
}

pub fn resolve_server_response(
    response: &Value,
    pending_approvals: &PendingApprovalResponses,
    pending_questions: &PendingQuestionResponses,
    receipts: &Arc<StdMutex<InteractionReceipts>>,
    require_binding: bool,
) -> InteractionReply {
    let Some(request_id) = response.get("id").and_then(Value::as_u64) else {
        return InteractionReply::Unmatched;
    };
    // Invalid envelopes cannot cancel an input waiter. Preserve legacy omission
    // of jsonrpc, but require an actual RPC error before treating it as failure.
    if response.get("method").is_some()
        || response
            .get("jsonrpc")
            .is_some_and(|version| version.as_str() != Some(kcoder_app_protocol::JSONRPC_VERSION))
    {
        return InteractionReply::Misattributed;
    }
    let response_error = match response.get("error") {
        Some(error) => {
            if response.get("result").is_some() {
                return InteractionReply::Misattributed;
            }
            match serde_json::from_value::<kcoder_app_protocol::RpcError>(error.clone()) {
                Ok(error) => Some(error),
                Err(_) => return InteractionReply::Misattributed,
            }
        }
        None => None,
    };
    // A connection that negotiated `interactionBindingV1` must name the
    // interaction, so a transport id issued by an earlier connection generation
    // can never be applied to a new turn. An error frame carries no decision and
    // can only fail the interaction, so it stays accepted without a binding.
    let (expected, expected_epoch) = {
        let receipts = receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let epoch = receipts
            .outstanding
            .get(&request_id)
            .and_then(|entry| entry.request.pointer("/params/appServerEpoch"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        (receipts.expected_binding(request_id).cloned(), epoch)
    };
    let verify = |reply: ReplyBinding, other_identity: &str| {
        // Typed replies ignore fields belonging to the other interaction kind.
        // Reject that explicit identity before consuming the original waiter.
        if !response["result"][other_identity].is_null() {
            return false;
        }
        // The typed responses ignore this optional transport field. Check it
        // against the original request before consuming either kind of waiter,
        // including replies from clients without binding negotiation.
        if let Some(epoch) = response
            .pointer("/result/appServerEpoch")
            .filter(|epoch| !epoch.is_null())
            && !epoch.as_str().is_some_and(|epoch| {
                !epoch.trim().is_empty() && Some(epoch) == expected_epoch.as_deref()
            })
        {
            return false;
        }
        match (&expected, require_binding) {
            (Some(expected), true) => reply.matches(expected),
            // Legacy clients may omit binding fields, but an explicit identity
            // must still name the original input before its waiter is consumed.
            (Some(expected), false) => {
                reply
                    .interaction_id
                    .is_none_or(|id| id == expected.interaction_id)
                    && reply.thread_id.is_none_or(|id| id == expected.thread_id)
                    && reply.turn_id.is_none_or(|id| id == expected.turn_id)
            }
            (None, _) => true,
        }
    };

    if pending_approvals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(&request_id)
    {
        let parsed = if let Some(error) = &response_error {
            Err(error.message.clone())
        } else {
            match serde_json::from_value::<ApprovalResponse>(
                response.get("result").cloned().unwrap_or(Value::Null),
            ) {
                Ok(reply) => {
                    if !verify(ReplyBinding::from(&reply), "questionId") {
                        return InteractionReply::Misattributed;
                    }
                    Ok(reply)
                }
                Err(error) => return InteractionReply::Unmatched.tap_invalid(&error),
            }
        };
        return deliver_approval_response(pending_approvals, request_id, parsed);
    }

    if pending_questions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(&request_id)
    {
        let parsed = if let Some(error) = &response_error {
            Err(error.message.clone())
        } else {
            match serde_json::from_value::<QuestionResponse>(
                response.get("result").cloned().unwrap_or(Value::Null),
            ) {
                Ok(reply) => {
                    if !verify(ReplyBinding::from(&reply), "approvalId") {
                        return InteractionReply::Misattributed;
                    }
                    // Outer identities do not bind answer item IDs. Check the
                    // original request before removing its waiter, including for
                    // legacy clients; partial and empty answers remain valid.
                    let items_match = receipts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .outstanding
                        .get(&request_id)
                        .and_then(|entry| entry.request.get("params")?.get("questions")?.as_array())
                        .is_none_or(|questions| {
                            reply.answers.keys().all(|id| {
                                questions.iter().any(|question| {
                                    question.get("id").and_then(Value::as_str) == Some(id.as_str())
                                })
                            })
                        });
                    if !items_match {
                        return InteractionReply::Misattributed;
                    }
                    Ok(reply)
                }
                Err(error) => return InteractionReply::Unmatched.tap_invalid(&error),
            }
        };
        return deliver_question_response(pending_questions, request_id, parsed);
    }

    InteractionReply::Unmatched
}

impl InteractionReply {
    /// An unparseable result frame is not an answer; keep it observable.
    pub fn tap_invalid(self, error: &impl std::fmt::Display) -> Self {
        tracing::warn!(%error, "app-server interaction reply was not a valid result frame");
        self
    }
}

impl<'a> From<&'a ApprovalResponse> for ReplyBinding<'a> {
    fn from(reply: &'a ApprovalResponse) -> Self {
        Self {
            interaction_id: reply.approval_id.as_deref(),
            thread_id: reply.thread_id.as_deref(),
            turn_id: reply.turn_id.as_deref(),
        }
    }
}

impl<'a> From<&'a QuestionResponse> for ReplyBinding<'a> {
    fn from(reply: &'a QuestionResponse) -> Self {
        Self {
            interaction_id: reply.question_id.as_deref(),
            thread_id: reply.thread_id.as_deref(),
            turn_id: reply.turn_id.as_deref(),
        }
    }
}

impl ReplyBinding<'_> {
    pub fn matches(&self, expected: &InteractionBinding) -> bool {
        self.interaction_id == Some(expected.interaction_id.as_str())
            && self.thread_id == Some(expected.thread_id.as_str())
            && self.turn_id == Some(expected.turn_id.as_str())
    }
}

pub fn deliver_approval_response(
    pending_approvals: &PendingApprovalResponses,
    request_id: u64,
    parsed: std::result::Result<ApprovalResponse, String>,
) -> InteractionReply {
    let Some(response_tx) = pending_approvals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&request_id)
    else {
        return InteractionReply::Unmatched;
    };
    let _ = response_tx.send(parsed);
    InteractionReply::Delivered
}

pub fn deliver_question_response(
    pending_questions: &PendingQuestionResponses,
    request_id: u64,
    parsed: std::result::Result<QuestionResponse, String>,
) -> InteractionReply {
    let Some(response_tx) = pending_questions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&request_id)
    else {
        return InteractionReply::Unmatched;
    };
    let _ = response_tx.send(parsed);
    InteractionReply::Delivered
}

impl InteractionReceipts {
    pub fn new(app_server_epoch: String) -> Self {
        Self {
            app_server_epoch,
            ..Self::default()
        }
    }

    /// Registers an interaction that is now waiting for a reply.
    pub fn track_request(&mut self, request_id: u64, binding: InteractionBinding, request: Value) {
        self.outstanding
            .insert(request_id, OutstandingInteraction { binding, request });
    }

    /// Drops an interaction that ended without a terminal answer to replay
    /// (timeout or closed connection); no receipt is kept for it.
    pub fn forget_request(&mut self, request_id: u64) {
        self.outstanding.remove(&request_id);
    }

    pub fn expected_binding(&self, request_id: u64) -> Option<&InteractionBinding> {
        self.outstanding
            .get(&request_id)
            .map(|entry| &entry.binding)
    }

    /// Captures only requests owned by this thread and turn before settlement mutates receipts.
    pub fn outstanding_for_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Vec<(u64, InteractionBinding)> {
        self.outstanding
            .iter()
            .filter(|(_, entry)| {
                entry.binding.thread_id == thread_id && entry.binding.turn_id == turn_id
            })
            .map(|(id, entry)| (*id, entry.binding.clone()))
            .collect()
    }

    pub fn outstanding_request(&self, request_id: u64) -> Option<Value> {
        self.outstanding
            .get(&request_id)
            .map(|entry| entry.request.clone())
    }

    pub fn note_misattributed(&mut self) {
        self.misattributed_replies = self.misattributed_replies.saturating_add(1);
    }

    pub fn record(&mut self, request_id: u64, notification: Value) {
        self.record_terminal(request_id, notification);
    }

    pub fn record_terminal(&mut self, request_id: u64, notification: Value) {
        let binding = self.outstanding.remove(&request_id).and_then(|entry| {
            self.terminal_matches_binding(request_id, &entry.binding, &entry.request, &notification)
                .then_some(entry.binding)
        });
        while self.resolved.len() >= INTERACTION_RECEIPT_LIMIT {
            self.resolved.pop_front();
        }
        self.resolved.push_back((
            request_id,
            ResolvedInteraction {
                binding,
                notification,
            },
        ));
    }

    fn terminal_matches_binding(
        &self,
        request_id: u64,
        binding: &InteractionBinding,
        request: &Value,
        notification: &Value,
    ) -> bool {
        use kcoder_app_protocol::InteractionStatusKindV1 as Kind;

        let (request_method, resolved_method, interaction_field) = match binding.kind {
            Kind::Approval => (
                method::APPROVAL_REQUEST,
                method::APPROVAL_RESOLVED,
                "approvalId",
            ),
            Kind::Question => (
                method::QUESTION_REQUEST,
                method::QUESTION_RESOLVED,
                "questionId",
            ),
        };
        let Some(request_params) = request.get("params") else {
            return false;
        };
        let Some(resolved_params) = notification.get("params") else {
            return false;
        };
        let resolved_server_matches = resolved_params
            .get("serverId")
            .map(|server_id| server_id.as_str() == Some(binding.server_id.as_str()))
            .unwrap_or(true);

        request.get("id").and_then(Value::as_u64) == Some(request_id)
            && request.get("method").and_then(Value::as_str) == Some(request_method)
            && request_params.get("serverId").and_then(Value::as_str)
                == Some(binding.server_id.as_str())
            && request_params.get("threadId").and_then(Value::as_str)
                == Some(binding.thread_id.as_str())
            && request_params.get("turnId").and_then(Value::as_str)
                == Some(binding.turn_id.as_str())
            && request_params
                .get(interaction_field)
                .and_then(Value::as_str)
                == Some(binding.interaction_id.as_str())
            && request_params.get("appServerEpoch").and_then(Value::as_str)
                == Some(self.app_server_epoch.as_str())
            && notification.get("method").and_then(Value::as_str) == Some(resolved_method)
            && resolved_params.get("requestId").and_then(Value::as_u64) == Some(request_id)
            && resolved_params.get("threadId").and_then(Value::as_str)
                == Some(binding.thread_id.as_str())
            && resolved_params.get("turnId").and_then(Value::as_str)
                == Some(binding.turn_id.as_str())
            && resolved_params
                .get(interaction_field)
                .and_then(Value::as_str)
                == Some(binding.interaction_id.as_str())
            && resolved_params
                .get("appServerEpoch")
                .and_then(Value::as_str)
                == Some(self.app_server_epoch.as_str())
            && resolved_server_matches
    }

    pub fn read_status(
        &self,
        params: &kcoder_app_protocol::InteractionStatusReadParamsV1,
        runtime_pending: Option<bool>,
    ) -> kcoder_app_protocol::InteractionStatusV1 {
        use kcoder_app_protocol::{InteractionStatusKindV1 as Kind, InteractionStatusV1 as Status};

        if params.app_server_epoch != self.app_server_epoch {
            return Status::Unknown;
        }
        let interaction_id = match params.kind {
            Kind::Approval => params.approval_id.as_deref(),
            Kind::Question => params.question_id.as_deref(),
        };
        let matches = |binding: &InteractionBinding| {
            binding.server_id == params.server_id
                && binding.thread_id == params.thread_id
                && binding.turn_id == params.turn_id
                && binding.kind == params.kind
                && Some(binding.interaction_id.as_str()) == interaction_id
        };
        if self.resolved.iter().any(|(id, resolved)| {
            *id == params.request_id && resolved.binding.as_ref().is_some_and(&matches)
        }) {
            return Status::Resolved;
        }
        if self
            .outstanding
            .get(&params.request_id)
            .is_some_and(|entry| matches(&entry.binding))
            && runtime_pending == Some(true)
        {
            return Status::Pending;
        }
        Status::Unknown
    }

    /// Returns the terminal answer already sent for `request_id`, if any.
    pub fn replay(&mut self, request_id: u64) -> Option<Value> {
        let found = self
            .resolved
            .iter()
            .find(|(id, _)| *id == request_id)
            .map(|(_, resolved)| resolved.notification.clone());
        if found.is_some() {
            self.duplicate_replies = self.duplicate_replies.saturating_add(1);
        }
        found
    }

    pub fn note_unmatched(&mut self) {
        self.unmatched_replies = self.unmatched_replies.saturating_add(1);
    }

    #[cfg(any(test, feature = "test-oracle"))]
    pub fn len(&self) -> usize {
        self.resolved.len()
    }

    #[cfg(any(test, feature = "test-oracle"))]
    pub fn counters(&self) -> (u64, u64) {
        (self.duplicate_replies, self.unmatched_replies)
    }

    #[cfg(any(test, feature = "test-oracle"))]
    pub fn outstanding_len(&self) -> usize {
        self.outstanding.len()
    }
}

/// Each worker captures the parent binding once. Later parent turns cannot steal it.
struct AppServerAgentQuestioner {
    host: AppServerQuestioner,
    source: kcoder_types::SourceAgent,
    validate: Arc<dyn Fn() -> bool + Send + Sync>,
}

#[async_trait]
impl UserQuestioner for AppServerAgentQuestioner {
    fn supports_agent_binding(&self) -> bool {
        (self.validate)()
            && self.host.supports_agent_binding()
            && self
                .host
                .context
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .is_some_and(|context| context.thread_id == self.source.parent_session_id)
    }

    fn bind_agent(
        &self,
        source: kcoder_types::SourceAgent,
        validate: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Option<Arc<dyn UserQuestioner>> {
        self.host.bind_agent(source, validate)
    }

    async fn ask(
        &self,
        request: UserQuestionRequest,
    ) -> std::result::Result<UserQuestionResponse, String> {
        if !(self.validate)() {
            return Err("subagent interaction source is no longer the owned task/run".to_string());
        }
        let context = self
            .host
            .context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if context
            .as_ref()
            .is_none_or(|context| context.thread_id != self.source.parent_session_id)
        {
            return Err("subagent interaction parent binding is unavailable".to_string());
        }
        let result = self
            .host
            .ask_agent(
                request,
                Some(self.source.clone()),
                Some(self.validate.clone()),
            )
            .await;
        if !(self.validate)() {
            return Err("subagent interaction source changed while awaiting response".to_string());
        }
        result
    }
}

#[async_trait]
impl UserQuestioner for AppServerQuestioner {
    fn supports_async_user_questions(&self) -> bool {
        !self.outbound_tx.is_closed()
    }

    async fn register_async_user_question(
        &self,
        state: &kcoder_state::AppState,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        request: kcoder_types::async_user_questions::AsyncQuestionRequest,
    ) -> std::result::Result<kcoder_types::async_user_questions::AsyncQuestionAccepted, String>
    {
        if !self.supports_async_user_questions() {
            return Err("asynchronous questions are unavailable".to_string());
        }
        let context = self
            .context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if context.as_ref().is_none_or(|context| {
            context.thread_id != state.session_id()
                || context.turn_id != request.source_turn_id
                || request.tool_call_id.trim().is_empty()
        }) {
            return Err(
                "asynchronous question source is no longer the active owned turn".to_string(),
            );
        }
        let accepted = state
            .register_async_question(owner, request)
            .map_err(|_| "asynchronous question could not be durably registered".to_string())?;
        let notification = notification(
            kcoder_app_protocol::method::ASYNC_QUESTION_CHANGED,
            kcoder_app_rpc_codec::encode(kcoder_app_protocol::AsyncQuestionChangedNotification {
                thread_id: accepted.question.thread_id.clone(),
                question: accepted.question.clone(),
            })
            .map_err(|_| "asynchronous question notification could not be encoded".to_string())?,
        );
        let _ = send(&self.outbound_tx, notification).await;
        Ok(accepted)
    }

    fn snapshot_agent_host(&self) -> Option<Arc<dyn UserQuestioner>> {
        if self.outbound_tx.is_closed() {
            return None;
        }
        let captured = self
            .context
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        let mut host = self.clone();
        host.context = Arc::new(StdMutex::new(Some(captured)));
        Some(Arc::new(host))
    }

    fn supports_agent_binding(&self) -> bool {
        !self.outbound_tx.is_closed()
            && self
                .context
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
    }

    fn bind_agent(
        &self,
        source: kcoder_types::SourceAgent,
        validate: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Option<Arc<dyn UserQuestioner>> {
        let captured = self
            .context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut host = self.clone();
        host.context = Arc::new(StdMutex::new(captured));
        Some(Arc::new(AppServerAgentQuestioner {
            host,
            source,
            validate,
        }))
    }

    async fn ask(
        &self,
        request: UserQuestionRequest,
    ) -> std::result::Result<UserQuestionResponse, String> {
        self.ask_agent(request, None, None).await
    }
}

impl AppServerQuestioner {
    async fn ask_agent(
        &self,
        request: UserQuestionRequest,
        source_agent: Option<kcoder_types::SourceAgent>,
        validate: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    ) -> std::result::Result<UserQuestionResponse, String> {
        let context = self
            .context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                "question was requested outside an active app-server turn".to_string()
            })?;
        let Some(request_id) = allocate_interaction_request_id(&self.next_id) else {
            return Err("app-server interaction request id space exhausted".to_string());
        };
        let question_id = format!("question-{request_id}");
        let app_server_epoch = self
            .receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .app_server_epoch
            .clone();
        let questions = request
            .questions
            .iter()
            .enumerate()
            .map(|(index, question)| Question {
                id: format!("question-{}", index + 1),
                header: question.header.clone(),
                prompt: question.question.clone(),
                options: question
                    .options
                    .iter()
                    .map(|option| QuestionOption {
                        label: option.label.clone(),
                        value: option.label.clone(),
                        description: option.description.clone(),
                        preview: option.preview.clone(),
                    })
                    .collect(),
                allows_freeform: true,
                multi_select: question.multi_select,
            })
            .collect::<Vec<_>>();
        let params = QuestionRequestParams {
            source_agent,
            server_id: context.server_id,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            question_id,
            app_server_epoch: Some(app_server_epoch.clone()),
            questions,
            annotations: request.annotations.clone(),
        };
        let resolved_question_id = params.question_id.clone();
        let resolved_thread_id = params.thread_id.clone();
        let resolved_turn_id = params.turn_id.clone();
        let (response_tx, response_rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request_id, response_tx);
        let request_frame = json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": method::QUESTION_REQUEST,
            "params": params,
        });
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .track_request(
                request_id,
                InteractionBinding {
                    interaction_id: resolved_question_id.clone(),
                    server_id: params.server_id.clone(),
                    thread_id: resolved_thread_id.clone(),
                    turn_id: resolved_turn_id.clone(),
                    kind: kcoder_app_protocol::InteractionStatusKindV1::Question,
                },
                request_frame.clone(),
            );
        let _owned_question = QuestionLease {
            host: self.clone(),
            request_id,
            question_id: resolved_question_id.clone(),
            thread_id: resolved_thread_id.clone(),
            turn_id: resolved_turn_id.clone(),
        };
        if self.outbound_tx.send(request_frame).await.is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            self.receipts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .forget_request(request_id);
            return Err("app-server connection closed while asking a question".to_string());
        }
        let mut response_rx = response_rx;
        let response = if let Some(validate) = validate {
            loop {
                tokio::select! {
                    response = &mut response_rx => break response,
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if !validate() {
                            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&request_id);
                            break Ok(Err("subagent question task/run was cancelled or replaced".to_string()));
                        }
                    }
                }
            }
        } else {
            response_rx.await
        };
        let reason = match &response {
            Ok(Ok(_)) => "client_response",
            Ok(Err(error)) if error == "the user cancelled the question request" => {
                "client_cancelled"
            }
            Ok(Err(_)) => "response_error",
            Err(_) => "cancelled",
        };
        let resolved = notification(
            method::QUESTION_RESOLVED,
            kcoder_app_rpc_codec::encode(QuestionResolvedParams {
                request_id,
                question_id: resolved_question_id,
                thread_id: resolved_thread_id,
                turn_id: resolved_turn_id,
                app_server_epoch: Some(app_server_epoch),
                reason: reason.into(),
            })
            .expect("question resolution serializes"),
        );
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record_terminal(request_id, resolved.clone());
        let _ = self.outbound_tx.send(resolved).await;
        let response = response.map_err(|_| "app-server question was cancelled".to_string())??;
        let mut answers = HashMap::new();
        for (index, question) in request.questions.iter().enumerate() {
            let id = format!("question-{}", index + 1);
            let selected = response
                .answers
                .get(&id)
                .map(|answer| answer.answers.join(", "))
                .unwrap_or_default();
            if !selected.trim().is_empty() {
                answers.insert(question.question.clone(), selected);
            }
        }
        let annotations = answer_lists::from_native_reply(
            response.annotations.or(request.annotations),
            request.questions.len(),
            &response.answers,
        );
        Ok(UserQuestionResponse {
            questions: request.questions,
            answers,
            annotations: Some(annotations),
        })
    }
}

/// Dropping an unfinished ask future retires only its original transport identity.
struct QuestionLease {
    host: AppServerQuestioner,
    request_id: u64,
    question_id: String,
    thread_id: String,
    turn_id: String,
}
impl Drop for QuestionLease {
    fn drop(&mut self) {
        self.host
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.request_id);
        let resolved = {
            let mut receipts = self.host.receipts.lock().unwrap_or_else(|e| e.into_inner());
            // Reply handoff can remove the sender before the ask future consumes
            // it. Only a recorded terminal receipt or a forgotten request ends
            // this lease; a missing sender alone does not prove settlement.
            if receipts.expected_binding(self.request_id).is_none() {
                return;
            }
            let resolved = notification(
                method::QUESTION_RESOLVED,
                json!({
                    "requestId": self.request_id, "questionId": self.question_id,
                    "threadId": self.thread_id, "turnId": self.turn_id,
                    "appServerEpoch": receipts.app_server_epoch, "reason": "cancelled"
                }),
            );
            receipts.record_terminal(self.request_id, resolved.clone());
            resolved
        };
        let _ = self.host.outbound_tx.try_send(resolved);
    }
}

#[cfg(test)]
mod source_question_tests {
    use super::*;

    fn setup() -> (AppServerQuestioner, mpsc::Receiver<Value>, Arc<AtomicBool>) {
        let (outbound_tx, outbound_rx) = mpsc::channel(8);
        let host = AppServerQuestioner {
            outbound_tx,
            pending: Arc::new(StdMutex::new(HashMap::new())),
            receipts: Arc::new(StdMutex::new(InteractionReceipts {
                app_server_epoch: "source-test-epoch".into(),
                ..InteractionReceipts::default()
            })),
            next_id: Arc::new(AtomicU64::new(42)),
            context: Arc::new(StdMutex::new(Some(QuestionContext {
                server_id: "server".into(),
                thread_id: "parent".into(),
                turn_id: "captured-turn".into(),
            }))),
        };
        (host, outbound_rx, Arc::new(AtomicBool::new(true)))
    }
    fn request() -> UserQuestionRequest {
        UserQuestionRequest {
            questions: vec![],
            answers: HashMap::new(),
            annotations: Some(json!({ "sourceAgent": { "agentId": "forged" } })),
        }
    }
    fn source() -> kcoder_types::SourceAgent {
        kcoder_types::SourceAgent {
            parent_session_id: "parent".into(),
            agent_id: "actual-agent".into(),
            background_run: None,
        }
    }
    #[tokio::test]
    async fn source_question_captures_parent_turn_and_cancels_exact_pending_identity() {
        let (host, mut outbound, valid) = setup();
        assert!(host.supports_agent_binding());
        let state = valid.clone();
        let bound = host
            .bind_agent(source(), Arc::new(move || state.load(Ordering::SeqCst)))
            .unwrap();
        // Ending/replacing the parent turn cannot rebind an already running child.
        *host.context.lock().unwrap() = None;
        assert!(!host.supports_agent_binding());
        assert!(bound.supports_agent_binding());
        let worker = tokio::spawn(async move { bound.ask(request()).await });
        let frame = tokio::time::timeout(Duration::from_secs(1), outbound.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame["params"]["sourceAgent"]["agentId"], "actual-agent");
        assert_eq!(frame["params"]["turnId"], "captured-turn");
        let app_server_epoch = frame["params"]["appServerEpoch"].as_str().unwrap();
        assert_eq!(app_server_epoch, "source-test-epoch");
        assert_eq!(host.pending.lock().unwrap().len(), 1);
        valid.store(false, Ordering::SeqCst);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), worker)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(host.pending.lock().unwrap().is_empty());
        let resolved = outbound.recv().await.unwrap();
        assert_eq!(resolved["method"], "question/resolved");
        assert_eq!(resolved["params"]["requestId"], 42);
        assert_eq!(resolved["params"]["appServerEpoch"], app_server_epoch);
        let status = host.receipts.lock().unwrap().read_status(
            &kcoder_app_protocol::InteractionStatusReadParamsV1 {
                server_id: "server".into(),
                thread_id: "parent".into(),
                turn_id: "captured-turn".into(),
                request_id: 42,
                app_server_epoch: app_server_epoch.into(),
                kind: kcoder_app_protocol::InteractionStatusKindV1::Question,
                approval_id: None,
                question_id: Some("question-42".into()),
            },
            None,
        );
        assert_eq!(status, kcoder_app_protocol::InteractionStatusV1::Resolved);
    }
    #[tokio::test]
    async fn cancelled_source_question_future_releases_its_own_pending_request() {
        let (host, mut outbound, _) = setup();
        let bound = host.bind_agent(source(), Arc::new(|| true)).unwrap();
        let worker = tokio::spawn(async move { bound.ask(request()).await });
        let frame = outbound.recv().await.unwrap();
        worker.abort();
        let _ = worker.await;
        assert!(host.pending.lock().unwrap().is_empty());
        let resolved = outbound.recv().await.unwrap();
        assert_eq!(resolved["params"]["reason"], "cancelled");
        assert_eq!(
            resolved["params"]["appServerEpoch"],
            frame["params"]["appServerEpoch"]
        );
        assert_eq!(
            host.receipts.lock().unwrap().read_status(
                &kcoder_app_protocol::InteractionStatusReadParamsV1 {
                    server_id: "server".into(),
                    thread_id: "parent".into(),
                    turn_id: "captured-turn".into(),
                    request_id: frame["id"].as_u64().unwrap(),
                    app_server_epoch: frame["params"]["appServerEpoch"].as_str().unwrap().into(),
                    kind: kcoder_app_protocol::InteractionStatusKindV1::Question,
                    approval_id: None,
                    question_id: Some(frame["params"]["questionId"].as_str().unwrap().into()),
                },
                None,
            ),
            kcoder_app_protocol::InteractionStatusV1::Resolved,
        );
    }
    #[tokio::test]
    async fn early_delegation_snapshot_binds_only_original_parent_after_async_delay() {
        let (host, mut outbound, valid) = setup();
        let captured = host.snapshot_agent_host().unwrap();
        *host.context.lock().unwrap() = None;
        assert!(host.snapshot_agent_host().is_none());
        let check = valid.clone();
        let bound = captured
            .bind_agent(source(), Arc::new(move || check.load(Ordering::SeqCst)))
            .unwrap();
        assert!(bound.supports_agent_binding());
        let worker = tokio::spawn(async move { bound.ask(request()).await });
        let frame = outbound.recv().await.unwrap();
        assert_eq!(frame["params"]["turnId"], "captured-turn");
        assert_eq!(frame["params"]["sourceAgent"]["agentId"], "actual-agent");
        valid.store(false, Ordering::SeqCst);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), worker)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(host.pending.lock().unwrap().is_empty());
        let mut other = source();
        other.parent_session_id = "other-parent".into();
        let wrong = captured.bind_agent(other, Arc::new(|| true)).unwrap();
        assert!(!wrong.supports_agent_binding());
        assert!(wrong.ask(request()).await.is_err());
    }
    #[tokio::test]
    async fn delegation_snapshot_never_reuses_a_closed_owner_sender() {
        let (host, outbound, _) = setup();
        let captured = host.snapshot_agent_host().unwrap();
        drop(outbound);
        assert!(!captured.supports_agent_binding());
        assert!(captured.snapshot_agent_host().is_none());
        let bound = captured.bind_agent(source(), Arc::new(|| true)).unwrap();
        assert!(!bound.supports_agent_binding());
        assert!(bound.ask(request()).await.is_err());
        assert!(host.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stale_source_and_cross_parent_are_refused_before_request() {
        let (host, mut outbound, _) = setup();
        let bound = host.bind_agent(source(), Arc::new(|| false)).unwrap();
        assert!(bound.ask(request()).await.is_err());
        let mut other = source();
        other.parent_session_id = "other-parent".into();
        let bound = host.bind_agent(other, Arc::new(|| true)).unwrap();
        assert!(bound.ask(request()).await.is_err());
        assert!(outbound.try_recv().is_err());
        assert!(host.pending.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod interaction_request_id_tests {
    use super::*;

    #[test]
    fn shared_allocator_keeps_approval_and_question_ids_unique_in_one_receipt_store() {
        let allocator = Arc::new(AtomicU64::new(1_000_000));
        let approval_id = allocate_interaction_request_id(&allocator).unwrap();
        let question_id = allocate_interaction_request_id(&allocator).unwrap();
        assert_ne!(approval_id, question_id);

        let mut receipts = InteractionReceipts::default();
        for (request_id, kind, name) in [
            (
                approval_id,
                kcoder_app_protocol::InteractionStatusKindV1::Approval,
                "approval",
            ),
            (
                question_id,
                kcoder_app_protocol::InteractionStatusKindV1::Question,
                "question",
            ),
        ] {
            receipts.track_request(
                request_id,
                InteractionBinding {
                    interaction_id: format!("{name}-{request_id}"),
                    server_id: "server-1".into(),
                    thread_id: "thread-1".into(),
                    turn_id: "turn-1".into(),
                    kind,
                },
                json!({"method":name}),
            );
        }
        assert_eq!(receipts.outstanding_len(), 2);
        assert!(receipts.outstanding_request(approval_id).is_some());
        assert!(receipts.outstanding_request(question_id).is_some());
    }

    #[test]
    fn shared_allocator_fails_closed_instead_of_wrapping() {
        let allocator = AtomicU64::new(u64::MAX);
        assert_eq!(allocate_interaction_request_id(&allocator), None);
        assert_eq!(allocate_interaction_request_id(&allocator), None);
        assert_eq!(allocator.load(Ordering::Relaxed), u64::MAX);
    }
}

#[cfg(test)]
mod interaction_status_read_tests {
    use super::*;
    use kcoder_app_protocol::{InteractionStatusKindV1, InteractionStatusV1};

    fn selector() -> kcoder_app_protocol::InteractionStatusReadParamsV1 {
        kcoder_app_protocol::InteractionStatusReadParamsV1 {
            server_id: "server-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            request_id: 1_000_001,
            app_server_epoch: "epoch-1".into(),
            kind: InteractionStatusKindV1::Approval,
            approval_id: Some("approval-1000001".into()),
            question_id: None,
        }
    }

    #[test]
    fn status_rpc_requires_negotiation_and_echoes_the_exact_selector() {
        let mut receipts = InteractionReceipts {
            app_server_epoch: "epoch-1".into(),
            ..InteractionReceipts::default()
        };
        let selector = selector();
        receipts.track_request(
            selector.request_id,
            InteractionBinding {
                interaction_id: selector.approval_id.clone().unwrap(),
                server_id: selector.server_id.clone(),
                thread_id: selector.thread_id.clone(),
                turn_id: selector.turn_id.clone(),
                kind: selector.kind,
            },
            json!({
                "jsonrpc":"2.0",
                "id":selector.request_id,
                "method":"approval/request",
                "params":{
                    "serverId":selector.server_id,
                    "threadId":selector.thread_id,
                    "turnId":selector.turn_id,
                    "approvalId":selector.approval_id,
                    "appServerEpoch":selector.app_server_epoch
                }
            }),
        );
        assert_eq!(
            read_interaction_status(false, json!({}), &receipts, |_| panic!(
                "unsupported method must not inspect runtime state"
            )),
            Err(InteractionStatusReadError::Unsupported),
        );

        let result = read_interaction_status(
            true,
            serde_json::to_value(&selector).unwrap(),
            &receipts,
            |_| Some(true),
        )
        .unwrap();
        assert_eq!(result.status, InteractionStatusV1::Pending);
        assert_eq!(result.server_id, selector.server_id);
        assert_eq!(result.thread_id, selector.thread_id);
        assert_eq!(result.turn_id, selector.turn_id);
        assert_eq!(result.request_id, selector.request_id);
        assert_eq!(result.app_server_epoch, selector.app_server_epoch);
        assert_eq!(result.kind, selector.kind);
        assert_eq!(result.approval_id, selector.approval_id);
        assert_eq!(result.question_id, selector.question_id);

        let mut wrong_server = selector.clone();
        wrong_server.server_id = "another-server".into();
        let mut wrong_thread = selector.clone();
        wrong_thread.thread_id = "another-thread".into();
        let mut wrong_turn = selector.clone();
        wrong_turn.turn_id = "another-turn".into();
        let mut wrong_request = selector.clone();
        wrong_request.request_id += 1;
        let mut wrong_epoch = selector.clone();
        wrong_epoch.app_server_epoch = "another-epoch".into();
        let mut wrong_kind = selector.clone();
        wrong_kind.kind = InteractionStatusKindV1::Question;
        wrong_kind.approval_id = None;
        wrong_kind.question_id = Some("question-1000001".into());
        let mut wrong_interaction_id = selector;
        wrong_interaction_id.approval_id = Some("approval-other".into());
        for mismatch in [
            wrong_server,
            wrong_thread,
            wrong_turn.clone(),
            wrong_request,
            wrong_epoch,
            wrong_kind,
            wrong_interaction_id,
        ] {
            let result = read_interaction_status(
                true,
                serde_json::to_value(&mismatch).unwrap(),
                &receipts,
                |_| Some(true),
            )
            .unwrap();
            assert_eq!(result.status, InteractionStatusV1::Unknown);
        }
    }

    #[test]
    fn status_rpc_rejects_invalid_selectors_without_reading_runtime_state() {
        let receipts = InteractionReceipts::default();
        assert_eq!(
            read_interaction_status(true, json!({"answer":"secret"}), &receipts, |_| panic!(
                "invalid params must not inspect runtime state"
            )),
            Err(InteractionStatusReadError::InvalidParams),
        );
    }
}
