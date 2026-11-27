use super::*;
use kcoder_types::workflow::WorkflowNode;
use kcoder_workflow::{
    AgentExecutor, AgentRequest, EventSink, WorkflowEvent, WorkflowRuntime, WorkflowRuntimeConfig,
};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

fn input() -> Value {
    json!({"period":"2026-W43","asOfDate":"2026-10-24","sourceRefs":[{"kind":"publication","id":"actual-explicit-source-reference","revision":"1"}]})
}

#[test]
fn actual_builtin_graphs_pin_real_sha_and_typed_defaults_without_creating_user_library()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("user-library");
    let store = WorkflowStore::new(&path);
    let templates = super::super::super::list_business_templates("en");
    assert_eq!(templates.len(), 7);
    for template in templates {
        let input = if template.id == "scheduled-review" {
            json!({"requirements":"Summarize important decisions","sourceRefs":[{"kind":"publication","id":"actual-explicit-source-reference","revision":"1"}]})
        } else {
            input()
        };
        let pin = resolve_pinned_business_workflow(
            &store,
            &template.workflow_id,
            template.workflow_version,
            &input,
            None,
        )?;
        let expected = resolve_business_workflow(&store, &template.workflow_id, 1)?;
        assert_eq!(pin.definition(), &expected);
        assert_eq!(pin.definition_sha256(), definition_fingerprint(&expected)?);
        let native = kcoder_tools::workflow::WorkflowNativeDefinition::from_pinned_definition(
            pin.definition().clone(),
            pin.definition_sha256(),
            pin.args().clone(),
            pin.inputs_sha256(),
        )?;
        assert_eq!(native.definition(), pin.definition());
        assert_eq!(native.inputs_sha256(), pin.inputs_sha256());
        assert_eq!(pin.args()["outputLanguage"], "zh-CN");
        assert_eq!(
            pin.args()["requirements"],
            if template.id == "scheduled-review" {
                "Summarize important decisions"
            } else {
                ""
            }
        );
        assert!(pin.input_schema_sha256().is_some());
        assert_eq!(
            pin.inputs_sha256(),
            format!("{:x}", Sha256::digest(serde_json::to_vec(pin.args())?))
        );
        assert!(
            pin.definition()
                .nodes
                .iter()
                .any(|node| node.kind == kcoder_types::workflow::WorkflowNodeKind::Agent)
        );
        pin.verify_source(&store)?;
        let repeated = resolve_pinned_business_workflow(
            &store,
            &template.workflow_id,
            1,
            pin.args(),
            Some(pin.definition_sha256()),
        )?;
        assert_eq!(repeated.inputs_sha256(), pin.inputs_sha256());
    }
    assert!(!path.exists());
    Ok(())
}

#[test]
fn wrong_id_revision_fingerprint_and_typed_input_refuse_without_prompt_or_library_fallback()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("no-fake-versions");
    let store = WorkflowStore::new(&path);
    for (id, version) in [
        ("builtin-office-unknown", 1),
        ("builtin-office-weekly-report", 2),
        ("builtin-office-weekly-report", 0),
    ] {
        assert!(resolve_pinned_business_workflow(&store, id, version, &input(), None).is_err());
    }
    assert!(
        resolve_pinned_business_workflow(
            &store,
            "builtin-office-weekly-report",
            1,
            &input(),
            Some(&"0".repeat(64))
        )
        .is_err()
    );
    assert!(
        resolve_pinned_business_workflow(
            &store,
            "builtin-office-weekly-report",
            1,
            &json!({}),
            None
        )
        .is_err()
    );
    let mut wrong = input();
    wrong["sourceRefs"] = json!("not-an-array");
    assert!(
        resolve_pinned_business_workflow(&store, "builtin-office-weekly-report", 1, &wrong, None)
            .is_err()
    );
    wrong = input();
    wrong["period"] = json!(7);
    assert!(
        resolve_pinned_business_workflow(&store, "builtin-office-weekly-report", 1, &wrong, None)
            .is_err()
    );
    wrong = input();
    wrong["trusted"] = json!(true);
    assert!(
        resolve_pinned_business_workflow(&store, "builtin-office-weekly-report", 1, &wrong, None)
            .is_err()
    );
    assert!(!path.exists());
    Ok(())
}

