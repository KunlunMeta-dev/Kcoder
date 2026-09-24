    use super::*;
    use crate::background::BackgroundJobEvent;
    use crate::{AgentError, AgentRunner, BackgroundJobSpawner};
    use kcoder_state::AppState;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

#[test]
fn foreground_result_uses_original_run_path_and_receipt_after_continuation() {
    let state = kcoder_state::AppState::new("/tmp");
    state.upsert_task(kcoder_state::Task::new("agent", "foreground"));
    let first = state.begin_background_run("agent").unwrap();
    let frozen_path = std::path::PathBuf::from("/tmp/runs/first/output.md");
    state
        .commit_background_terminal(
            &kcoder_types::BackgroundEventIdentity::terminal(first.clone()),
            kcoder_state::TaskStatus::Completed,
            Some(frozen_path.clone()),
        )
        .unwrap();
    let second = state.begin_background_run("agent").unwrap();
    state.update_task("agent", |task| {
        task.output_path = Some("/tmp/live/output.md".into())
    });
    let ctx = ToolContext::new(state);
    let completed = foreground_result_task(&ctx, "agent", Some(&first))
        .unwrap()
        .unwrap();
    assert_eq!(completed.output_path, Some(frozen_path));
    let output = ToolOutput::text("result").with_background_result_delivery(&completed);
    assert!(output.execution_metadata.iter().any(|metadata| matches!(metadata, crate::ToolExecutionMetadata::BackgroundResultDelivery { run } if run == &first && run != &second)));
}

    #[test]
    fn configured_agent_job_ids_use_five_character_reservations() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new_with_short_id(root.path(), &root.path().join("ids")).unwrap();
        let first = reserve_agent_job_id(&state).unwrap();
        let second = reserve_agent_job_id(&state).unwrap();
        assert_eq!(first.len(), 5);
        assert_eq!(second.len(), 5);
        assert!(!first.eq_ignore_ascii_case(&second));
        assert!(!first.eq_ignore_ascii_case(&state.session_id()));
        let invalid = root.path().join("occupied");
        std::fs::write(&invalid, "file").unwrap();
        state.set_short_id_registry(&invalid);
        assert!(reserve_agent_job_id(&state).is_err());
    }

    #[test]
    fn artifact_requirements_direct_parse_rejects_invalid_declarations() {
        for requirements in [
            serde_json::json!([{"path":""}]),
            serde_json::json!([{"path":"a\0b"}]),
            serde_json::json!([{"path":"x","min_bytes":16777217}]),
            serde_json::json!([{"path":"x","unknown":true}]),
            serde_json::json!([{"path":"x","required":"true"}]),
            serde_json::json!([{"path":"x","forbidden_literals":[""]}]),
            serde_json::json!([{"path":"x","forbidden_literals":["界".repeat(86)]}]),
            serde_json::json!([{"path":"x","forbidden_literals":vec!["x"; 17]}]),
            serde_json::json!(vec![serde_json::json!({"path":"x"}); 33]),
        ] {
            let input = serde_json::json!({"message":"test", "artifact_requirements":requirements});
            assert!(
                parse_input::<AgentInput>(&input).is_err(),
                "accepted {input}"
            );
            assert!(
                parse_input::<PlanAgentInput>(&input).is_err(),
                "accepted {input}"
            );
        }
    }

    #[test]
    fn artifact_requirements_schema_and_utf8_bounds_are_explicit() {
        for schema in [AgentTool.input_schema(), PlanAgentTool.input_schema()] {
            let requirements = &schema["properties"]["artifact_requirements"];
        assert_eq!(
            requirements["items"]["properties"]["forbidden_literals"]["maxItems"],
            16
        );
            assert_eq!(requirements["maxItems"], 32);
            assert_eq!(requirements["items"]["additionalProperties"], false);
            assert_eq!(
                requirements["items"]["required"],
                serde_json::json!(["path"])
            );
            assert_eq!(
                requirements["items"]["properties"]["min_bytes"]["maximum"].as_f64(),
                Some(16777216.0)
            );
            assert_eq!(
                requirements["items"]["properties"]["required"]["default"],
                true
            );
        }
        for (path, accepted) in [
            ("界".repeat(1365), true),
            ("界".repeat(1366), false),
            ("x".repeat(4096), true),
            ("x".repeat(4097), false),
        ] {
            let input = serde_json::json!({"message":"test", "artifact_requirements":[{"path":path,"min_bytes":0}]});
            assert_eq!(parse_input::<AgentInput>(&input).is_ok(), accepted);
        }
        let task = Task::new("legacy", "no declarations");
        let requirement = serde_json::from_value(serde_json::json!({"path":"new.md"})).unwrap();
        assert!(
            AgentRunOptions::default()
                .with_artifact_requirements(vec![requirement])
                .restore_artifact_requirements(&task)
                .is_err()
        );
    }

    #[test]
    fn agent_tool_schema_is_object() {
        let tool = AgentTool;
        let schema = tool.input_schema();
        assert_eq!(schema.get("type").unwrap(), "object");
        assert!(
            schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("message")
        );
        assert!(
            schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("agent_type")
        );
        assert!(
            schema
                .get("properties")
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("run_in_background")
        );
        let foreground_timeout = schema
            .get("properties")
            .unwrap()
            .get("foreground_timeout_ms")
            .unwrap();
        assert_eq!(foreground_timeout.get("minimum").unwrap(), 0);
        assert_eq!(foreground_timeout.get("default").unwrap(), 0);
        let max_turns = schema.get("properties").unwrap().get("max_turns").unwrap();
        assert_eq!(max_turns.get("maximum").unwrap(), MAX_AGENT_MAX_TURNS);
        let agent_type = schema.get("properties").unwrap().get("agent_type").unwrap();
        let enum_values = agent_type
            .get("enum")
            .and_then(Value::as_array)
            .expect("agent_type enum");
        assert!(!enum_values.contains(&serde_json::json!("explore")));
        assert!(enum_values.contains(&serde_json::json!("plan")));
        let background_description = schema["properties"]["run_in_background"]["description"]
            .as_str()
            .unwrap();
        for phrase in [
            "wait for every relevant background sub-agent",
            "Do not repeat work already delegated",
            "Do not produce the final aggregation",
        ] {
            assert!(
                background_description.contains(phrase),
                "missing background coordination guidance: {phrase}"
            );
        }
        let allowed_write_paths = schema
            .get("properties")
            .unwrap()
            .get("allowed_write_paths")
            .unwrap();
        let allowed_write_description = allowed_write_paths
            .get("description")
            .and_then(Value::as_str)
            .unwrap();
        assert!(allowed_write_description.contains("implementer agents must provide"));
        assert!(allowed_write_description.contains("Verifier agents may omit"));
        assert!(allowed_write_description.contains("must not receive write paths"));
    let allowed_shell_description = schema["properties"]["allowed_shell_prefixes"]["description"]
            .as_str()
            .unwrap();
        assert!(allowed_shell_description.contains("exact target"));
        assert!(allowed_shell_description.contains("docker exec"));
        let context_mode = schema
            .get("properties")
            .unwrap()
            .get("context_mode")
            .unwrap();
        let context_description = context_mode
            .get("description")
            .and_then(Value::as_str)
            .unwrap();
        for keyword in ["auto", "none", "semantic", "recent", "full", "follow-up"] {
            assert!(
                context_description.contains(keyword),
                "missing {keyword} in context_mode description"
            );
        }
        for phrase in [
            "real user turn",
            "task/workflow/sub-agent notifications",
            "provider or model",
            "never re-applies parent context",
            "Structured origin",
        ] {
            assert!(context_description.contains(phrase), "missing {phrase}");
        }
        let context_turns = schema
            .get("properties")
            .unwrap()
            .get("context_turns")
            .unwrap();
        assert_eq!(context_turns.get("minimum").unwrap(), 1);
        assert_eq!(context_turns.get("default").unwrap(), 2);
        assert!(
            context_turns["description"]
                .as_str()
                .unwrap()
                .contains("ignored by none/semantic/full")
        );
    }

    #[test]
    fn subagent_system_prompts_use_only_kcoder_product_branding() {
        for kind in [
            AgentKind::General,
            AgentKind::Explore,
            AgentKind::Plan,
            AgentKind::Review,
            AgentKind::Implementer,
            AgentKind::Verifier,
            AgentKind::ToolAgent,
        ] {
            let prompt = kind.system_prompt();
            let normalized = prompt.to_ascii_lowercase();
            let retired_stem = String::from_utf8(vec![107, 117, 110, 108, 117, 110]).unwrap();
            let retired_brands = [
                format!("{retired_stem}code"),
                format!("{retired_stem} code"),
                format!("{retired_stem}-code"),
                format!("{retired_stem}_code"),
            ];
            for legacy_brand in retired_brands {
                assert!(
                    !normalized.contains(&legacy_brand),
                    "sub-agent 系统提示词不得包含旧产品标识 {legacy_brand:?}"
                );
            }
            assert!(prompt.contains("KCoder"));
        }
    }

    #[test]
    fn explore_agent_declares_parallel_dispatch_safe() {
        assert!(ExploreAgentTool.is_concurrency_safe(&serde_json::json!({
            "message": "inspect parser flow"
        })));
    }

    #[test]
    fn spawn_agent_concurrency_is_limited_to_read_only_or_background_dispatch() {
        let tool = AgentTool;

        assert!(tool.is_concurrency_safe(&serde_json::json!({
            "message": "review parser changes",
            "agent_type": "review"
        })));
        assert!(tool.is_concurrency_safe(&serde_json::json!({
            "message": "collect repository facts",
            "agent_type": "tool_agent"
        })));
        assert!(tool.is_concurrency_safe(&serde_json::json!({
            "message": "implement independent change",
            "agent_type": "implementer",
            "run_in_background": true
        })));

        for agent_type in ["general", "plan", "implementer", "verifier"] {
            assert!(
                !tool.is_concurrency_safe(&serde_json::json!({
                    "message": "foreground work",
                    "agent_type": agent_type
                })),
                "foreground {agent_type} must remain serialized"
            );
        }
        assert!(!tool.is_concurrency_safe(&serde_json::json!({
            "message": "implicit general agent"
        })));
        assert!(!tool.is_concurrency_safe(&serde_json::json!({
            "message": "unknown role",
            "agent_type": "surprise"
        })));
    }

    #[test]
    fn explore_agent_tool_description_encourages_read_only_exploration() {
        let tool = ExploreAgentTool;
        let description = tool.description();

        assert!(description.contains("read-only"));
        assert!(description.contains("codebase reconnaissance"));
        assert!(description.contains("Prefer this tool"));
        assert!(description.contains("must not create, edit, delete"));
        assert!(description.contains("path:line evidence"));
        assert!(description.contains("context_mode"));
        assert!(!description.contains("auto resolves to recent"));
        assert!(tool.input_schema()["properties"]["context_mode"]["description"].as_str().unwrap().contains("recent outside Arrangement"));
    }

    #[test]
    fn arrangement_agent_descriptions_explain_role_boundaries() {
        let spawn_description = AgentTool.description();
        assert!(spawn_description.contains("In Arrangement mode"));
        assert!(spawn_description.contains("non-empty `allowed_write_paths`"));
    assert!(spawn_description.contains("Only implementer and verifier may receive write paths"));
        assert!(spawn_description.contains("agent_type=\"explore\""));

        let plan_description = PlanAgentTool.description();
        assert!(plan_description.contains("dedicated Arrangement PlanAgent"));
        assert!(plan_description.contains("complete plan"));
        assert!(plan_description.contains("atomic subtasks"));
        assert!(plan_description.contains("must not edit implementation files"));
    }

    #[test]
    fn explore_agent_tool_schema_is_simple_and_read_only() {
        let tool = ExploreAgentTool;
        let schema = tool.input_schema();
        let props = schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("schema properties");

        assert!(props.contains_key("message"));
        assert!(props.contains_key("max_turns"));
        assert!(props.contains_key("context_mode"));
        assert!(props.contains_key("context_turns"));
        assert!(!props.contains_key("agent_type"));
        assert!(
            props["message"]
                .get("description")
                .and_then(Value::as_str)
                .unwrap()
                .contains("read-only")
        );
        assert_eq!(props["foreground_timeout_ms"].get("default").unwrap(), 0);
        let context = props["context_mode"]["description"].as_str().unwrap();
        assert!(context.contains("real user turns"));
        assert!(context.contains("provider or model changed"));
        assert!(context.contains("Structured origin"));
        let background = props["run_in_background"]["description"].as_str().unwrap();
        assert!(background.contains("wait for every relevant background sub-agent"));
        assert!(background.contains("Do not repeat work already delegated"));
        assert!(background.contains("Do not produce the final aggregation"));
    }

    #[test]
    fn plan_agent_schema_explains_context_and_delivery_fields() {
        let schema = PlanAgentTool.input_schema();
        let props = schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("schema properties");
        let context = props["context_mode"]["description"].as_str().unwrap();
        for keyword in ["auto", "none", "semantic", "recent", "full", "follow-up"] {
            assert!(context.contains(keyword), "missing {keyword}");
        }
        assert!(context.contains("real user turn"));
        assert!(context.contains("provider or model"));
        assert!(context.contains("Structured origin"));
        assert_eq!(props["context_turns"]["default"], 2);
        assert_eq!(props["run_in_background"]["default"], false);
        let background = props["run_in_background"]["description"].as_str().unwrap();
        assert!(background.contains("wait for every relevant background sub-agent"));
        assert!(background.contains("Do not repeat work already delegated"));
        assert!(background.contains("Do not produce the final aggregation"));
        assert_eq!(props["max_turns"]["minimum"], MIN_AGENT_MAX_TURNS);
        assert_eq!(props["max_turns"]["maximum"], MAX_AGENT_MAX_TURNS);
        assert_eq!(props["foreground_timeout_ms"]["default"], 0);
        assert!(
            props["foreground_timeout_ms"]["description"]
                .as_str()
                .unwrap()
                .contains("without cancelling or restarting")
        );
    }

    struct FakeAgentRunner;

    #[derive(Default)]
    struct ArtifactCapturingRunner {
        calls: Mutex<Vec<AgentRunOptions>>,
        state: Option<AppState>,
    }

    #[async_trait::async_trait]
    impl AgentRunner for ArtifactCapturingRunner {
        async fn run_agent(&self, _: String, _: usize) -> Result<String, AgentError> {
            panic!("options must reach the runner")
        }

        async fn run_agent_session_with_options(
            &self,
            id: String,
            prompt: String,
            _: usize,
            _: AgentKind,
            options: AgentRunOptions,
        ) -> Result<String, AgentError> {
            assert!(prompt.contains("report.md"));
            if let Some(state) = &self.state {
                assert_eq!(
                    state
                        .task(&id)
                        .expect("task must precede runner")
                        .artifact_requirements,
                    options.artifact_requirements
                );
            }
            self.calls.lock().unwrap().push(options);
            tokio::time::sleep(Duration::from_millis(150)).await;
            Ok("declared, not verified".into())
        }

        async fn send_message_to_agent_with_options(
            &self,
            _: String,
            _: String,
            _: usize,
            _: AgentKind,
            options: AgentRunOptions,
        ) -> Result<String, AgentError> {
            self.calls.lock().unwrap().push(options);
            Ok("continued".into())
        }
    }

    struct ExecutingBackgroundManager(FakeBackgroundJobManager);

    impl BackgroundJobSpawner for ExecutingBackgroundManager {
        fn abort(&self, id: &str) -> bool {
            self.0.abort(id)
        }
        fn spawn_subagent_with_id(
            &self,
            id: String,
            description: String,
            work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            max: Option<usize>,
        ) -> Result<String, crate::SpawnError> {
            self.spawn_subagent_foreground_with_id(id, description, work, max)
        }
        fn spawn(
            &self,
            description: String,
            work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            max: Option<usize>,
        ) -> Result<String, crate::SpawnError> {
            self.0
                .spawn_subagent_foreground_with_id("artifact-job".into(), description, work, max)
        }
        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
            self.0.subscribe()
        }
        fn spawn_subagent_foreground_with_id(
            &self,
            id: String,
            description: String,
            mut work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            max: Option<usize>,
        ) -> Result<String, crate::SpawnError> {
            // Poll before returning from spawn, deterministically racing metadata initialization.
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(work.as_mut().poll(&mut context).is_pending());
            self.0
                .spawn_subagent_foreground_with_id(id, description, work, max)
        }
        fn promote_to_background(&self, id: &str) -> Result<(), crate::SpawnError> {
            self.0.promote_to_background(id)
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn artifact_requirements_reach_runner_and_task_for_all_delivery_modes() {
        for (background, timeout) in [(false, 0), (true, 0), (false, 1)] {
            let root = tempfile::tempdir().unwrap();
            let state = AppState::new(root.path());
            let runner = Arc::new(ArtifactCapturingRunner {
                state: Some(state.clone()),
                ..Default::default()
            });
            let manager = Arc::new(ExecutingBackgroundManager(
                FakeBackgroundJobManager::default(),
            ));
            let mut events = manager.subscribe();
            let ctx = ToolContext::new(state)
                .with_agent_runner(runner.clone())
                .with_background_job_manager(manager);
            let output = AgentTool.call(serde_json::json!({
                "message":"produce report.md", "run_in_background":background, "foreground_timeout_ms":timeout,
                "expected_artifacts":["a human-readable report"],
                "artifact_requirements":[{"path":"report.md","min_bytes":2,"unique_content":true,"forbidden_literals":["marker"]}]
            }), &ctx).await.unwrap();
        let result: SpawnAgentResult = serde_json::from_str(&tool_output_text(&output)).unwrap();
        let structured: serde_json::Value =
                serde_json::from_str(&tool_output_text(&output)).unwrap();
            assert_eq!(structured["artifact_validation_status"], "unavailable");
            assert!(structured.get("artifact_validation_report").is_none());
            assert!(output.execution_metadata.is_empty());
            tokio::time::timeout(Duration::from_secs(2), async {
                while runner.calls.lock().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let task = ctx.state.task(&result.agent_id).unwrap();
            assert_eq!(task.artifact_requirements[0].path, "report.md");
            assert_eq!(
                runner.calls.lock().unwrap()[0].artifact_requirements,
                task.artifact_requirements
            );
            assert_eq!(result.run_in_background, background || timeout > 0);
            assert!(!root.path().join("report.md").exists());
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(2), events.recv())
                    .await
                    .unwrap()
                .unwrap()
                .into_payload(),
                BackgroundJobEvent::Completed { .. }
            ));
        }
    }

    #[tokio::test]
    async fn artifact_requirements_invalid_input_never_calls_runner() {
        let runner = Arc::new(ArtifactCapturingRunner::default());
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());
        assert!(
            AgentTool
                .call(
                    serde_json::json!({"message":"test","artifact_requirements":[{"path":""}]}),
                    &ctx
                )
                .await
                .is_err()
        );
        assert!(runner.calls.lock().unwrap().is_empty());
        assert!(manager.spawned.lock().unwrap().is_empty());
        for background in [false, true] {
            let input = serde_json::json!({"message":"test", "run_in_background":background,
                "artifact_requirements":[{"path":"x","forbidden_literals":[""]}]});
            assert!(AgentTool.call(input.clone(), &ctx).await.is_err());
            assert!(PlanAgentTool.call(input, &ctx).await.is_err());
        }
        assert!(runner.calls.lock().unwrap().is_empty());
        assert!(manager.spawned.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn artifact_requirements_sidecar_failure_never_starts_runner() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(&root.path().join("history.jsonl"));
        let sidecar = state.session_state_path().unwrap();
        std::fs::remove_file(&sidecar).unwrap();
        std::fs::create_dir(&sidecar).unwrap();
        let runner = Arc::new(ArtifactCapturingRunner::default());
        let manager = Arc::new(ExecutingBackgroundManager(
            FakeBackgroundJobManager::default(),
        ));
        let mut events = manager.subscribe();
        let ctx = ToolContext::new(state.clone())
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager);
        let result = AgentTool.call(serde_json::json!({"message":"produce report.md", "artifact_requirements":[{"path":"report.md"}]}), &ctx).await;
        assert!(
            result.is_err(),
            "a non-durable declaration must not start a runner"
        );
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap()
            .unwrap()
            .into_payload(),
            BackgroundJobEvent::Failed { .. }
        ));
        assert!(runner.calls.lock().unwrap().is_empty());
        assert!(
            state
                .tasks()
                .values()
                .all(|task| task.artifact_requirements.is_empty())
        );
        assert!(sidecar.is_dir());
    }

    #[tokio::test]
    async fn artifact_requirements_continuation_restores_persisted_identity_and_rejects_changes() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("artifact-continuation", "test");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.artifact_requirements =
            vec![serde_json::from_value(serde_json::json!({"path":"report.md"})).unwrap()];
        let restored: Task = serde_json::from_value(serde_json::to_value(&task).unwrap()).unwrap();
        state.upsert_task(restored);
        state
            .enqueue_subagent_delivery(&task.id, "continue")
            .unwrap()
            .unwrap();
        let runner = Arc::new(ArtifactCapturingRunner::default());
    let mut changed =
        AgentRunOptions::default().with_artifact_requirements(task.artifact_requirements.clone());
        changed.artifact_requirements[0].forbidden_literals = vec!["sensitive-marker".into()];
        let rejected = run_continued_subagent_loop(
            state.clone(),
            runner.clone(),
            task.id.clone(),
            1,
            AgentKind::General,
            changed,
        )
        .await;
        assert!(rejected.is_error);
        assert!(runner.calls.lock().unwrap().is_empty());
        let output = run_continued_subagent_loop(
            state.clone(),
            runner.clone(),
            task.id.clone(),
            1,
            AgentKind::General,
            AgentRunOptions::default(),
        )
        .await;
        assert!(!output.is_error);
        assert_eq!(
            runner.calls.lock().unwrap()[0].artifact_requirements,
            task.artifact_requirements
        );
        assert_eq!(
            state.task(&task.id).unwrap().artifact_requirements,
            task.artifact_requirements
        );
    }

    #[async_trait::async_trait]
    impl AgentRunner for FakeAgentRunner {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Ok("fake result".to_string())
        }
    }

    struct PanickingAgentRunner;

    #[async_trait::async_trait]
    impl AgentRunner for PanickingAgentRunner {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            panic!("spawn_agent must not poll the runner before returning");
        }
    }

    struct CancelledAgentRunner;

    #[async_trait::async_trait]
    impl AgentRunner for CancelledAgentRunner {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Err(AgentError::Cancelled("cancelled by user".to_string()))
        }
    }

    #[tokio::test]
    async fn cancelled_subagent_commits_cancelled_task_state() {
        let state = AppState::new("/tmp");
        let agent_id = "cancelled-agent".to_string();
        let mut task = Task::new(&agent_id, "cancel test");
        task.status = TaskStatus::Running;
        task.kind = TaskKind::Subagent;
        state.upsert_task(task);

        let output = run_initial_subagent_loop(
            state.clone(),
            Arc::new(CancelledAgentRunner),
            agent_id.clone(),
            "cancel me".to_string(),
            1,
            AgentKind::General,
            AgentRunOptions::default(),
        )
        .await;

        assert!(output.is_error);
        let task = state.task(&agent_id).unwrap();
        assert_eq!(task.status, TaskStatus::Cancelled);
        assert!(!task.accepting_subagent_messages);
    }

    struct FailingAgentRunner;

    #[async_trait::async_trait]
    impl AgentRunner for FailingAgentRunner {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Err(AgentError::Execution("boom".to_string()))
        }
    }

    #[tokio::test]
    async fn failed_subagent_closes_message_queue_before_returning() {
        let state = AppState::new("/tmp");
        let agent_id = "failed-agent".to_string();
        let mut task = Task::new(&agent_id, "failure test");
        task.status = TaskStatus::Running;
        task.kind = TaskKind::Subagent;
        state.upsert_task(task);

        let output = run_initial_subagent_loop(
            state.clone(),
            Arc::new(FailingAgentRunner),
            agent_id.clone(),
            "fail".to_string(),
            1,
            AgentKind::General,
            AgentRunOptions::default(),
        )
        .await;

        assert!(output.is_error);
        assert!(!state.task(&agent_id).unwrap().accepting_subagent_messages);
        assert_eq!(
            state.enqueue_subagent_message(&agent_id, "lost".to_string()),
            None
        );
    }

    struct DeliveryAgentRunner {
        fail: bool,
        deliveries: Mutex<Vec<(String, String, String)>>,
    }

    #[async_trait::async_trait]
    impl AgentRunner for DeliveryAgentRunner {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Ok("unused".to_string())
        }

        async fn send_message_to_agent_with_options(
            &self,
            _agent_id: String,
            message: String,
            _max_turns: usize,
            _agent_kind: AgentKind,
            options: AgentRunOptions,
        ) -> Result<String, AgentError> {
            let delivery = options.delivery.expect("delivery lease must reach runner");
        self.deliveries
            .lock()
            .unwrap()
            .push((delivery.message_id, delivery.lease_id, message));
            if self.fail {
                Err(AgentError::Execution("provider timeout".to_string()))
            } else {
                Ok("continued".to_string())
            }
        }
    }

    #[tokio::test]
    async fn continued_loop_acks_only_after_successful_runner_completion() {
        let state = AppState::new("/tmp");
        let agent_id = "delivery-success".to_string();
        let mut task = Task::new(&agent_id, "delivery success");
        task.status = TaskStatus::Running;
        task.kind = TaskKind::Subagent;
        state.upsert_task(task);
        let receipt = state
            .enqueue_subagent_delivery(&agent_id, "follow up")
            .unwrap()
            .unwrap();
        let runner = Arc::new(DeliveryAgentRunner {
            fail: false,
            deliveries: Mutex::new(Vec::new()),
        });

        let output = run_continued_subagent_loop(
            state.clone(),
            runner.clone(),
            agent_id.clone(),
            60,
            AgentKind::General,
            AgentRunOptions::default(),
        )
        .await;

        assert!(!output.is_error);
        assert_eq!(runner.deliveries.lock().unwrap().len(), 1);
    assert_eq!(runner.deliveries.lock().unwrap()[0].0, receipt.message_id);
        let task = state.task(&agent_id).unwrap();
        assert!(task.message_queue.is_empty());
        assert!(!task.accepting_subagent_messages);
    }

    #[tokio::test]
    async fn continued_loop_requeues_failed_delivery_without_deleting_it() {
        let state = AppState::new("/tmp");
        let agent_id = "delivery-failure".to_string();
        let mut task = Task::new(&agent_id, "delivery failure");
        task.status = TaskStatus::Running;
        task.kind = TaskKind::Subagent;
        state.upsert_task(task);
        let receipt = state
            .enqueue_subagent_delivery(&agent_id, "follow up")
            .unwrap()
            .unwrap();
        let runner = Arc::new(DeliveryAgentRunner {
            fail: true,
            deliveries: Mutex::new(Vec::new()),
        });

        let output = run_continued_subagent_loop(
            state.clone(),
            runner,
            agent_id.clone(),
            60,
            AgentKind::General,
            AgentRunOptions::default(),
        )
        .await;

        assert!(output.is_error);
        let task = state.task(&agent_id).unwrap();
        assert_eq!(task.message_queue.len(), 1);
        assert_eq!(task.message_queue[0].message_id, receipt.message_id);
        assert_eq!(
            task.message_queue[0].status,
            kcoder_state::AgentMessageStatus::Queued
        );
        assert_eq!(task.message_queue[0].attempts, 1);
    }

    struct LargeAgentRunner;

    #[async_trait::async_trait]
    impl AgentRunner for LargeAgentRunner {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Ok(format!("BEGIN-{}-END", "x".repeat(2_000)))
        }
    }

    struct DelayedAgentRunner {
        active: AtomicUsize,
        max_active: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl AgentRunner for DelayedAgentRunner {
        async fn run_agent(&self, prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_active.fetch_max(active, Ordering::SeqCst);
            let delay = if prompt.contains("slower") { 260 } else { 180 };
            tokio::time::sleep(Duration::from_millis(delay)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(format!("finished after {delay}ms"))
        }
    }

    struct FakeBackgroundJobManager {
        spawned: Mutex<Vec<String>>,
        tx: tokio::sync::broadcast::Sender<BackgroundJobEvent>,
        promoted: AtomicBool,
        aborted: AtomicBool,
    }

    impl Default for FakeBackgroundJobManager {
        fn default() -> Self {
            let (tx, _) = tokio::sync::broadcast::channel(32);
            Self {
                spawned: Mutex::new(Vec::new()),
                tx,
                promoted: AtomicBool::new(false),
                aborted: AtomicBool::new(false),
            }
        }
    }

    impl BackgroundJobSpawner for FakeBackgroundJobManager {
        fn spawn(
            &self,
            description: String,
            _work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, crate::SpawnError> {
            self.spawned.lock().unwrap().push(description);
            Ok("job-123".to_string())
        }

        fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
            self.tx.subscribe()
        }

        fn spawn_subagent_foreground_with_id(
            &self,
            id: String,
            description: String,
            work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
            _max_concurrent: Option<usize>,
        ) -> Result<String, crate::SpawnError> {
            self.spawned.lock().unwrap().push(description);
            let tx = self.tx.clone();
            let event_id = id.clone();
            tokio::spawn(async move {
                let output = work.await;
                let event = if output.is_error {
                    BackgroundJobEvent::Failed {
                        id: event_id,
                        error: tool_output_text(&output),
                    }
                } else {
                    BackgroundJobEvent::Completed {
                        id: event_id,
                        output,
                    }
                };
                let _ = tx.send(event);
            });
            Ok(id)
        }

        fn abort(&self, _id: &str) -> bool {
            self.aborted.store(true, Ordering::SeqCst);
            true
        }

        fn promote_to_background(&self, _id: &str) -> Result<(), crate::SpawnError> {
            self.promoted.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn agent_tool_returns_background_task_id() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_agent_runtime_identity("test-provider", "test-model");

        let tool = AgentTool;
        let output = tool
            .call(
                serde_json::json!({"message": "explore project", "max_turns": 10, "run_in_background": true}),
                &ctx,
            )
            .await
            .unwrap();

        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let result: SpawnAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.agent_id, "job-123");
        assert_eq!(result.status, "running");
        assert!(result.run_in_background);
        assert_eq!(result.agent_type, "general");
        assert_eq!(result.max_turns, DEFAULT_AGENT_MAX_TURNS);
        assert!(
            std::path::Path::new(&result.output_file).ends_with(
                std::path::Path::new("subagents")
                    .join("job-123")
                    .join("output.md")
            )
        );
        let task = ctx.state.task("job-123").expect("registered task");
        assert_eq!(
            task.parent_session_id.as_deref(),
            Some(ctx.state.session_id().as_str())
        );
        assert_eq!(task.agent_kind.as_deref(), Some("general"));
        assert_eq!(task.context_mode.as_deref(), Some("semantic"));
        assert_eq!(task.context_turns, Some(2));
        assert_eq!(task.agent_depth, Some(1));
        assert_eq!(task.max_turns, Some(DEFAULT_AGENT_MAX_TURNS));
        assert_eq!(task.arrangement_mode, Some(false));
        assert_eq!(task.agent_provider.as_deref(), Some("test-provider"));
        assert_eq!(task.agent_model.as_deref(), Some("test-model"));
        assert!(task.accepting_subagent_messages);
    }

    #[tokio::test]
    async fn agent_tool_uses_configured_default_max_turns_when_omitted() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_default_subagent_max_turns(120);

        let output = AgentTool
            .call(
                serde_json::json!({
                    "message": "use configured default",
                    "run_in_background": true
                }),
                &ctx,
            )
            .await
            .unwrap();
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let result: SpawnAgentResult = serde_json::from_str(&text).unwrap();

        assert_eq!(result.max_turns, 120);
    assert_eq!(
        ctx.state.task(&result.agent_id).unwrap().max_turns,
        Some(120)
    );
    }

    #[tokio::test]
    async fn agent_tool_reports_clamped_max_turns() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let tool = AgentTool;
        let output = tool
            .call(
                serde_json::json!({"message": "deep task", "max_turns": 999999, "run_in_background": true}),
                &ctx,
            )
            .await
            .unwrap();

        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let result: SpawnAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.max_turns, MAX_AGENT_MAX_TURNS);
        assert!(result.next_action.contains("max 180 internal turns"));
    }

    #[tokio::test]
    async fn agent_tool_accepts_legacy_description_field() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let tool = AgentTool;
        let output = tool
            .call(
                serde_json::json!({"description": "explore", "run_in_background": true}),
                &ctx,
            )
            .await
            .unwrap();

        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        assert!(text.contains("job-123"));
    }

    #[tokio::test]
    async fn arrangement_implementer_requires_allowed_write_paths() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_arrangement_mode(true);

        let err = AgentTool
            .call(
                serde_json::json!({
                    "message": "edit the parser",
                    "agent_type": "implementer"
                }),
                &ctx,
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("require allowed_write_paths"));
    }

    #[tokio::test]
    async fn arrangement_read_only_roles_reject_allowed_write_paths() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_arrangement_mode(true);

        let err = AgentTool
            .call(
                serde_json::json!({
                    "message": "inspect the parser",
                    "agent_type": "general",
                    "allowed_write_paths": ["src/parser.rs"]
                }),
                &ctx,
            )
            .await
            .unwrap_err();

        assert!(
            err.to_string()
                .contains("Only Arrangement implementer and verifier")
        );
    }

    #[tokio::test]
    async fn arrangement_verifier_may_omit_or_receive_allowed_write_paths() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_arrangement_mode(true);

        let without_scope = AgentTool
            .call(
                serde_json::json!({
                    "message": "run checks",
                    "agent_type": "verifier"
                }),
                &ctx,
            )
            .await;
        assert!(without_scope.is_ok());

        let with_scope = AgentTool
            .call(
                serde_json::json!({
                    "message": "run checks with fixtures",
                    "agent_type": "verifier",
                    "allowed_write_paths": ["tests/fixtures"]
                }),
                &ctx,
            )
            .await;
        assert!(with_scope.is_ok());
    }

    #[tokio::test]
    async fn delegated_shell_prefix_is_role_limited_and_persisted() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_arrangement_mode(true);

        let rejected_role = AgentTool
            .call(
                serde_json::json!({
                    "message": "inspect externally",
                    "agent_type": "general",
                    "allowed_shell_prefixes": ["docker exec exact-container"]
                }),
                &ctx,
            )
            .await
            .unwrap_err();
    assert!(
        rejected_role
            .to_string()
            .contains("Only implementer and verifier")
    );

        let rejected_syntax = AgentTool
            .call(
                serde_json::json!({
                    "message": "implement externally",
                    "agent_type": "implementer",
                    "allowed_write_paths": ["staging.py"],
                    "allowed_shell_prefixes": ["docker exec exact-container; rm -rf /"],
                    "run_in_background": true
                }),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(rejected_syntax.to_string().contains("shell control"));

        AgentTool
            .call(
                serde_json::json!({
                    "message": "implement externally",
                    "agent_type": "implementer",
                    "allowed_write_paths": ["staging.py"],
                    "allowed_shell_prefixes": ["docker exec -i exact-container"],
                    "run_in_background": true
                }),
                &ctx,
            )
            .await
            .unwrap();
        let task = ctx
            .state
            .tasks()
            .into_values()
            .find(|task| task.kind == kcoder_state::TaskKind::Subagent)
            .unwrap();
        assert_eq!(
            task.allowed_shell_prefixes,
            ["docker exec -i exact-container"]
        );
    }

    #[test]
    fn direct_call_compatibility_canonicalizes_agent_type_aliases() {
        assert_eq!(
            AgentKind::from_agent_type(Some("explorer")),
            AgentKind::Explore
        );
        assert_eq!(
            AgentKind::from_agent_type(Some("code-review")),
            AgentKind::Review
        );
        assert_eq!(
            AgentKind::from_agent_type(Some("tester")),
            AgentKind::Verifier
        );
        assert_eq!(
            AgentKind::from_agent_type(Some("unknown legacy role")),
            AgentKind::General
        );
    }

    #[tokio::test]
    async fn agent_tool_records_concise_role_description() {
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(manager.clone());

        let tool = AgentTool;
        let output = tool
            .call(
                serde_json::json!({
                    "message": "map the execution path",
                    "agent_type": "reviewer"
                }),
                &ctx,
            )
            .await
            .unwrap();

        let spawned = manager.spawned.lock().unwrap().clone();
        assert_eq!(spawned, vec!["Review agent: map the execution path"]);

        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let result: SpawnAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.agent_type, "review");
    }

    #[tokio::test]
    async fn agent_tool_rejects_explore_role() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let error = AgentTool
            .call(
                serde_json::json!({
                    "message": "map the execution path",
                    "agent_type": "explorer"
                }),
                &ctx,
            )
            .await
            .expect_err("spawn_agent should reject explore aliases");

        match error {
            ToolError::InvalidInput(message) => {
                assert!(message.contains("dedicated exploration tool"));
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn agent_tool_rejects_nested_subagent_before_starting_work() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_depth(MAX_SUBAGENT_DEPTH)
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let error = AgentTool
            .call(
                serde_json::json!({
                    "message": "attempt nested delegation",
                    "agent_type": "general"
                }),
                &ctx,
            )
            .await
            .expect_err("nested sub-agent must be rejected");

        match error {
            ToolError::InvalidInput(message) => {
                assert!(message.contains("depth limit exceeded"));
                assert!(message.contains("maximum is 1"));
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
        assert!(ctx.state.tasks().is_empty());
    }

    #[tokio::test]
    async fn explore_agent_tool_always_spawns_explore_role() {
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(manager.clone());

        let tool = ExploreAgentTool;
        let output = tool
            .call(
                serde_json::json!({
                    "message": "map the request pipeline",
                    "max_turns": 12
                }),
                &ctx,
            )
            .await
            .unwrap();

        let spawned = manager.spawned.lock().unwrap().clone();
        assert_eq!(spawned, vec!["Explore agent: map the request pipeline"]);

        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let result: SpawnAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.agent_type, "explore");
        assert_eq!(result.max_turns, DEFAULT_AGENT_MAX_TURNS);
    }

    #[tokio::test]
    async fn agent_tool_returns_before_polling_background_work() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(PanickingAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let tool = AgentTool;
        let output = tool
            .call(
                serde_json::json!({"message": "slow delegated task", "run_in_background": true}),
                &ctx,
            )
            .await
            .unwrap();

        let text = output
            .content
            .iter()
            .filter_map(|b| match b {
                kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<String>();
        let result: SpawnAgentResult = serde_json::from_str(&text).unwrap();
        assert_eq!(result.status, "running");
        assert_eq!(result.agent_id, "job-123");
        assert!(
            result
                .next_action
                .contains("wait for every relevant background sub-agent")
        );
        assert!(
            result
                .next_action
                .contains("Do not repeat its delegated work")
        );
        assert!(
            result
                .next_action
                .contains("do not produce the final aggregation")
        );
    }

    #[tokio::test]
    async fn agent_tool_blocks_by_default_and_returns_full_result() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let output = AgentTool
            .call(serde_json::json!({"message": "finish this task"}), &ctx)
            .await
            .unwrap();
        let result: SpawnAgentResult = serde_json::from_str(&tool_output_text(&output)).unwrap();

        assert_eq!(result.status, "completed");
        assert!(!result.run_in_background);
        assert_eq!(result.foreground_timeout_ms, 0);
        assert_eq!(result.result.as_deref(), Some("fake result"));
        assert_eq!(result.result_bytes, Some("fake result".len()));
        assert!(!result.result_truncated);
        assert!(result.next_action.contains("do not query this run again"));
    }

    #[tokio::test]
    async fn large_foreground_result_is_bounded_and_points_to_complete_output() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(LargeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_output_limits(512, 100, 100);

        let output = AgentTool
            .call(
                serde_json::json!({"message": "produce a large report"}),
                &ctx,
            )
            .await
            .unwrap();
        let result: SpawnAgentResult = serde_json::from_str(&tool_output_text(&output)).unwrap();

        assert!(result.result_truncated);
        assert_eq!(result.result_bytes, Some(2_010));
        assert_eq!(
            tokio::fs::read_to_string(&result.output_file)
                .await
                .unwrap()
                .len(),
            2_010
        );
        assert_eq!(
            ctx.state.task(&result.agent_id).unwrap().status,
            TaskStatus::Completed
        );
        let preview = result.result.expect("inline preview");
        assert!(preview.len() < 2_010);
        assert!(preview.contains("BEGIN-"));
        assert!(preview.contains("-END"));
        assert!(result.next_action.contains(&result.output_file));
        assert!(result.next_action.contains("bounded head/tail preview"));
    }

    #[tokio::test]
    async fn slow_foreground_agent_keeps_same_run_alive_in_background() {
        let runner = Arc::new(DelayedAgentRunner {
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
        });
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone());
        let started = Instant::now();

        let output = AgentTool
            .call(
                serde_json::json!({
                    "message": "faster task",
                    "foreground_timeout_ms": 100
                }),
                &ctx,
            )
            .await
            .unwrap();
        let result: SpawnAgentResult = serde_json::from_str(&tool_output_text(&output)).unwrap();

        assert_eq!(result.status, "running");
        assert!(result.run_in_background);
        assert!(result.auto_backgrounded);
        assert_eq!(result.foreground_timeout_ms, 100);
        assert!(started.elapsed() < Duration::from_millis(170));
        assert!(manager.promoted.load(Ordering::SeqCst));
        assert!(!manager.aborted.load(Ordering::SeqCst));

        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(runner.active.load(Ordering::SeqCst), 0);
        assert_eq!(runner.max_active.load(Ordering::SeqCst), 1);
        assert!(!manager.aborted.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn two_default_blocking_agent_calls_can_run_concurrently() {
        let runner = Arc::new(DelayedAgentRunner {
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
        });
        let manager = Arc::new(FakeBackgroundJobManager::default());
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager);
        let tool = AgentTool;
        let started = Instant::now();

        let (first, second) = tokio::join!(
            tool.call(serde_json::json!({"message": "faster task"}), &ctx),
            tool.call(serde_json::json!({"message": "slower task"}), &ctx),
        );
        let elapsed = started.elapsed();

        assert!(first.is_ok());
        assert!(second.is_ok());
        assert_eq!(runner.max_active.load(Ordering::SeqCst), 2);
        assert!(
            elapsed < Duration::from_millis(400),
            "blocking calls ran serially: {elapsed:?}"
        );
    }

    #[derive(Default)]
    struct WorktreeCapturingRunner {
        prompt: Mutex<Option<String>>,
        worktree_path: Mutex<Option<Option<std::path::PathBuf>>>,
    }

    #[async_trait::async_trait]
    impl AgentRunner for WorktreeCapturingRunner {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
            Ok("unused".to_string())
        }

        async fn run_agent_session_with_options(
            &self,
            _agent_id: String,
            prompt: String,
            _max_turns: usize,
            _agent_kind: AgentKind,
            options: AgentRunOptions,
        ) -> Result<String, AgentError> {
            *self.prompt.lock().unwrap() = Some(prompt);
            *self.worktree_path.lock().unwrap() = Some(options.worktree_path);
            Ok("worktree run done".to_string())
        }
    }

    fn init_git_repo_with_commit(path: &std::path::Path) {
        for args in [
            vec!["init"],
            vec!["add", "README.md"],
            vec![
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test User",
                "commit",
                "-m",
                "init",
            ],
        ] {
            if args[0] == "add" {
                std::fs::write(path.join("README.md"), "hello\n").unwrap();
            }
            let status = std::process::Command::new("git")
                .args(&args)
                .current_dir(path)
                .status()
                .unwrap();
            assert!(status.success(), "git {:?} failed", args);
        }
    }

    #[tokio::test]
    async fn spawn_agent_with_worktree_isolation_scopes_child_to_worktree() {
        if which::which("git").is_err() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        init_git_repo_with_commit(temp.path());
        let runner = Arc::new(WorktreeCapturingRunner::default());
        let ctx = ToolContext::new(AppState::new(temp.path()))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()))
            .with_agent_runtime_identity("test-provider", "test-model");

        let output = AgentTool
            .call(
                serde_json::json!({"message": "edit files in isolation", "isolation": "worktree"}),
                &ctx,
            )
            .await
            .unwrap();
        let result: SpawnAgentResult = serde_json::from_str(&tool_output_text(&output)).unwrap();

        assert_eq!(result.status, "completed");
        let worktree_path = result.worktree_path.expect("worktree path reported");
        let worktree_branch = result.worktree_branch.expect("worktree branch reported");
        let worktree = std::path::Path::new(&worktree_path);
        assert!(
            worktree
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .windows(3)
                .any(|parts| parts[0] == ".kcoder"
                    && parts[1] == "worktrees"
                    && parts[2].starts_with("job-")),
            "{worktree_path}"
        );
        assert!(
            worktree_branch.starts_with("worktree-job-"),
            "{worktree_branch}"
        );
        assert!(worktree.join(".git").exists());
        assert!(
            result.next_action.contains("merge or cherry-pick"),
            "{}",
            result.next_action
        );

        let prompt = runner
            .prompt
            .lock()
            .unwrap()
            .clone()
            .expect("prompt captured");
        assert!(prompt.contains("Isolation boundary"), "{prompt}");
        assert!(prompt.contains(&worktree_path), "{prompt}");
        assert!(prompt.contains(&worktree_branch), "{prompt}");

        let scoped = runner
            .worktree_path
            .lock()
            .unwrap()
            .clone()
            .expect("run options captured");
        assert_eq!(
            scoped.as_deref(),
            Some(std::path::Path::new(&worktree_path))
        );

        let task = ctx.state.task(&result.agent_id).expect("task record");
        assert_eq!(
            task.worktree_path.as_deref(),
            Some(std::path::Path::new(&worktree_path))
        );
    assert_eq!(
        task.worktree_branch.as_deref(),
        Some(worktree_branch.as_str())
    );
    }

    #[tokio::test]
    async fn spawn_agent_rejects_unknown_isolation_value() {
        let ctx = ToolContext::new(AppState::new("/tmp"))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let error = AgentTool
            .call(
                serde_json::json!({"message": "task", "isolation": "container"}),
                &ctx,
            )
            .await
            .expect_err("unknown isolation must be rejected");

        match error {
            ToolError::InvalidInput(message) => {
                assert!(message.contains("unknown isolation value"), "{message}");
                assert!(message.contains("worktree"), "{message}");
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
        assert!(ctx.state.tasks().is_empty());
    }

    #[tokio::test]
    async fn spawn_agent_worktree_isolation_requires_git_repo() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(temp.path()))
            .with_agent_runner(Arc::new(FakeAgentRunner))
            .with_background_job_manager(Arc::new(FakeBackgroundJobManager::default()));

        let error = AgentTool
            .call(
                serde_json::json!({"message": "task", "isolation": "worktree"}),
                &ctx,
            )
            .await
            .expect_err("worktree isolation outside a git repo must fail");

        match error {
            ToolError::Execution(message) => {
                assert!(message.contains("git repository"), "{message}");
            }
            other => panic!("expected Execution error, got {other:?}"),
        }
        assert!(ctx.state.tasks().is_empty());
    }

