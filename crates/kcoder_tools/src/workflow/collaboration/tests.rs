use super::*;
use crate::{Tool, workflow_draft::WorkflowDraftTool};
use kcoder_types::workflow::*;
use serde_json::json;

fn plan() -> WorkflowCollaborationPlan {
    let member = |id: &str, role: WorkflowCollaborationRole| WorkflowCollaborationMember {
        id: id.into(),
        title: id.into(),
        role,
        instructions: format!("Inspect original member {id}"),
        model_selection: WorkflowAgentModelSelection::InheritCurrent,
        input_bindings: [("brief".into(), "/input/brief".into())].into(),
        depends_on: vec![],
        allowed_write_paths: vec![],
        acceptance_criteria: vec!["Use actual evidence".into()],
        artifact_requirements: vec![],
        output_schema: json!({"type":"object","properties":{"ok":{"const":true}},"required":["ok"]}),
        result_check: WorkflowCodeConfig {
            source: "return result.ok === true;".into(),
            timeout_ms: 1000,
        },
        max_turns: 2,
    };
    WorkflowCollaborationPlan {
        version: 1,
        input_schema: json!({"type":"object","properties":{"brief":{"type":"string"}},"required":["brief"]}),
        members: vec![
            member("read", WorkflowCollaborationRole::Researcher),
            member("verify", WorkflowCollaborationRole::Verifier),
        ],
    }
}
fn payload(output: crate::ToolOutput) -> serde_json::Value {
    serde_json::from_str(
        &output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>(),
    )
    .unwrap()
}
#[tokio::test]
async fn catalog_is_nonexecuting_and_does_not_initialize_profile_storage() {
    let temp = tempfile::tempdir().unwrap();
    let context = ToolContext::new(kcoder_state::AppState::new(temp.path()));
    let before: Vec<_> = std::fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    let value = payload(
        WorkflowDraftTool
            .call(json!({"action":"collaboration_presets"}), &context)
            .await
            .unwrap(),
    );
    assert_eq!(value["roles"].as_array().unwrap().len(), 5);
    let after: Vec<_> = std::fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(before, after);
}
#[tokio::test]
async fn normal_authoring_entry_applies_lossless_plan_with_cas_and_preserves_fixed_version() {
    let temp = tempfile::tempdir().unwrap();
    let directory = kcoder_config::PrivateDirectory::open_existing(temp.path()).unwrap();
    let profile = directory
        .create_private_child(std::ffi::OsStr::new("profile"))
        .unwrap();
    profile
        .atomic_replace(std::ffi::OsStr::new("settings.json"), b"{}")
        .unwrap();
    let context = ToolContext::new(kcoder_state::AppState::new(temp.path()))
        .with_settings_persistence_path(Some(temp.path().join("profile/settings.json")));
    let draft = payload(
        WorkflowDraftTool
            .call(
                json!({"action":"create","title":"Original owned collaboration"}),
                &context,
            )
            .await
            .unwrap(),
    );
    let applied=payload(WorkflowDraftTool.call(json!({"action":"apply_collaboration","id":draft["id"],"expected_revision":draft["revision"],"collaboration_plan_json":serde_json::to_string(&plan()).unwrap()}),&context).await.unwrap());
    assert!(!applied["nodes"].as_array().unwrap().is_empty());
    assert!(WorkflowDraftTool.call(json!({"action":"apply_collaboration","id":draft["id"],"expected_revision":draft["revision"],"collaboration_plan":plan()}),&context).await.is_err());
    let saved = payload(
        WorkflowDraftTool
            .call(
                json!({"action":"save","id":draft["id"],"expected_revision":applied["revision"]}),
                &context,
            )
            .await
            .unwrap(),
    );
    let read = payload(
        WorkflowDraftTool
            .call(
                json!({"action":"read","id":draft["id"],"version":saved["savedVersion"]}),
                &context,
            )
            .await
            .unwrap(),
    );
    assert_eq!(read, saved);
    assert!(
        context.state.tasks().is_empty(),
        "authoring never starts models or tasks"
    );
}
#[test]
fn missing_unavailable_or_wrong_artifact_reports_cannot_turn_into_verified_completion() {
    let temp = tempfile::tempdir().unwrap();
    let state = kcoder_state::AppState::new(temp.path());
    let requirement = kcoder_state::ArtifactRequirement {
        path: "report.txt".into(),
        min_bytes: 1,
        required: true,
        unique_content: false,
        require_changed: true,
        forbidden_literals: vec![],
    };
    assert!(
        require_artifact_report(&state, "original-agent", std::slice::from_ref(&requirement))
            .is_err()
    );
    let mut task = kcoder_state::Task::new("original-agent", "Original declared task");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.artifact_requirements = vec![requirement.clone()];
    state.upsert_task(task);
    state
        .bind_subagent_artifact_requirements("original-agent", std::slice::from_ref(&requirement))
        .unwrap();
    let (run, _) = state
        .begin_artifact_validation_with_origin(
            "original-agent",
            std::slice::from_ref(&requirement),
            None,
        )
        .unwrap();
    state
        .publish_artifact_validation(
            "original-agent",
            kcoder_state::ArtifactValidationReport {
                run,
                observed_at_ms: 1,
                entries: vec![kcoder_state::ArtifactValidationEntry {
                    index: 0,
                    path: "report.txt".into(),
                    status: kcoder_state::ArtifactValidationStatus::Missing,
                    size_bytes: None,
                    sha256: None,
                }],
            },
        )
        .unwrap();
    assert!(
        require_artifact_report(&state, "original-agent", std::slice::from_ref(&requirement))
            .is_err()
    );
}
fn configuration() -> kcoder_types::ModelConfigurationSummary {
    serde_json::from_value(json!({"providerId":"owned-profile","modelId":"owned-model","apiFormat":"openai","chatProtocol":"chat_completions","contextWindowTokens":32000,"maxOutputTokens":1024,"requestOutputLimits":{},"outputHeadroomTokens":100,"text":true,"tools":true,"vision":false,"reasoning":false,"structuredOutput":false,"reasoningEffort":null,"extraBodyConfigured":false,"requestOverrideFields":[],"revision":"original-native-revision","boundary":"session_snapshot","sources":{}})).unwrap()
}
#[test]
fn model_selection_requires_actual_facts_and_verifier_cannot_switch_pinned_model() {
    use crate::AgentKind;
    let original = configuration();
    assert!(
        RoleModelObserver::for_role(
            WorkflowAgentModelSelection::InheritCurrent,
            None,
            AgentKind::Verifier,
            None
        )
        .is_err()
    );
    let observer = RoleModelObserver::for_role(
        WorkflowAgentModelSelection::InheritCurrent,
        Some(original.clone()),
        AgentKind::Review,
        None,
    )
    .unwrap();
    observer
        .capture(original.clone(), "inherited_session")
        .unwrap();
    let mut changed = original.clone();
    changed.model_id = "other".into();
    assert!(
        observer
            .capture(changed.clone(), "inherited_session")
            .is_err()
    );
    let explicit = WorkflowAgentModelSelection::Explicit {
        profile: Some("owned-profile".into()),
        provider: None,
        model: "other".into(),
        expected_revision: None,
    };
    let verifier =
        RoleModelObserver::for_role(explicit, Some(original), AgentKind::Verifier, None).unwrap();
    assert!(verifier.capture(changed, "explicit_runtime").is_err());
}
