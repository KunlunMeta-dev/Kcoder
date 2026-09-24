use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_api::ProviderStream;
use kcoder_config::{MoaModelConfig, MoaPresetConfig};
use kcoder_state::Task;
use kcoder_tools::{AgentRunner, Tool};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};

#[test]
fn shared_fork_snapshot_is_immutable_across_replacement_and_clear() {
    let root = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(root.path()).build();
    let make = |text: &str| {
        Arc::new(crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text(text)].into(),
            active_skills: vec![],
            snapshot_provider: "captured-provider".into(),
            snapshot_model: "captured-model".into(),
            full_context_compatible: false,
        })
    };
    *engine.last_cache_safe_params.write().unwrap() = Some(make("old"));
    let first = engine.cache_safe_snapshot().unwrap();
    assert!(Arc::ptr_eq(&first, &engine.cache_safe_snapshot().unwrap()));
    let mut owned = engine.last_cache_safe_params().unwrap();
    owned.fork_context_messages.clear();
    assert_eq!(first.fork_context_messages, vec![Message::user_text("old")]);
    *engine.last_cache_safe_params.write().unwrap() = Some(make("new"));
    let second = engine.cache_safe_snapshot().unwrap();
    assert!(!Arc::ptr_eq(&first, &second));
    *engine.last_cache_safe_params.write().unwrap() = None;
    engine.state.clear_messages();
    assert_eq!(first.fork_context_messages, vec![Message::user_text("old")]);
    assert_eq!(
        second.fork_context_messages,
        vec![Message::user_text("new")]
    );
    assert_eq!(first.snapshot_model, "captured-model");
    assert!(!first.full_context_compatible);
    assert!(engine.cache_safe_snapshot().is_none());
}

#[test]
fn session_replacement_releases_fork_cache_after_external_owner_finishes() {
    let root = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(root.path()).build();
    for generation in 0..32 {
        let snapshot = Arc::new(crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text(format!("generation {generation}"))]
                .into(),
            active_skills: vec![],
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        });
        let observed = Arc::downgrade(&snapshot);
        *engine.last_cache_safe_params.write().unwrap() = Some(snapshot);
        let external = engine.cache_safe_snapshot().unwrap();
        assert_eq!(observed.strong_count(), 2);
        engine.prepare_session_replacement();
        assert!(engine.cache_safe_snapshot().is_none());
        assert_eq!(observed.strong_count(), 1);
        assert_eq!(
            external.fork_context_messages[0],
            Message::user_text(format!("generation {generation}"))
        );
        drop(external);
        assert!(observed.upgrade().is_none());
    }
}

fn request_preview(request: &MessagesRequest) -> String {
    request
        .messages
        .iter()
        .map(|message| message.preview(12_000))
        .collect::<Vec<_>>()
        .join("\n")
}

fn subagent_finish_reminder_count(request: &MessagesRequest) -> usize {
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
struct RecordingProvider {
    name: &'static str,
    request: Arc<Mutex<Option<MessagesRequest>>>,
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
struct MultiRecordingProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    outputs: Mutex<VecDeque<String>>,
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
struct GatedSubagentSteerProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    calls: AtomicUsize,
    first_response_started: Arc<Notify>,
    release_first_response: Arc<Notify>,
}

#[derive(Debug)]
struct FailBeforeCheckpointWriter;

#[async_trait::async_trait]
impl SubagentCheckpointWriter for FailBeforeCheckpointWriter {
    async fn write(&self, _path: &Path, _messages: &[Message]) -> anyhow::Result<()> {
        anyhow::bail!("injected checkpoint failure before commit")
    }
}

#[derive(Debug)]
struct CrashAfterCheckpointWriter;

#[async_trait::async_trait]
impl SubagentCheckpointWriter for CrashAfterCheckpointWriter {
    async fn write(&self, path: &Path, messages: &[Message]) -> anyhow::Result<()> {
        crate::agent::write_transcript_checkpoint(path, messages).await?;
        panic!("injected process exit after checkpoint and before ack")
    }
}

fn with_subagent_checkpoint_writer(
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
struct ToolThenSteerProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    calls: AtomicUsize,
}

#[derive(Debug)]
struct TwoAgentSteerProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    first_requests_started: AtomicUsize,
    both_first_requests_started: Arc<Notify>,
    release_first_requests: Arc<Notify>,
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
struct ForkSessionMemoryCountingProvider {
    session_memory_requests: Arc<AtomicUsize>,
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
struct ToolUseProvider;

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
struct HangingReadTool {
    started: Arc<Notify>,
}

#[derive(Debug)]
struct GatedSteerTool {
    started: Arc<Notify>,
    release: Arc<Notify>,
}

#[derive(Debug)]
struct LargeVerifierOutputTool;

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
struct ForbiddenFinalTool {
    calls: Arc<AtomicUsize>,
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
struct FailingSteerTool;

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
struct RepeatingToolUseProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

#[derive(Debug)]
struct TerminalVerdictProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

#[derive(Debug)]
struct LargeVerifierOutputProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

#[derive(Debug)]
struct IgnoresTerminalBoundaryProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
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

fn test_engine(provider: Arc<dyn Provider>, cwd: &std::path::Path) -> QueryEngine {
    TestEngineBuilder::new(cwd)
        .provider(provider)
        .skill_registry(SkillRegistry::empty())
        .build()
}

fn test_engine_with_settings(
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

#[tokio::test]
async fn role_runner_starts_each_verifier_in_a_fresh_session() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_session_tail = "FIRST_SESSION_PRIVATE_TAIL_SENTINEL";
    let first_verdict = format!(
        "FAIL\nknown rejection gap {}{first_session_tail}",
        "x".repeat(300)
    );
    let provider = Arc::new(MultiRecordingProvider {
        requests: Arc::clone(&requests),
        outputs: Mutex::new(VecDeque::from([
            first_verdict,
            "PASS\nrejection gap fixed".to_string(),
        ])),
    });
    let engine = test_engine(provider, tmp.path());
    let artifact_project_dir = tmp.path().join("artifacts");
    engine
        .state
        .with_session_artifact_project_dir(&artifact_project_dir, "fresh-verifiers");
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );
    // This test validates verifier-session isolation only. Disable evidence gates so the fake provider need not become a tool-protocol stub.
    let mut verifier_selection = kcoder_state::GoalVerifierSelection::default();
    verifier_selection.verification.require_tests = false;
    verifier_selection.verification.require_raw_exit_code = false;
    verifier_selection.verification.allow_workspace_changes = true;
    verifier_selection.verification.isolate_environment = false;
    verifier_selection.verification.allow_dependency_changes = true;
    engine
        .state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "verify the fresh-session contract",
            None,
            None,
            kcoder_state::GoalMode::Strict,
            kcoder_state::GoalVerificationKind::Artifact,
            verifier_selection,
        )
        .unwrap();
    let ctx = kcoder_tools::ToolContext::new(engine.state.clone())
        .with_agent_runner(Arc::new(crate::agent::QueryEngineAgentRunner::new(engine)));

    let first = kcoder_tools::UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();
    assert!(first.is_error);
    let second = kcoder_tools::UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();
    assert!(!second.is_error);

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let first_request = request_preview(&requests[0]);
    let second_request = request_preview(&requests[1]);
    assert!(!first_request.contains("previous_verifier_rejection"));
    assert!(second_request.contains("<previous_verifier_rejection>"));
    assert!(second_request.contains("known rejection gap"));
    assert!(!second_request.contains(first_session_tail));
    drop(requests);

    let subagents_dir = artifact_project_dir
        .join("fresh-verifiers")
        .join("subagents");
    let mut transcript_paths = std::fs::read_dir(&subagents_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("transcript.json"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    transcript_paths.sort();
    assert_eq!(transcript_paths.len(), 2);
    assert_ne!(transcript_paths[0], transcript_paths[1]);

    let transcripts = transcript_paths
        .iter()
        .map(|path| std::fs::read_to_string(path).unwrap())
        .collect::<Vec<_>>();
    assert!(transcripts.iter().any(|text| {
        text.contains(first_session_tail) && !text.contains("<previous_verifier_rejection>")
    }));
    assert!(transcripts.iter().any(|text| {
        text.contains("<previous_verifier_rejection>") && !text.contains(first_session_tail)
    }));
}

#[tokio::test]
async fn forked_agent_uses_parent_current_model() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());

    // Simulate a parent turn that captured a snapshot with specific values.
    let snapshot_model = "snapshot-model".to_string();
    let snapshot_max_tokens = 1024u32;
    let snapshot_skills = vec!["skill-a".to_string()];
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: snapshot_skills.clone(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: snapshot_model.clone(),
            full_context_compatible: true,
        }
        .into(),
    );

    // Mutate the live settings to prove the fork uses the parent's
    // current model, not a stale cache-safe snapshot.
    let live_model = "minimax-m3".to_string();
    engine.settings.write().unwrap().model = live_model.clone();
    engine.settings.write().unwrap().max_tokens = Some(4096);

    let result = engine
        .run_forked_agent(
            vec![Message::user_text("hello")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();
    assert_eq!(result.output_text, "hi");

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    assert_eq!(req.model, live_model);
    assert_eq!(req.max_tokens, 4096);
    // Active skills are baked into the system prompt via the skill registry;
    // the important invariant is that the fork used the current parent
    // model rather than the stale snapshot model.
    assert_ne!(req.model, snapshot_model);
    assert_ne!(req.max_tokens, snapshot_max_tokens);
}

#[tokio::test]
async fn running_subagent_applies_queued_delivery_before_final_completion() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_response_started = Arc::new(Notify::new());
    let release_first_response = Arc::new(Notify::new());
    let provider = Arc::new(GatedSubagentSteerProvider {
        requests: Arc::clone(&requests),
        calls: AtomicUsize::new(0),
        first_response_started: Arc::clone(&first_response_started),
        release_first_response: Arc::clone(&release_first_response),
    });
    let engine = test_engine(provider, tmp.path());
    let agent_id = "live-steer-agent";
    let transcript_path = tmp.path().join("live-steer-transcript.json");
    let mut task = Task::new(agent_id, "General agent: live steering regression");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let running_cache = cache_safe.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &running_cache,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages: vec![Message::user_text("start delegated work")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    first_response_started.notified().await;
    let receipt = engine
        .state
        .enqueue_subagent_delivery(agent_id, "change course while still running")
        .unwrap()
        .expect("running agent must accept the steer");
    release_first_response.notify_one();

    let result = run.await.unwrap().unwrap();
    assert_eq!(result.output_text, "after steer");
    {
        let requests = requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            2,
            "steer must force a second Provider round"
        );
        assert!(!request_preview(&requests[0]).contains("change course while still running"));
        assert!(request_preview(&requests[1]).contains("change course while still running"));
    }

    let task = engine.state.task(agent_id).unwrap();
    assert!(
        task.message_queue.is_empty(),
        "applied steer must be acknowledged"
    );
    let transcript: Vec<Message> = serde_json::from_slice(
        &tokio::fs::read(&transcript_path)
            .await
            .expect("live steer transcript checkpoint"),
    )
    .unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|message| message
                .preview(2_000)
                .contains("change course while still running"))
            .count(),
        1,
        "message {} must be persisted exactly once",
        receipt.message_id
    );
}

