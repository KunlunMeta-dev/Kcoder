//! Interaction requests: extracted from the app-server connection boundary.

use super::*;

pub(super) fn approval_response_timeout() -> Duration {
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

#[cfg(any(debug_assertions, test))]
pub(super) fn parse_e2e_approval_timeout(raw: Option<&str>) -> Option<Duration> {
    let milliseconds = raw?.parse::<u64>().ok()?;
    (10..=30_000)
        .contains(&milliseconds)
        .then(|| Duration::from_millis(milliseconds))
}

#[async_trait]
impl PermissionPrompt for AppServerPermissionPrompt {
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
            return HeadlessPermissionPrompt { mode: self.mode }
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
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let approval_id = format!("approval-{request_id}");
        let params = ApprovalRequestParams {
            server_id: context.server_id,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            approval_id,
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
                    thread_id: params.thread_id.clone(),
                    turn_id: params.turn_id.clone(),
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
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .forget_request(request_id);
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
            serde_json::to_value(ApprovalResolvedParams {
                request_id,
                approval_id: resolved_approval_id,
                thread_id: resolved_thread_id,
                turn_id: resolved_turn_id,
                decision,
                reason: reason.into(),
            })
            .expect("approval resolution serializes"),
        );
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(request_id, resolved.clone());
        let _ = self.outbound_tx.send(resolved).await;
        permission
    }
}

