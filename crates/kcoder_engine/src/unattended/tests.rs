use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_permissions::PermissionResponse;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountedTool {
    name: &'static str,
    calls: Arc<AtomicUsize>,
    explicit: bool,
    read_only: bool,
}
#[async_trait::async_trait]
impl Tool for CountedTool {
    fn name(&self) -> String {
        self.name.into()
    }
    fn description(&self) -> String {
        "Isolated counted invocation".into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object"})
    }
    fn requires_explicit_approval(&self) -> bool {
        self.explicit
    }
    fn is_read_only(&self) -> bool {
        self.read_only
    }
    async fn call(&self, _: Value, _: &ToolContext) -> std::result::Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput::text("executed"))
    }
}
struct CountedPrompt(Arc<AtomicUsize>);
struct CountedQuestioner(Arc<AtomicUsize>);
#[async_trait::async_trait]
impl UserQuestioner for CountedQuestioner {
    fn supports_async_user_questions(&self) -> bool {
        true
    }
    async fn ask(
        &self,
        _: UserQuestionRequest,
    ) -> std::result::Result<UserQuestionResponse, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("Unexpected interactive question".into())
    }
    async fn register_async_user_question(
        &self,
        _: &AppState,
        _: &kcoder_state::AppStateLifecycleIdentity,
        _: kcoder_types::async_user_questions::AsyncQuestionRequest,
    ) -> std::result::Result<kcoder_types::async_user_questions::AsyncQuestionAccepted, String>
    {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("Unexpected asynchronous question".into())
    }
}
#[async_trait::async_trait]
impl PermissionPrompt for CountedPrompt {
    async fn ask(&self, _: &str, _: String, _: &Value) -> PermissionResponse {
        self.0.fetch_add(1, Ordering::SeqCst);
        PermissionResponse::AllowOnce
    }
}