#[tokio::test]
async fn child_live_view_exposes_text_before_durable_checkpoint_and_cleans_up() {
    #[derive(Debug)]
    struct StreamingProbe {
        emitted: Arc<Notify>,
        release: Arc<Notify>,
    }
    impl Provider for StreamingProbe {
        fn name(&self) -> &'static str {
            "live-view-probe"
        }
        fn stream_messages(
            &self,
            _: MessagesRequest,
        ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
            let emitted = self.emitted.clone();
            let release = self.release.clone();
            Ok(Box::pin(async_stream::stream! {
                yield Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::Text { text: String::new() } });
                yield Ok(StreamEvent::ContentBlockDelta { index: 0, delta: ContentDelta::TextDelta { text: "LIVE_CHILD_SENTINEL".into() } });
                emitted.notify_one();
                release.notified().await;
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
                yield Ok(StreamEvent::MessageStop);
            }))
        }
    }
    let tmp = tempfile::tempdir().unwrap();
    let emitted = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(StreamingProbe {
            emitted: emitted.clone(),
            release: release.clone(),
        }),
        tmp.path(),
    );
    let id = "live-view-child";
    let transcript = tmp.path().join("child.json");
    let mut task = Task::new(id, "General agent: live view");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript.clone());
    engine.state.upsert_task(task);
    let cache = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };
    let worker = engine.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &worker,
            &cache,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(id.into()),
                messages: vec![Message::user_text("child task")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: Default::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(10), emitted.notified())
        .await
        .unwrap();
    let snapshot = engine
        .subagent_live_snapshot(id, None)
        .expect("live data before MessageStop");
    assert_eq!(snapshot.pending_text, "LIVE_CHILD_SENTINEL");
    assert!(
        !std::fs::read_to_string(&transcript)
            .unwrap()
            .contains("LIVE_CHILD_SENTINEL")
    );
    assert!(
        !engine
            .state
            .messages()
            .iter()
            .any(|m| m.preview(2000).contains("LIVE_CHILD_SENTINEL"))
    );
    assert!(engine.subagent_live_snapshot("sibling", None).is_none());
    release.notify_one();
    run.await.unwrap().unwrap();
    assert!(!engine.has_subagent_live_view(id));
    assert!(
        std::fs::read_to_string(transcript)
            .unwrap()
            .contains("LIVE_CHILD_SENTINEL")
    );
}

#[tokio::test]
async fn checkpoint_failure_rolls_back_child_and_requeues_delivery_for_exactly_once_retry() {
    let tmp = tempfile::tempdir().unwrap();
    let parent = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-failure-parent",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    );
    let agent_id = "checkpoint-failure-agent";
    let transcript_path = tmp.path().join("checkpoint-failure-transcript.json");
    let mut task = Task::new(agent_id, "General agent: checkpoint failure");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(parent.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    parent.state.upsert_task(task);
    let receipt = parent
        .state
        .enqueue_subagent_delivery(agent_id, "retry-after-checkpoint-failure")
        .unwrap()
        .unwrap();
    let original = vec![Message::user_text("original child context")];

    let failing_child = with_subagent_checkpoint_writer(
        test_engine(
            Arc::new(RecordingProvider {
                name: "checkpoint-failure-child",
                request: Arc::new(Mutex::new(None)),
            }),
            tmp.path(),
        )
        .with_subagent_runtime_control(
            parent.state.clone(),
            agent_id.to_string(),
            transcript_path.clone(),
        ),
        Arc::new(FailBeforeCheckpointWriter),
    );
    failing_child.state.set_messages(original.clone());

    let error = failing_child
        .apply_pending_subagent_deliveries_at_safe_boundary()
        .await
        .unwrap_err();
    assert!(error.to_string().contains("injected checkpoint failure"));
    assert_eq!(failing_child.state.messages(), original);
    assert!(!transcript_path.exists());
    let queued = parent.state.task(agent_id).unwrap().message_queue;
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].message_id, receipt.message_id);
    assert_eq!(queued[0].status, kcoder_state::AgentMessageStatus::Queued);
    assert!(queued[0].transcript_anchor.is_some());

    let retry_child = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-retry-child",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    )
    .with_subagent_runtime_control(
        parent.state.clone(),
        agent_id.to_string(),
        transcript_path.clone(),
    );
    retry_child.state.set_messages(original);
    let applied = retry_child
        .apply_pending_subagent_deliveries_at_safe_boundary()
        .await
        .unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].message_id, receipt.message_id);
    assert!(
        parent
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|message| message
                .preview(2_000)
                .contains("retry-after-checkpoint-failure"))
            .count(),
        1
    );
}

