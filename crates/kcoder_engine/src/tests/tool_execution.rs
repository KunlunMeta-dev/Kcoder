#[derive(Debug)]
struct ToolUseOnceProvider {
    emitted: AtomicBool,
}

impl Provider for ToolUseOnceProvider {
    fn name(&self) -> &'static str {
        "tool-use-once"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let first = !self.emitted.swap(true, Ordering::SeqCst);
        let stream = async_stream::stream! {
            if first {
                for (index, id, name) in [
                    (0usize, "safe-1", "safe_tool"),
                    (1usize, "safe-2", "safe_tool"),
                    (2usize, "unsafe-1", "unsafe_tool"),
                    (3usize, "unsafe-2", "unsafe_tool"),
                ] {
                    yield Ok(StreamEvent::ContentBlockStart {
                        index,
                        content_block: ContentBlock::ToolUse {
                            id: id.to_string(),
                            name: name.to_string(),
                            input: serde_json::json!({}),
                        },
                    });
                    yield Ok(StreamEvent::ContentBlockStop { index });
                }
            }
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug)]
struct DelayedStopToolUseProvider {
    emitted: AtomicBool,
}

impl Provider for DelayedStopToolUseProvider {
    fn name(&self) -> &'static str {
        "delayed-stop-tool-use"
    }

    fn stream_messages(
        &self,
        _request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let first = !self.emitted.swap(true, Ordering::SeqCst);
        let stream = async_stream::stream! {
            if first {
                for (index, id, input) in [
                    (0usize, "tool-a", serde_json::json!({"label": "alpha", "value": 1})),
                    (1usize, "tool-b", serde_json::json!({"label": "beta", "value": 2})),
                    (2usize, "tool-c", serde_json::json!({"label": "gamma", "value": 3})),
                ] {
                    yield Ok(StreamEvent::ContentBlockStart {
                        index,
                        content_block: ContentBlock::ToolUse {
                            id: id.to_string(),
                            name: "input_echo".to_string(),
                            input: serde_json::json!({}),
                        },
                    });
                    for partial_json in input.to_string().chars().map(|value| value.to_string()) {
                        yield Ok(StreamEvent::ContentBlockDelta {
                            index,
                            delta: ContentDelta::InputJsonDelta { partial_json },
                        });
                    }
                }
                for index in 0..3 {
                    yield Ok(StreamEvent::ContentBlockStop { index });
                }
            }
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[derive(Debug, Default)]
struct ConcurrencyRecord {
    active: AtomicUsize,
    max_active: AtomicUsize,
    events: Mutex<Vec<String>>,
}

#[derive(Debug)]
struct ConcurrencyTool {
    name: &'static str,
    safe: bool,
    record: Arc<ConcurrencyRecord>,
    timeline: Arc<Mutex<Vec<String>>>,
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for ConcurrencyTool {
    fn name(&self) -> String {
        self.name.to_string()
    }

    fn description(&self) -> String {
        "test concurrency tool".to_string()
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.safe
    }

    async fn call(
        &self,
        _input: Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let active = self.record.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.record.max_active.fetch_max(active, Ordering::SeqCst);
        self.record
            .events
            .lock()
            .unwrap()
            .push(format!("start:{}", self.name));
        self.timeline
            .lock()
            .unwrap()
            .push(format!("start:{}", self.name));
        tokio::time::sleep(Duration::from_millis(40)).await;
        self.record
            .events
            .lock()
            .unwrap()
            .push(format!("end:{}", self.name));
        self.timeline
            .lock()
            .unwrap()
            .push(format!("end:{}", self.name));
        self.record.active.fetch_sub(1, Ordering::SeqCst);
        Ok(ToolOutput::text(self.name))
    }
}

#[derive(Debug)]
struct InputEchoTool {
    seen: Arc<Mutex<Vec<Value>>>,
}

#[async_trait::async_trait]
impl kcoder_tools::Tool for InputEchoTool {
    fn name(&self) -> String {
        "input_echo".to_string()
    }

    fn description(&self) -> String {
        "records its input for tests".to_string()
    }

    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "additionalProperties": true
        })
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(
        &self,
        input: Value,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        self.seen.lock().unwrap().push(input.clone());
        Ok(ToolOutput::text(input.to_string()))
    }
}

#[tokio::test]
async fn indexed_tool_use_deltas_survive_delayed_content_block_stops() {
    let tmp = tempfile::tempdir().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        ..Settings::default()
    };
    let engine = QueryEngine::new(
        Arc::new(DelayedStopToolUseProvider {
            emitted: AtomicBool::new(false),
        }),
        AppState::new(tmp.path()),
        ToolRegistry::new().register(InputEchoTool {
            seen: Arc::clone(&seen),
        }),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    engine
        .state
        .add_message(Message::user_text("run indexed tool uses"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    let mut tool_input_progress = Vec::new();
    while let Some(event) = stream.next().await {
        if let EngineEvent::ToolInputProgress { id, name, chars } = event {
            assert!(
                !id.is_empty(),
                "tool input progress must carry the tool use id"
            );
            tool_input_progress.push((name, chars));
        }
    }

    assert_eq!(tool_input_progress.len(), 6);
    for events in tool_input_progress.chunks_exact(2) {
        assert_eq!(events[0], ("input_echo".to_string(), 0));
        assert_eq!(events[1].0, "input_echo");
        assert!(events[1].1 > 0);
    }

    let messages = engine.state.messages();
    let assistant_tool_inputs = messages
        .iter()
        .find_map(|message| {
            let Message::Assistant { content, .. } = message else {
                return None;
            };
            let inputs = content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse { id, input, .. } => Some((id.clone(), input.clone())),
                    _ => None,
                })
                .collect::<Vec<_>>();
            (!inputs.is_empty()).then_some(inputs)
        })
        .expect("assistant tool uses");
    assert_eq!(
        assistant_tool_inputs,
        vec![
            (
                "tool-a".to_string(),
                serde_json::json!({"label": "alpha", "value": 1})
            ),
            (
                "tool-b".to_string(),
                serde_json::json!({"label": "beta", "value": 2})
            ),
            (
                "tool-c".to_string(),
                serde_json::json!({"label": "gamma", "value": 3})
            ),
        ]
    );

    let tool_results = messages
        .iter()
        .flat_map(|message| match message {
            Message::User { content, .. } => content.as_slice(),
            _ => &[],
        })
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                is_error,
                ..
            } => Some((tool_use_id.clone(), is_error.unwrap_or(false))),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        tool_results,
        vec![
            ("tool-a".to_string(), false),
            ("tool-b".to_string(), false),
            ("tool-c".to_string(), false),
        ]
    );

    let mut seen = seen.lock().unwrap().clone();
    seen.sort_by_key(|value| {
        value
            .get("value")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default()
    });
    assert_eq!(
        seen,
        vec![
            serde_json::json!({"label": "alpha", "value": 1}),
            serde_json::json!({"label": "beta", "value": 2}),
            serde_json::json!({"label": "gamma", "value": 3}),
        ]
    );
}

