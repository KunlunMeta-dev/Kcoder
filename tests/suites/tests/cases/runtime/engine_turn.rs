use async_trait::async_trait;
use futures::{StreamExt, stream};
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::Settings;
use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_permissions::{AutoAllowPrompt, PermissionEngine};
use kcoder_skills::SkillRegistry;
use kcoder_state::AppState;
use kcoder_tools::{DenyAllUserQuestioner, Tool, ToolContext, ToolError, ToolOutput, ToolRegistry};
use kcoder_types::{ContentBlock, ContentDelta, Message, MessagesRequest, StreamEvent};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const TOOL_ID: &str = "fixture-tool-call-1";
const TOOL_NAME: &str = "fixture_echo";

#[derive(Debug)]
struct EchoTool {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> String {
        TOOL_NAME.to_string()
    }

    fn description(&self) -> String {
        "返回输入文本".to_string()
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"]
        })
    }

    async fn call(&self, input: Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let text = input["text"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidInput("缺少 text".to_string()))?;
        Ok(ToolOutput::text(format!("echo:{text}")))
    }
}

#[derive(Debug)]
struct ToolThenAnswerProvider {
    calls: Arc<AtomicUsize>,
    observed_tool_result: Arc<AtomicBool>,
}

impl Provider for ToolThenAnswerProvider {
    fn name(&self) -> &'static str {
        "tool-then-answer"
    }

    fn stream_messages(&self, request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let events = if call == 0 {
            vec![
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::ToolUse {
                        id: TOOL_ID.to_string(),
                        name: TOOL_NAME.to_string(),
                        input: serde_json::json!({}),
                    },
                }),
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::InputJsonDelta {
                        partial_json: r#"{"text":"hello"}"#.to_string(),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ]
        } else {
            assert_eq!(call, 1, "引擎只应向脚本 Provider 请求两次");
            let has_result = request.messages.iter().any(|message| match message {
                Message::User { content } => content.iter().any(|block| {
                    matches!(
                        block,
                        ContentBlock::ToolResult { tool_use_id, content, is_error }
                            if tool_use_id == TOOL_ID
                                && is_error != &Some(true)
                                && content.iter().any(|part| matches!(
                                    part,
                                    ContentBlock::Text { text } if text == "echo:hello"
                                ))
                    )
                }),
                Message::Assistant { .. } => false,
            });
            assert!(
                has_result,
                "第二次 Provider 请求必须包含配对的 ToolResult: {:#?}",
                request.messages
            );
            self.observed_tool_result.store(true, Ordering::SeqCst);
            vec![
                Ok(StreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: ContentBlock::Text {
                        text: String::new(),
                    },
                }),
                Ok(StreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: ContentDelta::TextDelta {
                        text: "最终回答".to_string(),
                    },
                }),
                Ok(StreamEvent::ContentBlockStop { index: 0 }),
                Ok(StreamEvent::MessageStop),
            ]
        };
        Ok(Box::pin(stream::iter(events)))
    }
}

struct PendingProvider {
    calls: Arc<AtomicUsize>,
    entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Provider for PendingProvider {
    fn name(&self) -> &'static str {
        "pending"
    }

    fn stream_messages(&self, _request: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(sender) = self.entered.lock().expect("entered 锁不应中毒").take() {
            let _ = sender.send(());
        }
        Ok(Box::pin(stream::pending()))
    }
}

fn engine(provider: Arc<dyn Provider>, tools: ToolRegistry, path: &std::path::Path) -> QueryEngine {
    let settings = Settings::default();
    let state = AppState::new(path);
    state.add_message(Message::user_text("请执行测试工具"));
    QueryEngine::new_for_client(
        provider,
        state,
        tools,
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::empty(),
        Arc::new(DenyAllUserQuestioner),
        path.to_path_buf(),
    )
}