#[tokio::test]
async fn resume_after_checkpoint_before_ack_crash_does_not_duplicate_delivery() {
    let tmp = tempfile::tempdir().unwrap();
    let history_path = tmp.path().join("checkpoint-before-ack.jsonl");
    let parent = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-crash-parent",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    );
    parent.state.with_history_path(&history_path);
    parent
        .state
        .add_message(Message::user_text("persist parent session"));
    parent.state.save_history().unwrap();
    let agent_id = "checkpoint-before-ack-agent";
    let transcript_path = tmp.path().join("checkpoint-before-ack-transcript.json");
    let mut task = Task::new(agent_id, "General agent: checkpoint before ack");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(parent.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    parent.state.upsert_task(task);
    let receipt = parent
        .state
        .enqueue_subagent_delivery(agent_id, "resume-without-duplicate")
        .unwrap()
        .unwrap();
    let original = vec![Message::user_text("original child context")];

    let crashing_child = with_subagent_checkpoint_writer(
        test_engine(
            Arc::new(RecordingProvider {
                name: "checkpoint-crash-child",
                request: Arc::new(Mutex::new(None)),
            }),
            tmp.path(),
        )
        .with_subagent_runtime_control(
            parent.state.clone(),
            agent_id.to_string(),
            transcript_path.clone(),
        ),
        Arc::new(CrashAfterCheckpointWriter),
    );
    crashing_child.state.set_messages(original);
    let crashed = tokio::spawn(async move {
        crashing_child
            .apply_pending_subagent_deliveries_at_safe_boundary()
            .await
    })
    .await;
    assert!(crashed.unwrap_err().is_panic());
    let leased = parent.state.task(agent_id).unwrap().message_queue;
    assert_eq!(leased.len(), 1);
    assert_eq!(leased[0].status, kcoder_state::AgentMessageStatus::Leased);
    assert!(leased[0].transcript_anchor.is_some());

    let resumed_parent = kcoder_state::AppState::new(tmp.path());
    resumed_parent.resume_from_history(&history_path).unwrap();
    resumed_parent.update_task(agent_id, |task| {
        task.status = kcoder_state::TaskStatus::Running;
        task.accepting_subagent_messages = true;
    });
    let recovered = resumed_parent.task(agent_id).unwrap();
    assert_eq!(recovered.message_queue.len(), 1);
    assert_eq!(
        recovered.message_queue[0].status,
        kcoder_state::AgentMessageStatus::Queued
    );

    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    let resumed_child = test_engine(
        Arc::new(RecordingProvider {
            name: "checkpoint-resume-child",
            request: Arc::new(Mutex::new(None)),
        }),
        tmp.path(),
    )
    .with_subagent_runtime_control(
        resumed_parent.clone(),
        agent_id.to_string(),
        transcript_path.clone(),
    );
    resumed_child.state.set_messages(transcript);
    let applied = resumed_child
        .apply_pending_subagent_deliveries_at_safe_boundary()
        .await
        .unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0].message_id, receipt.message_id);
    assert!(
        resumed_parent
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    assert_eq!(
        transcript
            .iter()
            .filter(|message| message.preview(2_000).contains("resume-without-duplicate"))
            .count(),
        1
    );
}

#[tokio::test]
async fn running_subagent_waits_for_complete_parallel_tool_batch_before_applying_steer() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_started = Arc::new(Notify::new());
    let release_tool = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(ToolThenSteerProvider {
            requests: Arc::clone(&requests),
            calls: AtomicUsize::new(0),
        }),
        tmp.path(),
    );
    let agent_id = "tool-boundary-steer-agent";
    let transcript_path = tmp.path().join("tool-boundary-steer-transcript.json");
    let mut task = Task::new(agent_id, "General agent: tool boundary steering");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let wait_started = Arc::clone(&tool_started);
    let wait_release = Arc::clone(&release_tool);
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages: vec![Message::user_text("run the gated tool")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides {
                    permission_mode_if_parent_asks: Some(PermissionMode::Auto),
                    ..crate::agent::SubagentContextOverrides::default()
                },
                max_turns: 10,
                tools: ToolRegistry::new()
                    .register(GatedSteerTool {
                        started: wait_started,
                        release: wait_release,
                    })
                    .register(FailingSteerTool),
                runtime: None,
            },
        )
        .await
    });

    tool_started.notified().await;
    engine
        .state
        .enqueue_subagent_delivery(agent_id, "steer after the tool result")
        .unwrap()
        .unwrap();
    assert!(!run.is_finished(), "steer must not cancel the active tool");
    release_tool.notify_one();

    let result = run.await.unwrap().unwrap();
    assert_eq!(result.output_text, "after tool steer");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!request_preview(&requests[0]).contains("steer after the tool result"));
    let second = requests[1]
        .messages
        .iter()
        .map(|message| message.preview(4_000))
        .collect::<Vec<_>>();
    let successful_tool_result = second
        .iter()
        .position(|message| message.contains("tool completed before steer"))
        .expect("complete ToolResult must be present");
    let failed_tool_result = requests[1]
        .messages
        .iter()
        .position(|message| {
            matches!(message, Message::User { content, .. } if content.iter().any(|block| {
                matches!(block, ContentBlock::ToolResult { tool_use_id, is_error: Some(true), .. } if tool_use_id == "steer-tool-2")
            }))
        })
        .expect("failed parallel ToolResult must be present");
    let steer = second
        .iter()
        .position(|message| message.contains("steer after the tool result"))
        .expect("steer must be present in the next request");
    assert!(
        successful_tool_result < steer && failed_tool_result < steer,
        "steer must follow every successful and failed ToolResult in the batch"
    );
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
}

