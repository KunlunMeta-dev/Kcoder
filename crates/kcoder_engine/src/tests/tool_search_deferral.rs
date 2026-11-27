// Extension deferral outside KWorker: KCoder mode and the CLI/TUI keep extension
// tools behind tool_search/tool_execute unless the user selected them or opted out.

fn coding(engine: QueryEngine) -> QueryEngine {
    engine
        .with_studio_work_mode(Some(StudioWorkMode::Kcoder))
        .with_client_presentation(Some(ClientPresentationV1 {
            version: 1,
            studio_work_mode: Some(StudioWorkMode::Kcoder),
            inline_widgets: false,
            isolated_widgets: false,
        }))
}

fn deferral_engine(root: &std::path::Path, settings: Settings, calls: &Arc<AtomicUsize>) -> QueryEngine {
    TestEngineBuilder::new(root)
        .settings(settings)
        .tool_registry(
            ToolRegistry::new()
                .register(kcoder_tools::FileReadTool)
                .register(extension("mcp__office__read_table", calls)),
        )
        .build_with_profile_directory()
}

fn attached(engine: &QueryEngine) -> std::collections::BTreeSet<String> {
    engine.active_tool_registry().names().into_iter().collect()
}

#[tokio::test]
async fn tool_search_defers_extensions_in_kcoder_mode_and_cli_by_default() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    // Separate engines: clones share one thread's discovery state and history.
    let cli = deferral_engine(root.path(), Settings::default(), &calls);
    let kcoder = coding(deferral_engine(root.path(), Settings::default(), &calls));
    for engine in [cli, kcoder] {
        let names = attached(&engine);
        assert!(names.contains("read"), "{names:?}");
        assert!(names.contains("tool_search"), "{names:?}");
        assert!(names.contains("tool_execute"), "{names:?}");
        assert!(!names.contains("mcp__office__read_table"), "{names:?}");
        let original = engine.tools.get("mcp__office__read_table").unwrap();
        let observed = engine
            .observable_mcp_tools()
            .get("mcp__office__read_table")
            .unwrap();
        assert!(Arc::ptr_eq(&original, &observed));
        assert!(
            engine
                .searchable_tools()
                .get("mcp__office__read_table")
                .is_some()
        );
        let definitions = engine.tool_definitions_for_request(false).await;
        assert!(
            !definitions
                .iter()
                .any(|tool| tool.name == "mcp__office__read_table")
        );
        let result = search(&engine, "Excel spreadsheet").await;
        assert_eq!(result["tools"][0]["name"], "mcp__office__read_table");
        assert_eq!(result["tools"][0]["call_via"], "tool_execute");
        let (output, _, _, _) = engine
            .execute_tool(
                "deferred-call",
                "tool_execute",
                json!({"tool_name":"mcp__office__read_table","arguments":{"sheet":1}}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(!output.is_error, "{output:?}");
        // The native list stays identical after discovery and execution.
        assert_eq!(
            serde_json::to_value(definitions).unwrap(),
            serde_json::to_value(engine.tool_definitions_for_request(false).await).unwrap()
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn tool_search_deferral_keeps_explicit_selection_opt_out_and_profile_gates() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    // An explicit KCoder selection attaches exactly the selected tools, extensions included.
    let mut selected = coding(deferral_engine(root.path(), Settings::default(), &calls));
    selected.studio_tool_selection.kcoder =
        Some(vec!["read".into(), "mcp__office__read_table".into()]);
    assert_eq!(
        attached(&selected),
        ["mcp__office__read_table", "read"]
            .map(String::from)
            .into_iter()
            .collect()
    );
    selected.studio_tool_selection.kcoder = Some(vec!["read".into()]);
    assert!(selected.observable_mcp_tools().names().is_empty());
    // Opting out restores direct attachment in KCoder mode and the CLI.
    let mut opted_out = Settings::default();
    opted_out.tools.defer_extensions = false;
    let cli = deferral_engine(root.path(), opted_out, &calls);
    for engine in [cli.clone(), coding(cli.clone())] {
        let names = attached(&engine);
        assert!(names.contains("mcp__office__read_table"), "{names:?}");
        assert!(!names.contains("tool_search"), "{names:?}");
        assert!(!names.contains("tool_execute"), "{names:?}");
    }
    // KWorker keeps its own default selection either way.
    let worker = office(cli);
    assert!(worker.active_tool_registry().get("tool_search").is_some());
    assert!(
        worker
            .active_tool_registry()
            .get("mcp__office__read_table")
            .is_none()
    );
    // nano/none and tool-less models never get the deferred route.
    let engine = deferral_engine(root.path(), Settings::default(), &calls);
    for profile in [
        kcoder_config::ToolProfile::Nano,
        kcoder_config::ToolProfile::None,
    ] {
        engine.settings.write().unwrap().tools.profile = profile;
        assert!(engine.active_tool_registry().get("tool_search").is_none());
        assert!(engine.active_tool_registry().get("tool_execute").is_none());
    }
    engine.settings.write().unwrap().tools.profile = kcoder_config::ToolProfile::Full;
    engine.settings.write().unwrap().model_capabilities.tools = false;
    assert!(engine.active_tool_registry().get("tool_search").is_none());
    // A disabled route keeps extensions attached instead of stranding them.
    let mut no_route = Settings::default();
    no_route.tools.disabled.push("tool_execute".into());
    let engine = deferral_engine(root.path(), no_route, &calls);
    assert!(engine.active_tool_registry().get("mcp__office__read_table").is_some());
    assert!(engine.active_tool_registry().get("tool_search").is_none());
    // Children and specialized sessions keep their direct composition.
    let child = deferral_engine(root.path(), Settings::default(), &calls)
        .with_subagent_system_prompt(Some("Read-only child".into()));
    assert!(child.active_tool_registry().get("tool_search").is_none());
    assert!(child.active_tool_registry().get("mcp__office__read_table").is_some());
    // Without any extension the native list is exactly the built-in list.
    let plain = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
        .build_with_profile_directory();
    assert_eq!(attached(&plain), ["read".to_string()].into_iter().collect());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn tool_search_direct_call_of_a_deferred_extension_returns_recovery_without_executing() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = deferral_engine(root.path(), Settings::default(), &calls);
    let (output, decision, _, _) = engine
        .execute_tool(
            "direct-name",
            "mcp__office__read_table",
            json!({"sheet":1}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(output.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    let text = tool_output_text(&output);
    assert!(text.contains("not executed"), "{text}");
    assert!(text.contains("tool_search"), "{text}");
    assert!(
        text.contains(r#"tool_execute with {"tool_name":"mcp__office__read_table""#),
        "{text}"
    );
    // A name that is neither attached nor deferred keeps the generic error.
    let (unknown, _, _, _) = engine
        .execute_tool(
            "unknown",
            "mcp__office__missing",
            json!({}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(unknown.is_error);
    assert!(tool_output_text(&unknown).contains("Unknown tool"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn tool_search_route_applies_permissions_and_hooks_to_the_inner_tool_in_cli() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut engine = deferral_engine(root.path(), Settings::default(), &calls);
    search(&engine, "mcp__office__read_table").await;
    let envelope = json!({"tool_name":"mcp__office__read_table","arguments":{"sheet":1}});
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
    let hook_command = if cfg!(windows) {
        "Write-Output '{\"continue\":false}'"
    } else {
        "printf '{\"continue\":false}'"
    };
    engine.hook_registry = kcoder_hooks::HookRegistry::from_settings(
        serde_json::from_value(json!({
            "PreToolUse": [{
                "matcher": "mcp__office__read_table",
                "hooks": [{ "type": "command", "command": hook_command }]
            }]
        }))
        .unwrap(),
    );
    let (blocked, _, _, _) = engine
        .execute_tool(
            "hook-blocked",
            "tool_execute",
            envelope,
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(blocked.is_error, "{blocked:?}");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn tool_search_deferral_keeps_skills_that_require_a_deferred_extension_visible() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join(".kcoder/skills/table-report");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\nname: table-report\ndescription: Summarize a spreadsheet table\nmetadata:\n  kcoder:\n    requires_tools: [mcp__office__read_table]\n---\nBODY",
    )
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = deferral_engine(root.path(), Settings::default(), &calls);
    assert!(engine.active_tool_registry().get("mcp__office__read_table").is_none());
    assert!(engine.skill_available_in_current_request("table-report"));
    engine
        .settings
        .write()
        .unwrap()
        .tools
        .disabled
        .push("mcp__office__read_table".into());
    assert!(!engine.skill_available_in_current_request("table-report"));
}