#[tokio::test]
async fn tool_execution_groups_safe_tools_and_serializes_unsafe_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let safe = Arc::new(ConcurrencyRecord::default());
    let unsafe_record = Arc::new(ConcurrencyRecord::default());
    let timeline = Arc::new(Mutex::new(Vec::new()));
    let settings = Settings {
        permission_mode: PermissionMode::Bypass,
        ..Settings::default()
    };
    let engine = QueryEngine::new(
        Arc::new(ToolUseOnceProvider {
            emitted: AtomicBool::new(false),
        }),
        AppState::new(tmp.path()),
        ToolRegistry::new()
            .register(ConcurrencyTool {
                name: "safe_tool",
                safe: true,
                record: Arc::clone(&safe),
                timeline: Arc::clone(&timeline),
            })
            .register(ConcurrencyTool {
                name: "unsafe_tool",
                safe: false,
                record: Arc::clone(&unsafe_record),
                timeline: Arc::clone(&timeline),
            }),
        PermissionEngine::from_settings(&settings),
        settings,
        MemoryManager::global_only(MemoryStore::empty()),
        SkillRegistry::load_project_only(tmp.path()).unwrap(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        tmp.path().to_path_buf(),
    );
    engine
        .state
        .add_message(Message::user_text("run grouped tools"));

    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while stream.next().await.is_some() {}

    assert_eq!(safe.max_active.load(Ordering::SeqCst), 2);
    assert_eq!(unsafe_record.max_active.load(Ordering::SeqCst), 1);
    let safe_events = safe.events.lock().unwrap().clone();
    let unsafe_events = unsafe_record.events.lock().unwrap().clone();
    assert_eq!(
        safe_events
            .iter()
            .filter(|event| event.starts_with("start"))
            .count(),
        2
    );
    assert_eq!(
        unsafe_events,
        vec![
            "start:unsafe_tool".to_string(),
            "end:unsafe_tool".to_string(),
            "start:unsafe_tool".to_string(),
            "end:unsafe_tool".to_string(),
        ]
    );
    let timeline = timeline.lock().unwrap().clone();
    let first_unsafe_start = timeline
        .iter()
        .position(|event| event == "start:unsafe_tool")
        .unwrap();
    let last_safe_end = timeline
        .iter()
        .rposition(|event| event == "end:safe_tool")
        .unwrap();
    assert!(first_unsafe_start > last_safe_end);
}

#[test]
fn partition_tool_uses_runs_real_explore_agents_in_one_parallel_group() {
    let registry = ToolRegistry::new().register(kcoder_tools::ExploreAgentTool);
    let groups = partition_tool_uses(
        vec![
            ToolUseItem {
                index: 0,
                id: "explore-a".to_string(),
                name: "explore_agent".to_string(),
                input: serde_json::json!({"message": "inspect parser"}),
            },
            ToolUseItem {
                index: 1,
                id: "explore-b".to_string(),
                name: "explore_agent".to_string(),
                input: serde_json::json!({"message": "inspect renderer"}),
            },
        ],
        &registry,
    );

    assert_eq!(groups.len(), 1);
    assert!(!groups[0].sequential);
    assert_eq!(groups[0].items.len(), 2);
}

