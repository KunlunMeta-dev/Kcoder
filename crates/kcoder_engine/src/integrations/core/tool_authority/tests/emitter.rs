use super::*;
use kcoder_state::AppState;
use kcoder_types::TurnAttemptIdentity;
use std::sync::{Mutex, atomic::AtomicBool};

// These tools count local effects only. External source identity is exercised
// separately with the real McpTool and a transport that must never be called.
struct EffectFixture {
    name: &'static str,
    changed: Arc<AtomicBool>,
    calls: Arc<AtomicUsize>,
}
#[async_trait::async_trait]
impl Tool for EffectFixture {
    fn name(&self) -> String {
        self.name.into()
    }
    fn source(&self) -> ToolSource {
        if self.changed.load(Ordering::SeqCst) {
            ToolSource::Mcp {
                server: "changed-after-registration".into(),
                tool: self.name.into(),
            }
        } else {
            ToolSource::Builtin
        }
    }
    fn description(&self) -> String {
        "Local provenance effect fixture".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type":"object"})
    }
    async fn call(&self, _: serde_json::Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput::text("owned local effect"))
    }
}
fn effect() -> (Arc<dyn Tool>, Arc<AtomicBool>, Arc<AtomicUsize>) {
    let changed = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    (
        Arc::new(EffectFixture {
            name: "OwnedEffect",
            changed: changed.clone(),
            calls: calls.clone(),
        }),
        changed,
        calls,
    )
}
fn attempt(engine: &QueryEngine) -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: engine.session_id(),
        turn_id: "actual-scope-turn".into(),
        attempt_id: "actual-scope-attempt".into(),
    }
}
struct ObservedAuthority {
    tool: Arc<dyn Tool>,
    state: AppState,
    attempt: TurnAttemptIdentity,
    phases: Mutex<Vec<NativeToolAuthorizationPhase>>,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for ObservedAuthority {
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        let emitter = request
            .emitter
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        assert!(emitter.matches_tool(&self.tool));
        assert!(std::ptr::eq(
            request.execution.unwrap(),
            emitter.execution()
        ));
        assert!(emitter.execution().matches_state(&self.state));
        assert_eq!(emitter.execution().attempt(), Some(&self.attempt));
        assert_eq!(emitter.execution().session_id(), request.session_id);
        assert_eq!(emitter.source(), &request.source);
        assert_eq!(emitter.tool_name(), request.tool_name);
        self.phases.lock().unwrap().push(request.phase);
        Ok(())
    }
}
#[tokio::test]
async fn actual_arc_and_current_task_local_frame_reach_both_invocation_phases() {
    let root = tempfile::tempdir().unwrap();
    let (tool, _, calls) = effect();
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register_arc(tool.clone()))
        .build_with_profile_directory();
    let id = attempt(&engine);
    let authority = Arc::new(ObservedAuthority {
        tool,
        state: engine.state.clone(),
        attempt: id.clone(),
        phases: Mutex::new(Vec::new()),
    });
    let engine = engine.with_native_tool_authorization(authority.clone());
    engine
        .state
        .history_attempt_scope(id)
        .unwrap()
        .run(async {
            let output = engine
                .execute_tool(
                    "owned-call",
                    "OwnedEffect",
                    serde_json::json!({}),
                    &kcoder_permissions::AutoAllowPrompt,
                )
                .await
                .unwrap();
            assert!(!output.0.is_error);
        })
        .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *authority.phases.lock().unwrap(),
        vec![
            NativeToolAuthorizationPhase::Admission,
            NativeToolAuthorizationPhase::Dispatch
        ]
    );
}
#[tokio::test]
async fn equal_name_and_source_do_not_substitute_another_arc_or_registry_revision() {
    let root = tempfile::tempdir().unwrap();
    let (original, _, _) = effect();
    let (replacement, _, _) = effect();
    let registry = ToolRegistry::new().register_arc(original.clone());
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(registry.clone())
        .build_with_profile_directory();
    let witness = engine
        .capture_native_tool_emitter(&registry, "OwnedEffect", &original)
        .unwrap();
    assert!(witness.matches_registry(&registry.clone()));
    assert!(!witness.matches_tool(&replacement));
    assert!(
        engine
            .capture_native_tool_emitter(&registry, "OwnedEffect", &replacement)
            .is_err()
    );
    let replacement_registry = ToolRegistry::new().register_arc(replacement);
    assert!(!witness.matches_registry(&replacement_registry));
    let expanded = registry.register(DeferredTool {
        name: "LaterSource",
        calls: Arc::new(AtomicUsize::new(0)),
    });
    assert!(!witness.matches_registry(&expanded));
}
#[tokio::test]
async fn source_changed_after_registration_is_rejected_before_native_authorization() {
    let root = tempfile::tempdir().unwrap();
    let (tool, changed, calls) = effect();
    let registry = ToolRegistry::new().register_arc(tool);
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(registry)
        .build_with_profile_directory();
    changed.store(true, Ordering::SeqCst);
    let result = engine
        .execute_tool(
            "mutated-source",
            "OwnedEffect",
            serde_json::json!({}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(result.0.is_error);
    assert_eq!(result.1, kcoder_permissions::PermissionDecision::Deny);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
struct SourceChangingAuthority(Arc<AtomicBool>);
#[async_trait::async_trait]
impl NativeToolAuthorization for SourceChangingAuthority {
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        tokio::task::yield_now().await;
        self.0.store(true, Ordering::SeqCst);
        Ok(())
    }
}
#[tokio::test]
async fn source_changed_during_authorization_cannot_use_the_old_registered_stamp() {
    let root = tempfile::tempdir().unwrap();
    let (tool, changed, calls) = effect();
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register_arc(tool))
        .build_with_profile_directory()
        .with_native_tool_authorization(Arc::new(SourceChangingAuthority(changed)));
    let result = engine
        .execute_tool(
            "changing-source",
            "OwnedEffect",
            serde_json::json!({}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(result.0.is_error);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
struct NoSendTransport(Arc<AtomicUsize>);
#[async_trait::async_trait]
impl kcoder_mcp::McpTransport for NoSendTransport {
    async fn send(&mut self, _: &str) -> anyhow::Result<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        anyhow::bail!("revoked actual MCP must never send")
    }
    async fn recv(&mut self) -> anyhow::Result<Option<String>> {
        Ok(None)
    }
}
struct LeaseRevokingAuthority {
    tool: Arc<dyn Tool>,
    lease: tokio_util::sync::CancellationToken,
    phases: AtomicUsize,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for LeaseRevokingAuthority {
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        let emitter = request.emitter.unwrap();
        assert!(emitter.matches_tool(&self.tool));
        assert!(emitter.downcast_tool::<kcoder_mcp::McpTool>().is_some());
        self.phases.fetch_add(1, Ordering::SeqCst);
        if request.phase == NativeToolAuthorizationPhase::Dispatch {
            self.lease.cancel();
        }
        Ok(())
    }
}
#[tokio::test]
async fn real_mcp_lease_revoked_at_dispatch_prevents_transport_and_emits_denial() {
    let root = tempfile::tempdir().unwrap();
    let sends = Arc::new(AtomicUsize::new(0));
    let handle = Arc::new(tokio::sync::Mutex::new(
        kcoder_mcp::McpClient::with_transport(Box::new(NoSendTransport(sends.clone()))),
    ));
    let lease = tokio_util::sync::CancellationToken::new();
    let tool: Arc<dyn Tool> = Arc::new(
        kcoder_mcp::McpTool::new(
            "owned-server",
            handle,
            serde_json::from_value(
                serde_json::json!({"name":"read","inputSchema":{"type":"object"}}),
            )
            .unwrap(),
        )
        .with_session_lease(lease.clone()),
    );
    let name = tool.name();
    let authority = Arc::new(LeaseRevokingAuthority {
        tool: tool.clone(),
        lease,
        phases: AtomicUsize::new(0),
    });
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register_arc(tool))
        .build_with_profile_directory()
        .with_native_tool_authorization(authority.clone());
    let result = engine
        .execute_tool(
            "revoke-actual-mcp",
            &name,
            serde_json::json!({}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(result.0.is_error);
    assert_eq!(result.1, kcoder_permissions::PermissionDecision::Deny);
    assert!(result.3.iter().any(|event| matches!(event, crate::EngineEvent::ToolDenied { reason, .. } if reason == "NATIVE_TOOL_EXPOSURE_REVOKED")));
    assert_eq!(authority.phases.load(Ordering::SeqCst), 2);
    assert_eq!(sends.load(Ordering::SeqCst), 0);
}
struct EpochReplacingAuthority {
    state: AppState,
    history: std::path::PathBuf,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for EpochReplacingAuthority {
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        if request.phase == NativeToolAuthorizationPhase::Dispatch {
            self.state.resume_from_history(&self.history).unwrap();
        }
        Ok(())
    }
}
#[tokio::test]
async fn same_session_restoration_during_dispatch_invalidates_the_native_frame() {
    let root = tempfile::tempdir().unwrap();
    let (tool, _, calls) = effect();
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register_arc(tool))
        .build_with_profile_directory();
    let history = root.path().join(format!("{}.jsonl", engine.session_id()));
    engine.state.with_history_path(&history);
    engine
        .state
        .add_message(kcoder_types::Message::user_text("owned history"));
    engine.state.flush_history().await.unwrap();
    let id = attempt(&engine);
    let original_session = engine.session_id();
    let state = engine.state.clone();
    let engine =
        engine.with_native_tool_authorization(Arc::new(EpochReplacingAuthority { state, history }));
    engine
        .state
        .history_attempt_scope(id)
        .unwrap()
        .run(async {
            let result = engine
                .execute_tool(
                    "restore-dispatch",
                    "OwnedEffect",
                    serde_json::json!({}),
                    &kcoder_permissions::AutoAllowPrompt,
                )
                .await
                .unwrap();
            assert!(result.0.is_error);
        })
        .await;
    assert_eq!(engine.session_id(), original_session);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn literal_ceiling_applies_even_to_a_previously_captured_registry() {
    let root = tempfile::tempdir().unwrap();
    let (tool, _, calls) = effect();
    let registry = ToolRegistry::new().register_arc(tool.clone());
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(registry.clone())
        .build_with_profile_directory()
        .with_native_tool_ceiling(&[])
        .unwrap();
    let result = engine
        .authorize_native_tool(
            &registry,
            &tool,
            "OwnedEffect",
            &serde_json::json!({}),
            false,
            NativeToolAuthorizationPhase::Dispatch,
        )
        .await;
    assert_eq!(result, Err(NativeToolAuthorizationError::Denied));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

struct TransportWaitAuthority {
    tool: Arc<dyn Tool>,
    allowed: AtomicBool,
    checked: tokio::sync::Notify,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for TransportWaitAuthority {
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        assert!(request.emitter.unwrap().matches_tool(&self.tool));
        assert_eq!(
            request.input,
            &serde_json::json!({"uri":"resource://original"})
        );
        if !self.allowed.load(Ordering::SeqCst) {
            return Err(NativeToolAuthorizationError::Denied);
        }
        if request.phase == NativeToolAuthorizationPhase::Dispatch {
            self.checked.notify_one();
        }
        Ok(())
    }
}
#[tokio::test]
async fn original_mcp_waiting_for_transport_rechecks_revocation_before_any_send() {
    let root = tempfile::tempdir().unwrap();
    let sends = Arc::new(AtomicUsize::new(0));
    let handle = Arc::new(tokio::sync::Mutex::new(
        kcoder_mcp::McpClient::with_transport(Box::new(NoSendTransport(sends.clone()))),
    ));
    let held_transport = handle.clone().lock_owned().await;
    let tool:Arc<dyn Tool>=Arc::new(kcoder_mcp::McpTool::new("owned-server",handle,
        serde_json::from_value(serde_json::json!({"name":"read","inputSchema":{"type":"object","properties":{"uri":{"type":"string"}}}})).unwrap()));
    let name = tool.name();
    let authority = Arc::new(TransportWaitAuthority {
        tool: tool.clone(),
        allowed: AtomicBool::new(true),
        checked: tokio::sync::Notify::new(),
    });
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register_arc(tool))
        .build_with_profile_directory()
        .with_native_tool_authorization(authority.clone());
    let owner = tokio::spawn(async move {
        engine
            .execute_tool(
                "original-waiting-call",
                &name,
                serde_json::json!({"uri":"resource://original"}),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        authority.checked.notified(),
    )
    .await
    .unwrap();
    assert_eq!(sends.load(Ordering::SeqCst), 0);
    authority.allowed.store(false, Ordering::SeqCst);
    drop(held_transport);
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), owner)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.0.is_error);
    assert_eq!(sends.load(Ordering::SeqCst), 0);
}
