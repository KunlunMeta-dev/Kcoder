use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_types::{ClientPresentationV1, StudioWorkMode};
use serde_json::json;
use std::sync::atomic::AtomicUsize;

#[derive(Debug)]
struct Extension {
    name: String,
    calls: Arc<AtomicUsize>,
    visible: bool,
    provenance: Option<ToolSource>,
}

#[async_trait::async_trait]
impl Tool for Extension {
    fn name(&self) -> String {
        self.name.clone()
    }
    fn source(&self) -> ToolSource {
        if let Some(source) = &self.provenance {
            return source.clone();
        }
        if self.name.starts_with("plugin__") {
            return ToolSource::Plugin {
                plugin: "office-plugin".into(),
                server: "office".into(),
                tool: self.name.clone(),
            };
        }
        ToolSource::Mcp {
            server: "office".into(),
            tool: self.name.clone(),
        }
    }
    fn description(&self) -> String {
        "Read an Excel spreadsheet table".into()
    }
    fn is_model_visible(&self) -> bool {
        self.visible
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"sheet":{"type":"integer"}},"required":["sheet"],"additionalProperties":false})
    }
    async fn call(&self, input: Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput::text(input.to_string()))
    }
}

fn office(engine: QueryEngine) -> QueryEngine {
    engine.with_client_presentation(Some(ClientPresentationV1 {
        version: 1,
        studio_work_mode: Some(StudioWorkMode::Kworker),
        inline_widgets: false,
        isolated_widgets: false,
    }))
}

fn extension(name: &str, calls: &Arc<AtomicUsize>) -> Extension {
    Extension {
        name: name.into(),
        calls: calls.clone(),
        visible: true,
        provenance: None,
    }
}

async fn search(engine: &QueryEngine, query: &str) -> Value {
    let (output, _, _, _) = engine
        .execute_tool(
            "search",
            "tool_search",
            json!({"query":query,"limit":1}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(!output.is_error, "{output:?}");
    let receipt = serde_json::from_str(
        tool_output_text(&output)
            .split_once("```json\n")
            .unwrap()
            .1
            .strip_suffix("\n```")
            .unwrap(),
    )
    .unwrap();
    if !output.user_context.is_empty() {
        engine.state.add_message(Message::User {
            content: output.user_context,
            origin: kcoder_types::MessageOrigin::Runtime,
        });
    }
    receipt
}

#[tokio::test]
async fn native_host_feature_is_discovered_without_impersonating_mcp_or_changing_the_prefix() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut tool = extension("OfficeDocument", &calls);
    tool.provenance = Some(ToolSource::NativeFeature {
        feature: "office".into(),
        tool: "OfficeDocument".into(),
        revision: "owned-host-v1".into(),
    });
    let engine = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(ToolRegistry::new().register(tool))
            .build_with_profile_directory(),
    );
    let before = engine.tool_definitions_for_request(false).await;
    assert!(!before.iter().any(|tool| tool.name == "OfficeDocument"));
    let result = search(&engine, "OfficeDocument").await;
    assert_eq!(result["tools"][0]["name"], "OfficeDocument");
    assert!(
        engine
            .deferred_tools_snapshot()
            .tools
            .get("OfficeDocument")
            .is_some()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(engine.tool_definitions_for_request(false).await).unwrap()
    );
}