#[tokio::test]
async fn live_steer_drain_is_fifo_and_bounded_per_provider_round() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_response_started = Arc::new(Notify::new());
    let release_first_response = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(GatedSubagentSteerProvider {
            requests: Arc::clone(&requests),
            calls: AtomicUsize::new(0),
            first_response_started: Arc::clone(&first_response_started),
            release_first_response: Arc::clone(&release_first_response),
        }),
        tmp.path(),
    );
    let agent_id = "bounded-live-steer-agent";
    let transcript_path = tmp.path().join("bounded-live-steer-transcript.json");
    let mut task = Task::new(agent_id, "General agent: bounded live steering");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages: vec![Message::user_text("start bounded delivery test")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    first_response_started.notified().await;
    for index in 0..20 {
        engine
            .state
            .enqueue_subagent_delivery(agent_id, format!("bounded-steer-{index:02}"))
            .unwrap()
            .unwrap();
    }
    release_first_response.notify_one();

    run.await.unwrap().unwrap();
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let second = request_preview(&requests[1]);
        let third = request_preview(&requests[2]);
        for index in 0..16 {
            assert!(second.contains(&format!("bounded-steer-{index:02}")));
        }
        for index in 16..20 {
            let message = format!("bounded-steer-{index:02}");
            assert!(!second.contains(&message));
            assert!(third.contains(&message));
        }
    }
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );
    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    let user_text = transcript
        .iter()
        .map(|message| message.preview(4_000))
        .collect::<Vec<_>>();
    for index in 0..20 {
        let message = format!("bounded-steer-{index:02}");
        assert_eq!(
            user_text
                .iter()
                .filter(|candidate| candidate.contains(&message))
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn targeted_live_steer_does_not_reach_sibling_or_parent() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let both_first_requests_started = Arc::new(Notify::new());
    let release_first_requests = Arc::new(Notify::new());
    let engine = test_engine(
        Arc::new(TwoAgentSteerProvider {
            requests: Arc::clone(&requests),
            first_requests_started: AtomicUsize::new(0),
            both_first_requests_started: Arc::clone(&both_first_requests_started),
            release_first_requests: Arc::clone(&release_first_requests),
        }),
        tmp.path(),
    );
    for agent_id in ["agent-a", "agent-b"] {
        let mut task = Task::new(agent_id, format!("General agent: {agent_id}"));
        task.kind = kcoder_state::TaskKind::Subagent;
        task.managed = true;
        task.status = kcoder_state::TaskStatus::Running;
        task.parent_session_id = Some(engine.state.session_id());
        task.transcript_path = Some(tmp.path().join(format!("{agent_id}-transcript.json")));
        engine.state.upsert_task(task);
    }
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let engine_a = engine.clone();
    let cache_a = cache_safe.clone();
    let run_a = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &engine_a,
            &cache_a,
            crate::agent::ForkedAgentRequest {
                agent_id: Some("agent-a".to_string()),
                messages: vec![Message::user_text("agent-a-start")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });
    let engine_b = engine.clone();
    let run_b = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &engine_b,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some("agent-b".to_string()),
                messages: vec![Message::user_text("agent-b-start")],
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    both_first_requests_started.notified().await;
    engine
        .state
        .enqueue_subagent_delivery("agent-b", "target-only-steer-sentinel")
        .unwrap()
        .unwrap();
    release_first_requests.notify_waiters();

    let result_a = run_a.await.unwrap().unwrap();
    let result_b = run_b.await.unwrap().unwrap();
    assert_eq!(result_a.output_text, "initial child response");
    assert_eq!(result_b.output_text, "target adjusted");
    let request_previews = requests
        .lock()
        .unwrap()
        .iter()
        .map(request_preview)
        .collect::<Vec<_>>();
    assert_eq!(
        request_previews
            .iter()
            .filter(|request| request.contains("target-only-steer-sentinel"))
            .count(),
        1
    );
    assert!(request_previews.iter().all(|request| {
        !(request.contains("agent-a-start") && request.contains("target-only-steer-sentinel"))
    }));
    assert!(engine.state.messages().iter().all(|message| {
        !message
            .preview(2_000)
            .contains("target-only-steer-sentinel")
    }));
    let transcript_a: Vec<Message> = serde_json::from_slice(
        &tokio::fs::read(tmp.path().join("agent-a-transcript.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(transcript_a.iter().all(|message| {
        !message
            .preview(2_000)
            .contains("target-only-steer-sentinel")
    }));
}

#[tokio::test]
async fn continued_subagent_acknowledges_initial_delivery_before_live_steer() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let first_response_started = Arc::new(Notify::new());
    let release_first_response = Arc::new(Notify::new());
    let provider = Arc::new(GatedSubagentSteerProvider {
        requests: Arc::clone(&requests),
        calls: AtomicUsize::new(0),
        first_response_started: Arc::clone(&first_response_started),
        release_first_response: Arc::clone(&release_first_response),
    });
    let engine = test_engine(provider, tmp.path());
    let agent_id = "continued-live-steer-agent";
    let transcript_path = tmp.path().join("continued-live-steer-transcript.json");
    let mut task = Task::new(
        agent_id,
        "General agent: continued live steering regression",
    );
    task.kind = kcoder_state::TaskKind::Subagent;
    task.managed = true;
    task.status = kcoder_state::TaskStatus::Running;
    task.parent_session_id = Some(engine.state.session_id());
    task.transcript_path = Some(transcript_path.clone());
    engine.state.upsert_task(task);

    let mut messages = vec![Message::user_text("original delegated context")];
    let initial_receipt = engine
        .state
        .enqueue_subagent_delivery(agent_id, "initial continuation message")
        .unwrap()
        .unwrap();
    let initial_claim = engine
        .state
        .claim_next_subagent_delivery(agent_id, 120, 8)
        .unwrap();
    let kcoder_state::AgentDeliveryClaimOutcome::Claimed(initial_claim) = initial_claim else {
        panic!("expected the initial continuation claim")
    };
    let baseline_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&messages).unwrap())
    );
    engine
        .state
        .prepare_subagent_delivery(
            agent_id,
            &initial_claim.message_id,
            &initial_claim.lease_id,
            kcoder_state::TranscriptDeliveryAnchor {
                baseline_message_count: messages.len(),
                baseline_sha256,
                body_sha256: format!("{:x}", Sha256::digest(initial_claim.body.as_bytes())),
            },
        )
        .unwrap();
    messages.push(Message::user_text(initial_claim.body.clone()));
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let running_engine = engine.clone();
    let run = tokio::spawn(async move {
        crate::agent::continue_forked_agent_with_tools(
            &running_engine,
            &cache_safe,
            crate::agent::ForkedAgentRequest {
                agent_id: Some(agent_id.to_string()),
                messages,
                prompt_message_count: 1,
                initial_delivery: Some(kcoder_tools::AgentDeliveryContext {
                    message_id: initial_claim.message_id,
                    lease_id: initial_claim.lease_id,
                }),
                overrides: crate::agent::SubagentContextOverrides::default(),
                max_turns: 10,
                tools: ToolRegistry::new(),
                runtime: None,
            },
        )
        .await
    });

    first_response_started.notified().await;
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty(),
        "initial delivery must be acknowledged before the Provider stream starts"
    );
    let second_receipt = engine
        .state
        .enqueue_subagent_delivery(agent_id, "second message during continuation")
        .unwrap()
        .unwrap();
    release_first_response.notify_one();

    let result = run.await.unwrap().unwrap();
    assert_eq!(result.output_text, "after steer");
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(request_preview(&requests[0]).contains("initial continuation message"));
        assert!(!request_preview(&requests[0]).contains("second message during continuation"));
        assert!(request_preview(&requests[1]).contains("second message during continuation"));
    }
    assert!(
        engine
            .state
            .task(agent_id)
            .unwrap()
            .message_queue
            .is_empty()
    );

    let transcript: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    for (message_id, body) in [
        (initial_receipt.message_id, "initial continuation message"),
        (
            second_receipt.message_id,
            "second message during continuation",
        ),
    ] {
        assert_eq!(
            transcript
                .iter()
                .filter(|message| message.preview(2_000).contains(body))
                .count(),
            1,
            "message {message_id} must be persisted exactly once"
        );
    }
}

