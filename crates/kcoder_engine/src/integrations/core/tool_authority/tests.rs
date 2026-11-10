mod approved_invocation;
mod emitter;
use super::*;
use super::{
    NativeToolAuthorization, NativeToolAuthorizationError, NativeToolAuthorizationRequest,
};
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_tools::{Tool, ToolContext, ToolError, ToolOutput, ToolSource};
use kcoder_types::{ClientPresentationV1, StudioWorkMode};
use std::sync::atomic::{AtomicUsize, Ordering};

struct ArcIdentityGuard {
    calls: AtomicUsize,
    enabled: std::sync::atomic::AtomicBool,
}
impl ArcIdentityGuard {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            enabled: std::sync::atomic::AtomicBool::new(true),
        })
    }
}
#[async_trait::async_trait]
impl NativeToolAuthorization for ArcIdentityGuard {
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.enabled.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
}
async fn invoke_actual_registered_guard(
    engine: &QueryEngine,
) -> Result<(), NativeToolAuthorizationError> {
    let registry = engine.active_tool_registry();
    let tool = registry.get("read").unwrap();
    engine
        .authorize_native_tool(
            &registry,
            &tool,
            "read",
            &serde_json::json!({}),
            false,
            NativeToolAuthorizationPhase::Admission,
        )
        .await
}
#[tokio::test]
async fn same_actual_arc_is_checked_once_even_after_nested_intersections() {
    let temp = tempfile::tempdir().unwrap();
    let a = ArcIdentityGuard::new();
    let b = ArcIdentityGuard::new();
    let c = ArcIdentityGuard::new();
    let engine = TestEngineBuilder::new(temp.path())
        .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
        .build_with_profile_directory()
        .with_native_tool_authorization(a.clone())
        .with_native_tool_authorization(b.clone())
        .with_native_tool_authorization(a.clone())
        .with_native_tool_authorization(c.clone())
        .with_native_tool_authorization(b.clone());
    invoke_actual_registered_guard(&engine).await.unwrap();
    for guard in [&a, &b, &c] {
        assert_eq!(guard.calls.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn distinct_equal_configured_guard_arcs_are_both_checked_and_can_revoke() {
    let temp = tempfile::tempdir().unwrap();
    let a = ArcIdentityGuard::new();
    let b = ArcIdentityGuard::new();
    let engine = TestEngineBuilder::new(temp.path())
        .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
        .build_with_profile_directory()
        .with_native_tool_authorization(a.clone())
        .with_native_tool_authorization(b.clone());
    invoke_actual_registered_guard(&engine).await.unwrap();
    assert_eq!(a.calls.load(Ordering::SeqCst), 1);
    assert_eq!(b.calls.load(Ordering::SeqCst), 1);
    b.enabled.store(false, Ordering::SeqCst);
    assert!(matches!(
        invoke_actual_registered_guard(&engine).await,
        Err(NativeToolAuthorizationError::Denied)
    ));
    assert_eq!(a.calls.load(Ordering::SeqCst), 2);
    assert_eq!(b.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn repeated_same_arc_never_caches_or_replaces_its_current_denial() {
    let temp = tempfile::tempdir().unwrap();
    let a = ArcIdentityGuard::new();
    let engine = TestEngineBuilder::new(temp.path())
        .tool_registry(ToolRegistry::new().register(kcoder_tools::FileReadTool))
        .build_with_profile_directory()
        .with_native_tool_authorization(a.clone())
        .with_native_tool_authorization(a.clone());
    invoke_actual_registered_guard(&engine).await.unwrap();
    a.enabled.store(false, Ordering::SeqCst);
    assert!(matches!(
        invoke_actual_registered_guard(&engine).await,
        Err(NativeToolAuthorizationError::Denied)
    ));
    assert_eq!(a.calls.load(Ordering::SeqCst), 2);
}

fn office(engine: QueryEngine) -> QueryEngine {
    engine.with_client_presentation(Some(ClientPresentationV1 {
        version: 1,
        studio_work_mode: Some(StudioWorkMode::Kworker),
        inline_widgets: false,
        isolated_widgets: false,
    }))
}

#[test]
fn empty_ceiling_stays_empty_across_kworker_discovery_role_and_registry_replacement() {
    let root = tempfile::tempdir().unwrap();
    let original = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory(),
    );
    assert!(original.active_tool_registry().get("tool_search").is_some());
    let restricted = original.clone().with_native_tool_ceiling(&[]).unwrap();
    for engine in [
        restricted.clone(),
        restricted.with_turn_tools(kcoder_tools::default_registry()),
    ] {
        assert!(engine.tools.names().is_empty());
        assert!(engine.active_tool_registry().names().is_empty());
        assert!(
            engine
                .active_tool_registry_for_mode(true)
                .names()
                .is_empty()
        );
        assert!(
            engine
                .active_subagent_tools_for_mode(false)
                .names()
                .is_empty()
        );
        assert!(
            engine
                .active_subagent_tools_for_mode(true)
                .names()
                .is_empty()
        );
        assert!(engine.searchable_tools().names().is_empty());
        assert!(engine.deferred_tools_snapshot().tools.names().is_empty());
    }
    assert!(
        original.active_tool_registry().get("tool_search").is_some(),
        "a peer engine must retain its original policy"
    );
    assert!(!original.active_subagent_tools().names().is_empty());
}

#[test]
fn native_ceiling_intersects_and_is_inherited_by_fork_without_broadening() {
    let root = tempfile::tempdir().unwrap();
    let parent = TestEngineBuilder::new(root.path())
        .tool_registry(kcoder_tools::default_registry())
        .build_with_profile_directory()
        .with_native_tool_ceiling(&["read".into()])
        .unwrap();
    let narrowed = parent
        .clone()
        .with_native_tool_ceiling(&["read".into(), "bash".into()])
        .unwrap()
        .with_turn_tools(kcoder_tools::default_registry());
    assert_eq!(narrowed.active_tool_registry().names(), vec!["read"]);
    assert_eq!(narrowed.active_subagent_tools().names(), vec!["read"]);
    let fork = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(kcoder_tools::default_registry())
            .build_with_profile_directory(),
    )
    .with_inherited_native_tool_ceiling(&parent);
    assert_eq!(fork.active_tool_registry().names(), vec!["read"]);
    assert_eq!(
        fork.active_subagent_tools_for_mode(true).names(),
        vec!["read"]
    );
    assert!(fork.with_native_tool_ceiling(&["*".into()]).is_err());
}

struct DeferredTool {
    name: &'static str,
    calls: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl Tool for DeferredTool {
    fn name(&self) -> String {
        self.name.into()
    }
    fn description(&self) -> String {
        "Native office capability".into()
    }
    fn source(&self) -> ToolSource {
        ToolSource::NativeFeature {
            feature: "office".into(),
            tool: self.name.into(),
            revision: "1".into(),
        }
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type":"object"})
    }
    async fn call(&self, _: serde_json::Value, _: &ToolContext) -> Result<ToolOutput, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput::text("native-result"))
    }
}

#[tokio::test]
async fn deferred_catalog_and_execution_cannot_escape_native_ceiling() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new()
        .register(DeferredTool {
            name: "OfficeAllowed",
            calls: calls.clone(),
        })
        .register(DeferredTool {
            name: "OfficeBlocked",
            calls: calls.clone(),
        });
    let engine = office(
        TestEngineBuilder::new(root.path())
            .tool_registry(registry)
            .build_with_profile_directory(),
    )
    .with_native_tool_ceiling(&[
        "tool_search".into(),
        "tool_execute".into(),
        "OfficeAllowed".into(),
    ])
    .unwrap();
    assert_eq!(engine.searchable_tools().names(), vec!["OfficeAllowed"]);
    let result = engine
        .execute_tool(
            "blocked-direct",
            "OfficeBlocked",
            serde_json::json!({}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await;
    assert!(result.is_err() || result.unwrap().0.is_error);
    let result = engine
        .execute_tool(
            "blocked-deferred",
            "tool_execute",
            serde_json::json!({"tool_name":"OfficeBlocked","arguments":{}}),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await;
    assert!(result.is_err() || result.unwrap().0.is_error);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

struct RevocableAuthorization {
    enabled: std::sync::atomic::AtomicBool,
    observations: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for RevocableAuthorization {
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.observations
            .lock()
            .unwrap()
            .push((request.tool_name.into(), request.input.clone()));
        if self.enabled.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
}

#[tokio::test]
async fn revocation_reaches_existing_engine_and_fork_and_a_new_guard_cannot_remove_it() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = ToolRegistry::new().register(DeferredTool {
        name: "OfficeAllowed",
        calls: calls.clone(),
    });
    let authority = Arc::new(RevocableAuthorization {
        enabled: std::sync::atomic::AtomicBool::new(true),
        observations: Default::default(),
    });
    let parent = TestEngineBuilder::new(root.path())
        .tool_registry(registry.clone())
        .build_with_profile_directory()
        .with_native_tool_authorization(authority.clone());
    let fork = TestEngineBuilder::new(root.path())
        .tool_registry(registry)
        .build_with_profile_directory()
        .with_inherited_native_tool_ceiling(&parent);
    let input = serde_json::json!({"revision":"original"});
    let result = parent
        .execute_tool(
            "allowed",
            "OfficeAllowed",
            input.clone(),
            &kcoder_permissions::AutoAllowPrompt,
        )
        .await
        .unwrap();
    assert!(!result.0.is_error);
    authority.enabled.store(false, Ordering::SeqCst);
    let permissive = Arc::new(RevocableAuthorization {
        enabled: std::sync::atomic::AtomicBool::new(true),
        observations: Default::default(),
    });
    for engine in [parent.with_native_tool_authorization(permissive), fork] {
        let result = engine
            .execute_tool(
                "revoked",
                "OfficeAllowed",
                input.clone(),
                &kcoder_permissions::AutoAllowPrompt,
            )
            .await
            .unwrap();
        assert!(result.0.is_error);
        assert_eq!(result.1, kcoder_permissions::PermissionDecision::Deny);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let observations = authority.observations.lock().unwrap();
    assert_eq!(observations.len(), 4);
    assert!(
        observations
            .iter()
            .all(|(name, value)| name == "OfficeAllowed" && value == &input)
    );
}

struct RevokingPrompt(Arc<RevocableAuthorization>);
#[async_trait::async_trait]
impl kcoder_permissions::PermissionPrompt for RevokingPrompt {
    async fn ask(
        &self,
        _: &str,
        _: String,
        _: &serde_json::Value,
    ) -> kcoder_permissions::PermissionResponse {
        self.0.enabled.store(false, Ordering::SeqCst);
        kcoder_permissions::PermissionResponse::AllowOnce
    }
}

#[tokio::test]
async fn authority_revoked_during_permission_wait_prevents_the_tool_effect() {
    let root = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let authority = Arc::new(RevocableAuthorization {
        enabled: std::sync::atomic::AtomicBool::new(true),
        observations: Default::default(),
    });
    let engine = TestEngineBuilder::new(root.path())
        .tool_registry(ToolRegistry::new().register(DeferredTool {
            name: "OfficeAllowed",
            calls: calls.clone(),
        }))
        .build_with_profile_directory()
        .with_native_tool_authorization(authority.clone());
    engine.permissions.write().unwrap().mode = kcoder_config::PermissionMode::Ask;
    let result = engine
        .execute_tool(
            "revoke-during-approval",
            "OfficeAllowed",
            serde_json::json!({}),
            &RevokingPrompt(authority.clone()),
        )
        .await
        .unwrap();
    assert!(result.0.is_error);
    assert_eq!(result.1, kcoder_permissions::PermissionDecision::Deny);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(authority.observations.lock().unwrap().len(), 2);
}
