//! Real normal Engine permission/dispatch consumers; no model or external resource is used.
use super::*;
use kcoder_types::TurnAttemptIdentity;
use serde_json::{Value, json};
struct Effect {
    calls: Arc<AtomicUsize>,
    mcp_source: bool,
}
#[async_trait::async_trait]
impl Tool for Effect {
    fn name(&self) -> String {
        "OwnedNativeReceiptEffect".into()
    }
    fn source(&self) -> ToolSource {
        if self.mcp_source {
            return ToolSource::Mcp {
                server: "owned-original-mcp".into(),
                tool: "actual-reviewed-effect".into(),
            };
        }
        ToolSource::NativeFeature {
            feature: "owned-native-receipt-fixture".into(),
            tool: self.name(),
            revision: "actual-source-r1".into(),
        }
    }
    fn description(&self) -> String {
        "Owned local effect requiring the actual final native dispatch receipt".into()
    }
    fn input_schema(&self) -> Value {
        json!({"type":"object","additionalProperties":false})
    }
    fn requires_explicit_approval(&self) -> bool {
        true
    }
    async fn call(&self, input: Value, context: &ToolContext) -> Result<ToolOutput, ToolError> {
        if !context.authorizes_native_tool_invocation(self, &input) {
            return Err(ToolError::Execution(
                "ACTUAL_NATIVE_DISPATCH_REQUIRED".into(),
            ));
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput::text("Actual native invocation"))
    }
}
struct DispatchDenied;
#[async_trait::async_trait]
impl NativeToolAuthorization for DispatchDenied {
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        if request.phase == NativeToolAuthorizationPhase::Dispatch {
            return Err(NativeToolAuthorizationError::Denied);
        }
        Ok(())
    }
}
fn fixture(
    root: &std::path::Path,
) -> (
    QueryEngine,
    Arc<Effect>,
    Arc<AtomicUsize>,
    TurnAttemptIdentity,
) {
    fixture_source(root, false)
}
fn fixture_source(
    root: &std::path::Path,
    mcp_source: bool,
) -> (
    QueryEngine,
    Arc<Effect>,
    Arc<AtomicUsize>,
    TurnAttemptIdentity,
) {
    let calls = Arc::new(AtomicUsize::new(0));
    let tool = Arc::new(Effect {
        calls: calls.clone(),
        mcp_source,
    });
    let engine = TestEngineBuilder::new(root)
        .tool_registry(ToolRegistry::new().register_arc(tool.clone()))
        .build_with_profile_directory();
    engine.permissions.write().unwrap().mode = kcoder_config::PermissionMode::Ask;
    let attempt = TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "actual-native-dispatch-turn".into(),
        attempt_id: "actual-native-dispatch-attempt".into(),
    };
    (engine, tool, calls, attempt)
}
#[tokio::test]
async fn direct_context_and_a_denied_ordinary_permission_cannot_mint_the_effect_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let (engine, tool, calls, attempt) = fixture(temp.path());
    engine
        .state
        .history_attempt_scope(attempt)
        .unwrap()
        .run(async {
            assert!(
                tool.call(
                    json!({}),
                    &ToolContext::new(engine.state.clone())
                        .with_tool_call_id("made-up-approved-call")
                )
                .await
                .is_err()
            );
            let result = engine
                .execute_tool(
                    "ordinary-denied-call",
                    "OwnedNativeReceiptEffect",
                    json!({}),
                    &kcoder_permissions::AutoDenyPrompt,
                )
                .await
                .unwrap();
            assert!(result.0.is_error);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        })
        .await;
}
#[tokio::test]
async fn a_late_native_guard_denial_prevents_receipt_issuance_and_all_local_effects() {
    let temp = tempfile::tempdir().unwrap();
    let (engine, _tool, calls, attempt) = fixture(temp.path());
    let engine = engine.with_native_tool_authorization(Arc::new(DispatchDenied));
    engine
        .state
        .history_attempt_scope(attempt)
        .unwrap()
        .run(async {
            let result = engine
                .execute_tool(
                    "native-dispatch-denied",
                    "OwnedNativeReceiptEffect",
                    json!({}),
                    &CountedPrompt(Arc::new(AtomicUsize::new(0))),
                )
                .await
                .unwrap();
            assert!(result.0.is_error);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        })
        .await;
}
#[tokio::test]
async fn actual_normal_approved_dispatch_reaches_only_the_exact_native_tool_instance() {
    let temp = tempfile::tempdir().unwrap();
    let (engine, _tool, calls, attempt) = fixture(temp.path());
    engine
        .state
        .history_attempt_scope(attempt)
        .unwrap()
        .run(async {
            let result = engine
                .execute_tool(
                    "actual-approved-native-call",
                    "OwnedNativeReceiptEffect",
                    json!({}),
                    &CountedPrompt(Arc::new(AtomicUsize::new(0))),
                )
                .await
                .unwrap();
            assert!(!result.0.is_error);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        })
        .await;
}

