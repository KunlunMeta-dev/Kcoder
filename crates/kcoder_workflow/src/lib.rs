use async_trait::async_trait;
use rquickjs::{
    AsyncContext, AsyncRuntime, CaughtError, Function, Promise,
    function::{Async, Func},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRequest {
    pub prompt: String,
    pub agent_type: String,
    pub max_turns: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_write_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expected_artifacts: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub context_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub out_of_scope: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verification: Vec<String>,
}

#[async_trait]
pub trait AgentExecutor: Send + Sync {
    async fn execute(&self, agent_id: &str, request: AgentRequest) -> Result<String, String>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowEvent {
    Log {
        message: String,
    },
    PhaseStarted {
        name: String,
    },
    PhaseCompleted {
        name: String,
    },
    PhaseFailed {
        name: String,
        error: String,
    },
    AgentStarted {
        agent_id: String,
        request: AgentRequest,
    },
    AgentCompleted {
        agent_id: String,
        output: String,
    },
    AgentFailed {
        agent_id: String,
        error: String,
    },
}

pub trait EventSink: Send + Sync {
    fn record(&self, event: WorkflowEvent);
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ScriptEvent {
    Log { message: String },
    PhaseStarted { name: String },
    PhaseCompleted { name: String },
    PhaseFailed { name: String, error: String },
}

impl From<ScriptEvent> for WorkflowEvent {
    fn from(event: ScriptEvent) -> Self {
        match event {
            ScriptEvent::Log { message } => Self::Log { message },
            ScriptEvent::PhaseStarted { name } => Self::PhaseStarted { name },
            ScriptEvent::PhaseCompleted { name } => Self::PhaseCompleted { name },
            ScriptEvent::PhaseFailed { name, error } => Self::PhaseFailed { name, error },
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkflowRuntimeConfig {
    pub agent_id_prefix: String,
    pub max_concurrency: usize,
    pub default_agent_max_turns: usize,
    pub max_agent_max_turns: usize,
    pub max_script_bytes: usize,
    pub memory_limit_bytes: usize,
    pub max_stack_bytes: usize,
    pub max_runtime_millis: u64,
    pub max_events: usize,
    pub max_event_bytes: usize,
    pub cancellation_token: CancellationToken,
}

impl Default for WorkflowRuntimeConfig {
    fn default() -> Self {
        Self {
            agent_id_prefix: "workflow".to_string(),
            max_concurrency: 4,
            default_agent_max_turns: 20,
            max_agent_max_turns: 100,
            max_script_bytes: 256 * 1024,
            memory_limit_bytes: 64 * 1024 * 1024,
            max_stack_bytes: 1024 * 1024,
            max_runtime_millis: 30 * 60 * 1000,
            max_events: 4096,
            max_event_bytes: 8 * 1024,
            cancellation_token: CancellationToken::new(),
        }
    }
}

#[derive(Debug, Error)]
pub enum WorkflowError {
    #[error("workflow script is too large ({actual} bytes; maximum {maximum} bytes)")]
    ScriptTooLarge { actual: usize, maximum: usize },
    #[error("failed to initialize JavaScript runtime: {0}")]
    Runtime(String),
    #[error("workflow script failed: {0}")]
    Script(String),
    #[error("workflow exceeded its {0} ms time limit")]
    TimeLimit(u64),
    #[error("workflow was cancelled")]
    Cancelled,
    #[error("workflow exceeded its {0} event limit")]
    EventLimit(usize),
    #[error("workflow event is too large ({actual} bytes; maximum {maximum} bytes)")]
    EventTooLarge { actual: usize, maximum: usize },
}

pub struct WorkflowRuntime;

impl WorkflowRuntime {
    pub async fn execute(
        script: &str,
        args: Value,
        executor: Arc<dyn AgentExecutor>,
        sink: Arc<dyn EventSink>,
        config: WorkflowRuntimeConfig,
    ) -> Result<Value, WorkflowError> {
        if script.len() > config.max_script_bytes {
            return Err(WorkflowError::ScriptTooLarge {
                actual: script.len(),
                maximum: config.max_script_bytes,
            });
        }

        let runtime = AsyncRuntime::new().map_err(runtime_error)?;
        runtime.set_memory_limit(config.memory_limit_bytes).await;
        runtime.set_max_stack_size(config.max_stack_bytes).await;
        let cancellation = config.cancellation_token.clone();
        let timed_out = Arc::new(AtomicBool::new(false));
        let interrupt_cancellation = cancellation.clone();
        let interrupt_timed_out = Arc::clone(&timed_out);
        let max_runtime_millis = config.max_runtime_millis.max(1);
        let deadline = Instant::now() + Duration::from_millis(max_runtime_millis);
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                if interrupt_cancellation.is_cancelled() {
                    return true;
                }
                if Instant::now() >= deadline {
                    interrupt_timed_out.store(true, Ordering::Relaxed);
                    return true;
                }
                false
            })))
            .await;
        let context = AsyncContext::full(&runtime).await.map_err(runtime_error)?;

        let semaphore = Arc::new(Semaphore::new(config.max_concurrency.max(1)));
        let next_agent_id = Arc::new(AtomicUsize::new(1));
        let event_count = Arc::new(AtomicUsize::new(0));
        let args_json = serde_json::to_string(&args)
            .map_err(|error| WorkflowError::Runtime(error.to_string()))?;
        let wrapped_script = build_script(script, &args_json);

        let execution = rquickjs::async_with!(context => |ctx| {
            let agent_executor = Arc::clone(&executor);
            let agent_sink = Arc::clone(&sink);
            let agent_semaphore = Arc::clone(&semaphore);
            let agent_counter = Arc::clone(&next_agent_id);
            let agent_event_count = Arc::clone(&event_count);
            let max_events = config.max_events.max(1);
            let default_max_turns = config.default_agent_max_turns.max(1);
            let max_agent_max_turns = config.max_agent_max_turns.max(default_max_turns);
            let agent_id_prefix = config.agent_id_prefix.clone();
            let agent = Func::from(Async(move |request_json: String| {
                let executor = Arc::clone(&agent_executor);
                let sink = Arc::clone(&agent_sink);
                let semaphore = Arc::clone(&agent_semaphore);
                let event_count = Arc::clone(&agent_event_count);
                let agent_id = format!(
                    "{}-agent-{}",
                    agent_id_prefix,
                    agent_counter.fetch_add(1, Ordering::Relaxed)
                );
                async move {
                    let wire: AgentRequestWire = serde_json::from_str(&request_json).map_err(|error| {
                        rquickjs::Error::new_from_js_message(
                            "workflow agent request",
                            "AgentRequest",
                            error.to_string(),
                        )
                    })?;
                    let prompt = wire.prompt.trim().to_string();
                    if prompt.is_empty() {
                        return Err(rquickjs::Error::new_from_js_message(
                            "workflow agent request",
                            "AgentRequest",
                            "prompt must not be empty",
                        ));
                    }
                    let request = AgentRequest {
                        prompt,
                        agent_type: normalized_agent_type(wire.agent_type.as_deref()),
                        max_turns: wire
                            .max_turns
                            .unwrap_or(default_max_turns)
                            .clamp(1, max_agent_max_turns),
                        allowed_write_paths: clean_list(wire.allowed_write_paths),
                        acceptance_criteria: clean_list(wire.acceptance_criteria),
                        expected_artifacts: clean_list(wire.expected_artifacts),
                        context_paths: clean_list(wire.context_paths),
                        out_of_scope: clean_list(wire.out_of_scope),
                        verification: clean_list(wire.verification),
                    };
                    let _permit = semaphore.acquire_owned().await.map_err(|error| {
                        rquickjs::Error::new_from_js_message(
                            "workflow semaphore",
                            "permit",
                            error.to_string(),
                        )
                    })?;
                    reserve_events(&event_count, max_events, 2).map_err(|message| {
                        rquickjs::Error::new_from_js_message(
                            "workflow event",
                            "event limit",
                            message,
                        )
                    })?;
                    sink.record(WorkflowEvent::AgentStarted {
                        agent_id: agent_id.clone(),
                        request: request.clone(),
                    });
                    match executor.execute(&agent_id, request).await {
                        Ok(output) => {
                            sink.record(WorkflowEvent::AgentCompleted {
                                agent_id,
                                output: output.clone(),
                            });
                            Ok(output)
                        }
                        Err(error) => {
                            sink.record(WorkflowEvent::AgentFailed {
                                agent_id,
                                error: error.clone(),
                            });
                            Err(rquickjs::Error::new_from_js_message(
                                "AgentExecutor",
                                "workflow agent",
                                error,
                            ))
                        }
                    }
                }
            }));
            ctx.globals().set("__kcoder_agent", agent).map_err(|error| js_error(&ctx, error))?;

            let event_sink = Arc::clone(&sink);
            let script_event_count = Arc::clone(&event_count);
            let max_event_bytes = config.max_event_bytes.max(1);
            let record_event = Func::from(move |event_json: String| -> rquickjs::Result<()> {
                if event_json.len() > max_event_bytes {
                    return Err(rquickjs::Error::new_from_js_message(
                        "workflow event",
                        "event size limit",
                        format!(
                            "event is too large ({} bytes; maximum {max_event_bytes} bytes)",
                            event_json.len()
                        ),
                    ));
                }
                reserve_events(&script_event_count, max_events, 1).map_err(|message| {
                    rquickjs::Error::new_from_js_message(
                        "workflow event",
                        "event limit",
                        message,
                    )
                })?;
                let event: ScriptEvent = serde_json::from_str(&event_json).map_err(|error| {
                    rquickjs::Error::new_from_js_message(
                        "workflow event",
                        "ScriptEvent",
                        error.to_string(),
                    )
                })?;
                event_sink.record(event.into());
                Ok(())
            });
            ctx.globals()
                .set("__kcoder_record_event", record_event)
                .map_err(|error| js_error(&ctx, error))?;

            let function = ctx
                .eval::<Function, _>(wrapped_script)
                .map_err(|error| js_error(&ctx, error))?;
            let promise: Promise = function.call(()).map_err(|error| js_error(&ctx, error))?;
            let json = promise
                .into_future::<String>()
                .await
                .map_err(|error| js_error(&ctx, error))?;
            serde_json::from_str(&json).map_err(|error| WorkflowError::Script(error.to_string()))
        });
        tokio::pin!(execution);
        let result = tokio::select! {
            result = &mut execution => result,
            _ = cancellation.cancelled() => Err(WorkflowError::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(max_runtime_millis)) => {
                timed_out.store(true, Ordering::Relaxed);
                Err(WorkflowError::TimeLimit(max_runtime_millis))
            }
        };

        if cancellation.is_cancelled() {
            Err(WorkflowError::Cancelled)
        } else if timed_out.load(Ordering::Relaxed) {
            Err(WorkflowError::TimeLimit(max_runtime_millis))
        } else {
            result
        }
    }
}

fn reserve_events(counter: &AtomicUsize, maximum: usize, requested: usize) -> Result<(), String> {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
            current
                .checked_add(requested)
                .filter(|next| *next <= maximum)
        })
        .map(|_| ())
        .map_err(|current| {
            format!("workflow exceeded its {maximum} event limit ({current} recorded)")
        })
}

