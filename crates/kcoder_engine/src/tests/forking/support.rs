use super::*;

pub(super) fn request_preview(request: &MessagesRequest) -> String {
    request
        .messages
        .iter()
        .map(|message| message.preview(12_000))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn subagent_finish_reminder_count(request: &MessagesRequest) -> usize {
    request
        .messages
        .iter()
        .filter(|message| {
            message
                .preview(2000)
                .contains("[system][subagent_finish_reminder]")
        })
        .count()
}

#[derive(Debug)]
pub(super) struct RecordingProvider {
    pub(super) name: &'static str,
    pub(super) request: Arc<Mutex<Option<MessagesRequest>>>,
}

impl Provider for RecordingProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        *self.request.lock().unwrap() = Some(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text: "hi".to_string() },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct MultiRecordingProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
    pub(super) outputs: Mutex<VecDeque<String>>,
}

impl Provider for MultiRecordingProvider {
    fn name(&self) -> &'static str {
        "multi-recording"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let output = self
            .outputs
            .lock()
            .unwrap()
            .pop_front()
            .expect("one provider output per verifier session");
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta { text: output },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct GatedSubagentSteerProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
    pub(super) calls: AtomicUsize,
    pub(super) first_response_started: Arc<Notify>,
    pub(super) release_first_response: Arc<Notify>,
}

#[derive(Debug)]
pub(super) struct FailBeforeCheckpointWriter;

#[async_trait::async_trait]
impl SubagentCheckpointWriter for FailBeforeCheckpointWriter {
    async fn write(&self, _path: &Path, _messages: &[Message]) -> anyhow::Result<()> {
        anyhow::bail!("injected checkpoint failure before commit")
    }
}

#[derive(Debug)]
pub(super) struct CrashAfterCheckpointWriter;

#[async_trait::async_trait]
impl SubagentCheckpointWriter for CrashAfterCheckpointWriter {
    async fn write(&self, path: &Path, messages: &[Message]) -> anyhow::Result<()> {
        crate::agent::write_transcript_checkpoint(path, messages).await?;
        panic!("injected process exit after checkpoint and before ack")
    }
}

pub(super) fn with_subagent_checkpoint_writer(
    mut engine: QueryEngine,
    writer: Arc<dyn SubagentCheckpointWriter>,
) -> QueryEngine {
    let control = engine
        .subagent_runtime_control
        .as_ref()
        .as_ref()
        .expect("sub-agent runtime control must be configured before its checkpoint writer");
    engine.subagent_runtime_control = Arc::new(Some(SubagentRuntimeControl {
        parent_state: control.parent_state.clone(),
        agent_id: control.agent_id.clone(),
        transcript_path: control.transcript_path.clone(),
        checkpoint_writer: writer,
    }));
    engine
}

impl Provider for GatedSubagentSteerProvider {
    fn name(&self) -> &'static str {
        "gated-subagent-steer"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(request);
        let first_response_started = Arc::clone(&self.first_response_started);
        let release_first_response = Arc::clone(&self.release_first_response);
        let stream = async_stream::stream! {
            if call == 0 {
                first_response_started.notify_one();
                release_first_response.notified().await;
            }
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: if call == 0 { "before steer" } else { "after steer" }.to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct ToolThenSteerProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
    pub(super) calls: AtomicUsize,
}

#[derive(Debug)]
pub(super) struct TwoAgentSteerProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
    pub(super) first_requests_started: AtomicUsize,
    pub(super) both_first_requests_started: Arc<Notify>,
    pub(super) release_first_requests: Arc<Notify>,
}

impl Provider for TwoAgentSteerProvider {
    fn name(&self) -> &'static str {
        "two-agent-steer"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let preview = request_preview(&request);
        let contains_steer = preview.contains("target-only-steer-sentinel");
        self.requests.lock().unwrap().push(request);
        let started = self
            .first_requests_started
            .fetch_add(usize::from(!contains_steer), Ordering::SeqCst);
        let both_started = Arc::clone(&self.both_first_requests_started);
        let release = Arc::clone(&self.release_first_requests);
        let stream = async_stream::stream! {
            if !contains_steer {
                if started + 1 == 2 {
                    both_started.notify_one();
                }
                release.notified().await;
            }
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text { text: String::new() },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: if contains_steer {
                        "target adjusted"
                    } else {
                        "initial child response"
                    }.to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

impl Provider for ToolThenSteerProvider {
    fn name(&self) -> &'static str {
        "tool-then-steer"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            if call == 0 {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "steer-tool-1".to_string(),
                        name: "gated_read".to_string(),
                        input: serde_json::json!({}),
                    },
                });
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 1,
                    content_block: ContentBlock::ToolUse {
                        id: "steer-tool-2".to_string(),
                        name: "failing_read".to_string(),
                        input: serde_json::json!({}),
                    },
                });
            } else {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text { text: String::new() },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "after tool steer".to_string(),
                    },
                });
            }
            yield Ok(StreamEvent::ContentBlockStop { index: if call == 0 { 1 } else { 0 } });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct ForkSessionMemoryCountingProvider {
    pub(super) session_memory_requests: Arc<AtomicUsize>,
}