#[tokio::test]
async fn tool_search_supplies_real_schema_without_changing_native_tools_or_request_fence() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(
                ToolRegistry::new().register(extension("mcp__office__read_table", &calls)),
            )
            .build_with_profile_directory(),
    );
    let initial = engine.tool_definitions_for_request(false).await;
    let frozen_native = engine.active_tool_registry();
    let frozen_deferred = engine.deferred_tools_snapshot();
    let result = search(&engine, "分析表格").await;
    assert_eq!(result["tools"][0]["name"], "mcp__office__read_table");
    assert_eq!(result["tools"][0]["availability"], "discovered");
    assert_eq!(result["tools"][0]["call_via"], "tool_execute");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let next = engine.tool_definitions_for_request(false).await;
    assert_eq!(
        serde_json::to_value(initial).unwrap(),
        serde_json::to_value(next).unwrap()
    );
    let schema = &engine.deferred_tools_snapshot().schemas["mcp__office__read_table"];
    assert_eq!(schema["properties"]["sheet"]["type"], "integer");
    assert_eq!(schema["required"], json!(["sheet"]));
    let (rejected, _, _, _) = engine
        .execute_model_request_tool(
            "premature",
            "tool_execute",
            json!({"tool_name":"mcp__office__read_table","arguments":{"sheet":1}}),
            &kcoder_permissions::AutoAllowPrompt,
            crate::deferred_tool_dispatch::ModelToolRegistry {
                native: &frozen_native,
                deferred: &frozen_deferred,
                arrangement_mode: false,
            },
        )
        .await
        .unwrap();
    assert!(rejected.is_error);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let (direct, _, _, _) = engine
        .execute_tool(
            "native-name",
            "mcp__office__read_table",
            json!({"sheet":1}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(direct.is_error);
    let (output, _, _, _) = engine
        .execute_tool(
            "real-call",
            "tool_execute",
            json!({"tool_name":"mcp__office__read_table","arguments":{"sheet":1}}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(!output.is_error, "{output:?}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        !engine
            .effective_tool_catalog()
            .await
            .iter()
            .any(|tool| tool.name == "mcp__office__read_table")
    );
    engine.prepare_session_replacement();
    assert!(
        engine
            .deferred_tools_snapshot()
            .tools
            .get("mcp__office__read_table")
            .is_none()
    );
}

#[tokio::test]
async fn tool_search_cannot_bypass_disabled_hidden_permission_or_luna_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut hidden = extension("mcp__office__hidden", &calls);
    hidden.visible = false;
    let mut settings = Settings::default();
    settings.tools.disabled = vec!["mcp__office__disabled".into()];
    settings.denied_tools = vec!["mcp__office__denied".into()];
    let engine = office(
        TestEngineBuilder::new(root.path())
            .settings(settings)
            .tool_registry(
                ToolRegistry::new()
                    .register(extension("mcp__office__enabled", &calls))
                    .register(extension("mcp__office__disabled", &calls))
                    .register(extension("mcp__office__denied", &calls))
                    .register(hidden)
                    .register(kcoder_tools::ocr::OcrReviewTool),
            )
            .build_with_profile_directory(),
    );
    for name in [
        "mcp__office__disabled",
        "mcp__office__denied",
        "mcp__office__hidden",
        "mcp__office__missing",
        "ocr",
    ] {
        assert_eq!(search(&engine, name).await["tools"], json!([]), "{name}");
    }
    search(&engine, "mcp__office__enabled").await;
    engine
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .push("mcp__office__enabled".into());
    assert!(
        !engine
            .tool_definitions_for_request(false)
            .await
            .iter()
            .any(|tool| tool.name == "mcp__office__enabled")
    );
    assert_eq!(
        search(&engine, "mcp__office__enabled").await["tools"],
        json!([])
    );
    engine
        .permissions
        .write()
        .unwrap()
        .deny_for_session("mcp__office__enabled");
    engine.settings.write().unwrap().tools.disabled.clear();
    assert_eq!(
        search(&engine, "mcp__office__enabled").await["tools"],
        json!([])
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn tool_search_respects_cli_model_profile_and_thread_isolation() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let cli = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(extension("mcp__office__read_table", &calls)))
        .build_with_profile_directory();
    assert!(cli.active_tool_registry().get("tool_search").is_none());
    assert!(cli.active_tool_registry().get("tool_execute").is_none());
    let engine = office(cli.clone());
    search(&engine, "mcp__office__read_table").await;
    let other = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(
                ToolRegistry::new().register(extension("mcp__office__read_table", &calls)),
            )
            .build_with_profile_directory(),
    );
    assert!(
        other
            .active_tool_registry()
            .get("mcp__office__read_table")
            .is_none()
    );
    assert!(
        engine
            .clone()
            .with_client_presentation(None)
            .active_tool_registry()
            .get("tool_search")
            .is_none()
    );
    let mut child = engine.clone();
    child.subagent_system_prompt = Arc::new(Some("Read-only exploration".into()));
    assert!(child.active_tool_registry().get("tool_search").is_none());
    let stale = EngineToolSearchBackend {
        engine: engine.clone(),
        owner: "another-session".into(),
    };
    assert!(stale.search("mcp__office__read_table", 1, None).is_err());
    for profile in [
        kcoder_config::ToolProfile::Nano,
        kcoder_config::ToolProfile::None,
    ] {
        engine.settings.write().unwrap().tools.profile = profile;
        assert!(engine.active_tool_registry().get("tool_search").is_none());
        assert!(
            engine
                .active_tool_registry()
                .get("mcp__office__read_table")
                .is_none()
        );
    }
    engine.settings.write().unwrap().tools.profile = kcoder_config::ToolProfile::Full;
    engine.settings.write().unwrap().model_capabilities.tools = false;
    assert!(engine.tool_definitions_for_request(false).await.is_empty());
}

#[test]
fn tool_search_retains_bounded_recent_selection() {
    let mut selection = DiscoveredTools::default();
    for index in 0..MAX_DISCOVERED_TOOLS + 10 {
        selection.select(
            format!("mcp__office__{index}"),
            ToolSource::Mcp {
                server: "office".into(),
                tool: index.to_string(),
            },
            json!({}),
        );
    }
    assert_eq!(selection.entries.len(), MAX_DISCOVERED_TOOLS);
    assert_eq!(selection.entries.front().unwrap().0, "mcp__office__0");
    selection.select(
        "mcp__office__68".into(),
        ToolSource::Mcp {
            server: "office".into(),
            tool: "68".into(),
        },
        json!({}),
    );
    assert_eq!(selection.entries.back().unwrap().0, "mcp__office__68");
}

#[tokio::test]
async fn tool_search_handles_plugin_provenance_and_keeps_extension_execution_permissions() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = office(
        TestEngineBuilder::new(root.path())
            .settings(Settings {
                permission_mode: PermissionMode::Auto,
                ..Settings::default()
            })
            .tool_registry(
                ToolRegistry::new().register(extension("plugin__office__read_table", &calls)),
            )
            .build_with_profile_directory(),
    );
    let result = search(&engine, "plugin__office__read_table").await;
    assert!(
        result["tools"][0]["source"]
            .as_str()
            .unwrap()
            .contains("office-plugin")
    );
    let deny = kcoder_permissions::AutoDenyPrompt;
    let (output, decision, _, _) = engine
        .execute_tool(
            "blocked-write",
            "tool_execute",
            json!({"tool_name":"plugin__office__read_table","arguments":{"sheet":1}}),
            &deny,
        )
        .await
        .unwrap();
    assert!(output.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // Reusing the same name with another provenance does not inherit the selection.
    let mut replacement = extension("plugin__office__read_table", &calls);
    replacement.provenance = Some(ToolSource::Mcp {
        server: "changed-source".into(),
        tool: replacement.name.clone(),
    });
    let replaced = engine
        .clone()
        .with_turn_tools(ToolRegistry::new().register(replacement));
    assert!(
        replaced
            .active_tool_registry()
            .get("plugin__office__read_table")
            .is_none()
    );
}

#[derive(Debug)]
struct DiscoveryProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for DiscoveryProvider {
    fn name(&self) -> &'static str {
        "discovery-fixture"
    }
    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let round = {
            let mut requests = self.requests.lock().unwrap();
            let round = requests.len();
            requests.push(request);
            round
        };
        let blocks = match round {
            0 => vec![
                ContentBlock::ToolUse {
                    id: "search".into(),
                    name: "tool_search".into(),
                    input: json!({"query":"mcp__office__read_table","limit":1}),
                },
                ContentBlock::ToolUse {
                    id: "repeat-search".into(),
                    name: "tool_search".into(),
                    input: json!({"query":"分析表格","limit":1}),
                },
                ContentBlock::ToolUse {
                    id: "premature".into(),
                    name: "tool_execute".into(),
                    input: json!({"tool_name":"mcp__office__read_table","arguments":{"sheet":1}}),
                },
            ],
            1 => vec![ContentBlock::ToolUse {
                id: "authorized".into(),
                name: "tool_execute".into(),
                input: json!({"tool_name":"mcp__office__read_table","arguments":{"sheet":1}}),
            }],
            _ => vec![ContentBlock::Text {
                text: "Finished.".into(),
            }],
        };
        Ok(Box::pin(async_stream::stream! {
            for (index, content_block) in blocks.into_iter().enumerate() {
                yield Ok(StreamEvent::ContentBlockStart { index, content_block });
                yield Ok(StreamEvent::ContentBlockStop { index });
            }
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}

#[tokio::test]
async fn tool_search_stream_loop_attaches_selected_schema_to_next_provider_request_only() {
    use futures::StreamExt;
    let root = tempfile::tempdir().unwrap();
    // Streaming captures native profile identity; the owned fixture must exist.
    kcoder_config::PrivateDirectory::open_or_create(&root.path().join("test-config")).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = office(
        TestEngineBuilder::new(root.path())
            .settings(Settings {
                permission_mode: PermissionMode::Bypass,
                ..Settings::default()
            })
            .provider(Arc::new(DiscoveryProvider {
                requests: requests.clone(),
            }))
            .tool_registry(
                ToolRegistry::new().register(extension("mcp__office__read_table", &calls)),
            )
            .build_with_profile_directory(),
    );
    engine.state.add_message(Message::user_text("分析这个表格"));
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream(&prompt);
    while let Some(event) = stream.next().await {
        assert!(!matches!(event, EngineEvent::Error(_)), "{event:?}");
    }
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(
        !requests[0]
            .tools
            .iter()
            .any(|tool| tool.name == "mcp__office__read_table")
    );
    for request in &requests[1..] {
        assert_eq!(
            serde_json::to_vec(&requests[0].tools).unwrap(),
            serde_json::to_vec(&request.tools).unwrap()
        );
        assert_eq!(requests[0].system, request.system);
        for (index, message) in requests[0].messages.iter().enumerate() {
            assert_eq!(
                serde_json::to_vec(message).unwrap(),
                serde_json::to_vec(request.messages.get(index).unwrap()).unwrap()
            );
        }
        let before = serde_json::to_value(&requests[0].messages).unwrap();
        let after = serde_json::to_value(&request.messages).unwrap();
        assert_eq!(
            before.as_array().unwrap(),
            &after.as_array().unwrap()[..before.as_array().unwrap().len()]
        );
    }
    assert!(
        matches!(requests[1].messages.last(), Some(Message::User { content, origin: kcoder_types::MessageOrigin::Runtime }) if matches!(content.as_slice(), [ContentBlock::Text { text }] if text.starts_with(crate::tool_search_context::DISCOVERY_HEADER)))
    );
    assert_eq!(requests[1].messages.iter().filter(|message| matches!(message, Message::User { content, .. } if matches!(content.as_slice(), [ContentBlock::Text { text }] if text.starts_with(crate::tool_search_context::DISCOVERY_HEADER)))).count(), 1);
    let Message::User { content, .. } = requests[1].messages.last().unwrap() else {
        panic!("ordinary user context expected")
    };
    let ContentBlock::Text { text } = &content[0] else {
        panic!("Markdown text expected")
    };
    assert!(text.contains("## `mcp__office__read_table`"));
    let schema: Value = serde_json::from_str(
        text.split_once("```json\n")
            .unwrap()
            .1
            .split_once("\n```\n")
            .unwrap()
            .0,
    )
    .unwrap();
    assert_eq!(schema["required"], json!(["sheet"]));
    let feedback = serde_json::to_string(&requests[1].messages).unwrap();
    assert!(feedback.contains("discovered before this model request"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn tool_search_envelope_preserves_argument_validation_and_input_specific_denials() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(
                ToolRegistry::new().register(extension("mcp__office__read_table", &calls)),
            )
            .build_with_profile_directory(),
    );
    search(&engine, "mcp__office__read_table").await;
    for arguments in [json!({"sheet":"invalid"}), json!({"unknown":true})] {
        let (output, _, _, _) = engine
            .execute_tool(
                "bad-input",
                "tool_execute",
                json!({"tool_name":"mcp__office__read_table","arguments":arguments}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(output.is_error, "{output:?}");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    engine
        .permissions
        .write()
        .unwrap()
        .rules
        .push(kcoder_config::PermissionRule {
            tool: "mcp__office__read_table".into(),
            input_pattern: Some("sheet=1".into()),
            action: kcoder_config::PermissionAction::Deny,
        });
    let envelope = json!({"tool_name":"mcp__office__read_table","arguments":{"sheet":1}});
    let (output, decision, _, events) = engine
        .execute_tool(
            "denied",
            "tool_execute",
            envelope.clone(),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(output.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert!(events.iter().any(|event| matches!(event, EngineEvent::ToolDenied { name, .. } if name == "mcp__office__read_table")));
    engine.permissions.write().unwrap().rules.clear();
    engine
        .permissions
        .write()
        .unwrap()
        .rules
        .push(kcoder_config::PermissionRule {
            tool: "tool_execute".into(),
            input_pattern: Some("tool_name=mcp__office__read_table".into()),
            action: kcoder_config::PermissionAction::Deny,
        });
    let (output, _, _, events) = engine
        .execute_tool(
            "envelope-denied",
            "tool_execute",
            envelope,
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(output.is_error);
    assert!(events.iter().any(
        |event| matches!(event, EngineEvent::ToolDenied { name, .. } if name == "tool_execute")
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn tool_search_preserves_visible_bindings_without_changing_native_definitions_or_history() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut registry = ToolRegistry::new();
    for index in 0..40 {
        registry = registry.register(extension(&format!("mcp__office__table_{index}"), &calls));
    }
    let engine = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(registry)
            .build_with_profile_directory(),
    );
    let initial = serde_json::to_value(engine.tool_definitions_for_request(false).await).unwrap();
    for index in 0..40 {
        let (output, _, _, _) = engine
            .execute_tool(
                "search",
                "tool_search",
                json!({"query":format!("mcp__office__table_{index}")}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert_eq!(output.user_context.len(), 1);
        assert!(!tool_output_text(&output).contains("input_schema"));
        engine.state.add_message(Message::User {
            content: output.user_context,
            origin: kcoder_types::MessageOrigin::Runtime,
        });
        assert_eq!(
            serde_json::to_value(engine.tool_definitions_for_request(false).await).unwrap(),
            initial
        );
    }
    let before = serde_json::to_value(engine.state.messages()).unwrap();
    let mut cli_messages = engine.state.messages().into();
    engine
        .clone()
        .with_client_presentation(None)
        .project_tool_discovery_messages(&mut cli_messages);
    assert!(cli_messages.is_empty());
    search(&engine, "mcp__office__table_0").await;
    assert_eq!(
        serde_json::to_value(engine.state.messages()).unwrap(),
        before
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(engine.deferred_tools_snapshot().tools.names().len(), 40);
    engine
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .push("tool_execute".into());
    assert_eq!(
        search(&engine, "mcp__office__table_0").await["tools"],
        json!([])
    );
}

#[tokio::test]
async fn tool_search_deduplicates_until_the_actual_definition_is_compacted() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(
                ToolRegistry::new().register(extension("mcp__office__read_table", &calls)),
            )
            .build_with_profile_directory(),
    );
    let first = search(&engine, "分析表格").await;
    assert_eq!(first["tools"].as_array().unwrap().len(), 1);
    let retained = engine.state.messages();
    let repeat = search(&engine, "mcp__office__read_table").await;
    assert_eq!(repeat["tools"], json!([]));
    assert_eq!(repeat["already_returned"], 1);
    assert_eq!(repeat["empty_reason"], "definition_already_returned");
    assert_eq!(engine.state.messages(), retained);
    // Compacting unrelated history must not reset deduplication for a retained definition.
    engine.state.set_messages(
        [
            vec![Message::compaction_text("Earlier work summarized")],
            retained,
        ]
        .concat(),
    );
    assert_eq!(
        search(&engine, "Excel spreadsheet").await["tools"],
        json!([])
    );
    // Once the actual definition disappears, rediscovery is useful again.
    engine.state.set_messages(vec![Message::compaction_text(
        "Earlier tools summarized without their schemas",
    )]);
    let rediscovered = search(&engine, "Excel spreadsheet").await;
    assert_eq!(rediscovered["tools"].as_array().unwrap().len(), 1);
    assert_eq!(rediscovered["already_returned"], 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn tool_search_fills_results_from_unseen_matches_and_restores_visible_bindings() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new()
        .register(extension("mcp__office__a", &calls))
        .register(extension("mcp__office__b", &calls));
    let engine = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(registry.clone())
            .build_with_profile_directory(),
    );
    assert_eq!(
        search(&engine, "Excel").await["tools"][0]["name"],
        "mcp__office__a"
    );
    let second = search(&engine, "Excel").await;
    assert_eq!(second["tools"][0]["name"], "mcp__office__b");
    assert_eq!(second["already_returned"], 1);
    assert_eq!(search(&engine, "Excel").await["tools"], json!([]));
    let restored = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(registry)
            .build_with_profile_directory(),
    );
    restored.state.set_messages(engine.state.messages());
    let recovery = search(&restored, "mcp__office__a").await;
    assert_eq!(recovery["tools"], json!([]));
    assert_eq!(recovery["already_returned"], 1);
    assert!(
        restored
            .deferred_tools_snapshot()
            .tools
            .get("mcp__office__a")
            .is_some()
    );
}

/// A tool this turn already attaches is not a discovery target: search indexes deferred
/// candidates only, so attached built-ins and attached extensions never come back.
#[tokio::test]
async fn tool_search_never_returns_a_tool_the_request_already_attaches() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut settings = Settings::default();
    // The office allowlist names the extension, so the turn attaches it directly.
    settings
        .tools
        .luna
        .allowed
        .push("mcp__office__attached".into());
    let engine = office(
        TestEngineBuilder::new(root.path())
            .settings(settings)
            .tool_registry(
                ToolRegistry::new()
                    .register(kcoder_tools::FileReadTool)
                    .register(extension("mcp__office__attached", &calls))
                    .register(extension("mcp__office__deferred", &calls)),
            )
            .build_with_profile_directory(),
    );
    assert!(engine.active_tool_registry().get("read").is_some());
    assert!(
        engine
            .active_tool_registry()
            .get("mcp__office__attached")
            .is_some(),
        "the allowlist entry must be attached for this case"
    );

    for attached in ["read", "mcp__office__attached"] {
        let result = search(&engine, attached).await;
        assert_eq!(
            result["tools"],
            json!([]),
            "{attached} is already attached and must not be searchable"
        );
        assert_eq!(result["total_matches"], 0);
        assert_eq!(result["already_returned"], 0);
        assert_eq!(result["catalog_kind"], "registered_deferred_tools");
        assert_eq!(result["empty_reason"], "matching_tools_already_attached");
        assert!(result["directly_available_matches"].as_u64().unwrap() > 0);
        assert!(
            engine
                .deferred_tools_snapshot()
                .tools
                .get(attached)
                .is_none()
        );
    }
    let discovered = search(&engine, "mcp__office__deferred").await;
    assert_eq!(discovered["tools"][0]["name"], "mcp__office__deferred");
    assert_eq!(discovered["tools"][0]["availability"], "discovered");
    assert_eq!(discovered["tools"][0]["call_via"], "tool_execute");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn empty_search_observations_distinguish_registry_from_keyword_without_claiming_source_absence()
 {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let empty = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(ToolRegistry::new())
            .build_with_profile_directory(),
    );
    let before = serde_json::to_value(empty.tool_definitions_for_request(false).await).unwrap();
    let result = search(&empty, "mcp__unknown__not_registered").await;
    assert_eq!(result["catalog_kind"], "registered_deferred_tools");
    assert_eq!(result["empty_reason"], "no_permitted_deferred_tools");
    assert_eq!(result["directly_available_matches"], 0);
    assert!(result.get("mcpConfigured").is_none());
    assert!(result.get("applicationInstalled").is_none());
    assert_eq!(
        before,
        serde_json::to_value(empty.tool_definitions_for_request(false).await).unwrap()
    );
    let registered = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(
                ToolRegistry::new().register(extension("mcp__office__read_table", &calls)),
            )
            .build_with_profile_directory(),
    );
    let prefix =
        serde_json::to_value(registered.tool_definitions_for_request(false).await).unwrap();
    let unmatched = search(&registered, "zxqv_unmatched_symbol_407").await;
    assert_eq!(unmatched["empty_reason"], "no_keyword_match");
    assert_eq!(unmatched["tools"], json!([]));
    assert_eq!(
        prefix,
        serde_json::to_value(registered.tool_definitions_for_request(false).await).unwrap()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

include!("tool_search_lifecycle.rs");