#[tokio::test]
async fn training_mode_preserves_forked_agents_with_distinct_session_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let mut settings = Settings::default();
    settings.enable_training_mode();
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    let parent_session_id = engine.state.session_id();
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let result = engine
        .run_forked_agent(
            vec![Message::user_text("perform delegated work")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();

    assert_eq!(result.output_text, "hi");
    let request = request
        .lock()
        .unwrap()
        .take()
        .expect("subagent Provider request");
    let child_session_id = request
        .debug_session_id
        .expect("subagent request must expose its session id");
    assert_ne!(child_session_id, parent_session_id);
    assert_eq!(request.trajectory_agent_depth, Some(1));
}

#[tokio::test]
async fn full_context_rejects_provider_or_model_switch_since_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: "snapshot-model".to_string(),
            full_context_compatible: true,
        }
        .into(),
    );
    engine.settings.write().unwrap().model = "live-model".to_string();

    let runner = crate::agent::QueryEngineAgentRunner::new(engine);
    let error = runner
        .run_agent_session_with_options(
            "full-incompatible".to_string(),
            "continue exactly".to_string(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default()
                .with_context_inheritance(kcoder_tools::SubagentContextMode::Full, 2),
        )
        .await
        .expect_err("full context must reject a model-switched snapshot");

    assert!(error.to_string().contains("context_mode=full"));
    assert!(
        error
            .to_string()
            .contains("use context_mode=semantic or recent")
    );
    assert!(request.lock().unwrap().is_none());
}

#[tokio::test]
async fn moa_turn_marks_snapshot_incompatible_with_full_inheritance() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request,
    });
    let mut settings = Settings {
        model: "parent-model".to_string(),
        request_timeout_secs: Some(1),
        provider_no_proxy: true,
        local_base_url: Some("http://127.0.0.1:9/v1".to_string()),
        ..Settings::default()
    };
    settings.moa.enabled = true;
    settings.moa.default_preset = "snapshot-test".to_string();
    settings.moa.presets = std::collections::BTreeMap::from([(
        "snapshot-test".to_string(),
        MoaPresetConfig {
            enabled: true,
            reference_models: vec![MoaModelConfig::new("missing-provider", "reference-model")],
            aggregator: MoaModelConfig::new("local", "aggregator-model"),
            reference_max_tokens: Some(32),
            aggregator_max_tokens: Some(32),
        },
    )]);
    let engine = test_engine_with_settings(provider, tmp.path(), settings);
    engine
        .state
        .add_message(Message::user_text("answer through MoA"));
    engine.enable_moa_for_next_turn(Some("snapshot-test".to_string()));

    let turn_engine = engine.clone();
    let turn = tokio::spawn(async move {
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let mut stream = Box::pin(turn_engine.run_turn_stream(&prompt));
        while stream.next().await.is_some() {}
    });

    let params = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(params) = engine.last_cache_safe_params() {
                break params;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("MoA turn should publish cache-safe params before provider completion");

    assert_eq!(params.snapshot_provider, "recording");
    assert_eq!(params.snapshot_model, "parent-model");
    assert_ne!(params.snapshot_model, "aggregator-model");
    assert!(!params.full_context_compatible);

    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let error = runner
        .run_agent_session_with_options(
            "moa-full-rejected".to_string(),
            "continue exactly".to_string(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default()
                .with_context_inheritance(kcoder_tools::SubagentContextMode::Full, 2),
        )
        .await
        .expect_err("MoA snapshots must reject full inheritance");
    assert!(error.to_string().contains("active MoA aggregator turn"));
    assert!(error.to_string().contains("semantic or recent"));

    engine.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(2), turn).await;
}

#[tokio::test]
async fn send_message_repairs_legacy_unmatched_tool_use_before_provider_request() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let agent_id = "legacy-unmatched-tool";
    let transcript_path = engine.state.subagent_transcript_path(agent_id);
    let legacy_messages = vec![
        Message::user_text("inspect the file"),
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "legacy-tool-use".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({"file_path": "src/lib.rs"}),
            }],
            usage: None,
        },
    ];
    if let Some(parent) = transcript_path.parent() {
        tokio::fs::create_dir_all(parent).await.unwrap();
    }
    tokio::fs::write(
        &transcript_path,
        serde_json::to_vec(&legacy_messages).unwrap(),
    )
    .await
    .unwrap();
    let mut task = Task::new(agent_id, "General agent: legacy transcript");
    task.kind = TaskKind::Subagent;
    task.transcript_path = Some(transcript_path.clone());
    task.agent_provider = Some(engine.provider_name());
    task.agent_model = Some(engine.model_name());
    engine.state.upsert_task(task);

    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let output = runner
        .send_message_to_agent_with_options(
            agent_id.to_string(),
            "continue safely".to_string(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(output, "hi");

    let provider_request = request.lock().unwrap().take().unwrap();
    assert!(!repair_tool_message_sequence(provider_request.messages.to_vec()).1);
    assert!(provider_request.messages.iter().any(|message| {
        matches!(
            message,
            Message::User { content, .. }
                if content.iter().any(|block| matches!(
                    block,
                    ContentBlock::ToolResult { tool_use_id, .. }
                        if tool_use_id == "legacy-tool-use"
                ))
        )
    }));
    let persisted: Vec<Message> =
        serde_json::from_slice(&tokio::fs::read(&transcript_path).await.unwrap()).unwrap();
    assert!(!repair_tool_message_sequence(persisted).1);
}

#[tokio::test]
async fn artifact_requirements_direct_runner_persists_restores_and_rejects_before_provider() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let engine = test_engine(
        Arc::new(RecordingProvider {
            name: "recording",
            request: request.clone(),
        }),
        tmp.path(),
    );
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );
    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let requirement: kcoder_state::ArtifactRequirement =
        serde_json::from_value(serde_json::json!({"path":"report.md"})).unwrap();
    let options = kcoder_tools::AgentRunOptions::default()
        .with_artifact_requirements(vec![requirement.clone()]);
    let mut invalid = options.clone();
    invalid.artifact_requirements[0].path.clear();
    let error = runner
        .run_agent_session_with_options(
            "invalid-artifact".into(),
            "test".into(),
            1,
            kcoder_tools::AgentKind::General,
            invalid,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("artifact_requirements"));
    assert!(engine.state.task("invalid-artifact").is_none());
    assert!(
        !engine
            .state
            .subagent_transcript_path("invalid-artifact")
            .exists()
    );
    assert!(request.lock().unwrap().is_none());

    let agent_id = "typed-artifact-runner";
    engine
        .state
        .upsert_task(Task::new("empty-artifact-task", "legacy"));
    let error = runner
        .run_agent_session_with_options(
            "empty-artifact-task".into(),
            "test".into(),
            1,
            kcoder_tools::AgentKind::General,
            options.clone(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("conflict with persisted"));
    assert!(
        engine
            .state
            .task("empty-artifact-task")
            .unwrap()
            .artifact_requirements
            .is_empty()
    );
    assert!(request.lock().unwrap().is_none());
    runner
        .run_agent_session_with_options(
            agent_id.into(),
            "produce report.md".into(),
            10,
            kcoder_tools::AgentKind::General,
            options.clone(),
        )
        .await
        .unwrap();
    let task = engine.state.task(agent_id).unwrap();
    assert_eq!(task.artifact_requirements, vec![requirement.clone()]);
    let restored: Task = serde_json::from_value(serde_json::to_value(&task).unwrap()).unwrap();
    engine.state.upsert_task(restored);
    request.lock().unwrap().take();
    let before = tokio::fs::read(engine.state.subagent_transcript_path(agent_id))
        .await
        .unwrap();
    let mut conflicting = options;
    conflicting.artifact_requirements[0].path = "expanded.md".into();
    let error = runner
        .send_message_to_agent_with_options(
            agent_id.into(),
            "continue".into(),
            10,
            kcoder_tools::AgentKind::General,
            conflicting,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("conflict with persisted"));
    assert!(request.lock().unwrap().is_none());
    assert_eq!(
        tokio::fs::read(engine.state.subagent_transcript_path(agent_id))
            .await
            .unwrap(),
        before
    );
    runner
        .send_message_to_agent_with_options(
            agent_id.into(),
            "continue".into(),
            10,
            kcoder_tools::AgentKind::General,
            kcoder_tools::AgentRunOptions::default(),
        )
        .await
        .unwrap();
    assert!(request.lock().unwrap().is_some());
    assert_eq!(
        engine.state.task(agent_id).unwrap().artifact_requirements,
        vec![requirement]
    );
    assert!(!tmp.path().join("report.md").exists());
    engine
        .state
        .with_history_path(tmp.path().join("artifact-durable.jsonl"));
    let sidecar = engine.state.session_state_path().unwrap();
    std::fs::remove_file(&sidecar).unwrap();
    std::fs::create_dir(&sidecar).unwrap();
    request.lock().unwrap().take();
    let options = kcoder_tools::AgentRunOptions::default()
        .with_artifact_requirements(engine.state.task(agent_id).unwrap().artifact_requirements);
    let error = runner
        .run_agent_session_with_options(
            "artifact-write-failure".into(),
            "test".into(),
            1,
            kcoder_tools::AgentKind::General,
            options,
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("failed to bind artifact declarations")
    );
    assert!(request.lock().unwrap().is_none());
    assert!(
        engine
            .state
            .task("artifact-write-failure")
            .unwrap()
            .artifact_requirements
            .is_empty()
    );
    assert!(
        !engine
            .state
            .subagent_transcript_path("artifact-write-failure")
            .exists()
    );
}