#[tokio::test]
async fn engine_turn_executes_tool_and_feeds_result_back_to_provider() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let temp = tempfile::tempdir().expect("应创建临时目录");
        let provider_calls = Arc::new(AtomicUsize::new(0));
        let tool_calls = Arc::new(AtomicUsize::new(0));
        let observed_tool_result = Arc::new(AtomicBool::new(false));
        let provider = Arc::new(ToolThenAnswerProvider {
            calls: Arc::clone(&provider_calls),
            observed_tool_result: Arc::clone(&observed_tool_result),
        });
        let registry = ToolRegistry::new().register(EchoTool {
            calls: Arc::clone(&tool_calls),
        });
        let engine = engine(provider, registry, temp.path());

        let events = engine
            .run_turn_stream(&AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        let assistant_started = events
            .iter()
            .enumerate()
            .filter_map(|(index, event)| matches!(event, EngineEvent::AssistantMessageStarted).then_some(index))
            .collect::<Vec<_>>();
        let assistant_done = events
            .iter()
            .enumerate()
            .filter_map(|(index, event)| matches!(event, EngineEvent::AssistantMessageDone).then_some(index))
            .collect::<Vec<_>>();
        let tool_started = events
            .iter()
            .position(|event| matches!(
                event,
                EngineEvent::ToolUseStarted { id, name, .. }
                    if id == TOOL_ID && name == TOOL_NAME
            ))
            .expect("应发出带原始 ID 的 ToolUseStarted");
        let tool_result = events
            .iter()
            .position(|event| matches!(
                event,
                EngineEvent::ToolResult { id, name, output }
                    if id == TOOL_ID
                        && name == TOOL_NAME
                        && matches!(output.content.as_slice(), [ContentBlock::Text { text }] if text == "echo:hello")
            ))
            .expect("应发出配对的 ToolResult");
        let final_text = events
            .iter()
            .position(|event| matches!(event, EngineEvent::AssistantTextDelta(text) if text == "最终回答"))
            .expect("第二轮应输出最终文本");

        assert_eq!(assistant_started.len(), 2, "每次 Provider 响应必须且只能开始一次 assistant message");
        assert_eq!(assistant_done.len(), 2, "每次 Provider 响应必须且只能结束一次 assistant message");
        assert!(
            assistant_started[0] < tool_started
                && tool_started < assistant_done[0]
                && assistant_done[0] < tool_result
                && tool_result < assistant_started[1]
                && assistant_started[1] < final_text
                && final_text < assistant_done[1],
            "tool loop 事件顺序错误: {events:#?}"
        );
        assert_eq!(assistant_done[1], events.len() - 1, "最终 Done 必须是轮次最后一个事件");
        assert_eq!(provider_calls.load(Ordering::SeqCst), 2);
        assert_eq!(tool_calls.load(Ordering::SeqCst), 1);
        assert!(observed_tool_result.load(Ordering::SeqCst));
    })
    .await
    .expect("真实引擎轮次测试总时限为 5 秒");
}

#[tokio::test]
async fn engine_turn_cancellation_aborts_pending_provider_without_running_tools() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let temp = tempfile::tempdir().expect("应创建临时目录");
        let provider_calls = Arc::new(AtomicUsize::new(0));
        let tool_calls = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let provider = Arc::new(PendingProvider {
            calls: Arc::clone(&provider_calls),
            entered: Mutex::new(Some(entered_tx)),
        });
        let registry = ToolRegistry::new().register(EchoTool {
            calls: Arc::clone(&tool_calls),
        });
        let engine = engine(provider, registry, temp.path());
        let cancel = CancellationToken::new();
        let mut events = engine.run_turn_stream_with_cancel(&AutoAllowPrompt, cancel.clone());
        let reason = {
            let receive_abort = async {
                while let Some(event) = events.next().await {
                    if let EngineEvent::StreamAborted { reason } = event {
                        return reason;
                    }
                }
                panic!("取消后事件流不应无声结束");
            };
            tokio::pin!(receive_abort);

            tokio::select! {
                result = &mut receive_abort => panic!("Provider 挂起前事件流意外结束: {result}"),
                entered = entered_rx => entered.expect("Provider 应报告已进入"),
            }
            cancel.cancel();
            tokio::time::timeout(Duration::from_secs(1), &mut receive_abort)
                .await
                .expect("取消应在 1 秒内生效")
        };
        assert!(reason.to_ascii_lowercase().contains("cancel"));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), events.next())
                .await
                .expect("取消后事件流必须及时终止")
                .is_none(),
            "StreamAborted 后不应再产生任何事件"
        );
        assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
        assert_eq!(tool_calls.load(Ordering::SeqCst), 0);
    })
    .await
    .expect("取消边界测试总时限为 5 秒");
}