#[derive(Debug, Deserialize)]
struct AgentRequestWire {
    prompt: String,
    #[serde(default)]
    agent_type: Option<String>,
    #[serde(default)]
    max_turns: Option<usize>,
    #[serde(default)]
    allowed_write_paths: Vec<String>,
    #[serde(default)]
    acceptance_criteria: Vec<String>,
    #[serde(default)]
    expected_artifacts: Vec<String>,
    #[serde(default)]
    context_paths: Vec<String>,
    #[serde(default)]
    out_of_scope: Vec<String>,
    #[serde(default)]
    verification: Vec<String>,
}

fn clean_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalized_agent_type(value: Option<&str>) -> String {
    let value = value.unwrap_or("general").trim().to_ascii_lowercase();
    if value.is_empty() {
        "general".to_string()
    } else {
        value.replace(['-', ' '], "_")
    }
}

fn runtime_error(error: rquickjs::Error) -> WorkflowError {
    WorkflowError::Runtime(error.to_string())
}

fn js_error(ctx: &rquickjs::Ctx<'_>, error: rquickjs::Error) -> WorkflowError {
    WorkflowError::Script(CaughtError::from_error(ctx, error).to_string())
}

fn build_script(script: &str, args_json: &str) -> String {
    let args_literal = serde_json::to_string(args_json).expect("JSON string serialization");
    format!(
        r#"
        (function() {{
            "use strict";
            const args = JSON.parse({args_literal});

            const emit = (event) => __kcoder_record_event(JSON.stringify(event));
            const stringifyPart = (value) => {{
                if (typeof value === "string") return value;
                if (value === undefined) return "undefined";
                try {{ return JSON.stringify(value); }} catch (_) {{ return String(value); }}
            }};

            globalThis.log = (...parts) => emit({{
                type: "log",
                message: parts.map(stringifyPart).join(" "),
            }});

            globalThis.agent = async (input, options = {{}}) => {{
                const request = typeof input === "string"
                    ? {{ ...options, prompt: input }}
                    : {{ ...(input || {{}}) }};
                if (request.agentType !== undefined && request.agent_type === undefined) {{
                    request.agent_type = request.agentType;
                }}
                if (request.maxTurns !== undefined && request.max_turns === undefined) {{
                    request.max_turns = request.maxTurns;
                }}
                for (const [camel, snake] of [
                    ["allowedWritePaths", "allowed_write_paths"],
                    ["acceptanceCriteria", "acceptance_criteria"],
                    ["expectedArtifacts", "expected_artifacts"],
                    ["contextPaths", "context_paths"],
                    ["outOfScope", "out_of_scope"],
                ]) {{
                    if (request[camel] !== undefined && request[snake] === undefined) {{
                        request[snake] = request[camel];
                    }}
                }}
                return await __kcoder_agent(JSON.stringify(request));
            }};

            globalThis.parallel = async (steps) => {{
                if (!Array.isArray(steps)) throw new TypeError("parallel expects an array");
                return await Promise.all(steps.map((step) =>
                    typeof step === "function" ? step() : step
                ));
            }};

            globalThis.pipeline = async (steps, initial = undefined) => {{
                if (!Array.isArray(steps)) throw new TypeError("pipeline expects an array");
                let value = initial;
                for (const step of steps) {{
                    value = typeof step === "function" ? await step(value) : await step;
                }}
                return value;
            }};

            globalThis.phase = async (name, action) => {{
                const phaseName = String(name);
                emit({{ type: "phase_started", name: phaseName }});
                try {{
                    const result = typeof action === "function" ? await action() : await action;
                    emit({{ type: "phase_completed", name: phaseName }});
                    return result;
                }} catch (error) {{
                    emit({{
                        type: "phase_failed",
                        name: phaseName,
                        error: error && error.message ? error.message : String(error),
                    }});
                    throw error;
                }}
            }};

            globalThis.workflow = async (name, action) => {{
                if (typeof action !== "function" && !(action instanceof Promise)) {{
                    throw new TypeError("workflow expects a name and an async action");
                }}
                return await phase(`workflow:${{String(name)}}`, action);
            }};

            return (async function() {{
                {script}
            }})().then((value) => JSON.stringify(value === undefined ? null : value));
        }})
        "#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeExecutor {
        requests: Mutex<Vec<AgentRequest>>,
    }

    #[async_trait]
    impl AgentExecutor for FakeExecutor {
        async fn execute(&self, _agent_id: &str, request: AgentRequest) -> Result<String, String> {
            self.requests.lock().unwrap().push(request.clone());
            Ok(format!("done:{}", request.prompt))
        }
    }

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<WorkflowEvent>>);

    impl EventSink for RecordingSink {
        fn record(&self, event: WorkflowEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[tokio::test]
    async fn executes_agent_pipeline_and_exposes_args() {
        let executor = Arc::new(FakeExecutor::default());
        let sink = Arc::new(RecordingSink::default());
        let result = WorkflowRuntime::execute(
            r#"
                return await pipeline([
                    () => agent({ prompt: args.topic, agent_type: "review", max_turns: 7 }),
                    previous => agent(`summarize ${previous}`),
                ]);
            "#,
            serde_json::json!({"topic": "inspect parser"}),
            executor.clone(),
            sink,
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap();

        assert_eq!(
            result,
            Value::String("done:summarize done:inspect parser".into())
        );
        let requests = executor.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].agent_type, "review");
        assert_eq!(requests[0].max_turns, 7);
        assert_eq!(requests[1].agent_type, "general");
    }

    #[tokio::test]
    async fn emits_phase_log_and_agent_events() {
        let executor = Arc::new(FakeExecutor::default());
        let sink = Arc::new(RecordingSink::default());
        WorkflowRuntime::execute(
            r#"
                return await phase("review", async () => {
                    log("starting", args.count);
                    return await agent("inspect");
                });
            "#,
            serde_json::json!({"count": 2}),
            executor,
            sink.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap();

        let events = sink.0.lock().unwrap();
        assert!(matches!(&events[0], WorkflowEvent::PhaseStarted { name } if name == "review"));
        assert!(matches!(&events[1], WorkflowEvent::Log { message } if message == "starting 2"));
        assert!(matches!(&events[2], WorkflowEvent::AgentStarted { .. }));
        assert!(matches!(&events[3], WorkflowEvent::AgentCompleted { .. }));
        assert!(matches!(&events[4], WorkflowEvent::PhaseCompleted { name } if name == "review"));
    }

    #[tokio::test]
    async fn rejects_event_floods_before_the_sink_can_grow_without_bound() {
        let sink = Arc::new(RecordingSink::default());
        let config = WorkflowRuntimeConfig {
            max_events: 3,
            ..WorkflowRuntimeConfig::default()
        };
        let error = WorkflowRuntime::execute(
            "for (let i = 0; i < 10; i++) log(i);",
            Value::Null,
            Arc::new(FakeExecutor::default()),
            sink.clone(),
            config,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("event limit"));
        assert_eq!(sink.0.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn rejects_oversized_script_events() {
        let sink = Arc::new(RecordingSink::default());
        let config = WorkflowRuntimeConfig {
            max_event_bytes: 64,
            ..WorkflowRuntimeConfig::default()
        };
        let error = WorkflowRuntime::execute(
            "log('x'.repeat(256));",
            Value::Null,
            Arc::new(FakeExecutor::default()),
            sink.clone(),
            config,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("event size limit"));
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn parallel_preserves_result_order() {
        let result = WorkflowRuntime::execute(
            r#"
                return await parallel([
                    () => agent("first"),
                    () => agent("second"),
                    () => "plain",
                ]);
            "#,
            Value::Null,
            Arc::new(FakeExecutor::default()),
            Arc::new(RecordingSink::default()),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap();

        assert_eq!(
            result,
            serde_json::json!(["done:first", "done:second", "plain"])
        );
    }

    #[tokio::test]
    async fn rejects_oversized_scripts_before_execution() {
        let config = WorkflowRuntimeConfig {
            max_script_bytes: 8,
            ..WorkflowRuntimeConfig::default()
        };
        let error = WorkflowRuntime::execute(
            "return 'too long';",
            Value::Null,
            Arc::new(FakeExecutor::default()),
            Arc::new(RecordingSink::default()),
            config,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("script is too large"));
    }

    #[tokio::test]
    async fn interrupts_non_yielding_scripts_at_runtime_limit() {
        let config = WorkflowRuntimeConfig {
            max_runtime_millis: 25,
            ..WorkflowRuntimeConfig::default()
        };
        let error = WorkflowRuntime::execute(
            "while (true) {}",
            Value::Null,
            Arc::new(FakeExecutor::default()),
            Arc::new(RecordingSink::default()),
            config,
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("time limit"));
    }

    #[tokio::test]
    async fn nested_workflow_blocks_are_named_and_awaited() {
        let sink = Arc::new(RecordingSink::default());
        let result = WorkflowRuntime::execute(
            r#"
                return await workflow("inner", async () => agent("nested"));
            "#,
            Value::Null,
            Arc::new(FakeExecutor::default()),
            sink.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap();
        assert_eq!(result, Value::String("done:nested".to_string()));
        let events = sink.0.lock().unwrap();
        assert!(
            matches!(&events[0], WorkflowEvent::PhaseStarted { name } if name == "workflow:inner")
        );
        assert!(
            matches!(&events[3], WorkflowEvent::PhaseCompleted { name } if name == "workflow:inner")
        );
    }

    struct ConcurrencyExecutor {
        active: AtomicUsize,
        maximum: AtomicUsize,
    }

    #[async_trait]
    impl AgentExecutor for ConcurrencyExecutor {
        async fn execute(&self, _agent_id: &str, request: AgentRequest) -> Result<String, String> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(request.prompt)
        }
    }

    #[tokio::test]
    async fn parallel_agent_calls_respect_local_concurrency_limit() {
        let executor = Arc::new(ConcurrencyExecutor {
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
        });
        let result = WorkflowRuntime::execute(
            "return await parallel([agent('a'), agent('b'), agent('c')]);",
            Value::Null,
            executor.clone(),
            Arc::new(RecordingSink::default()),
            WorkflowRuntimeConfig {
                max_concurrency: 2,
                ..WorkflowRuntimeConfig::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(result, serde_json::json!(["a", "b", "c"]));
        assert_eq!(executor.maximum.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failed_phase_emits_terminal_phase_event() {
        let sink = Arc::new(RecordingSink::default());
        let error = WorkflowRuntime::execute(
            "return await phase('broken', () => { throw new Error('boom'); });",
            Value::Null,
            Arc::new(FakeExecutor::default()),
            sink.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("boom"));
        let events = sink.0.lock().unwrap();
        assert!(matches!(&events[0], WorkflowEvent::PhaseStarted { name } if name == "broken"));
        assert!(
            matches!(&events[1], WorkflowEvent::PhaseFailed { name, error } if name == "broken" && error == "boom")
        );
    }

    #[tokio::test]
    async fn script_cannot_forge_agent_lifecycle_events() {
        let sink = Arc::new(RecordingSink::default());
        let error = WorkflowRuntime::execute(
            r#"
                __kcoder_record_event(JSON.stringify({
                    type: "agent_completed",
                    agent_id: "../../escape",
                    output: "forged",
                }));
                return "unreachable";
            "#,
            Value::Null,
            Arc::new(FakeExecutor::default()),
            sink.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("ScriptEvent"));
        assert!(sink.0.lock().unwrap().is_empty());
    }

    struct SlowExecutor;

    #[async_trait]
    impl AgentExecutor for SlowExecutor {
        async fn execute(&self, _agent_id: &str, _request: AgentRequest) -> Result<String, String> {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok("late".to_string())
        }
    }

    #[tokio::test]
    async fn timeout_interrupts_an_awaited_agent() {
        let started = Instant::now();
        let error = WorkflowRuntime::execute(
            "return await agent('slow');",
            Value::Null,
            Arc::new(SlowExecutor),
            Arc::new(RecordingSink::default()),
            WorkflowRuntimeConfig {
                max_runtime_millis: 25,
                ..WorkflowRuntimeConfig::default()
            },
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("time limit"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_awaited_agent() {
        let parent = CancellationToken::new();
        let cancellation = parent.child_token();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            parent.cancel();
        });
        let error = WorkflowRuntime::execute(
            "return await agent('slow');",
            Value::Null,
            Arc::new(SlowExecutor),
            Arc::new(RecordingSink::default()),
            WorkflowRuntimeConfig {
                cancellation_token: cancellation,
                ..WorkflowRuntimeConfig::default()
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, WorkflowError::Cancelled));
    }

    #[tokio::test]
    async fn pre_cancelled_token_interrupts_before_awaited_agent_completes() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let error = WorkflowRuntime::execute(
            "return await agent('slow');",
            Value::Null,
            Arc::new(SlowExecutor),
            Arc::new(RecordingSink::default()),
            WorkflowRuntimeConfig {
                cancellation_token: cancellation,
                ..WorkflowRuntimeConfig::default()
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(error, WorkflowError::Cancelled));
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_non_yielding_script() {
        let cancellation = CancellationToken::new();
        let trigger = cancellation.clone();
        let cancel_thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            trigger.cancel();
        });

        let error = WorkflowRuntime::execute(
            "while (true) {}",
            Value::Null,
            Arc::new(FakeExecutor::default()),
            Arc::new(RecordingSink::default()),
            WorkflowRuntimeConfig {
                cancellation_token: cancellation,
                ..WorkflowRuntimeConfig::default()
            },
        )
        .await
        .unwrap_err();
        cancel_thread.join().unwrap();

        assert!(matches!(error, WorkflowError::Cancelled));
    }

    #[tokio::test]
    async fn unawaited_agent_does_not_outlive_a_completed_script() {
        let started = Instant::now();
        let result = WorkflowRuntime::execute(
            "agent('slow'); return 'done';",
            Value::Null,
            Arc::new(SlowExecutor),
            Arc::new(RecordingSink::default()),
            WorkflowRuntimeConfig {
                max_runtime_millis: 100,
                ..WorkflowRuntimeConfig::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(result, Value::String("done".to_string()));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
