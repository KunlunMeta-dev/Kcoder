use super::*;

pub(super) struct RecordingVerifier {
    pub(super) output: Result<String, String>,
    pub(super) prompts: Arc<Mutex<Vec<String>>>,
}

pub(super) struct BlockingVerifier {
    pub(super) started: Arc<Notify>,
    pub(super) proceed: Arc<Notify>,
}

pub(super) struct SequenceVerifier {
    pub(super) outputs: Mutex<VecDeque<Result<String, String>>>,
    pub(super) prompts: Arc<Mutex<Vec<String>>>,
}

pub(super) struct StaticResultVerifier {
    pub(super) result: AgentRunResult,
}

pub(super) fn traced_verifier_result(output: String) -> AgentRunResult {
    AgentRunResult {
        output,
        tool_executions: vec![crate::AgentToolExecution {
            name: "bash".to_string(),
            input: serde_json::json!({"command": "pytest tests"}),
            output: "exit_code: 0\n1 passed".to_string(),
            is_error: Some(false),
            test_origin: Some(crate::VerifierTestOrigin::Candidate),
            verifier_relative_workdir: Some(PathBuf::new()),
            process_exit_code: Some(0),
            process_signal: None,
            process_cwd: Some(PathBuf::new()),
            artifacts: Vec::new(),
            raw_exit_code: true,
        }],
        candidate_changed_paths: vec!["src/lib.rs".to_string()],
        candidate_fingerprint: Some("candidate-1".to_string()),
        tool_trace_complete: true,
        environment_isolated: true,
        dependency_mutation_blocked: true,
        workspace_snapshot_verified: true,
        workspace_unchanged: true,
        verifier_baseline_root: None,
        verifier_vote: None,
    }
}

pub(super) fn strict_artifact_goal() -> Goal {
    Goal::new_with_file_mode_and_verification(
        "ship",
        None,
        None,
        GoalMode::Strict,
        GoalVerificationKind::Artifact,
    )
    .unwrap()
}

pub(super) fn strict_artifact_goal_requiring_behavior_delta() -> Goal {
    let mut goal = strict_artifact_goal();
    goal.verifier_selection.verification.require_behavior_delta = true;
    goal
}

pub(super) fn strict_external_artifact_goal() -> Goal {
    let mut goal = strict_artifact_goal();
    goal.verifier_selection.verification.allow_workspace_changes = true;
    goal.verifier_selection.verification.isolate_environment = false;
    goal.verifier_selection
        .verification
        .allow_dependency_changes = true;
    goal.verifier_selection.verification.require_behavior_delta = false;
    goal
}

pub(super) fn tool_execution(
    command: &str,
    exit_code: i32,
    output: &str,
) -> crate::AgentToolExecution {
    crate::AgentToolExecution {
        name: "bash".to_string(),
        input: serde_json::json!({"command": command}),
        output: format!("exit_code: {exit_code}\n{output}"),
        is_error: Some(exit_code != 0),
        test_origin: Some(crate::VerifierTestOrigin::Candidate),
        verifier_relative_workdir: Some(PathBuf::new()),
        process_exit_code: Some(exit_code),
        process_signal: None,
        process_cwd: Some(PathBuf::new()),
        artifacts: Vec::new(),
        raw_exit_code: true,
    }
}

pub(super) fn baseline_tool_execution(
    command: &str,
    exit_code: i32,
    output: &str,
) -> crate::AgentToolExecution {
    let mut execution = tool_execution(command, exit_code, output);
    execution.test_origin = Some(crate::VerifierTestOrigin::Baseline);
    execution
}

pub(super) fn verifier_run(executions: Vec<crate::AgentToolExecution>) -> AgentRunResult {
    AgentRunResult {
        output: "PASS\nverified".to_string(),
        tool_executions: executions,
        candidate_changed_paths: vec!["src/lib.rs".to_string()],
        candidate_fingerprint: Some("candidate-1".to_string()),
        tool_trace_complete: true,
        environment_isolated: true,
        dependency_mutation_blocked: true,
        workspace_snapshot_verified: true,
        workspace_unchanged: true,
        verifier_baseline_root: None,
        verifier_vote: None,
    }
}

#[async_trait::async_trait]
impl AgentRunner for RecordingVerifier {
    async fn run_agent(&self, prompt: String, _max_turns: usize) -> Result<String, AgentError> {
        self.prompts.lock().unwrap().push(prompt);
        self.output.clone().map_err(AgentError::Execution)
    }

    async fn run_agent_with_kind(
        &self,
        prompt: String,
        _max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        assert_eq!(agent_kind, AgentKind::Verifier);
        self.prompts.lock().unwrap().push(prompt);
        self.output.clone().map_err(AgentError::Execution)
    }

    async fn run_verifier_with_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        runtime: Option<AgentRuntimeSelection>,
        _options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        let _ = runtime;
        self.run_agent_with_kind(prompt, max_turns, AgentKind::Verifier)
            .await
            .map(traced_verifier_result)
    }
}

#[async_trait::async_trait]
impl AgentRunner for BlockingVerifier {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
        self.started.notify_one();
        self.proceed.notified().await;
        Ok("PASS\nverified".to_string())
    }

    async fn run_agent_with_kind(
        &self,
        prompt: String,
        max_turns: usize,
        _agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        self.run_agent(prompt, max_turns).await
    }

    async fn run_verifier_with_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        runtime: Option<AgentRuntimeSelection>,
        _options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        let _ = runtime;
        self.run_agent(prompt, max_turns)
            .await
            .map(traced_verifier_result)
    }
}

#[async_trait::async_trait]
impl AgentRunner for SequenceVerifier {
    async fn run_agent(&self, prompt: String, _max_turns: usize) -> Result<String, AgentError> {
        self.prompts.lock().unwrap().push(prompt);
        self.outputs
            .lock()
            .unwrap()
            .pop_front()
            .expect("test verifier output should be configured")
            .map_err(AgentError::Execution)
    }

    async fn run_agent_with_kind(
        &self,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        assert_eq!(agent_kind, AgentKind::Verifier);
        self.run_agent(prompt, max_turns).await
    }

    async fn run_verifier_with_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        runtime: Option<AgentRuntimeSelection>,
        _options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        let _ = runtime;
        self.run_agent(prompt, max_turns)
            .await
            .map(traced_verifier_result)
    }
}

#[async_trait::async_trait]
impl AgentRunner for StaticResultVerifier {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
        Ok(self.result.output.clone())
    }

    async fn run_verifier_with_runtime(
        &self,
        _prompt: String,
        _max_turns: usize,
        _runtime: Option<AgentRuntimeSelection>,
        _options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        Ok(self.result.clone())
    }
}