#[tokio::test]
async fn cancelling_fork_during_tool_execution_persists_matched_tool_result() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = test_engine(Arc::new(ToolUseProvider), tmp.path());
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };
    let agent_id = "cancel-during-tool".to_string();
    let cancel = CancellationToken::new();
    let cancel_later = cancel.clone();
    let tool_started = Arc::new(Notify::new());
    let cancel_after_tool_started = Arc::clone(&tool_started);
    tokio::spawn(async move {
        cancel_after_tool_started.notified().await;
        cancel_later.cancel();
    });

    let error = crate::agent::continue_forked_agent_with_tools(
        &engine,
        &cache_safe,
        crate::agent::ForkedAgentRequest {
            agent_id: Some(agent_id.clone()),
            messages: vec![Message::user_text("run the read")],
            prompt_message_count: 1,
            initial_delivery: None,
            overrides: crate::agent::SubagentContextOverrides {
                abort_token: Some(cancel),
                permission_mode_if_parent_asks: Some(PermissionMode::Auto),
                ..crate::agent::SubagentContextOverrides::default()
            },
            max_turns: 10,
            tools: ToolRegistry::new().register(HangingReadTool {
                started: tool_started,
            }),
            runtime: None,
        },
    )
    .await
    .expect_err("cancelled tool execution must return a typed abort");
    assert!(error.to_string().contains("cancelled by user"));

    let transcript_path = engine.state.subagent_transcript_path(&agent_id);
    let messages: Vec<Message> = serde_json::from_slice(
        &tokio::fs::read(&transcript_path)
            .await
            .expect("cancelled transcript checkpoint"),
    )
    .expect("valid transcript JSON");
    let (repaired, changed) = repair_tool_message_sequence(messages.clone());
    assert!(
        !changed,
        "checkpoint still needed tool-protocol repair: {repaired:?}"
    );
    assert!(messages.iter().any(|message| {
        message
            .preview(2_000)
            .contains("Tool call was interrupted by the user")
    }));
}

#[tokio::test]
async fn forked_agent_does_not_refresh_session_memory() {
    let tmp = tempfile::tempdir().unwrap();
    let session_memory_requests = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(ForkSessionMemoryCountingProvider {
        session_memory_requests: Arc::clone(&session_memory_requests),
    });
    let engine = test_engine(provider, tmp.path());
    {
        let mut settings = engine.settings.write().unwrap();
        settings.session_memory.update_enabled = true;
        settings.session_memory.init_min_tokens = 1;
        settings.session_memory.update_min_token_delta = 1;
    }
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent user")].into(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let result = engine
        .run_forked_agent(
            vec![Message::user_text("hello")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();
    assert_eq!(result.output_text, "hi");

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        session_memory_requests.load(Ordering::SeqCst),
        0,
        "forked/subagent turns must not run session-memory maintenance"
    );
}

#[tokio::test]
async fn arrangement_implementer_fork_keeps_worker_tool_registry() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
    engine.state.set_goal_prepared_with_mode(
        "orchestrate implementation",
        None,
        None,
        kcoder_state::GoalMode::Arrangement,
    );
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text("parent user")].into(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };
    let tools = crate::agent::filter_tools_for_agent_kind_in_mode(
        &kcoder_tools::arrangement_subagent_registry(),
        kcoder_tools::AgentKind::Implementer,
        true,
        true,
    );

    let result = crate::agent::continue_forked_agent_with_tools(
        &engine,
        &cache_safe,
        crate::agent::ForkedAgentRequest {
            agent_id: Some("agent-implementer".to_string()),
            messages: vec![Message::user_text("make the scoped edit")],
            prompt_message_count: 1,
            initial_delivery: None,
            overrides: crate::agent::SubagentContextOverrides {
                share_abort_controller: true,
                allowed_write_paths: vec!["src/parser.rs".to_string()],
                arrangement_mode: Some(true),
                ..crate::agent::SubagentContextOverrides::default()
            },
            max_turns: 10,
            tools,
            runtime: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.output_text, "hi");

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    let tool_names = req
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<std::collections::HashSet<_>>();
    assert!(tool_names.contains("edit"));
    assert!(tool_names.contains("write"));
    assert!(tool_names.contains(if cfg!(windows) { "PowerShell" } else { "bash" }));
    assert!(!tool_names.contains("PlanAgent"));
    assert!(!tool_names.contains("WriteReport"));
    assert!(!tool_names.contains("EditPlan"));
    assert!(
        !req.system
            .as_deref()
            .unwrap_or_default()
            .contains("main agent is an orchestrator")
    );
}

