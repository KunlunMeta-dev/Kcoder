use crate::*;
use kcoder_types::workflow::*;
use serde_json::json;
use std::collections::HashMap;

struct Host(HashMap<String, WorkflowDefinition>);
#[async_trait]
impl AgentExecutor for Host {
    async fn execute(&self, _: &str, _: AgentRequest) -> Result<String, String> {
        Err("pure subgraphs must not call an agent".into())
    }
    async fn resolve_workflow(&self, id: &str, _: u64) -> Result<WorkflowDefinition, String> {
        self.0.get(id).cloned().ok_or("missing version".into())
    }
}
struct Sink;
impl EventSink for Sink {
    fn record(&self, _: WorkflowEvent) {}
}
fn graph(id: &str, nodes: Value) -> WorkflowDefinition {
    serde_json::from_value(json!({"id":id,"title":id,"description":"","revision":1,
        "status":"saved","savedVersion":1,"createdAtMs":1,"updatedAtMs":1,"nodes":nodes}))
    .unwrap()
}
fn sub(id: &str, child: &str) -> Value {
    json!({"id":id,"title":id,"kind":"subworkflow","config":{"subworkflow":{
        "definitionId":child,"version":1,"arguments":{"value":21}}}})
}
#[tokio::test]
async fn pure_child_executes_pinned_version_without_consuming_parent_slot() {
    let child = graph(
        "child",
        json!([
            {"id":"compute","title":"Compute","kind":"code","config":{"code":{"source":"return input.value * 2;"}}}
        ]),
    );
    let parent = graph("parent", json!([sub("call", "child")]));
    let output = WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        Arc::new(Host(HashMap::from([("child".into(), child)]))),
        Arc::new(Sink),
        WorkflowRuntimeConfig {
            max_concurrency: 1,
            max_runtime_millis: 1000,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(output["outputs"][0]["output"]["outputs"][0]["output"], 42);
}
#[tokio::test]
async fn rejects_wrong_version_and_recursive_references() {
    let parent = graph("parent", json!([sub("call", "child")]));
    let mut child = graph("child", json!([sub("back", "parent")]));
    let host = Host(HashMap::from([
        ("child".into(), child.clone()),
        ("parent".into(), parent.clone()),
    ]));
    let error = WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        Arc::new(host),
        Arc::new(Sink),
        Default::default(),
    )
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("recursive version cycle"),
        "{error}"
    );
    child.saved_version = Some(2);
    let error = WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        Arc::new(Host(HashMap::from([("child".into(), child)]))),
        Arc::new(Sink),
        Default::default(),
    )
    .await
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("different or unpublished version"),
        "{error}"
    );
}

#[tokio::test]
async fn missing_child_is_rejected_before_any_sibling_agent_executes() {
    struct NoEffects;
    #[async_trait]
    impl AgentExecutor for NoEffects {
        async fn execute(&self, _: &str, _: AgentRequest) -> Result<String, String> {
            panic!("preflight must reject the graph before an agent starts");
        }
        async fn resolve_workflow(&self, _: &str, _: u64) -> Result<WorkflowDefinition, String> {
            Err("missing published version".into())
        }
    }
    let parent = graph(
        "parent",
        json!([
            {"id":"side_effect","title":"Effect","kind":"agent","prompt":"Never run"},
            sub("call", "missing")
        ]),
    );
    let error = WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        Arc::new(NoEffects),
        Arc::new(Sink),
        Default::default(),
    )
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("missing published version"),
        "{error}"
    );
}