#[test]
fn context_contract_is_once_per_model_definition_and_keeps_role_defaults() {
    for (tool, expected_auto) in [
        (Box::new(AgentTool) as Box<dyn Tool>, "general=semantic; plan/review=recent; implementer/verifier/tool_agent=none; all Arrangement roles=none"),
        (Box::new(ExploreAgentTool), "recent outside Arrangement; none in Arrangement"),
        (Box::new(PlanAgentTool), "recent outside Arrangement; none in Arrangement"),
    ] {
        let schema = tool.input_schema();
        let description = tool.description();
        let context = schema["properties"]["context_mode"]["description"].as_str().unwrap();
        assert!(context.contains(expected_auto), "{}", tool.name());
        for constraint in ["Explicit modes are honored", "drop entire mixed ToolUse", "Structured origin", "unknown legacy text is retained", "Summaries do not count", "tool-sequence-repaired", "provider or model changed", "MoA aggregator", "Does not change model, role, permissions", "never re-applies parent context"] {
            assert!(context.contains(constraint), "{} missing {constraint}", tool.name());
        }
        assert!(!description.contains("semantic cleanup"));
        assert_eq!(schema["properties"]["context_mode"]["enum"], serde_json::json!(["auto","none","semantic","recent","full"]));
        assert_eq!(schema["properties"]["context_turns"]["minimum"], 1);
        assert_eq!(schema["properties"]["context_turns"]["default"], 2);
        assert!(context.len() < 1500, "context documentation grew: {}", context.len());
    }
}
