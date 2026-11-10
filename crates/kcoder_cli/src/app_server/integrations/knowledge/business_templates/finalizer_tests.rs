use super::*;
use kcoder_workflow::{
    AgentExecutor, AgentRequest, EventSink, WorkflowEvent, WorkflowRuntime, WorkflowRuntimeConfig,
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
struct Proposal {
    value: serde_json::Value,
    calls: AtomicUsize,
}
#[async_trait::async_trait]
impl AgentExecutor for Proposal {
    async fn execute(&self, _: &str, request: AgentRequest) -> std::result::Result<String, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(request.prompt.contains("total_units=<number>"));
        Ok(self.value.to_string())
    }
}
struct Sink;
impl EventSink for Sink {
    fn record(&self, _: WorkflowEvent) {}
}

#[tokio::test]
async fn simple_scheduled_review_executes_the_actual_fixed_graph_without_inventing_dates()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let store = WorkflowStore::new(root.path().join("unused"));
    let definition = resolve_business_workflow(&store, "builtin-office-scheduled-review", 1)?;
    let reference = json!({"kind":"publication","id":"selected-original-page","revision":"2"});
    let input = json!({"requirements":"Summarize decisions and include total_units=<number>.","sourceRefs":[reference.clone()]});
    let prepared = kcoder_workflow::graph::prepare_arguments(&definition, &input)?;
    assert!(prepared.get("period").is_none() && prepared.get("asOfDate").is_none());
    for invalid in [
        json!({"requirements":"  ","sourceRefs":[reference.clone()]}),
        json!({"requirements":"Summarize","sourceRefs":[]}),
    ] {
        assert!(kcoder_workflow::graph::prepare_arguments(&definition, &invalid).is_err());
    }
    let proposal = Arc::new(Proposal {
        value: json!({"status":"complete","title":"Decisions","summary":"One item needs confirmation.","findings":["total_units=12"],"sourceRefs":[reference.clone()],"missingInputs":["Confirm the owner."]}),
        calls: AtomicUsize::new(0),
    });
    let result = WorkflowRuntime::execute_definition(
        &definition,
        input,
        proposal.clone(),
        Arc::new(Sink),
        WorkflowRuntimeConfig::default(),
    )
    .await?;
    assert_eq!(proposal.calls.load(Ordering::SeqCst), 1);
    let report = &result["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["nodeId"] == "produce")
        .unwrap()["output"];
    assert_eq!(report["status"], "needs_input");
    assert_eq!(report["sourceRefs"], json!([reference]));
    assert!(!root.path().join("unused").exists());
    Ok(())
}
#[tokio::test]
async fn actual_code_runtime_rejects_missing_labels_and_changed_refs_without_retry_or_rewriting()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let store = WorkflowStore::new(root.path().join("unused"));
    let definition = resolve_business_workflow(&store, "builtin-office-source-digest", 1)?;
    let reference =
        json!({"kind":"publication","id":"explicit-owned-page","revision":"revision-b"});
    let input = json!({"period":"owned period","asOfDate":"2032-03-01","sourceRefs":[reference.clone()],"outputLanguage":"en","requirements":"Include findings total_units=<number>."});
    let correct = json!({"status":"complete","title":"Independent report","summary":"Approval remains unavailable.","findings":["total_units=39"],"sourceRefs":[reference],"missingInputs":["No approval supplied."]});
    for change in ["label", "reference", "valid"] {
        let mut value = correct.clone();
        if change == "label" {
            value["findings"] = json!(["Total units=39"]);
        }
        if change == "reference" {
            value["sourceRefs"][0]["revision"] = json!("not-selected");
        }
        let agent = Arc::new(Proposal {
            value: value.clone(),
            calls: AtomicUsize::new(0),
        });
        let result = WorkflowRuntime::execute_definition(
            &definition,
            input.clone(),
            agent.clone(),
            Arc::new(Sink),
            WorkflowRuntimeConfig::default(),
        )
        .await;
        assert_eq!(agent.calls.load(Ordering::SeqCst), 1);
        match change {
            "label" => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("BUSINESS_REPORT_REQUIRED_FIELD_MISSING")
            ),
            "reference" => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("BUSINESS_REPORT_FIXED_REFERENCES_CHANGED")
            ),
            _ => {
                let output = result?;
                let report = &output["outputs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|node| node["nodeId"] == "produce")
                    .unwrap()["output"];
                assert_eq!(report["status"], "needs_input");
                assert_eq!(report["findings"], value["findings"]);
                assert_eq!(report["sourceRefs"], value["sourceRefs"]);
            }
        }
    }
    assert!(!root.path().join("unused").exists());
    Ok(())
}