#[derive(Debug)]
struct RequestBoundToolUseProvider {
    emitted: AtomicBool,
    live_settings: Mutex<Option<Arc<std::sync::RwLock<Settings>>>>,
    enable_after_request: bool,
    observed_attachment: Mutex<Vec<bool>>,
}

impl Provider for RequestBoundToolUseProvider {
    fn name(&self) -> &'static str { "request-bound-tool-fixture" }
    fn stream_messages(&self, request: MessagesRequest) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let first = !self.emitted.swap(true, Ordering::SeqCst);
        self.observed_attachment.lock().unwrap().push(request.tools.iter().any(|tool| tool.name == "request_bound_write"));
        if first {
            self.live_settings.lock().unwrap().as_ref().unwrap().write().unwrap().model_capabilities.tools = self.enable_after_request;
        }
        Ok(Box::pin(async_stream::stream! {
            if first {
                yield Ok(StreamEvent::ContentBlockStart { index: 0, content_block: ContentBlock::ToolUse {
                    id: "unsolicited-or-attached".into(), name: "request_bound_write".into(), input: serde_json::json!({}),
                }});
                yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            }
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}

struct RequestBoundWriteTool { target: std::path::PathBuf, calls: Arc<AtomicUsize> }
#[async_trait::async_trait]
impl kcoder_tools::Tool for RequestBoundWriteTool {
    fn name(&self) -> String { "request_bound_write".into() }
    fn description(&self) -> String { "Write the test marker".into() }
    fn input_schema(&self) -> Value { serde_json::json!({"type":"object","properties":{}}) }
    async fn call(&self, _: Value, _: &kcoder_tools::ToolContext) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::fs::write(&self.target, "executed").await.unwrap();
        Ok(kcoder_tools::ToolOutput::text("marker written"))
    }
}

#[tokio::test]
async fn model_tool_execution_uses_request_allowset_even_when_capability_changes_mid_response() {
    for originally_attached in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("side-effect.txt");
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = Arc::new(RequestBoundToolUseProvider {
            emitted: AtomicBool::new(false), live_settings: Mutex::new(None),
            enable_after_request: !originally_attached, observed_attachment: Mutex::new(vec![]),
        });
        let mut settings = Settings { permission_mode: PermissionMode::Bypass, ..Settings::default() };
        settings.model_capabilities.tools = originally_attached;
        let engine = TestEngineBuilder::new(root.path()).settings(settings).provider(provider.clone())
            .tool_registry(ToolRegistry::new().register(RequestBoundWriteTool { target: target.clone(), calls: calls.clone() })).build();
        *provider.live_settings.lock().unwrap() = Some(engine.settings.clone());
        engine.state.add_message(Message::user_text("exercise request-bound capability"));
        let prompt = kcoder_permissions::AutoAllowPrompt;
        let mut events = engine.run_turn_stream(&prompt);
        let mut tool_errors = vec![];
        while let Some(event) = events.next().await {
            if let EngineEvent::ToolResult { name, output, .. } = event {
                if name == "request_bound_write" { tool_errors.push(output.is_error); }
            }
        }
        assert_eq!(provider.observed_attachment.lock().unwrap()[0], originally_attached);
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(originally_attached));
        assert_eq!(target.exists(), originally_attached);
        assert_eq!(tool_errors, vec![!originally_attached]);
    }
}

#[tokio::test]
async fn workflow_generation_mode_rejects_forged_execution_tools() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("must-not-exist");
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(RequestBoundToolUseProvider {
        emitted: AtomicBool::new(false), live_settings: Mutex::new(None),
        enable_after_request: true, observed_attachment: Mutex::new(vec![]),
    });
    let settings = Settings { permission_mode: PermissionMode::Bypass, ..Settings::default() };
    let engine = TestEngineBuilder::new(root.path()).settings(settings).provider(provider.clone())
        .tool_registry(kcoder_tools::default_registry().register(RequestBoundWriteTool { target: target.clone(), calls: calls.clone() })).build();
    engine.state.enter_workflow_draft_before_first_message().unwrap();
    engine.enable_moa_for_next_turn(None);
    assert!(engine.take_moa_for_next_turn().is_none());
    assert!(engine.moa_plan_preflight().unwrap_err().to_string().contains("Workflow draft"));
    let names = engine.tool_definitions_for_model().await.into_iter().map(|tool| tool.name).collect::<Vec<_>>();
    assert_eq!(names, ["WorkflowDraft"]);
    assert!(engine.start_workflow(serde_json::json!({"script":"return 1;"})).await.is_err());
    *provider.live_settings.lock().unwrap() = Some(engine.settings.clone());
    engine.state.add_message(Message::user_text("Generate a graph only"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut events = engine.run_turn_stream(&prompt);
    let mut denied = false;
    while let Some(event) = events.next().await {
        if let EngineEvent::ToolResult { name, output, .. } = event {
            if name == "request_bound_write" { denied = output.is_error; }
        }
    }
    assert!(denied);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!target.exists());
}