#[tokio::test]
async fn loop_can_run_a_pure_subgraph_for_each_item_without_agents() {
    let child = graph(
        "child",
        json!([
            {"id":"compute","title":"Compute","kind":"code","config":{"code":{"source":"return input.value * 2;"}}}
        ]),
    );
    let parent = graph(
        "parent",
        json!([{
            "id":"each","title":"Each","kind":"loop","config":{"loop":{
                "mode":"for_each","maxIterations":3,"collectionPointer":"/input/values",
                "body":{"definitionId":"child","version":1,"bindings":{"value":"/iteration/item"}}
            }}
        }]),
    );
    let output = WorkflowRuntime::execute_definition(
        &parent,
        json!({"values":[2,3,4]}),
        Arc::new(Host(HashMap::from([("child".into(), child)]))),
        Arc::new(Sink),
        WorkflowRuntimeConfig {
            max_concurrency: 1,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let result = &output["outputs"][0]["output"];
    assert_eq!(result["count"], 3);
    for (index, expected) in [4, 6, 8].iter().enumerate() {
        assert_eq!(
            result["iterations"][index]["outputs"][0]["output"],
            *expected
        );
    }
}

#[tokio::test]
async fn read_only_tools_retry_and_mutating_tools_are_never_replayed() {
    struct Flaky {
        calls: AtomicUsize,
        read_only: bool,
    }
    #[async_trait]
    impl AgentExecutor for Flaky {
        fn tool_is_read_only(&self, _: &str) -> bool {
            self.read_only
        }
        async fn execute(&self, _: &str, _: AgentRequest) -> Result<String, String> {
            panic!("no agent")
        }
        async fn execute_tool(&self, _: &str, _: &str, _: Value) -> Result<Value, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err("temporary transport failure".into())
            } else {
                Ok(json!({"value":42}))
            }
        }
    }
    let parent = graph(
        "parent",
        json!([{"id":"fetch","title":"Fetch","kind":"tool","config":{
            "tool":{"name":"lookup"},"failurePolicy":{"maxAttempts":2,"delayMs":1}
        }}]),
    );
    let host = Arc::new(Flaky {
        calls: AtomicUsize::new(0),
        read_only: true,
    });
    let output = WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        host.clone(),
        Arc::new(Sink),
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(output["outputs"][0]["output"]["value"], 42);
    assert_eq!(host.calls.load(Ordering::SeqCst), 2);
    let host = Arc::new(Flaky {
        calls: AtomicUsize::new(0),
        read_only: false,
    });
    assert!(
        WorkflowRuntime::execute_definition(
            &parent,
            json!({}),
            host.clone(),
            Arc::new(Sink),
            Default::default()
        )
        .await
        .is_err()
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn explicit_failure_output_can_route_to_a_recovery_branch() {
    let parent = graph(
        "parent",
        json!([
            {"id":"fail","title":"Fail","kind":"code","config":{"code":{"source":"throw new Error('try recovery');"},"failurePolicy":{"continueOnError":true}}},
            {"id":"route","title":"Route","kind":"condition","dependsOn":["fail"],"config":{"condition":{"op":"exists","pointer":"/nodes/fail/workflowError"}}},
            {"id":"recover","title":"Recover","kind":"code","dependsOn":["route"],"runIf":{"nodeId":"route","equals":true},"config":{"code":{"source":"return {recovered:true};"}}}
        ]),
    );
    let result = WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        Arc::new(Host(HashMap::new())),
        Arc::new(Sink),
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(result["outputs"][2]["output"]["recovered"], true);
    assert_eq!(
        result["outputs"][0]["output"]["workflowError"]["nodeId"],
        "fail"
    );
}

#[tokio::test]
async fn subgraph_loop_stops_when_structured_iteration_result_matches() {
    let child = graph(
        "child",
        json!([
            {"id":"score","title":"Score","kind":"code","config":{"code":{"source":"return (input.index + 1) * 2;"}}}
        ]),
    );
    let parent = graph(
        "parent",
        json!([{"id":"revise","title":"Revise","kind":"loop","config":{"loop":{
            "mode":"repeat","maxIterations":3,"body":{"definitionId":"child","version":1,"bindings":{"index":"/iteration/index"}},
            "until":{"op":"greater_than","pointer":"/iteration/output/outputs/0/output","value":3}
        }}}]),
    );
    let output = WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        Arc::new(Host(HashMap::from([("child".into(), child)]))),
        Arc::new(Sink),
        Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(output["outputs"][0]["output"]["count"], 2);
    assert_eq!(
        output["outputs"][0]["output"]["exitReason"],
        "condition_met"
    );
}

#[tokio::test]
async fn nested_graphs_share_the_root_agent_concurrency_limit() {
    struct Concurrent {
        child: WorkflowDefinition,
        active: AtomicUsize,
        maximum: AtomicUsize,
    }
    #[async_trait]
    impl AgentExecutor for Concurrent {
        async fn resolve_workflow(&self, _: &str, _: u64) -> Result<WorkflowDefinition, String> {
            Ok(self.child.clone())
        }
        async fn execute(&self, _: &str, _: AgentRequest) -> Result<String, String> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok("done".into())
        }
    }
    let child = graph(
        "child",
        json!([
            {"id":"a","title":"A","kind":"agent","prompt":"A"},
            {"id":"b","title":"B","kind":"agent","prompt":"B"}
        ]),
    );
    let host = Arc::new(Concurrent {
        child,
        active: AtomicUsize::new(0),
        maximum: AtomicUsize::new(0),
    });
    let parent = graph("parent", json!([sub("one", "child"), sub("two", "child")]));
    WorkflowRuntime::execute_definition(
        &parent,
        json!({}),
        host.clone(),
        Arc::new(Sink),
        WorkflowRuntimeConfig {
            max_concurrency: 2,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(host.maximum.load(Ordering::SeqCst), 2);
    assert_eq!(host.active.load(Ordering::SeqCst), 0);
}
