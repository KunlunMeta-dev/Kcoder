//! Engine constraint plumbing uses explicit guard fixtures, not a service authorization producer.
use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_tools::{FileReadTool, ToolRegistry};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Constraint {
    current: AtomicBool,
    checks: AtomicUsize,
}
#[async_trait::async_trait]
impl NativeInvocationConstraint for Constraint {
    async fn verify(
        &self,
        _: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        if self.current.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
}
struct Source {
    current: AtomicBool,
    checks: AtomicUsize,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for Source {
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        if self.current.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
}
async fn invoke(engine: &QueryEngine) -> Result<(), NativeToolAuthorizationError> {
    let registry = engine.active_tool_registry();
    let tool = registry.get("read").unwrap();
    engine
        .authorize_native_tool(
            &registry,
            &tool,
            "read",
            &serde_json::json!({}),
            false,
            NativeToolAuthorizationPhase::Dispatch,
        )
        .await
}
#[test]
fn invocation_constraint_cannot_create_an_original_source_authority() {
    let temp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
    assert!(
        engine
            .with_native_invocation_constraint(Arc::new(Constraint {
                current: AtomicBool::new(true),
                checks: AtomicUsize::new(0)
            }))
            .is_err()
    );
}
#[tokio::test]
async fn invocation_constraint_preserves_original_guard_identity_and_current_denials() {
    let temp = tempfile::tempdir().unwrap();
    let source = Arc::new(Source {
        current: AtomicBool::new(true),
        checks: AtomicUsize::new(0),
    });
    let constraint = Arc::new(Constraint {
        current: AtomicBool::new(true),
        checks: AtomicUsize::new(0),
    });
    let engine = TestEngineBuilder::new(temp.path())
        .tool_registry(ToolRegistry::new().register(FileReadTool))
        .build_with_profile_directory()
        .with_native_tool_authorization(source.clone())
        .with_native_invocation_constraint(constraint.clone())
        .unwrap()
        .with_native_tool_authorization(source.clone())
        .with_native_invocation_constraint(constraint.clone())
        .unwrap();
    invoke(&engine).await.unwrap();
    assert_eq!(source.checks.load(Ordering::SeqCst), 1);
    assert_eq!(constraint.checks.load(Ordering::SeqCst), 1);
    constraint.current.store(false, Ordering::SeqCst);
    assert_eq!(
        invoke(&engine).await.unwrap_err(),
        NativeToolAuthorizationError::Denied
    );
    assert_eq!(source.checks.load(Ordering::SeqCst), 1);
    constraint.current.store(true, Ordering::SeqCst);
    source.current.store(false, Ordering::SeqCst);
    assert_eq!(
        invoke(&engine).await.unwrap_err(),
        NativeToolAuthorizationError::Denied
    );
    assert_eq!(source.checks.load(Ordering::SeqCst), 2);
    assert_eq!(constraint.checks.load(Ordering::SeqCst), 3);
}

#[cfg(unix)]
#[tokio::test]
async fn fixed_native_code_purpose_suppresses_actual_lifecycle_commands_after_source_install() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("hook-ran");
    let marker_argument = format!("'{}'", marker.to_string_lossy().replace('\'', "'\\''"));
    let hooks: kcoder_hooks::HooksSettings =
        serde_json::from_value(serde_json::json!({"SessionStart":[{"hooks":[
            {"type":"command","command":format!("printf native > {marker_argument}")}
        ]}]}))
        .unwrap();
    let mut engine = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
    engine.hook_registry = kcoder_hooks::HookRegistry::from_settings(hooks);
    engine.run_startup_hooks().await;
    assert!(
        marker.exists(),
        "the owned command hook must actually be executable in the baseline"
    );
    std::fs::remove_file(&marker).unwrap();
    let source = Arc::new(Source {
        current: AtomicBool::new(true),
        checks: AtomicUsize::new(0),
    });
    let constraint = Arc::new(Constraint {
        current: AtomicBool::new(true),
        checks: AtomicUsize::new(0),
    });
    let engine = engine
        .with_native_tool_authorization(source)
        .with_native_code_execution_constraint(constraint)
        .unwrap();
    engine.run_startup_hooks().await;
    assert!(
        !marker.exists(),
        "the code-only authority must suppress the actual command, not merely clear an unrelated settings field"
    );
    assert!(engine.active_tool_registry().names().is_empty());
}

struct CodeOnlySource {
    state: kcoder_state::AppState,
}
#[async_trait::async_trait]
impl NativeToolAuthorization for CodeOnlySource {
    async fn authorize_provider(
        &self,
        _: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Denied)
    }
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Denied)
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> Result<(), NativeToolAuthorizationError> {
        if frame.execution().matches_state(&self.state) {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
}
fn current_constraint() -> Arc<Constraint> {
    Arc::new(Constraint {
        current: AtomicBool::new(true),
        checks: AtomicUsize::new(0),
    })
}

struct WorkflowNameOnly;
#[async_trait::async_trait]
impl kcoder_tools::Tool for WorkflowNameOnly {
    fn name(&self) -> String {
        "Workflow".into()
    }
    fn description(&self) -> String {
        "Negative contribution identity fixture".into()
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({"type":"object"})
    }
    async fn call(
        &self,
        _: serde_json::Value,
        _: &kcoder_tools::ToolContext,
    ) -> Result<kcoder_tools::ToolOutput, kcoder_tools::ToolError> {
        panic!("a same-name fake contribution must never execute")
    }
}

#[test]
fn saved_code_workflow_contribution_requires_original_guard_and_actual_arc_without_broadening_old_empty_ceiling()
 {
    let temp = tempfile::tempdir().unwrap();
    let engine = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
    let workflow: Arc<dyn kcoder_tools::Tool> = Arc::new(kcoder_tools::workflow::WorkflowTool);
    assert!(
        engine
            .clone()
            .with_native_code_workflow_execution_constraint(workflow.clone(), current_constraint())
            .is_err()
    );
    let source = Arc::new(CodeOnlySource {
        state: engine.state.clone(),
    });
    let guarded = engine.with_native_tool_authorization(source);
    assert!(
        guarded
            .clone()
            .with_native_code_workflow_execution_constraint(
                Arc::new(WorkflowNameOnly),
                current_constraint()
            )
            .is_err()
    );
    assert!(
        guarded
            .clone()
            .with_native_code_workflow_execution_constraint(
                Arc::new(FileReadTool),
                current_constraint()
            )
            .is_err()
    );
    let empty = guarded
        .clone()
        .with_native_code_execution_constraint(current_constraint())
        .unwrap();
    assert!(
        empty
            .with_native_code_workflow_execution_constraint(workflow.clone(), current_constraint())
            .is_err()
    );
    let fixed = guarded
        .with_native_code_workflow_execution_constraint(workflow.clone(), current_constraint())
        .unwrap();
    assert_eq!(
        fixed.active_tool_registry().names(),
        vec!["Workflow".to_owned()]
    );
    assert!(Arc::ptr_eq(
        &fixed.active_tool_registry().get("Workflow").unwrap(),
        &workflow
    ));
}

#[tokio::test]
async fn saved_code_private_pinned_launch_executes_original_code_but_model_and_arbitrary_tool_calls_stay_denied()
 {
    use kcoder_tools::workflow::{
        WorkflowNativeDefinition, WorkflowNativeLaunch, WorkflowNativeLaunchObserver,
    };
    use sha2::{Digest, Sha256};
    struct OriginalLaunch {
        id: String,
        definition: String,
        input: String,
        calls: std::sync::Mutex<Vec<WorkflowNativeLaunch>>,
    }
    impl WorkflowNativeLaunchObserver for OriginalLaunch {
        fn before_dispatch(
            &self,
            launch: &WorkflowNativeLaunch,
        ) -> Result<(), kcoder_tools::ToolError> {
            if launch.definition_id != self.id
                || launch.version != 1
                || launch.definition_sha256 != self.definition
                || launch.inputs_sha256 != self.input
            {
                return Err(kcoder_tools::ToolError::Execution(
                    "ORIGINAL_PIN_CHANGED".into(),
                ));
            }
            self.calls.lock().unwrap().push(launch.clone());
            Ok(())
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("owned-profile");
    std::fs::create_dir(&profile).unwrap();
    let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
    let draft = library
        .create(
            "Actual pinned Code component regression",
            "No provider or source authorization producer",
        )
        .unwrap();
    let draft = library.upsert_node(&draft.id, draft.revision, serde_json::from_value(serde_json::json!({
        "id":"code","title":"Original bounded code","kind":"code","config":{"code":{"source":"return {marker:'ACTUAL_NATIVE_CODE_CONTRIBUTION',value:input.value*2};"}}
    })).unwrap()).unwrap();
    let saved = library.save(&draft.id, draft.revision).unwrap();
    let definition = library.read_saved(&saved.id, Some(1)).unwrap();
    let definition_sha = kcoder_workflow::store::definition_fingerprint(&definition).unwrap();
    let args = serde_json::json!({"value":7});
    let input_sha = format!("{:x}", Sha256::digest(serde_json::to_vec(&args).unwrap()));
    let native = Arc::new(
        WorkflowNativeDefinition::from_pinned_definition(
            definition,
            &definition_sha,
            args.clone(),
            &input_sha,
        )
        .unwrap(),
    );
    let observer = Arc::new(OriginalLaunch {
        id: saved.id.clone(),
        definition: definition_sha,
        input: input_sha,
        calls: std::sync::Mutex::new(vec![]),
    });
    let baseline = TestEngineBuilder::new(temp.path())
        .build_with_profile_directory()
        .with_settings_persistence_path(profile.join("settings.json"));
    let source = Arc::new(CodeOnlySource {
        state: baseline.state.clone(),
    });
    let workflow: Arc<dyn kcoder_tools::Tool> = Arc::new(kcoder_tools::workflow::WorkflowTool);
    let engine = baseline
        .with_native_tool_authorization(source)
        .with_native_code_workflow_execution_constraint(workflow.clone(), current_constraint())
        .unwrap();
    assert!(engine.authorize_native_provider().await.is_err());
    for input in [
        serde_json::json!({"script":"return 99"}),
        serde_json::json!({"definition_id":"other","version":1}),
        serde_json::json!({"definition_id":saved.id,"version":2}),
    ] {
        assert!(
            engine
                .authorize_native_tool(
                    &engine.active_tool_registry(),
                    &workflow,
                    "Workflow",
                    &input,
                    false,
                    NativeToolAuthorizationPhase::Dispatch
                )
                .await
                .is_err()
        );
        assert!(
            engine
                .start_workflow_with_native_definition(input, native.clone(), observer.clone())
                .await
                .is_err()
        );
    }
    assert!(observer.calls.lock().unwrap().is_empty());
    let other = ToolRegistry::new().register(FileReadTool);
    assert!(
        engine
            .authorize_native_tool(
                &other,
                &other.get("read").unwrap(),
                "read",
                &serde_json::json!({}),
                false,
                NativeToolAuthorizationPhase::Dispatch
            )
            .await
            .is_err()
    );
    let output = engine.start_workflow_with_native_definition(serde_json::json!({"definition_id":saved.id,"version":1,"args_json":serde_json::to_string(&args).unwrap()}), native, observer.clone()).await.unwrap();
    let run = output
        .content
        .iter()
        .find_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } => {
                serde_json::from_str::<serde_json::Value>(text)
                    .ok()
                    .and_then(|value| value["run_id"].as_str().map(str::to_owned))
            }
            _ => None,
        })
        .unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let record =
            kcoder_tools::workflow_runs::observe_read(profile.join("workflow-runs"), &run).unwrap();
        if record.status == "completed" {
            assert!(record.node_states.iter().any(|node| {
                node.output_preview
                    .as_deref()
                    .is_some_and(|value| value.contains("ACTUAL_NATIVE_CODE_CONTRIBUTION"))
            }));
            break;
        }
        assert!(
            !matches!(record.status.as_str(), "failed" | "cancelled"),
            "actual owned Code failed: {}",
            record.status
        );
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(observer.calls.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn saved_code_workflow_contribution_keeps_actual_startup_hook_suppressed() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("owned-workflow-hook-marker");
    let marker_argument = format!("'{}'", marker.to_string_lossy().replace('\'', "'\\''"));
    let hooks: kcoder_hooks::HooksSettings =
        serde_json::from_value(serde_json::json!({"SessionStart":[{"hooks":[
            {"type":"command","command":format!("printf native > {marker_argument}")}
        ]}]}))
        .unwrap();
    let mut engine = TestEngineBuilder::new(temp.path()).build_with_profile_directory();
    engine.hook_registry = kcoder_hooks::HookRegistry::from_settings(hooks);
    engine.run_startup_hooks().await;
    assert!(marker.exists());
    std::fs::remove_file(&marker).unwrap();
    let source = Arc::new(CodeOnlySource {
        state: engine.state.clone(),
    });
    let engine = engine
        .with_native_tool_authorization(source)
        .with_native_code_workflow_execution_constraint(
            Arc::new(kcoder_tools::workflow::WorkflowTool),
            current_constraint(),
        )
        .unwrap();
    engine.run_startup_hooks().await;
    assert!(!marker.exists());
}