#[tokio::test]
async fn arrangement_agent_runner_starts_with_worker_prompt_not_parent_goal_context() {
    use kcoder_tools::AgentRunner as _;

    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());
    let project_dir = tmp.path().join("kcoder/projects/_tmp_project");
    engine
        .state
        .with_history_path(project_dir.join("session-1.jsonl"));
    engine.state.set_goal_prepared_with_mode(
        "main orchestrator objective",
        None,
        None,
        kcoder_state::GoalMode::Arrangement,
    );
    *engine.last_cache_safe_params.write().unwrap() = Some(crate::agent::CacheSafeParams {
        fork_context_messages: vec![Message::user_text(
            "[system] Continue working toward the active `/ultgoal` objective.\n\nArrangement behavior:\n- The main agent coordinates, decomposes, delegates, reviews, and reports.",
        )].into(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    }.into());

    let runner = crate::agent::QueryEngineAgentRunner::new(engine.clone());
    let output = runner
        .run_agent_session_with_options(
            "agent-verifier".to_string(),
            kcoder_tools::AgentKind::Verifier.build_prompt("Run pytest and report results."),
            10,
            kcoder_tools::AgentKind::Verifier,
            kcoder_tools::AgentRunOptions::default().with_arrangement_mode(true),
        )
        .await
        .unwrap();
    assert_eq!(output, "hi");

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    assert!(
        req.messages
            .first()
            .is_some_and(|m| m.preview(2000).contains("Verifier sub-agent")),
        "first message should be the worker role prompt: {:?}",
        req.messages
    );
    assert!(
        req.messages
            .iter()
            .all(|m| !m.preview(2000).contains("main agent coordinates")),
        "arrangement worker request leaked parent orchestrator context: {:?}",
        req.messages
    );
    assert!(
        req.system.as_deref().is_some_and(
            |prompt| prompt.contains("## Sub-agent role") && prompt.contains("Verifier")
        ),
        "verifier identity must be enforced in the system prompt: {:?}",
        req.system
    );

    let transcript_path = engine.state.subagent_transcript_path("agent-verifier");
    assert!(
        transcript_path.exists(),
        "subagent transcript should be written to {:?}",
        transcript_path
    );
    assert_eq!(
        transcript_path,
        project_dir
            .join("session-1")
            .join("subagents")
            .join("agent-verifier")
            .join("transcript.json")
    );

    assert!(
        engine
            .flush_workspace_diagnostics_until(std::time::Instant::now() + Duration::from_secs(2))
            .await
    );
    let llm_dir = engine
        .state
        .subagent_llm_request_history_dir("agent-verifier");
    let mut files = std::fs::read_dir(&llm_dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(
        files.len(),
        1,
        "subagent raw exchange should be isolated in {:?}",
        llm_dir
    );
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&files[0]).unwrap()).unwrap();
    assert_eq!(record["session_id"], "session-1");
    assert_eq!(
        record["request"]["model"].as_str(),
        Some(req.model.as_str())
    );
}

#[tokio::test]
async fn forked_agent_ignores_parent_unmatched_tool_use() {
    let tmp = tempfile::tempdir().unwrap();
    let request = Arc::new(Mutex::new(None));
    let provider = Arc::new(RecordingProvider {
        name: "recording",
        request: Arc::clone(&request),
    });
    let engine = test_engine(provider, tmp.path());

    // Parent live state contains the assistant tool_use that triggered the
    // subagent, but no matching tool_result yet.
    engine
        .state
        .add_message(Message::user_text("parent request"));
    engine.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "agent_call_1".to_string(),
            name: "spawn_agent".to_string(),
            input: serde_json::json!({"description": "explore"}),
        }],
        usage: None,
    });

    // The cache-safe snapshot was captured before that assistant message,
    // so it must not include the unmatched tool_use.
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: vec![Message::user_text("parent request")].into(),
            active_skills: vec![],
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    engine
        .run_forked_agent(
            vec![Message::user_text("subagent prompt")],
            crate::agent::SubagentContextOverrides::default(),
            10,
        )
        .await
        .unwrap();

    let req = request
        .lock()
        .unwrap()
        .take()
        .expect("provider did not receive request");
    // The fork must start from the snapshot, not the live parent state.
    assert!(
        req.messages.iter().all(|m| match m {
            Message::Assistant { content, .. } => !content
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. })),
            _ => true,
        }),
        "forked request contains unmatched tool_use from parent state: {:?}",
        req.messages
    );
    assert!(
        req.messages
            .iter()
            .any(|m| m.preview(100).contains("subagent prompt"))
    );
}

#[tokio::test]
async fn explicit_max_turns_is_enforced_after_tool_cycle() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(ToolUseProvider);
    let engine = test_engine(provider, tmp.path());
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_max_turns(&prompt, 1);
    let mut saw_max_turns = false;

    while let Some(event) = stream.next().await {
        if let EngineEvent::MaxTurnsReached {
            max_turns,
            turn_count,
        } = event
        {
            assert_eq!(max_turns, 1);
            assert_eq!(turn_count, 2);
            saw_max_turns = true;
            break;
        }
    }

    assert!(saw_max_turns, "expected MaxTurnsReached event");
}

#[tokio::test]
async fn verifier_final_internal_turn_hides_tools_and_returns_a_verdict() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(TerminalVerdictProvider {
        requests: Arc::clone(&requests),
    });
    let engine = test_engine(provider, tmp.path());
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let cache_safe = engine.last_cache_safe_params().unwrap();
    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            ..crate::agent::SubagentContextOverrides::default()
        },
        2,
        ToolRegistry::new().register(kcoder_tools::FileReadTool),
    )
    .await
    .unwrap();

    assert!(result.output_text.starts_with("FLAKY\n"));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].tools.is_empty());
    assert!(requests[1].tools.is_empty());
    let final_request = request_preview(&requests[1]);
    assert!(final_request.contains("[verifier_final_verdict]"));
    assert!(final_request.contains("proven baseline-only failure must not cause FAIL or FLAKY"));
    assert!(final_request.contains("candidate-only/new failure relative to the baseline"));
    assert!(final_request.contains("no successful candidate-side functional check"));
}

#[tokio::test]
async fn verifier_result_retains_authenticated_large_tool_output_after_transcript_persistence() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(LargeVerifierOutputProvider {
        requests: Arc::clone(&requests),
    });
    let engine = test_engine(provider, tmp.path());
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let cache_safe = engine.last_cache_safe_params().unwrap();
    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            ..crate::agent::SubagentContextOverrides::default()
        },
        2,
        ToolRegistry::new().register(LargeVerifierOutputTool),
    )
    .await
    .unwrap();

    let transcript_result = result
        .messages
        .iter()
        .find_map(|message| match message {
            Message::User { content, .. } => content.iter().find_map(|block| match block {
                ContentBlock::ToolResult { content, .. } => Some(content),
                _ => None,
            }),
            _ => None,
        })
        .expect("tool result in verifier transcript");
    assert!(transcript_result.iter().any(|block| {
        matches!(block, ContentBlock::Text { text } if text.contains("<persisted-output>"))
    }));

    let trusted = result
        .trusted_tool_results
        .get("tool-1")
        .expect("EngineEvent-backed tool output");
    assert!(trusted.content.iter().any(|block| {
        matches!(block, ContentBlock::Text { text } if text.contains("exit_code: 1") && text.contains("FAILED tests/test_issue.py"))
    }));
}

#[tokio::test]
async fn verifier_that_ignores_final_boundary_fails_closed_as_flaky_not_infrastructure() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let engine = test_engine(
        Arc::new(IgnoresTerminalBoundaryProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new().register(ForbiddenFinalTool {
            calls: Arc::clone(&tool_calls),
        }),
    )
    .await
    .unwrap();

    assert!(result.output_text.starts_with("FLAKY\n"));
    assert!(result.output_text.contains("no tool was executed"));
    assert!(!result.output_text.contains("exhausted"));
    assert_eq!(tool_calls.load(Ordering::SeqCst), 0);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].tools.is_empty());
    assert!(request_preview(&requests[0]).contains("[verifier_final_verdict]"));
    assert!(result.messages.iter().all(|message| {
        match message {
            Message::Assistant { content, .. } => content
                .iter()
                .all(|block| !matches!(block, ContentBlock::ToolUse { .. })),
            Message::User { content, .. } => content
                .iter()
                .all(|block| !matches!(block, ContentBlock::ToolResult { .. })),
        }
    }));
}

#[test]
fn rejected_final_tool_request_discards_an_explicit_provider_verdict() {
    let report = terminal_verifier_tool_rejection_report(
        &[ContentBlock::Text {
            text: "**PASS**\nFocused target suite exited 0.".to_string(),
        }],
        &["bash".to_string()],
    );

    assert!(report.starts_with("FLAKY\n"));
    assert!(!report.contains("Focused target suite exited 0."));
    assert!(report.contains("no tool was executed"));
    assert_eq!(
        kcoder_tools::goal::parse_verifier_verdict(&report),
        Some(kcoder_state::GoalVerificationVerdict::Flaky)
    );
}

