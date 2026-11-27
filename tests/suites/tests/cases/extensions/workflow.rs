use crate::materialize_extensions_fixture;
use async_trait::async_trait;
use kcoder_workflow::{
    AgentExecutor, AgentRequest, EventSink, WorkflowEvent, WorkflowRuntime, WorkflowRuntimeConfig,
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct RecordingExecutor {
    calls: Mutex<Vec<(String, AgentRequest)>>,
}

#[async_trait]
impl AgentExecutor for RecordingExecutor {
    async fn execute(&self, agent_id: &str, request: AgentRequest) -> Result<String, String> {
        self.calls
            .lock()
            .unwrap()
            .push((agent_id.to_string(), request.clone()));
        Ok(format!("已审查:{}", request.prompt))
    }
}

#[derive(Default)]
struct RecordingSink {
    events: Mutex<Vec<WorkflowEvent>>,
}

impl EventSink for RecordingSink {
    fn record(&self, event: WorkflowEvent) {
        self.events.lock().unwrap().push(event);
    }
}

#[tokio::test]
async fn fixture_workflow_executes_one_agent_and_emits_ordered_events_and_json() {
    let (_temporary, fixture) = materialize_extensions_fixture();
    let script = std::fs::read_to_string(fixture.root.join(".kcoder/workflows/review.js")).unwrap();
    let executor = Arc::new(RecordingExecutor::default());
    let sink = Arc::new(RecordingSink::default());
    let config = WorkflowRuntimeConfig {
        agent_id_prefix: "fixture".to_string(),
        max_runtime_millis: 5_000,
        ..WorkflowRuntimeConfig::default()
    };

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        WorkflowRuntime::execute(
            &script,
            json!({"target": "crates/kcoder_state"}),
            executor.clone(),
            sink.clone(),
            config,
        ),
    )
    .await
    .expect("fixture workflow 必须在 10 秒内结束")
    .unwrap();

    assert_eq!(
        result,
        json!({
            "ok": true,
            "target": "crates/kcoder_state",
            "output": "已审查:审查 crates/kcoder_state"
        })
    );
    let calls = executor.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let (agent_id, request) = &calls[0];
    assert_eq!(agent_id, "fixture-agent-1");
    assert_eq!(request.prompt, "审查 crates/kcoder_state");
    assert_eq!(request.agent_type, "reviewer");
    assert_eq!(request.max_turns, 7);
    assert_eq!(request.acceptance_criteria, ["返回结构化结论"]);
    assert_eq!(request.context_paths, ["crates/kcoder_state"]);
    drop(calls);

    let events = sink.events.lock().unwrap();
    assert_eq!(events.len(), 4);
    assert!(matches!(
        &events[0],
        WorkflowEvent::PhaseStarted { name } if name == "review"
    ));
    assert!(matches!(
        &events[1],
        WorkflowEvent::AgentStarted { agent_id, request }
            if agent_id == "fixture-agent-1" && request.prompt == "审查 crates/kcoder_state"
    ));
    assert!(matches!(
        &events[2],
        WorkflowEvent::AgentCompleted { agent_id, output }
            if agent_id == "fixture-agent-1" && output == "已审查:审查 crates/kcoder_state"
    ));
    assert!(matches!(
        &events[3],
        WorkflowEvent::PhaseCompleted { name } if name == "review"
    ));

    let wire = serde_json::to_value(events.as_slice()).unwrap();
    assert_eq!(wire[0]["type"], "phase_started");
    assert_eq!(wire[1]["request"]["agent_type"], "reviewer");
    assert_eq!(wire[2]["type"], "agent_completed");
    assert_eq!(wire[3]["type"], "phase_completed");
}