impl Provider for ForkSessionMemoryCountingProvider {
    fn name(&self) -> &'static str {
        "fork-session-memory-counting"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let is_session_memory_update = request
            .messages
            .first()
            .map(|message| {
                message
                    .preview(20_000)
                    .contains("internal session-memory maintenance task")
            })
            .unwrap_or(false);
        if is_session_memory_update {
            self.session_memory_requests.fetch_add(1, Ordering::SeqCst);
            let memory = DEFAULT_SESSION_MEMORY_TEMPLATE.replace(
                "# Current State",
                "# Current State\n\nFork memory should not be written.",
            );
            let stream = async_stream::stream! {
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: format!("<session_memory>{memory}</session_memory>"),
                    },
                });
                yield Ok(StreamEvent::MessageStop);
            };
            return Ok(Box::pin(stream));
        }

        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::TextDelta {
                    text: "hi".to_string(),
                },
            });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct ToolUseProvider;

impl Provider for ToolUseProvider {
    fn name(&self) -> &'static str {
        "tool-use"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "missing_tool".to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
pub(super) struct HangingReadTool {
    pub(super) started: Arc<Notify>,
}

#[derive(Debug)]
pub(super) struct GatedSteerTool {
    pub(super) started: Arc<Notify>,
    pub(super) release: Arc<Notify>,
}

#[derive(Debug)]
pub(super) struct LargeVerifierOutputTool;

#[async_trait::async_trait]
impl kcoder_tools::Tool for LargeVerifierOutputTool {
    fn name(&self) -> String {
        "bash".to_string()
    }

    fn description(&self) -> String {
        "test-only large verifier output".to_string()
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Ok(kcoder_tools::ToolOutput::error(format!(
            "exit_code: 1\n{}\nFAILED tests/test_issue.py::test_regression - AssertionError",
            "x".repeat(60_000)
        )))
    }
}

#[derive(Debug)]
pub(super) struct ForbiddenFinalTool {
    pub(super) calls: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for ForbiddenFinalTool {
    fn name(&self) -> String {
        "missing_tool".to_string()
    }

    fn description(&self) -> String {
        "最终 verifier 判词轮绝不能执行的测试工具".to_string()
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(kcoder_tools::ToolOutput::text("must not run"))
    }
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for HangingReadTool {
    fn name(&self) -> String {
        "missing_tool".to_string()
    }

    fn description(&self) -> String {
        "test-only hanging read".to_string()
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        self.started.notify_one();
        std::future::pending().await
    }
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for GatedSteerTool {
    fn name(&self) -> String {
        "gated_read".to_string()
    }

    fn description(&self) -> String {
        "用于验证 steer 工具批次边界的只读测试工具".to_string()
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        self.started.notify_one();
        self.release.notified().await;
        Ok(kcoder_tools::ToolOutput::text(
            "tool completed before steer",
        ))
    }
}

#[derive(Debug)]
pub(super) struct FailingSteerTool;

#[async_trait::async_trait]
impl kcoder_tools::Tool for FailingSteerTool {
    fn name(&self) -> String {
        "failing_read".to_string()
    }

    fn description(&self) -> String {
        "用于验证并行工具失败仍保持完整批次边界".to_string()
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type": "object"})
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn call(
        &self,
        _input: serde_json::Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        Err(kcoder_tools::ToolError::Execution(
            "injected parallel tool failure".to_string(),
        ))
    }
}

#[derive(Debug)]
pub(super) struct RepeatingToolUseProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

#[derive(Debug)]
pub(super) struct TerminalVerdictProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

#[derive(Debug)]
pub(super) struct LargeVerifierOutputProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

#[derive(Debug)]
pub(super) struct IgnoresTerminalBoundaryProvider {
    pub(super) requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for IgnoresTerminalBoundaryProvider {
    fn name(&self) -> &'static str {
        "ignores-terminal-boundary"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: "PASS\nFocused target suite exited 0.".to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 1,
                content_block: ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "missing_tool".to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 1 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

impl Provider for TerminalVerdictProvider {
    fn name(&self) -> &'static str {
        "terminal-verdict"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let terminal = request.tools.is_empty();
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            if terminal {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text { text: String::new() },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "FLAKY\nEvidence remained insufficient at the final boundary.".to_string(),
                    },
                });
            } else {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "tool-1".to_string(),
                        name: "missing_tool".to_string(),
                        input: serde_json::json!({}),
                    },
                });
            }
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

impl Provider for LargeVerifierOutputProvider {
    fn name(&self) -> &'static str {
        "large-verifier-output"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        let terminal = request.tools.is_empty();
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            if terminal {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text { text: String::new() },
                });
                yield Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "FLAKY\nEvidence remained insufficient at the final boundary.".to_string(),
                    },
                });
            } else {
                yield Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: "tool-1".to_string(),
                        name: "bash".to_string(),
                        input: serde_json::json!({}),
                    },
                });
            }
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

impl Provider for RepeatingToolUseProvider {
    fn name(&self) -> &'static str {
        "repeating-tool-use"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "missing_tool".to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

pub(super) fn test_engine(provider: Arc<dyn Provider>, cwd: &std::path::Path) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .skill_registry(SkillRegistry::empty())
        .build()
}

pub(super) fn test_engine_with_settings(
    provider: Arc<dyn Provider>,
    cwd: &std::path::Path,
    settings: Settings,
) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .settings(settings)
        .skill_registry(SkillRegistry::empty())
        .build()
}