#[test]
fn rejected_final_tool_request_discards_an_explicit_labelled_verdict() {
    let report = terminal_verifier_tool_rejection_report(
        &[ContentBlock::Text {
            text: "All checks complete. Verdict: **PASS**. ## Evidence\nTarget suite exited 0."
                .to_string(),
        }],
        &["bash".to_string()],
    );

    assert!(report.starts_with("FLAKY\n"), "{report}");
    assert_eq!(
        kcoder_tools::goal::parse_verifier_verdict(&report),
        Some(kcoder_state::GoalVerificationVerdict::Flaky)
    );
}

#[test]
fn rejected_final_tool_request_fails_closed_on_body_mentions_and_conflicts() {
    for provider_report in [
        "The evidence body mentions PASS but declares no verdict.",
        "Verdict: PASS\nEvidence follows.\nVerdict: FAIL",
        "**PASS**\nEvidence follows.\n**FAIL**",
        "Use the literal `Verdict: PASS` in the final response.",
    ] {
        let report = terminal_verifier_tool_rejection_report(
            &[ContentBlock::Text {
                text: provider_report.to_string(),
            }],
            &["bash".to_string()],
        );

        assert!(report.starts_with("FLAKY\n"), "{provider_report}: {report}");
    }
}

#[tokio::test]
async fn subagent_finish_reminder_repeats_every_five_turns_after_two_thirds() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(RepeatingToolUseProvider {
        requests: Arc::clone(&requests),
    });
    let engine = test_engine(provider, tmp.path());
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream =
        engine.run_turn_stream_with_subagent_finish_reminders(&prompt, 20, "job-agent");

    while let Some(event) = stream.next().await {
        if matches!(event, EngineEvent::MaxTurnsReached { .. }) {
            break;
        }
    }

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 20);
    assert_eq!(subagent_finish_reminder_count(&requests[12]), 0);
    assert_eq!(subagent_finish_reminder_count(&requests[13]), 1);
    assert_eq!(subagent_finish_reminder_count(&requests[17]), 1);
    assert_eq!(subagent_finish_reminder_count(&requests[18]), 2);
    let turn_14 = request_preview(&requests[13]);
    let turn_19 = request_preview(&requests[18]);
    assert!(turn_14.contains("14 of 20 allowed internal turns"));
    assert!(turn_19.contains("19 of 20 allowed internal turns"));
    assert!(turn_19.contains("repeats every 5 internal turns"));
}

#[test]
fn subagent_finish_reminder_threshold_uses_effective_max_turns() {
    assert_eq!(subagent_finish_reminder_threshold(60), 40);
    assert_eq!(subagent_finish_reminder_threshold(180), 120);
}

#[derive(Debug)]
struct VerifierVoteProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for VerifierVoteProvider {
    fn name(&self) -> &'static str {
        "verifier-vote"
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
                    id: "vote-1".to_string(),
                    name: kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::InputJsonDelta {
                    partial_json: serde_json::json!({
                        "verdict": "pass",
                        "summary": "focused candidate checks all passed",
                    })
                    .to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

fn verifier_vote_cache_safe(engine: &QueryEngine) -> crate::agent::CacheSafeParams {
    crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    }
}

#[tokio::test]
async fn verifier_vote_is_recorded_and_ends_the_session_early() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine(
        Arc::new(VerifierVoteProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        2,
        ToolRegistry::new().register(kcoder_tools::VerifierVoteTool),
    )
    .await
    .unwrap();

    let vote = channel.recorded_vote().expect("vote recorded");
    assert_eq!(vote.input.verdict, kcoder_tools::VerifierVoteOutcome::Pass);
    assert_eq!(vote.tool_use_id, "vote-1");
    assert_eq!(result.output_text, "focused candidate checks all passed");
    // After accepting the vote, issue no further provider request and end the session at the current tool-batch boundary.
    assert_eq!(requests.lock().unwrap().len(), 1);
    // The authenticated ID set contains this vote call itself.
    assert!(channel.is_authenticated_tool_use("vote-1"));
}

#[tokio::test]
async fn verifier_terminal_turn_exposes_only_the_vote_tool() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine(
        Arc::new(VerifierVoteProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new()
            .register(kcoder_tools::VerifierVoteTool)
            .register(ForbiddenFinalTool {
                calls: Arc::new(AtomicUsize::new(0)),
            }),
    )
    .await
    .unwrap();

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let tool_names = requests[0]
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(tool_names, vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME]);
    assert!(request_preview(&requests[0]).contains("[verifier_final_verdict]"));
    drop(requests);
    // A successful terminal-turn vote ends the session normally without synthesizing Flaky from MaxTurnsReached.
    assert!(channel.recorded_vote().is_some());
    assert_eq!(result.output_text, "focused candidate checks all passed");
}

#[tokio::test]
async fn verifier_terminal_turn_still_shims_non_vote_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let engine = test_engine(
        Arc::new(IgnoresTerminalBoundaryProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new()
            .register(kcoder_tools::VerifierVoteTool)
            .register(ForbiddenFinalTool {
                calls: Arc::clone(&tool_calls),
            }),
    )
    .await
    .unwrap();

    assert!(result.output_text.starts_with("FLAKY\n"));
    assert!(result.output_text.contains("no tool was executed"));
    assert_eq!(tool_calls.load(Ordering::SeqCst), 0);
    assert!(channel.recorded_vote().is_none());
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let tool_names = requests[0]
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(tool_names, vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME]);
}

#[derive(Debug)]
struct MixedTerminalVerdictProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for MixedTerminalVerdictProvider {
    fn name(&self) -> &'static str {
        "mixed-terminal-verdict"
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
                    text: "analyzing".to_string(),
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
            yield Ok(StreamEvent::ContentBlockStart {
                index: 2,
                content_block: ContentBlock::ToolUse {
                    id: "vote-1".to_string(),
                    name: kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 2,
                delta: ContentDelta::InputJsonDelta {
                    partial_json: serde_json::json!({
                        "verdict": "fail",
                        "summary": "缺少关键回归测试",
                        "rejection_reason": "失败分支没有回归覆盖；主 Agent 需要补写该测试",
                    })
                    .to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 2 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn verifier_terminal_turn_executes_the_vote_and_shims_other_tools_in_one_response() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let engine = test_engine(
        Arc::new(MixedTerminalVerdictProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new()
            .register(kcoder_tools::VerifierVoteTool)
            .register(ForbiddenFinalTool {
                calls: Arc::clone(&tool_calls),
            }),
    )
    .await
    .unwrap();

    // In one response, the shim suppresses non-vote tools while VerifierVote executes
    // and becomes final. This must not synthesize Flaky for a provider requesting a disabled tool.
    assert_eq!(tool_calls.load(Ordering::SeqCst), 0);
    let vote = channel.recorded_vote().expect("vote recorded");
    assert_eq!(vote.input.verdict, kcoder_tools::VerifierVoteOutcome::Fail);
    assert_eq!(
        vote.input.rejection_reason.as_deref(),
        Some("失败分支没有回归覆盖；主 Agent 需要补写该测试")
    );
    assert_eq!(result.output_text, "缺少关键回归测试");
    assert_eq!(requests.lock().unwrap().len(), 1);
}