fn local_version(store: &WorkflowStore) -> Result<WorkflowDefinition> {
    let schema = json!({"type":"object","additionalProperties":false,"required":["values","sourceRevision","expectedTotal"],"properties":{"values":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"number"}},"factor":{"type":"integer","default":2},"sourceRevision":{"type":"string","minLength":1},"expectedTotal":{"type":"number"}}});
    let draft = store.create_with_schema(
        "Owned deterministic fixed graph",
        "No Agent or external side effect",
        Some(schema),
    )?;
    let node: WorkflowNode = serde_json::from_value(
        json!({"id":"calculate","kind":"code","title":"Exact local total","config":{"code":{"source":"return {total: input.values.reduce((a,b)=>a+b,0)*input.factor, sourceRevision: input.sourceRevision};"},"outputSchema":{"type":"object","additionalProperties":false,"required":["total","sourceRevision"],"properties":{"total":{"type":"number"},"sourceRevision":{"type":"string"}}},"resultCheck":{"source":"return result.total === input.expectedTotal && result.sourceRevision === input.sourceRevision;"}}}),
    )?;
    let draft = store.upsert_node(&draft.id, draft.revision, node)?;
    store.save(&draft.id, draft.revision)
}
#[derive(Default)]
struct NoAgents(AtomicUsize);
#[async_trait::async_trait]
impl AgentExecutor for NoAgents {
    async fn execute(&self, _: &str, _: AgentRequest) -> std::result::Result<String, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("Agent execution is not part of this local gate".into())
    }
}
#[derive(Default)]
struct Events(Mutex<Vec<WorkflowEvent>>);
impl EventSink for Events {
    fn record(&self, event: WorkflowEvent) {
        self.0.lock().unwrap().push(event)
    }
}

struct ReportProposal {
    requests: Mutex<Vec<AgentRequest>>,
    invalid_first: bool,
    source_missing: bool,
}
#[async_trait::async_trait]
impl AgentExecutor for ReportProposal {
    async fn execute(&self, _: &str, request: AgentRequest) -> std::result::Result<String, String> {
        let mut requests = self.requests.lock().unwrap();
        let first = requests.is_empty();
        requests.push(request);
        let result = json!({"status":"complete","title":"Source-grounded proposal","summary":"An input remains unavailable.",
            "findings":["Preserve the literal source amount 17."],"sourceRefs":if self.source_missing {json!([])} else {json!([{"kind":"publication","id":"actual-explicit-source-reference","revision":"1"}])},"missingInputs":["The approval was not provided."]});
        Ok(if self.invalid_first && first {
            format!("Here is the report:\n{result}")
        } else {
            result.to_string()
        })
    }
}