impl AppServerPermissionPrompt {
    pub(super) fn persist_decision(&self, artifact: ApprovalDecisionArtifact) -> Result<()> {
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

pub(super) fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(super) fn approval_action_for(request: &PermissionRequestContext) -> ApprovalAction {
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

pub(super) fn resolve_server_response(
    response: &Value,
    pending_approvals: &PendingApprovalResponses,
    pending_questions: &PendingQuestionResponses,
    receipts: &Arc<StdMutex<InteractionReceipts>>,
    require_binding: bool,
) -> InteractionReply {
    let Some(request_id) = response.get("id").and_then(Value::as_u64) else {
        return InteractionReply::Unmatched;
    };
    // A connection that negotiated `interactionBindingV1` must name the
    // interaction, so a transport id issued by an earlier connection generation
    // can never be applied to a new turn. An error frame carries no decision and
    // can only fail the interaction, so it stays accepted without a binding.
    let expected = receipts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .expected_binding(request_id)
        .cloned();
    let error_frame = response.get("error").is_some();
    let verify = |reply: ReplyBinding| match (&expected, require_binding, error_frame) {
        (Some(expected), true, false) => reply.matches(expected),
        _ => true,
    };

    if pending_approvals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(&request_id)
    {
        let parsed = if let Some(error) = response.get("error") {
            Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("approval request failed")
                .to_string())
        } else {
            match serde_json::from_value::<ApprovalResponse>(
                response.get("result").cloned().unwrap_or(Value::Null),
            ) {
                Ok(reply) => {
                    if !verify(ReplyBinding::from(&reply)) {
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
        let parsed = if let Some(error) = response.get("error") {
            Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("question request failed")
                .to_string())
        } else {
            match serde_json::from_value::<QuestionResponse>(
                response.get("result").cloned().unwrap_or(Value::Null),
            ) {
                Ok(reply) => {
                    if !verify(ReplyBinding::from(&reply)) {
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
    pub(super) fn tap_invalid(self, error: &impl std::fmt::Display) -> Self {
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
    pub(super) fn matches(&self, expected: &InteractionBinding) -> bool {
        self.interaction_id == Some(expected.interaction_id.as_str())
            && self.thread_id == Some(expected.thread_id.as_str())
            && self.turn_id == Some(expected.turn_id.as_str())
    }
}

pub(super) fn deliver_approval_response(
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

pub(super) fn deliver_question_response(
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
    /// Registers an interaction that is now waiting for a reply.
    pub(super) fn track_request(
        &mut self,
        request_id: u64,
        binding: InteractionBinding,
        request: Value,
    ) {
        self.outstanding
            .insert(request_id, OutstandingInteraction { binding, request });
    }

    /// Drops an interaction that ended without a terminal answer to replay
    /// (timeout or closed connection); no receipt is kept for it.
    pub(super) fn forget_request(&mut self, request_id: u64) {
        self.outstanding.remove(&request_id);
    }

    pub(super) fn expected_binding(&self, request_id: u64) -> Option<&InteractionBinding> {
        self.outstanding
            .get(&request_id)
            .map(|entry| &entry.binding)
    }

    pub(super) fn outstanding_request(&self, request_id: u64) -> Option<Value> {
        self.outstanding
            .get(&request_id)
            .map(|entry| entry.request.clone())
    }

    pub(super) fn note_misattributed(&mut self) {
        self.misattributed_replies = self.misattributed_replies.saturating_add(1);
    }

    pub(super) fn record(&mut self, request_id: u64, notification: Value) {
        self.outstanding.remove(&request_id);
        while self.resolved.len() >= INTERACTION_RECEIPT_LIMIT {
            self.resolved.pop_front();
        }
        self.resolved.push_back((request_id, notification));
    }

    /// Returns the terminal answer already sent for `request_id`, if any.
    pub(super) fn replay(&mut self, request_id: u64) -> Option<Value> {
        let found = self
            .resolved
            .iter()
            .find(|(id, _)| *id == request_id)
            .map(|(_, notification)| notification.clone());
        if found.is_some() {
            self.duplicate_replies = self.duplicate_replies.saturating_add(1);
        }
        found
    }

    pub(super) fn note_unmatched(&mut self) {
        self.unmatched_replies = self.unmatched_replies.saturating_add(1);
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.resolved.len()
    }

    #[cfg(test)]
    pub(super) fn counters(&self) -> (u64, u64) {
        (self.duplicate_replies, self.unmatched_replies)
    }

    #[cfg(test)]
    pub(super) fn outstanding_len(&self) -> usize {
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
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let question_id = format!("question-{request_id}");
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
                    thread_id: resolved_thread_id.clone(),
                    turn_id: resolved_turn_id.clone(),
                },
                request_frame.clone(),
            );
        let _owned_question = validate.as_ref().map(|_| SourceQuestionLease {
            host: self.clone(),
            request_id,
            question_id: resolved_question_id.clone(),
            thread_id: resolved_thread_id.clone(),
            turn_id: resolved_turn_id.clone(),
        });
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
            Ok(Err(error)) if error == "the user cancelled the question request" => "cancelled",
            Ok(Err(_)) => "response_error",
            Err(_) => "cancelled",
        };
        let resolved = notification(
            method::QUESTION_RESOLVED,
            serde_json::to_value(QuestionResolvedParams {
                request_id,
                question_id: resolved_question_id,
                thread_id: resolved_thread_id,
                turn_id: resolved_turn_id,
                reason: reason.into(),
            })
            .expect("question resolution serializes"),
        );
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(request_id, resolved.clone());
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
        Ok(UserQuestionResponse {
            questions: request.questions,
            answers,
            annotations: response.annotations.or(request.annotations),
        })
    }
}

/// Dropping a cancelled worker's ask future releases only its own transport identity.
struct SourceQuestionLease {
    host: AppServerQuestioner,
    request_id: u64,
    question_id: String,
    thread_id: String,
    turn_id: String,
}
impl Drop for SourceQuestionLease {
    fn drop(&mut self) {
        let removed = self
            .host
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.request_id);
        if removed.is_none() {
            return;
        }
        let resolved = notification(
            method::QUESTION_RESOLVED,
            json!({
                "requestId": self.request_id, "questionId": self.question_id,
                "threadId": self.thread_id, "turnId": self.turn_id, "reason": "cancelled"
            }),
        );
        self.host
            .receipts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .record(self.request_id, resolved.clone());
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
            receipts: Arc::new(StdMutex::new(InteractionReceipts::default())),
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
    }
    #[tokio::test]
    async fn cancelled_source_question_future_releases_its_own_pending_request() {
        let (host, mut outbound, _) = setup();
        let bound = host.bind_agent(source(), Arc::new(|| true)).unwrap();
        let worker = tokio::spawn(async move { bound.ask(request()).await });
        outbound.recv().await.unwrap();
        worker.abort();
        let _ = worker.await;
        assert!(host.pending.lock().unwrap().is_empty());
        assert_eq!(
            outbound.recv().await.unwrap()["params"]["reason"],
            "cancelled"
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
