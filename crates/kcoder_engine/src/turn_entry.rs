//! Turn entry within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    /// Answer one isolated `/btw` side question without mutating the main
    /// conversation or exposing tools to the side request.
    ///
    /// The preferred context is the cache-safe snapshot captured for the
    /// current provider/model. Before the first request boundary, or after a
    /// runtime switch, fall back to a repaired compact-aware snapshot of the
    /// live conversation. The caller owns cancellation so dismissing the side
    /// question never cancels the main turn.
    pub async fn run_side_question(
        &self,
        question: &str,
        cancel_token: CancellationToken,
    ) -> anyhow::Result<String> {
        let question = question.trim();
        if question.is_empty() {
            anyhow::bail!("side question must not be empty");
        }

        let (model, max_tokens, reasoning_effort) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings.model.clone(),
                settings
                    .max_tokens
                    .unwrap_or(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS),
                settings
                    .model_capabilities
                    .reasoning
                    .then(|| settings.model_reasoning_effort.clone())
                    .flatten(),
            )
        };
        let provider_name = self.provider_name();
        let mut messages: kcoder_types::SharedMessages = self
            .cache_safe_snapshot()
            .filter(|snapshot| {
                snapshot.full_context_compatible
                    && snapshot.snapshot_provider == provider_name
                    && snapshot.snapshot_model == model
            })
            .map(|snapshot| snapshot.fork_context_messages.clone())
            .unwrap_or_else(|| {
                message_repair::prepare_shared_request_messages(
                    self.state.shared_messages_with_revision().0,
                )
                .0
            });
        self.prepend_project_user_context(&mut messages);
        messages.push(Message::user_text(format_side_question_prompt(question)));

        let system_prompt = build_side_question_system_prompt(&self.cwd, &model);

        let request = MessagesRequest::new_shared(model, messages)
            .with_system(system_prompt)
            // Deliberately omit tool definitions. `/btw` is one informational
            // response, not a second agentic loop.
            .with_max_tokens(max_tokens)
            .with_reasoning_effort(reasoning_effort)
            .with_debug_session_id(self.state.session_id());
        let response = collect_provider_text(self.current_provider(), request, cancel_token)
            .await?
            .trim()
            .to_string();
        if response.is_empty() {
            anyhow::bail!("no response received for side question");
        }
        Ok(response)
    }

    /// Append a user message and run a single turn as a live event stream.
    ///
    /// Prompt-submit hooks and memory prompt recording happen before the model
    /// turn begins, preserving the semantics of [`Self::submit_message`] while
    /// allowing headless and UI callers to consume progress immediately.
    pub fn submit_message_stream<'a, P: PermissionPrompt>(
        &'a self,
        text: impl Into<String>,
        permissions: &'a P,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        let text = text.into();
        self.submit_message_content_stream(Message::user_text(text.clone()), text, permissions)
    }

    /// Append a user message with structured content and run one live event stream.
    /// Prompt text is used for UserPromptSubmit hooks and memory records, while
    /// structured blocks such as images are preserved for the provider request.
    pub fn submit_message_content_stream<'a, P: PermissionPrompt>(
        &'a self,
        message: Message,
        prompt_text: impl Into<String>,
        permissions: &'a P,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        let prompt_text = prompt_text.into();
        Box::pin(stream! {
            if self.input_persistence_failed.load(Ordering::Acquire) {
                yield EngineEvent::Error("Input durability is uncertain; reload this session before sending another message.".into());
                return;
            }
            // This API submits a new user turn. Raw run_turn_stream callers may
            // be continuing a failed turn and must retain their semantic snapshot.
            if let Err(error) = self.prepare_client_model_for_turn(None, false) {
                yield EngineEvent::Error(format!("Cannot prepare selected model: {error}"));
                return;
            }
            let (hook_events, modified_text, blocking_error) =
                self.run_user_prompt_submit_hooks(&prompt_text).await;
            for event in hook_events {
                yield event;
            }

            if let Some(error) = blocking_error {
                yield EngineEvent::HookMessage {
                    text: error.clone(),
                    is_error: true,
                };
                yield EngineEvent::Error(format!("user prompt submit hook blocked the turn: {error}"));
                return;
            }

            let text = modified_text.unwrap_or(prompt_text);
            let prompt_number = self.next_memory_prompt_number();
            let prompt_text = text.clone();
            self.state
                .add_message(Self::replace_user_message_text(message, text).with_origin(kcoder_types::MessageOrigin::User));
            // The accepted input must survive a process crash before the first
            // assistant checkpoint. Do not publish acceptance or call a model
            // when the owned history writer cannot commit the input.
            if self.state.flush_history().await.is_err() {
                self.input_persistence_failed.store(true, Ordering::Release);
                yield EngineEvent::Error("Input durability is uncertain; no model request was sent. Reload this session before continuing.".into());
                return;
            }
            yield EngineEvent::UserMessageAdded;
            self.record_user_prompt(prompt_number, &prompt_text);

            let mut turn_stream = self.run_turn_stream(permissions);
            while let Some(event) = turn_stream.next().await {
                yield event;
            }
        })
    }

    /// Append a user message and run a single turn, returning all engine events.
    pub async fn submit_message<P: PermissionPrompt>(
        &self,
        text: impl Into<String>,
        permissions: &P,
    ) -> Vec<EngineEvent> {
        self.submit_message_stream(text, permissions)
            .collect()
            .await
    }

    pub(super) fn replace_user_message_text(message: Message, text: String) -> Message {
        match message {
            Message::User {
                mut content,
                origin,
            } => {
                if let Some(block) = content
                    .iter_mut()
                    .find(|block| matches!(block, ContentBlock::Text { .. }))
                {
                    *block = ContentBlock::Text { text };
                } else {
                    content.insert(0, ContentBlock::Text { text });
                }
                Message::User { content, origin }
            }
            Message::Assistant { .. } => Message::user_text(text),
        }
    }

    /// Run a single turn and return a stream of engine events.
    ///
    /// The caller is responsible for having already added the user message to
    /// [`AppState`]. This stream yields text deltas, tool-use events, tool
    /// results, and terminal events as they happen.
    ///
    /// When a tool call fails (bad arguments, execution error, or permission
    /// denied), the engine automatically re-invokes the model with the error
    /// result so it can correct itself, up to the configured retry limit.
    pub fn run_turn_stream<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_max_turns(prompt, MAX_AGENT_TURNS)
    }

    /// Run a single turn with a caller-provided cancellation token.
    ///
    /// This allows the UI to cancel an individual turn without affecting the
    /// global engine cancellation state.
    pub fn run_turn_stream_with_cancel<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        cancel_token: CancellationToken,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            cancel_token,
            MAX_AGENT_TURNS,
            None,
            None,
        )
    }

    /// Run a regular turn using a steering session created by the caller before task scheduling.
    pub fn run_turn_stream_with_cancel_and_steering<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        cancel_token: CancellationToken,
        steer_session: TurnSteerSession,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            cancel_token,
            MAX_AGENT_TURNS,
            None,
            Some(steer_session),
        )
    }

    /// Execute a user-entered shell command through the normal tool pipeline.
    ///
    /// This is used by TUI `!cmd` prompts. It deliberately reuses
    /// `execute_tool` so permissions, hooks, sandbox escalation, output limits,
    /// and lifecycle events stay aligned with model-initiated shell tools.
    pub async fn run_user_shell_command<P: PermissionPrompt>(
        &self,
        command: String,
        prompt: &P,
        cancel_token: CancellationToken,
    ) -> Vec<EngineEvent> {
        let engine = self.clone().with_cancel_token(cancel_token.clone());
        let tool_name = if cfg!(windows) { "PowerShell" } else { "bash" };
        let tool_id = format!("user-shell-{}", monotonic_millis());
        let input = serde_json::json!({
            "command": command,
            "description": "User shell command",
        });

        let mut events = vec![EngineEvent::ToolUseStarted {
            id: tool_id.clone(),
            name: tool_name.to_string(),
            input: input.clone(),
        }];
        let result = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                events.push(EngineEvent::StreamAborted {
                    reason: "cancelled by user".into(),
                });
                events.push(EngineEvent::ToolResult {
                    id: tool_id.clone(),
                    name: tool_name.to_string(),
                    output: ToolOutput::error("Tool call was interrupted by the user."),
                });
                return events;
            }
            result = engine.execute_tool(&tool_id, tool_name, input, prompt) => result,
        };

        match result {
            Ok((output, _decision, _modified_input, hook_events)) => {
                events.extend(hook_events);
                events.push(EngineEvent::ToolResult {
                    id: tool_id,
                    name: tool_name.to_string(),
                    output,
                });
            }
            Err(error) => {
                events.push(EngineEvent::ToolResult {
                    id: tool_id,
                    name: tool_name.to_string(),
                    output: ToolOutput::error(format!("Error: {error}")),
                });
            }
        }
        events
    }

    /// Run a single turn with an explicit maximum number of model/tool cycles.
    ///
    /// This is primarily used by forked sub-agents, whose caller-provided
    /// `max_turns` must be enforced instead of the main-loop safeguard.
    pub fn run_turn_stream_with_max_turns<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        max_turns: usize,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            self.cancel_token.clone(),
            max_turns,
            None,
            None,
        )
    }

    pub(crate) fn run_turn_stream_with_subagent_finish_reminders<'a, P: PermissionPrompt>(
        &self,
        prompt: &'a P,
        max_turns: usize,
        agent_id: impl Into<String>,
    ) -> Pin<Box<dyn Stream<Item = EngineEvent> + Send + 'a>> {
        self.run_turn_stream_with_cancel_and_max_turns(
            prompt,
            self.cancel_token.clone(),
            max_turns,
            Some(SubagentFinishReminder::new(agent_id.into())),
            None,
        )
    }
}