#[tokio::test]
async fn builtin_repairs_syntax_once_and_finalizes_gaps_without_rewriting_source_facts()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let store = WorkflowStore::new(root.path().join("unused"));
    let pin = resolve_pinned_business_workflow(
        &store,
        "builtin-office-source-digest",
        1,
        &input(),
        None,
    )?;
    let agent = Arc::new(ReportProposal {
        requests: Mutex::new(Vec::new()),
        invalid_first: true,
        source_missing: false,
    });
    let result = WorkflowRuntime::execute_definition(
        pin.definition(),
        pin.args().clone(),
        agent.clone(),
        Arc::new(Events::default()),
        WorkflowRuntimeConfig::default(),
    )
    .await;
    assert!(
        result.is_ok(),
        "The actual fixed graph must repair syntax and keep unresolved input: {result:?}"
    );
    let result = result?;
    let outputs = result["outputs"].as_array().unwrap();
    let proposal = &outputs
        .iter()
        .find(|node| node["nodeId"] == "analyze")
        .unwrap()["output"];
    let final_report = &outputs
        .iter()
        .find(|node| node["nodeId"] == "produce")
        .unwrap()["output"];
    assert_eq!(proposal["status"], "complete");
    assert_eq!(final_report["status"], "needs_input");
    for field in [
        "title",
        "summary",
        "findings",
        "sourceRefs",
        "missingInputs",
    ] {
        assert_eq!(proposal[field], final_report[field]);
    }
    let requests = agent.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].output_repair_only);
    assert!(requests[1].output_repair_only);
    assert!(
        requests[1].allowed_write_paths.is_empty()
            && requests[1].expected_artifacts.is_empty()
            && requests[1].artifact_requirements.is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn builtin_never_retries_valid_json_to_invent_missing_source_references() -> Result<()> {
    let root = tempfile::tempdir()?;
    let store = WorkflowStore::new(root.path().join("unused"));
    let pin = resolve_pinned_business_workflow(
        &store,
        "builtin-office-source-digest",
        1,
        &input(),
        None,
    )?;
    let agent = Arc::new(ReportProposal {
        requests: Mutex::new(Vec::new()),
        invalid_first: false,
        source_missing: true,
    });
    assert!(
        WorkflowRuntime::execute_definition(
            pin.definition(),
            pin.args().clone(),
            agent.clone(),
            Arc::new(Events::default()),
            WorkflowRuntimeConfig::default()
        )
        .await
        .is_err()
    );
    assert_eq!(agent.requests.lock().unwrap().len(), 1);
    Ok(())
}

#[tokio::test]
async fn actual_fixed_local_graph_runs_in_existing_workflow_runtime_without_any_agent() -> Result<()>
{
    let root = tempfile::tempdir()?;
    let store = WorkflowStore::new(root.path().join("actual-owned-library"));
    let saved = local_version(&store)?;
    let args = json!({"values":[2,3],"sourceRevision":"local-r1","expectedTotal":10});
    let pin = resolve_pinned_business_workflow(&store, &saved.id, 1, &args, None)?;
    assert_eq!(pin.args()["factor"], 2);
    pin.verify_source(&store)?;
    let agent = Arc::new(NoAgents::default());
    let events = Arc::new(Events::default());
    let output = WorkflowRuntime::execute_definition(
        pin.definition(),
        pin.args().clone(),
        agent.clone(),
        events.clone(),
        WorkflowRuntimeConfig {
            max_runtime_millis: 1000,
            max_concurrency: 1,
            ..Default::default()
        },
    )
    .await?;
    assert_eq!(
        output["outputs"][0]["output"],
        json!({"total":10,"sourceRevision":"local-r1"})
    );
    assert_eq!(output["verification"]["status"], "passed");
    assert_eq!(agent.0.load(Ordering::SeqCst), 0);
    assert!(
        events
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, WorkflowEvent::NodeCompleted { .. }))
    );
    assert!(
        resolve_pinned_business_workflow(
            &store,
            &saved.id,
            1,
            &json!({"values":"wrong","sourceRevision":"r1","expectedTotal":10}),
            Some(pin.definition_sha256())
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn immutable_saved_version_does_not_upgrade_to_mutable_draft_and_source_tampering_is_rejected()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("owned-library");
    let store = WorkflowStore::new(&path);
    let saved = local_version(&store)?;
    let args = json!({"values":[2,3],"sourceRevision":"local-r1","expectedTotal":10});
    let pin = resolve_pinned_business_workflow(&store, &saved.id, 1, &args, None)?;
    let draft = store.read(&saved.id)?;
    store.update_metadata(
        &saved.id,
        draft.revision,
        "New draft only",
        "Must not replace the saved body",
        saved.input_schema.clone(),
    )?;
    pin.verify_source(&store)?;
    let mut mutated = pin.definition().clone();
    mutated.description = "Not the original source".into();
    assert!(pin.verify_definition(&mutated).is_err());
    let file = path.join("library.json");
    let mut library: Value = serde_json::from_slice(&std::fs::read(&file)?)?;
    library["records"][&saved.id]["versions"]["1"]["description"] =
        json!("Actual changed saved source bytes");
    std::fs::write(&file, serde_json::to_vec(&library)?)?;
    assert!(pin.verify_source(&store).is_err());
    assert!(
        resolve_pinned_business_workflow(
            &store,
            &saved.id,
            1,
            &args,
            Some(pin.definition_sha256())
        )
        .is_err()
    );
    Ok(())
}