struct CountedPrompt(Arc<AtomicUsize>);
#[async_trait::async_trait]
impl kcoder_permissions::PermissionPrompt for CountedPrompt {
    async fn ask_explicit_context_with_edit(
        &self,
        request: &kcoder_permissions::PermissionRequestContext,
    ) -> kcoder_permissions::PermissionDialogResult {
        kcoder_permissions::PermissionDialogResult {
            response: self
                .ask(
                    &request.tool_name,
                    request.description.clone(),
                    &request.input,
                )
                .await,
            modified_input: None,
        }
    }
    async fn ask(
        &self,
        _: &str,
        _: String,
        input: &Value,
    ) -> kcoder_permissions::PermissionResponse {
        assert_eq!(input, &json!({}));
        self.0.fetch_add(1, Ordering::SeqCst);
        kcoder_permissions::PermissionResponse::AllowOnce
    }
}
#[tokio::test]
async fn automatic_allow_is_not_an_explicit_effect_approval() {
    let temp = tempfile::tempdir().unwrap();
    let (engine, _tool, calls, attempt) = fixture_source(temp.path(), true);
    engine
        .state
        .history_attempt_scope(attempt)
        .unwrap()
        .run(async {
            let result = engine
                .execute_tool(
                    "no-interactive-user",
                    "OwnedNativeReceiptEffect",
                    json!({}),
                    &kcoder_permissions::AutoAllowPrompt,
                )
                .await
                .unwrap();
            assert!(result.0.is_error);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        })
        .await;
}
#[tokio::test]
async fn reviewed_mcp_effect_gets_only_the_original_post_approval_dispatch_receipt() {
    for denied_at_dispatch in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (mut engine, tool, calls, attempt) = fixture_source(temp.path(), true);
        if denied_at_dispatch {
            engine = engine.with_native_tool_authorization(Arc::new(DispatchDenied));
        }
        let prompts = Arc::new(AtomicUsize::new(0));
        engine
            .state
            .history_attempt_scope(attempt)
            .unwrap()
            .run(async {
                assert!(
                    tool.call(
                        json!({}),
                        &ToolContext::new(engine.state.clone())
                            .with_tool_call_id("unapproved-mcp-call")
                    )
                    .await
                    .is_err()
                );
                assert_eq!(calls.load(Ordering::SeqCst), 0);
                let result = engine
                    .execute_tool(
                        "original-mcp-call",
                        "OwnedNativeReceiptEffect",
                        json!({}),
                        &CountedPrompt(prompts.clone()),
                    )
                    .await
                    .unwrap();
                assert_eq!(result.0.is_error, denied_at_dispatch);
                assert_eq!(prompts.load(Ordering::SeqCst), 1);
                assert_eq!(
                    calls.load(Ordering::SeqCst),
                    usize::from(!denied_at_dispatch)
                );
            })
            .await;
    }
}
#[tokio::test]
async fn explicit_effect_keeps_one_real_prompt_after_hook_allow_and_bypass_but_hook_deny_stops_it()
{
    for deny in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (mut engine, _tool, calls, attempt) = fixture(temp.path());
        engine.permissions.write().unwrap().mode = kcoder_config::PermissionMode::Bypass;
        engine.settings.write().unwrap().permission_mode = kcoder_config::PermissionMode::Bypass;
        let decision = if deny { "deny" } else { "allow" };
        let response=json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":decision}}).to_string();
        let command = if cfg!(windows) {
            format!("Write-Output '{}'", response)
        } else {
            format!("printf '%s' '{}'", response)
        };
        engine.hook_registry = kcoder_hooks::HookRegistry::from_settings(
            serde_json::from_value(
                json!({"PreToolUse":[{"hooks":[{"type":"command","command":command}]}]}),
            )
            .unwrap(),
        );
        let prompts = Arc::new(AtomicUsize::new(0));
        engine
            .state
            .history_attempt_scope(attempt)
            .unwrap()
            .run(async {
                let result = engine
                    .execute_tool(
                        "original-explicit-effect",
                        "OwnedNativeReceiptEffect",
                        json!({}),
                        &CountedPrompt(prompts.clone()),
                    )
                    .await
                    .unwrap();
                assert_eq!(result.0.is_error, deny);
                assert_eq!(prompts.load(Ordering::SeqCst), usize::from(!deny));
                assert_eq!(calls.load(Ordering::SeqCst), usize::from(!deny));
            })
            .await;
    }
}
