use super::*;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
struct NoGeneration(Arc<AtomicUsize>);
impl Provider for NoGeneration {
    fn name(&self) -> &'static str {
        "owned-authoring-only"
    }
    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }
    fn stream_messages(
        &self,
        _: kcoder_types::MessagesRequest,
    ) -> Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("nonexecuting authoring cannot call a model")
    }
}
fn engine(root: &Path) -> (QueryEngine, Arc<AtomicUsize>) {
    let directory = kcoder_config::PrivateDirectory::open_existing(root).unwrap();
    let profile = directory
        .create_private_child(std::ffi::OsStr::new("profile"))
        .unwrap();
    profile
        .atomic_replace(std::ffi::OsStr::new("settings.json"), b"{}")
        .unwrap();
    let settings = kcoder_config::Settings {
        training_mode: true,
        model: "workspace-default-is-not-task-model".into(),
        ..Default::default()
    };
    let calls = Arc::new(AtomicUsize::new(0));
    (
        QueryEngine::new(
            Arc::new(NoGeneration(calls.clone())),
            kcoder_state::AppState::new(root),
            kcoder_tools::ToolRegistry::new()
                .register(kcoder_tools::FileReadTool)
                .register(kcoder_tools::FileWriteTool),
            kcoder_permissions::PermissionEngine::from_settings(&settings),
            settings,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::load_project_only(root).unwrap(),
            Arc::new(kcoder_tools::DenyAllUserQuestioner),
            root.into(),
        )
        .with_settings_persistence_path(root.join("profile/settings.json")),
        calls,
    )
}
#[test]
fn catalog_is_readonly_and_never_labels_bootstrap_as_a_selected_thread_model() {
    let temp = tempfile::tempdir().unwrap();
    let (engine, calls) = engine(temp.path());
    let catalog = request(&engine, WORKFLOW_COLLABORATION_CATALOG, json!({})).unwrap();
    assert_eq!(catalog["roles"].as_array().unwrap().len(), 5);
    assert_eq!(catalog["modelOrigin"], "execution_parent");
    assert!(catalog["modelSnapshot"].is_null());
    let cold = request(
        &engine,
        WORKFLOW_COLLABORATION_CATALOG,
        json!({"threadId":"original-cold-thread"}),
    )
    .unwrap();
    assert_eq!(cold["modelOrigin"], "thread_unobserved");
    assert!(cold["modelSnapshot"].is_null());
    let exact = request(
        &engine,
        WORKFLOW_COLLABORATION_CATALOG,
        json!({"threadId":engine.session_id()}),
    )
    .unwrap();
    assert_eq!(exact["modelOrigin"], "thread_unobserved");
    assert!(
        exact["modelSnapshot"].is_null(),
        "even a bootstrap ID is not a resident-thread model proof"
    );
    assert!(!temp.path().join("profile/workflow-library").exists());
    assert!(engine.state.tasks().is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[test]
fn public_apply_changes_only_original_empty_draft_by_cas_and_save_is_nonexecuting() {
    let temp = tempfile::tempdir().unwrap();
    let (engine, calls) = engine(temp.path());
    let store =
        kcoder_workflow::store::WorkflowStore::new(temp.path().join("profile/workflow-library"));
    let draft = store.create("Original draft", "").unwrap();
    let role = |id: &str, role: WorkflowCollaborationRole| WorkflowCollaborationMember {
        id: id.into(),
        title: id.into(),
        role,
        instructions: "Inspect original declared inputs".into(),
        model_selection: WorkflowAgentModelSelection::InheritCurrent,
        input_bindings: [("brief".into(), "/input/brief".into())].into(),
        depends_on: vec![],
        allowed_write_paths: vec![],
        acceptance_criteria: vec!["Evidence matches".into()],
        artifact_requirements: vec![],
        output_schema: json!({"type":"object"}),
        result_check: WorkflowCodeConfig {
            source: "return typeof result === 'object';".into(),
            timeout_ms: 1000,
        },
        max_turns: 3,
    };
    let plan = WorkflowCollaborationPlan {
        version: 1,
        input_schema: json!({"type":"object","properties":{"brief":{"type":"string"}},"required":["brief"]}),
        members: vec![
            role("research", WorkflowCollaborationRole::Researcher),
            role("verify", WorkflowCollaborationRole::Verifier),
        ],
    };
    let params = WorkflowCollaborationApplyParams {
        id: draft.id.clone(),
        expected_revision: draft.revision,
        plan,
    };
    let applied = request(
        &engine,
        WORKFLOW_COLLABORATION_APPLY,
        serde_json::to_value(&params).unwrap(),
    )
    .unwrap();
    assert!(applied["nodes"].as_array().unwrap().len() > 2);
    assert!(
        request(
            &engine,
            WORKFLOW_COLLABORATION_APPLY,
            serde_json::to_value(&params).unwrap()
        )
        .is_err()
    );
    let saved = super::super::request(
        &engine,
        method::WORKFLOW_SAVE,
        json!({"id":draft.id,"expectedRevision":applied["revision"]}),
    )
    .unwrap();
    assert_eq!(saved["savedVersion"], 1);
    assert!(engine.state.tasks().is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!temp.path().join("profile/workflow-runs").exists());
}