#[tokio::test]
async fn only_channel_candidate_denies_missing_grants_and_preserves_web_interaction() -> Result<()>
{
    let root = tempfile::tempdir()?;
    let calls = Arc::new(AtomicUsize::new(0));
    let prompts = Arc::new(AtomicUsize::new(0));
    let questions = Arc::new(AtomicUsize::new(0));
    let mut web = TestEngineBuilder::new(root.path())
        .settings(Settings {
            permission_mode: PermissionMode::Ask,
            ..Default::default()
        })
        .tool_registry(
            ToolRegistry::new()
                .register(CountedTool {
                    name: "OwnedEffect",
                    calls: calls.clone(),
                    explicit: false,
                    read_only: false,
                })
                .register(CountedTool {
                    name: "WebOnlyEffect",
                    calls: calls.clone(),
                    explicit: false,
                    read_only: false,
                })
                .register(kcoder_tools::AskUserQuestionTool)
                .register(kcoder_tools::AskUserQuestionAsyncTool),
        )
        .build_with_profile_directory()
        .with_async_user_questions_supported(true);
    web.set_user_questioner(Arc::new(CountedQuestioner(questions.clone())));
    assert!(
        web.active_tool_registry()
            .get("AskUserQuestionAsync")
            .is_some()
    );
    let channel = web
        .clone()
        .with_unattended_input()
        .with_channel_tool_restrictions(
            kcoder_types::channel_tool_restrictions::ChannelToolRestrictions {
                enabled: true,
                disabled_tools: vec!["AskUserQuestion".into(), "AskUserQuestionAsync".into()],
            },
        )
        .with_client_questions_supported(true)
        .with_async_user_questions_supported(true);
    assert_eq!(
        serde_json::to_value(web.tool_definitions_for_model().await)?,
        serde_json::to_value(channel.tool_definitions_for_model().await)?,
    );
    assert_eq!(web.session_id(), channel.session_id());
    assert!(web.state.shares_state_with(&channel.state));
    assert!(Arc::ptr_eq(&web.permissions, &channel.permissions));
    for name in ["AskUserQuestion", "AskUserQuestionAsync"] {
        assert!(channel.active_tool_registry().get(name).is_some());
        assert!(Arc::ptr_eq(
            &web.tool_definitions,
            &channel.tool_definitions
        ));
        assert!(Arc::ptr_eq(
            &web.tool_input_schemas,
            &channel.tool_input_schemas
        ));
        let (result, decision, ..) = channel
            .execute_tool("forced", name, json!({}), &CountedPrompt(prompts.clone()))
            .await?;
        assert!(result.is_error);
        assert!(tool_output_text(&result).contains("CHANNEL_TOOL_DISABLED"));
        assert_eq!(decision, PermissionDecision::Deny);
    }
    let (result, decision, ..) = channel
        .execute_tool(
            "blocked",
            "OwnedEffect",
            json!({}),
            &CountedPrompt(prompts.clone()),
        )
        .await?;
    assert!(result.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(prompts.load(Ordering::SeqCst), 0);
    // An existing explicit grant applies without changing either task's mode.
    web.permissions
        .write()
        .unwrap()
        .allow_for_session("OwnedEffect");
    let (result, decision, ..) = channel
        .execute_tool(
            "allowed",
            "OwnedEffect",
            json!({}),
            &CountedPrompt(prompts.clone()),
        )
        .await?;
    assert!(!result.is_error);
    assert_eq!(decision, PermissionDecision::Allow);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // Live revocation is still observed by the already configured candidate.
    web.permissions
        .write()
        .unwrap()
        .deny_for_session("OwnedEffect");
    let (result, decision, ..) = channel
        .execute_tool(
            "revoked",
            "OwnedEffect",
            json!({}),
            &CountedPrompt(prompts.clone()),
        )
        .await?;
    assert!(result.is_error);
    assert_eq!(decision, PermissionDecision::Deny);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(prompts.load(Ordering::SeqCst), 0);
    assert!(web.active_tool_registry().get("AskUserQuestion").is_some());
    assert_eq!(web.permissions.read().unwrap().mode, PermissionMode::Ask);
    assert_eq!(questions.load(Ordering::SeqCst), 0);
    let (result, decision, ..) = web
        .execute_tool(
            "normal-web",
            "WebOnlyEffect",
            json!({}),
            &CountedPrompt(prompts.clone()),
        )
        .await?;
    assert!(!result.is_error);
    assert_eq!(decision, PermissionDecision::Allow);
    assert_eq!(prompts.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn unattended_inherits_bypass_but_preserves_denials_and_fresh_approval_boundaries()
-> Result<()> {
    let root = tempfile::tempdir()?;
    for mode in [PermissionMode::Yolo, PermissionMode::Bypass] {
        let calls = Arc::new(AtomicUsize::new(0));
        let prompts = Arc::new(AtomicUsize::new(0));
        let web = TestEngineBuilder::new(root.path())
            .settings(Settings {
                permission_mode: mode,
                ..Default::default()
            })
            .tool_registry(
                ToolRegistry::new()
                    .register(CountedTool {
                        name: "OwnedEffect",
                        calls: calls.clone(),
                        explicit: false,
                        read_only: false,
                    })
                    .register(CountedTool {
                        name: "FreshApprovalEffect",
                        calls: calls.clone(),
                        explicit: true,
                        read_only: false,
                    }),
            )
            .build_with_profile_directory();
        let channel = web.clone().with_unattended_input();
        web.permissions
            .write()
            .unwrap()
            .allow_for_session("FreshApprovalEffect");
        for (name, allowed) in [("OwnedEffect", true), ("FreshApprovalEffect", false)] {
            let (result, decision, ..) = channel
                .execute_tool("channel", name, json!({}), &CountedPrompt(prompts.clone()))
                .await?;
            assert_eq!(result.is_error, !allowed);
            assert_eq!(
                decision,
                if allowed {
                    PermissionDecision::Allow
                } else {
                    PermissionDecision::Deny
                }
            );
        }
        assert_eq!(prompts.load(Ordering::SeqCst), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let (result, decision, ..) = web
            .execute_tool(
                "web",
                "OwnedEffect",
                json!({}),
                &CountedPrompt(prompts.clone()),
            )
            .await?;
        assert!(!result.is_error);
        assert_eq!(decision, PermissionDecision::Allow);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let child = web.clone().with_inherited_native_tool_ceiling(&channel);
        assert!(child.unattended_input);
        let (result, decision, ..) = child
            .execute_tool(
                "child",
                "OwnedEffect",
                json!({}),
                &CountedPrompt(prompts.clone()),
            )
            .await?;
        assert!(!result.is_error);
        assert_eq!(decision, PermissionDecision::Allow);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        web.permissions
            .write()
            .unwrap()
            .deny_for_session("OwnedEffect");
        for candidate in [&channel, &child] {
            let (result, decision, ..) = candidate
                .execute_tool(
                    "revoked",
                    "OwnedEffect",
                    json!({}),
                    &CountedPrompt(prompts.clone()),
                )
                .await?;
            assert!(result.is_error);
            assert_eq!(decision, PermissionDecision::Deny);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(prompts.load(Ordering::SeqCst), 0);
        assert_eq!(web.permissions.read().unwrap().mode, mode);
    }
    Ok(())
}

#[tokio::test]
async fn unattended_read_only_tools_follow_the_original_session_mode_without_prompting()
-> Result<()> {
    let root = tempfile::tempdir()?;
    for (mode, allowed) in [
        (PermissionMode::Ask, false),
        (PermissionMode::Auto, true),
        (PermissionMode::AcceptEdits, true),
        (PermissionMode::DontAsk, false),
        (PermissionMode::Yolo, true),
        (PermissionMode::Bypass, true),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let prompts = Arc::new(AtomicUsize::new(0));
        let web = TestEngineBuilder::new(root.path())
            .settings(Settings {
                permission_mode: mode,
                ..Default::default()
            })
            .tool_registry(ToolRegistry::new().register(CountedTool {
                name: "ReadOnlyEffect",
                calls: calls.clone(),
                explicit: false,
                read_only: true,
            }))
            .build_with_profile_directory();
        let channel = web.clone().with_unattended_input();
        // Check the real web tools' permission classification without network I/O.
        for tool in [
            &kcoder_tools::WebSearchTool::default() as &dyn Tool,
            &kcoder_tools::WebFetchTool as &dyn Tool,
        ] {
            assert_eq!(
                channel.permissions.read().unwrap().decide(tool, &json!({})),
                if allowed {
                    PermissionDecision::Allow
                } else if mode == PermissionMode::Ask {
                    PermissionDecision::Ask
                } else {
                    PermissionDecision::Deny
                },
                "{mode:?}: {}",
                tool.name(),
            );
        }
        let (result, decision, ..) = channel
            .execute_tool(
                "read",
                "ReadOnlyEffect",
                json!({}),
                &CountedPrompt(prompts.clone()),
            )
            .await?;
        assert_eq!(result.is_error, !allowed, "{mode:?}");
        assert_eq!(
            decision,
            if allowed {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(allowed));
        assert_eq!(prompts.load(Ordering::SeqCst), 0);
        assert_eq!(web.permissions.read().unwrap().mode, mode);
    }
    Ok(())
}

struct QueuedEffect {
    at_gate: Arc<tokio::sync::Notify>,
    calls: Arc<AtomicUsize>,
}
#[async_trait::async_trait]
impl Tool for QueuedEffect {
    fn name(&self) -> String {
        "QueuedEffect".into()
    }
    fn description(&self) -> String {
        "Isolated invocation waiting for the original execution gate".into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object"})
    }
    fn is_concurrency_safe(&self, _: &Value) -> bool {
        self.at_gate.notify_one();
        false
    }
    async fn call(&self, _: Value, _: &ToolContext) -> std::result::Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput::text("executed"))
    }
}

#[tokio::test]
async fn revocation_and_mode_changes_while_queued_block_dispatch_for_both_origins() -> Result<()> {
    for unattended in [false, true] {
        for change_mode in [false, true] {
            let root = tempfile::tempdir()?;
            let calls = Arc::new(AtomicUsize::new(0));
            let at_gate = Arc::new(tokio::sync::Notify::new());
            let mut engine = TestEngineBuilder::new(root.path())
                .settings(Settings {
                    permission_mode: PermissionMode::Yolo,
                    ..Default::default()
                })
                .tool_registry(ToolRegistry::new().register(QueuedEffect {
                    at_gate: at_gate.clone(),
                    calls: calls.clone(),
                }))
                .build_with_profile_directory();
            if unattended {
                engine = engine.with_unattended_input();
            }
            let guard = engine.tool_execution_gate.write().await;
            let candidate = engine.clone();
            let running = tokio::spawn(async move {
                candidate
                    .execute_tool(
                        "queued",
                        "QueuedEffect",
                        json!({}),
                        &kcoder_permissions::AutoAllowPrompt,
                    )
                    .await
            });
            tokio::time::timeout(Duration::from_secs(5), at_gate.notified()).await?;
            if change_mode {
                engine.permissions.write().unwrap().mode = PermissionMode::Ask;
            } else {
                engine
                    .permissions
                    .write()
                    .unwrap()
                    .deny_for_session("QueuedEffect");
            }
            drop(guard);
            let (output, decision, ..) = running.await??;
            assert!(output.is_error);
            assert_eq!(decision, PermissionDecision::Deny);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }
    Ok(())
}

#[tokio::test]
async fn shared_permission_hooks_preserve_per_invocation_allows_and_noninteractive_requests()
-> Result<()> {
    for (mode, behavior, allowed, requested) in [
        (PermissionMode::Ask, "allow", true, false),
        (PermissionMode::Ask, "ask", false, true),
        (PermissionMode::Bypass, "ask", true, false),
        (PermissionMode::Yolo, "deny", false, false),
    ] {
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let prompts = Arc::new(AtomicUsize::new(0));
        let mut engine = TestEngineBuilder::new(root.path())
            .settings(Settings {
                permission_mode: mode,
                ..Default::default()
            })
            .tool_registry(ToolRegistry::new().register(CountedTool {
                name: "OwnedEffect",
                calls: calls.clone(),
                explicit: false,
                read_only: false,
            }))
            .build_with_profile_directory()
            .with_unattended_input();
        let output = json!({"hookSpecificOutput":{"permissionDecision":behavior}}).to_string();
        let command = if cfg!(windows) {
            format!("Write-Output '{output}'")
        } else {
            format!("printf '%s' '{output}'")
        };
        let request = if cfg!(windows) {
            "Set-Content permission-request.marker requested"
        } else {
            "printf requested > permission-request.marker"
        };
        engine.hook_registry = kcoder_hooks::HookRegistry::from_settings(serde_json::from_value(
            json!({
                "PreToolUse":[{"matcher":"OwnedEffect","hooks":[{"type":"command","command":command,"timeout":5}]}],
                "PermissionRequest":[{"matcher":"OwnedEffect","hooks":[{"type":"command","command":request,"timeout":5}]}]
            }),
        )?);
        let (output, decision, ..) = engine
            .execute_tool(
                "hook",
                "OwnedEffect",
                json!({}),
                &CountedPrompt(prompts.clone()),
            )
            .await?;
        assert_eq!(output.is_error, !allowed, "{mode:?} / {behavior}");
        assert_eq!(
            decision,
            if allowed {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(allowed));
        assert_eq!(prompts.load(Ordering::SeqCst), 0);
        assert_eq!(
            root.path().join("permission-request.marker").exists(),
            requested
        );
        // A trusted Hook allow cannot bypass a subsequently explicit task denial.
        if behavior == "allow" {
            engine
                .permissions
                .write()
                .unwrap()
                .deny_for_session("OwnedEffect");
            let (output, decision, ..) = engine
                .execute_tool(
                    "denied",
                    "OwnedEffect",
                    json!({}),
                    &CountedPrompt(prompts.clone()),
                )
                .await?;
            assert!(output.is_error);
            assert_eq!(decision, PermissionDecision::Deny);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }
    Ok(())
}

/// A controlled sandbox denial exercises escalation without spawning a shell.
struct SandboxEffect(Arc<AtomicUsize>);
#[async_trait::async_trait]
impl Tool for SandboxEffect {
    fn name(&self) -> String {
        "bash".into()
    }
    fn description(&self) -> String {
        "Owned sandbox escalation fixture".into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","properties":{"command":{"type":"string"}},"required":["command"]})
    }
    async fn call(
        &self,
        _: Value,
        ctx: &ToolContext,
    ) -> std::result::Result<ToolOutput, ToolError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        if ctx.sandbox.is_some() {
            Err(ToolError::SandboxDenied {
                reason: "controlled sandbox rejection".into(),
                output: None,
            })
        } else {
            Ok(ToolOutput::text("configured escalation completed"))
        }
    }
}

#[tokio::test]
async fn channel_sandbox_escalation_uses_original_mode_configuration_and_noninteractive_prompt()
-> Result<()> {
    for (mode, escalation_enabled, expected_calls, allowed) in [
        (PermissionMode::Ask, true, 1, false),
        (PermissionMode::Yolo, true, 2, true),
        (PermissionMode::Bypass, true, 2, true),
        (PermissionMode::Yolo, false, 1, false),
    ] {
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let prompts = Arc::new(AtomicUsize::new(0));
        let engine = TestEngineBuilder::new(root.path())
            .settings(Settings {
                permission_mode: mode,
                allowed_tools: vec!["bash".into()],
                sandbox: kcoder_types::SandboxConfig {
                    allow_shell_escalation: escalation_enabled,
                    require_shell_escalation_approval: true,
                    ..Default::default()
                },
                ..Default::default()
            })
            .tool_registry(ToolRegistry::new().register(SandboxEffect(calls.clone())))
            .build_with_profile_directory()
            .with_unattended_input();
        let (output, decision, ..) = engine
            .execute_tool(
                "sandbox",
                "bash",
                json!({"command":"fixture"}),
                &CountedPrompt(prompts.clone()),
            )
            .await?;
        assert_eq!(
            output.is_error, !allowed,
            "{mode:?} / escalation={escalation_enabled}"
        );
        assert_eq!(
            decision,
            if allowed {
                PermissionDecision::Allow
            } else {
                PermissionDecision::Deny
            }
        );
        assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
        assert_eq!(prompts.load(Ordering::SeqCst), 0);
    }
    Ok(())
}

#[tokio::test]
async fn configured_channel_restrictions_narrow_all_permission_modes_without_changing_schemas()
-> Result<()> {
    use kcoder_types::channel_tool_restrictions::ChannelToolRestrictions;
    for mode in [
        PermissionMode::Ask,
        PermissionMode::Bypass,
        PermissionMode::Yolo,
    ] {
        let root = tempfile::tempdir()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let web = TestEngineBuilder::new(root.path())
            .settings(Settings {
                permission_mode: mode,
                ..Default::default()
            })
            .tool_registry(ToolRegistry::new().register(CountedTool {
                name: "OwnedRead",
                calls: calls.clone(),
                explicit: false,
                read_only: true,
            }))
            .build_with_profile_directory();
        web.permissions
            .write()
            .unwrap()
            .allow_for_session("OwnedRead");
        let policy = ChannelToolRestrictions {
            enabled: true,
            disabled_tools: vec!["OwnedRead".into()],
        };
        let channel = web
            .clone()
            .with_unattended_input()
            .with_channel_tool_restrictions(policy.clone());
        assert!(Arc::ptr_eq(
            &web.tool_definitions,
            &channel.tool_definitions
        ));
        assert_eq!(
            web.model_tool_names(&web.active_tool_registry(), false),
            channel.model_tool_names(&channel.active_tool_registry(), false)
        );
        assert!(web.channel_turn_prompt().is_none());
        assert!(channel.channel_turn_prompt().unwrap().contains("OwnedRead"));
        let (output, decision, ..) = channel
            .execute_tool(
                "disabled",
                "OwnedRead",
                json!({}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await?;
        assert_eq!(decision, PermissionDecision::Deny);
        assert!(tool_output_text(&output).contains("CHANNEL_TOOL_DISABLED"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let open = channel.with_channel_tool_restrictions(ChannelToolRestrictions {
            enabled: false,
            ..policy
        });
        assert!(!open.channel_turn_prompt().unwrap().contains("OwnedRead"));
        let (output, decision, ..) = open
            .execute_tool(
                "enabled",
                "OwnedRead",
                json!({}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await?;
        assert_eq!(decision, PermissionDecision::Allow);
        assert!(!output.is_error);
        web.permissions
            .write()
            .unwrap()
            .deny_for_session("OwnedRead");
        let (_, decision, ..) = open
            .execute_tool(
                "revoked",
                "OwnedRead",
                json!({}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await?;
        assert_eq!(decision, PermissionDecision::Deny);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    Ok(())
}
