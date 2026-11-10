use super::*;
use async_trait::async_trait;
use kcoder_types::workflow::*;
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn member(
    id: &str,
    role: WorkflowCollaborationRole,
    dependencies: &[&str],
) -> WorkflowCollaborationMember {
    WorkflowCollaborationMember {
        id: id.into(),
        title: id.into(),
        role,
        instructions: format!("Execute original member {id}"),
        model_selection: WorkflowAgentModelSelection::InheritCurrent,
        input_bindings: [("brief".into(), "/input/brief".into())].into(),
        depends_on: dependencies.iter().map(|id| (*id).into()).collect(),
        allowed_write_paths: if role.is_writer() {
            vec!["report.txt".into()]
        } else {
            vec![]
        },
        acceptance_criteria: vec!["Original required work is actually performed".into()],
        artifact_requirements: if role.is_writer() {
            vec![WorkflowArtifactRequirement {
                path: "report.txt".into(),
                min_bytes: 1,
                required: true,
                unique_content: true,
                require_changed: true,
                forbidden_literals: vec!["PLACEHOLDER".into()],
            }]
        } else {
            vec![]
        },
        output_schema: json!({"type":"object","properties":{"ok":{"const":true}},"required":["ok"],"additionalProperties":false}),
        result_check: WorkflowCodeConfig {
            source: "return result.ok === true;".into(),
            timeout_ms: 1000,
        },
        max_turns: 3,
    }
}
fn plan() -> WorkflowCollaborationPlan {
    WorkflowCollaborationPlan {
        version: 1,
        input_schema: json!({"type":"object","properties":{"brief":{"type":"string","minLength":1}},"required":["brief"],"additionalProperties":false}),
        members: vec![
            member("writer_b", WorkflowCollaborationRole::Writer, &["writer_a"]),
            member("reader_b", WorkflowCollaborationRole::Researcher, &[]),
            member("verify", WorkflowCollaborationRole::Verifier, &["writer_b"]),
            member(
                "writer_a",
                WorkflowCollaborationRole::Writer,
                &["reader_a", "reader_b"],
            ),
            member("reader_a", WorkflowCollaborationRole::Researcher, &[]),
        ],
    }
}
fn base() -> WorkflowDefinition {
    WorkflowDefinition {
        id: "owned-definition".into(),
        title: "Actual collaboration".into(),
        description: "Owned acceptance".into(),
        revision: 1,
        status: WorkflowStatus::Draft,
        nodes: vec![],
        created_at_ms: 1,
        updated_at_ms: 1,
        saved_version: None,
        input_schema: None,
    }
}
#[test]
fn compilation_uses_original_topology_and_checks_changed_scoped_artifacts() {
    let result = compile(&base(), &plan()).unwrap();
    let a = result
        .nodes
        .iter()
        .find(|node| node.id == "writer_a")
        .unwrap();
    let b = result
        .nodes
        .iter()
        .find(|node| node.id == "writer_b")
        .unwrap();
    assert!(!a.depends_on.contains(&"writer_b".into()));
    assert!(b.depends_on.contains(&"writer_a".into()));
    for reader in ["reader_a", "reader_b"] {
        let node = result.nodes.iter().find(|node| node.id == reader).unwrap();
        assert_eq!(node.depends_on, [compiler::INPUT_ID]);
    }
    assert!(
        result
            .nodes
            .iter()
            .filter(|node| node.kind == WorkflowNodeKind::Tool)
            .all(|node| node.depends_on.contains(&"writer_a".into())
                && node.depends_on.contains(&"writer_b".into()))
    );
    assert!(a.config.artifact_requirements[0].require_changed);
}
#[test]
fn deleting_write_order_or_lying_about_roles_cannot_save_an_executable_collaboration() {
    let mut input = plan();
    input
        .members
        .iter_mut()
        .find(|node| node.id == "writer_b")
        .unwrap()
        .depends_on
        .clear();
    let mut result = compile(&base(), &input).unwrap();
    result
        .nodes
        .iter_mut()
        .find(|node| node.id == "writer_b")
        .unwrap()
        .depends_on
        .retain(|id| id != "writer_a");
    assert!(
        crate::graph::validate(&result, true)
            .unwrap_err()
            .to_string()
            .contains("ordered")
    );
    let mut result = compile(&base(), &plan()).unwrap();
    result
        .nodes
        .iter_mut()
        .find(|node| node.id == "reader_a")
        .unwrap()
        .agent_type = "implementer".into();
    assert!(crate::graph::validate(&result, true).is_err());
}
#[test]
fn contradictory_verification_dependencies_and_escaping_scopes_fail_before_storage() {
    let mut input = plan();
    input
        .members
        .iter_mut()
        .find(|node| node.id == "writer_a")
        .unwrap()
        .depends_on
        .push("verify".into());
    assert!(compile(&base(), &input).is_err());
    for path in [
        "../escape",
        "/absolute",
        "C:\\absolute",
        "scope/**",
        "a//b",
        "a/./b",
    ] {
        let mut input = plan();
        input
            .members
            .iter_mut()
            .find(|node| node.id == "writer_a")
            .unwrap()
            .allowed_write_paths = vec![path.into()];
        assert!(compile(&base(), &input).is_err(), "{path}");
    }
}
#[test]
fn omitted_new_fields_preserve_legacy_serialized_node_and_request_shapes() {
    let config = WorkflowNodeConfig::default();
    assert_eq!(serde_json::to_value(config).unwrap(), json!({}));
    let request: crate::AgentRequest =
        serde_json::from_value(json!({"prompt":"old","agent_type":"explore","max_turns":2}))
            .unwrap();
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({"prompt":"old","agent_type":"explore","max_turns":2})
    );
}
struct Sink;
impl crate::EventSink for Sink {
    fn record(&self, _: crate::WorkflowEvent) {}
}
struct Executor {
    root: std::path::PathBuf,
    readers: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    barrier: tokio::sync::Barrier,
    writes: Mutex<Vec<String>>,
    omit_write: bool,
}
#[async_trait]
impl crate::AgentExecutor for Executor {
    fn tool_is_read_only(&self, name: &str) -> bool {
        name == "read"
    }
    async fn execute(&self, _: &str, request: crate::AgentRequest) -> Result<String, String> {
        assert!(request.model_selection.is_some());
        assert!(request.prompt.contains("\"bindings\""));
        assert!(
            !request.prompt.contains("\"nodes\""),
            "ordering edges do not inject full unrelated outputs"
        );
        if request.agent_type == "explore" {
            let active = self.readers.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(active, Ordering::SeqCst);
            self.barrier.wait().await;
            self.readers.fetch_sub(1, Ordering::SeqCst);
        }
        if request.agent_type == "implementer" {
            let id = if request.prompt.contains("member writer_a") {
                "writer_a"
            } else {
                "writer_b"
            };
            assert!(request.artifact_requirements[0].require_changed);
            self.writes.lock().unwrap().push(id.into());
            if !self.omit_write {
                std::fs::write(self.root.join("report.txt"), id).unwrap();
            }
        }
        Ok("{\"ok\":true}".into())
    }
    async fn execute_tool(&self, _: &str, name: &str, arguments: Value) -> Result<Value, String> {
        assert_eq!(name, "read");
        assert_eq!(arguments["format"], "raw");
        let bytes =
            std::fs::read_to_string(self.root.join(arguments["file_path"].as_str().unwrap()))
                .map_err(|_| "actual required file missing".to_string())?;
        Ok(json!({"isError":false,"content":[{"type":"text","text":bytes}]}))
    }
}
#[tokio::test]
async fn original_runtime_runs_parallel_reads_serial_writes_and_actual_independent_file_checks() {
    for omit_write in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let peak = Arc::new(AtomicUsize::new(0));
        let executor = Arc::new(Executor {
            root: temp.path().into(),
            readers: Arc::new(AtomicUsize::new(0)),
            peak: peak.clone(),
            barrier: tokio::sync::Barrier::new(2),
            writes: Mutex::new(vec![]),
            omit_write,
        });
        let mut definition = compile(&base(), &plan()).unwrap();
        definition.status = WorkflowStatus::Saved;
        definition.saved_version = Some(1);
        let result = crate::WorkflowRuntime::execute_definition(
            &definition,
            json!({"brief":"original declared input"}),
            executor.clone(),
            Arc::new(Sink),
            crate::WorkflowRuntimeConfig {
                max_runtime_millis: 5000,
                ..Default::default()
            },
        )
        .await;
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(
            executor.writes.lock().unwrap().as_slice(),
            &["writer_a", "writer_b"]
        );
        assert_eq!(result.is_ok(), !omit_write, "{result:?}");
        if !omit_write {
            assert_eq!(
                std::fs::read_to_string(temp.path().join("report.txt")).unwrap(),
                "writer_b"
            );
        }
    }
}
#[test]
fn actual_private_store_applies_atomically_and_preserves_fixed_versions() {
    let temp = tempfile::tempdir().unwrap();
    let store = crate::store::WorkflowStore::new(temp.path().join("library"));
    let draft = store.create("Original collaboration", "").unwrap();
    let applied = store
        .initialize_collaboration(&draft.id, draft.revision, &plan(), |_| Ok(()))
        .unwrap();
    assert!(
        store
            .initialize_collaboration(&draft.id, draft.revision, &plan(), |_| Ok(()))
            .is_err()
    );
    let saved = store.save(&draft.id, applied.revision).unwrap();
    let version = store.read_saved(&saved.id, Some(1)).unwrap();
    assert_eq!(saved, version);
    assert!(
        version
            .nodes
            .iter()
            .any(|node| node.config.model_selection.is_some())
    );
}
