//! Durable workflow state, event observations and cached completion records.
//! Store fields remain private on the parent owner; no extra state or locking is introduced.

use super::*;

impl WorkflowRunStore {
    pub(super) fn create(
        run_dir: PathBuf,
        run_id: String,
        name: String,
        source: String,
        script: &str,
        args: &Value,
        limits: WorkflowRunLimits,
    ) -> Result<Arc<Self>, ToolError> {
        let parent = run_dir.parent().ok_or_else(|| {
            ToolError::Execution("workflow run directory has no parent".to_string())
        })?;
        secure_create_dir(parent).map_err(|error| {
            ToolError::Execution(format!(
                "failed to create workflow root `{}`: {error}",
                parent.display()
            ))
        })?;
        secure_create_new_dir(&run_dir).map_err(|error| {
            ToolError::Execution(format!(
                "failed to create a new workflow run directory `{}`: {error}",
                run_dir.display()
            ))
        })?;
        let script_path = run_dir.join("script.js");
        let journal_path = run_dir.join("journal.jsonl");
        let output_path = run_dir.join("output.json");
        let args_path = run_dir.join("args.json");
        let state_path = run_dir.join("state.json");
        atomic_write_file(&script_path, script).map_err(|error| {
            ToolError::Execution(format!(
                "failed to persist workflow script `{}`: {error}",
                script_path.display()
            ))
        })?;
        atomic_write_file(
            &args_path,
            serde_json::to_vec_pretty(args).map_err(|error| {
                ToolError::Execution(format!("failed to serialize workflow args: {error}"))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to persist workflow args `{}`: {error}",
                args_path.display()
            ))
        })?;
        let now = now_millis();
        let store = Arc::new(Self {
            run_dir,
            state_path,
            state: Mutex::new(WorkflowRunState {
                run_id,
                name,
                status: "running".to_string(),
                source,
                definition_sha256: None,
                script_path,
                args_path,
                journal_path,
                output_path,
                started_at_ms: now,
                updated_at_ms: now,
                max_concurrency: limits.max_concurrency,
                max_agent_turns: limits.max_agent_turns,
                timeout_seconds: limits.timeout_seconds,
                unresolved_execution_limits: limits.unresolved_execution_limits,
                agent_started: 0,
                agent_completed: 0,
                agent_failed: 0,
                agent_reused: 0,
                event_count: 0,
                resume_count: 0,
                reuse_from_run: None,
                checkpoint_format: None,
                active_phase: None,
                error: None,
            }),
            events: Mutex::new(()),
            io: Mutex::new(()),
            journal_buffer: Mutex::new(Vec::new()),
            observation: Mutex::new(None),
            verification: Mutex::new(None),
        });
        store.persist_state()?;
        store.append_json(&json!({
            "type": "workflow_started",
            "timestamp_ms": now,
            "run_id": store.state.lock().unwrap().run_id,
        }))?;
        Ok(store)
    }

    pub(super) fn open_for_resume(run_dir: PathBuf) -> Result<Arc<Self>, ToolError> {
        let state_path = run_dir.join("state.json");
        let persisted: Value = serde_json::from_slice(
            &secure_read_file(&state_path, MAX_SCRIPT_BYTES).map_err(|error| {
                ToolError::Execution(format!(
                    "failed to read workflow state `{}`: {error}",
                    state_path.display()
                ))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to parse workflow state `{}`: {error}",
                state_path.display()
            ))
        })?;
        let mut state: WorkflowRunState =
            serde_json::from_value(persisted.clone()).map_err(|error| {
                ToolError::Execution(format!("failed to parse workflow state: {error}"))
            })?;
        state.unresolved_execution_limits |= u8::from(persisted.get("max_agent_turns").is_none())
            | (u8::from(persisted.get("timeout_seconds").is_none()) << 1);
        let status = kcoder_types::domain_status::WorkflowRunStatus::from_raw(&state.status)
            .map_err(|error| ToolError::Execution(error.into()))?;
        if !status.is_known() {
            return Err(ToolError::InvalidInput(
                "workflow_unknown: run history is read-only".into(),
            ));
        }
        let expected_run_id = run_dir
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ToolError::Execution("invalid workflow run directory".to_string()))?;
        if state.run_id != expected_run_id {
            return Err(ToolError::Execution(format!(
                "workflow state id `{}` does not match run directory `{expected_run_id}`",
                state.run_id
            )));
        }
        state.script_path = run_dir.join("script.js");
        state.args_path = run_dir.join("args.json");
        state.journal_path = run_dir.join("journal.jsonl");
        state.output_path = run_dir.join("output.json");
        if !state.script_path.is_file() || !state.args_path.is_file() {
            return Err(ToolError::Execution(format!(
                "workflow {} is missing its persisted script or arguments",
                state.run_id
            )));
        }
        Ok(Arc::new(Self {
            run_dir,
            state_path,
            state: Mutex::new(state),
            events: Mutex::new(()),
            io: Mutex::new(()),
            journal_buffer: Mutex::new(Vec::new()),
            observation: Mutex::new(None),
            verification: Mutex::new(None),
        }))
    }

    pub(super) fn begin_resume(
        &self,
        args: &Value,
        limits: WorkflowRunLimits,
    ) -> Result<ResumeRollback, ToolError> {
        let previous_state = self.state.lock().unwrap().clone();
        let status =
            kcoder_types::domain_status::WorkflowRunStatus::from_raw(&previous_state.status)
                .map_err(|error| ToolError::Execution(error.into()))?;
        if !status.is_known() {
            return Err(ToolError::InvalidInput(
                "workflow_unknown: run history is read-only".into(),
            ));
        }
        let previous_args =
            secure_read_file(&previous_state.args_path, MAX_SCRIPT_BYTES).map_err(|error| {
                ToolError::Execution(format!("failed to snapshot workflow args: {error}"))
            })?;
        let rollback = ResumeRollback {
            state: previous_state.clone(),
            args: previous_args,
        };
        let begin = (|| {
            atomic_write_file(
                &previous_state.args_path,
                serde_json::to_vec_pretty(args).map_err(std::io::Error::other)?,
            )?;
            let now = now_millis();
            let (run_id, resume_count) = {
                let mut state = self.state.lock().unwrap();
                state.status = "running".to_string();
                state.updated_at_ms = now;
                state.active_phase = None;
                state.error = None;
                state.max_concurrency = limits.max_concurrency;
                state.max_agent_turns = limits.max_agent_turns;
                state.timeout_seconds = limits.timeout_seconds;
                state.unresolved_execution_limits = limits.unresolved_execution_limits;
                state.agent_started = 0;
                state.agent_completed = 0;
                state.agent_failed = 0;
                state.agent_reused = 0;
                state.resume_count += 1;
                (state.run_id.clone(), state.resume_count)
            };
            self.persist_state()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            self.append_json(&json!({
                "type": "workflow_resumed",
                "timestamp_ms": now,
                "run_id": run_id,
                "resume_count": resume_count,
                "previous_status": previous_state.status,
            }))
            .map_err(|error| std::io::Error::other(error.to_string()))
        })();
        if let Err(error) = begin {
            let _ = self.rollback_resume(rollback);
            return Err(ToolError::Execution(format!(
                "failed to begin workflow resume: {error}"
            )));
        }
        Ok(rollback)
    }

    pub(super) fn rollback_resume(&self, rollback: ResumeRollback) -> Result<(), ToolError> {
        atomic_write_file(&rollback.state.args_path, &rollback.args).map_err(|error| {
            ToolError::Execution(format!("failed to restore workflow args: {error}"))
        })?;
        *self.state.lock().unwrap() = rollback.state;
        self.persist_state()?;
        self.append_json(&json!({
            "type": "workflow_resume_rolled_back",
            "timestamp_ms": now_millis(),
        }))
    }

    pub(super) fn output_path(&self) -> PathBuf {
        self.state.lock().unwrap().output_path.clone()
    }

    pub(super) fn persist_state(&self) -> Result<(), ToolError> {
        let _io = self.io.lock().unwrap();
        self.flush_journal_locked()?;
        let state = self.state.lock().unwrap().clone();
        let bytes = serde_json::to_vec_pretty(&state).map_err(|error| {
            ToolError::Execution(format!("failed to serialize workflow state: {error}"))
        })?;
        atomic_write_file(&self.state_path, bytes).map_err(|error| {
            ToolError::Execution(format!("failed to write workflow state: {error}"))
        })?;
        if let Some(observation) = self.observation.lock().unwrap().as_ref() {
            observation
                .update(|run| {
                    run.status = state.status.clone();
                    run.error = state.error.as_deref().map(|e| preview(e, 1024));
                    run.updated_at_ms = state.updated_at_ms;
                    run.resume_count = state.resume_count as u32;
                    if state.status != "running" {
                        for node in &mut run.node_states {
                            if node.status == "running"
                                || node.status == "retrying"
                                || node.status == "pending"
                            {
                                node.status = if state.status == "cancelled" {
                                    "cancelled".into()
                                } else if node.status == "pending" {
                                    "skipped".into()
                                } else {
                                    "interrupted".into()
                                };
                                node.finished_at_ms = Some(state.updated_at_ms);
                            }
                        }
                    }
                })
                .map_err(|e| ToolError::Execution(e.to_string()))?;
        }
        Ok(())
    }

    pub(super) fn append_json(&self, value: &Value) -> Result<(), ToolError> {
        let journal_path = self.state.lock().unwrap().journal_path.clone();
        let _io = self.io.lock().unwrap();
        self.flush_journal_locked()?;
        let mut bytes = serde_json::to_vec(value).map_err(|error| {
            ToolError::Execution(format!("failed to write workflow journal: {error}"))
        })?;
        bytes.push(b'\n');
        secure_append_file(&journal_path, &bytes).map_err(|error| {
            ToolError::Execution(format!("failed to finish workflow journal entry: {error}"))
        })
    }

    pub(super) fn queue_json(&self, value: &Value) -> Result<(), ToolError> {
        let mut bytes = serde_json::to_vec(value).map_err(|error| {
            ToolError::Execution(format!("failed to write workflow journal: {error}"))
        })?;
        bytes.push(b'\n');
        self.journal_buffer.lock().unwrap().extend(bytes);
        Ok(())
    }

    pub(super) fn flush_journal_locked(&self) -> Result<(), ToolError> {
        let bytes = {
            let mut pending = self.journal_buffer.lock().unwrap();
            if pending.is_empty() {
                return Ok(());
            }
            std::mem::take(&mut *pending)
        };
        let journal_path = self.state.lock().unwrap().journal_path.clone();
        if let Err(error) = secure_append_file(&journal_path, &bytes) {
            self.journal_buffer.lock().unwrap().splice(0..0, bytes);
            return Err(ToolError::Execution(format!(
                "failed to flush workflow journal: {error}"
            )));
        }
        Ok(())
    }

    pub(super) fn finish(&self, result: Result<Value, String>) -> Result<(), ToolError> {
        let now = now_millis();
        let output_path = self.output_path();
        let output = match result {
            Ok(result) => {
                let mut state = self.state.lock().unwrap();
                if state.status != "running" {
                    return Ok(());
                }
                state.status = "completed".to_string();
                state.updated_at_ms = now;
                state.active_phase = None;
                json!({"run_id": state.run_id, "status": "completed", "result": result})
            }
            Err(error) => {
                let mut state = self.state.lock().unwrap();
                if state.status != "running" {
                    return Ok(());
                }
                state.status = "failed".to_string();
                state.updated_at_ms = now;
                state.active_phase = None;
                state.error = Some(error.clone());
                json!({"run_id": state.run_id, "status": "failed", "error": error})
            }
        };
        atomic_write_file(
            &output_path,
            serde_json::to_vec_pretty(&output).map_err(|error| {
                ToolError::Execution(format!("failed to serialize workflow output: {error}"))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!("failed to write workflow output: {error}"))
        })?;
        self.persist_state()?;
        self.finish_verification(&output)?;
        self.append_json(&json!({
            "type": "workflow_finished",
            "timestamp_ms": now,
            "status": output["status"],
            "output_file": output_path,
        }))
    }

    pub(super) fn cancel(&self) -> Result<(), ToolError> {
        let now = now_millis();
        let output_path = {
            let mut state = self.state.lock().unwrap();
            if state.status != "running" {
                return Ok(());
            }
            state.status = "cancelled".to_string();
            state.updated_at_ms = now;
            state.active_phase = None;
            state.error = Some("cancelled by user".to_string());
            state.output_path.clone()
        };
        atomic_write_file(
            &output_path,
            serde_json::to_vec_pretty(&json!({
                "run_id": self.state.lock().unwrap().run_id,
                "status": "cancelled",
                "error": "cancelled by user",
            }))
            .map_err(|error| {
                ToolError::Execution(format!("failed to serialize cancelled workflow: {error}"))
            })?,
        )
        .map_err(|error| {
            ToolError::Execution(format!(
                "failed to write cancelled workflow output: {error}"
            ))
        })?;
        self.persist_state()?;
        self.finish_verification(&json!({"status":"cancelled"}))?;
        self.append_json(&json!({
            "type": "workflow_cancelled",
            "timestamp_ms": now,
            "output_file": output_path,
        }))
    }
}

impl EventSink for WorkflowRunStore {
    fn record(&self, event: WorkflowEvent) {
        let _event = self.events.lock().unwrap();
        if let Err(error) = self.record_verification_event(&event) {
            tracing::warn!(%error, "failed to persist workflow check coverage");
        }
        let now = now_millis();
        if let WorkflowEvent::NodeReused { node_id } = &event
            && let Some(observation) = self.observation.lock().unwrap().as_ref()
        {
            let _ = observation.update(|run| {
                if let Some(node) = run
                    .node_states
                    .iter_mut()
                    .find(|node| &node.node_id == node_id)
                {
                    node.reused = true;
                }
            });
        }
        let reused_agent = matches!(
            &event,
            WorkflowEvent::AgentStarted { agent_id, request }
                if cached_agent_request_matches(
                    &self
                        .run_dir
                        .join("agents")
                        .join(kcoder_state::artifact_id_path_component(agent_id)),
                    request
                )
        );
        if self.state.lock().unwrap().status == "running"
            && let Some(observation) = self.observation.lock().unwrap().as_ref()
        {
            use kcoder_types::workflow_runs::WorkflowNodeRun;
            let identity = match &event {
                WorkflowEvent::NodeStarted {
                    node_id,
                    iteration,
                    attempt,
                    agent_id,
                }
                | WorkflowEvent::NodeCompleted {
                    node_id,
                    iteration,
                    attempt,
                    agent_id,
                    ..
                }
                | WorkflowEvent::NodeFailed {
                    node_id,
                    iteration,
                    attempt,
                    agent_id,
                    ..
                } => Some((node_id, *iteration, *attempt, agent_id.clone())),
                WorkflowEvent::NodeSkipped {
                    node_id, iteration, ..
                } => Some((node_id, *iteration, 0, None)),
                _ => None,
            };
            if let Some((node_id, iteration, attempt, agent_id)) = identity {
                if matches!(&event, WorkflowEvent::NodeStarted { .. })
                    && let Err(error) = observation.clear_output(node_id)
                {
                    tracing::warn!(%error,"cannot clear previous node output");
                }
                if let WorkflowEvent::NodeCompleted { output, .. } = &event
                    && let Ok(text) = output
                        .as_str()
                        .map(str::to_owned)
                        .map(Ok)
                        .unwrap_or_else(|| serde_json::to_string(output))
                    && let Err(error) = observation.output(node_id, &text)
                {
                    tracing::warn!(%error,"failed to persist node output projection");
                }
                if let Err(error) = observation.update(|run| {
                    run.updated_at_ms = now;
                    let index = run
                        .node_states
                        .iter()
                        .position(|n| &n.node_id == node_id)
                        .unwrap_or_else(|| {
                            run.node_states.push(WorkflowNodeRun {
                                node_id: node_id.to_string(),
                                status: "pending".into(),
                                iteration,
                                iteration_status: None,
                                attempt,
                                started_at_ms: None,
                                finished_at_ms: None,
                                agent_id: None,
                                reused: false,
                                output_preview: None,
                                error: None,
                            });
                            run.node_states.len() - 1
                        });
                    let node = &mut run.node_states[index];
                    if iteration.is_some() {
                        node.iteration = iteration;
                    }
                    node.attempt = attempt;
                    node.agent_id = agent_id;
                    match &event {
                        WorkflowEvent::NodeStarted { .. } => {
                            node.status = "running".into();
                            if iteration.is_none() {
                                node.started_at_ms = Some(now);
                                node.iteration = None;
                                node.iteration_status = None;
                            } else {
                                node.iteration_status = Some("running".into());
                            }
                            node.finished_at_ms = None;
                            node.error = None;
                            node.reused = false;
                            node.output_preview = None;
                        }
                        WorkflowEvent::NodeCompleted { output, .. } => {
                            if iteration.is_some() {
                                node.status = "running".into();
                                node.iteration_status = Some("completed".into());
                            } else {
                                node.status = "completed".into();
                                node.finished_at_ms = Some(now);
                            }
                            node.error = None;
                            node.output_preview = serde_json::to_string(output)
                                .ok()
                                .map(|text| preview(&text, 512));
                        }
                        WorkflowEvent::NodeFailed {
                            error, will_retry, ..
                        } => {
                            let status = if *will_retry { "retrying" } else { "failed" };
                            if iteration.is_some() {
                                node.status = "running".into();
                                node.iteration_status = Some(status.into());
                            } else {
                                node.status = status.into();
                                node.finished_at_ms = Some(now);
                            }
                            node.error = Some(preview(error, 1024));
                        }
                        WorkflowEvent::NodeSkipped { reason, .. } => {
                            if iteration.is_some() {
                                node.status = "running".into();
                                node.iteration_status = Some("skipped".into());
                            } else {
                                node.status = "skipped".into();
                                node.finished_at_ms = Some(now);
                            }
                            node.error = Some(preview(reason, 1024));
                        }
                        _ => {}
                    }
                }) {
                    tracing::warn!(%error,"failed to persist node observation");
                }
            } else if let WorkflowEvent::AgentStarted { agent_id, .. } = &event {
                let _ = observation.update(|run| {
                    if let Some(node) = run
                        .node_states
                        .iter_mut()
                        .find(|n| n.agent_id.as_ref() == Some(agent_id))
                    {
                        node.reused = reused_agent;
                    }
                });
            } else if let WorkflowEvent::AgentCompleted { agent_id, output } = &event {
                let mut node_id = None;
                let _ = observation.update(|run| {
                    if let Some(node) = run
                        .node_states
                        .iter_mut()
                        .find(|n| n.agent_id.as_ref() == Some(agent_id))
                    {
                        node_id = Some(node.node_id.clone());
                        node.output_preview = Some(preview(output, 512));
                    }
                });
                if let Some(node_id) = node_id
                    && let Err(error) = observation.output(&node_id, output)
                {
                    tracing::warn!(%error,"cannot mirror actual agent output");
                }
            }
        }
        if let WorkflowEvent::NodeFailed {
            agent_id: Some(agent_id),
            ..
        } = &event
            && valid_agent_artifact_id(agent_id)
        {
            let directory = self
                .run_dir
                .join("agents")
                .join(kcoder_state::artifact_id_path_component(agent_id));
            let repair = secure_read_file(&directory.join("request.json"), MAX_SCRIPT_BYTES)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<AgentRequest>(&bytes).ok())
                .is_some_and(|request| request.output_repair_only);
            if repair && let Err(error) = secure_remove_file(&directory.join("completed")) {
                tracing::warn!(%error,"cannot invalidate rejected repair output");
            }
        }
        let persisted = match &event {
            WorkflowEvent::AgentStarted { agent_id, request } => {
                if !valid_agent_artifact_id(agent_id) {
                    tracing::error!(agent_id, "refusing unsafe workflow agent artifact id");
                    return;
                }
                let agent_dir = self
                    .run_dir
                    .join("agents")
                    .join(kcoder_state::artifact_id_path_component(agent_id));
                let output_path = agent_dir.join("output.md");
                let request_path = agent_dir.join("request.json");
                let completed_path = agent_dir.join("completed");
                let reused = cached_agent_request_matches(&agent_dir, request);
                // AgentStarted precedes host execution. Retain the prior evidence
                // when unresolved historical limits cannot prove this request.
                let blocked = self.state.lock().unwrap().unresolved_execution_limits != 0
                    && !legacy_agent_request_proven(&self.run_dir, agent_id, request);
                if !reused
                    && !blocked
                    && let Err(error) = secure_create_dir(&agent_dir).and_then(|_| {
                        secure_remove_file(&output_path)?;
                        secure_remove_file(&completed_path)?;
                        atomic_write_file(
                            &request_path,
                            serde_json::to_vec_pretty(request).map_err(std::io::Error::other)?,
                        )
                    })
                {
                    tracing::warn!(agent_id, %error, "failed to persist workflow agent request");
                }
                json!({
                    "type": if reused { "agent_reused" } else { "agent_started" },
                    "timestamp_ms": now,
                    "agent_id": agent_id,
                    "request": request,
                    "request_file": (!blocked).then_some(&request_path),
                    "retained_request_file": blocked.then_some(&request_path),
                    "execution_blocked": blocked,
                })
            }
            WorkflowEvent::AgentCompleted { agent_id, output } => {
                if !valid_agent_artifact_id(agent_id) {
                    tracing::error!(agent_id, "refusing unsafe workflow agent artifact id");
                    return;
                }
                let agent_dir = self
                    .run_dir
                    .join("agents")
                    .join(kcoder_state::artifact_id_path_component(agent_id));
                let output_path = agent_dir.join("output.md");
                let completed_path = agent_dir.join("completed");
                if let Err(error) = secure_create_dir(&agent_dir)
                    .and_then(|_| atomic_write_file(&output_path, output.as_bytes()))
                    .and_then(|_| atomic_write_file(&completed_path, b"ok\n"))
                {
                    tracing::warn!(agent_id, %error, "failed to persist workflow agent output");
                }
                json!({
                    "type": "agent_completed",
                    "timestamp_ms": now,
                    "agent_id": agent_id,
                    "output_file": output_path,
                    "output_preview": preview(output, 240),
                })
            }
            _ => {
                let mut value = serde_json::to_value(&event).unwrap_or_else(|error| {
                    json!({"type": "event_serialization_failed", "error": error.to_string()})
                });
                if let Some(object) = value.as_object_mut() {
                    object.insert("timestamp_ms".to_string(), json!(now));
                }
                value
            }
        };

        let flush_now = {
            let mut state = self.state.lock().unwrap();
            state.updated_at_ms = now;
            state.event_count += 1;
            match &event {
                WorkflowEvent::PhaseStarted { name } => state.active_phase = Some(name.clone()),
                WorkflowEvent::PhaseCompleted { name } => {
                    if state.active_phase.as_deref() == Some(name) {
                        state.active_phase = None;
                    }
                }
                WorkflowEvent::PhaseFailed { name, .. } => {
                    if state.active_phase.as_deref() == Some(name) {
                        state.active_phase = None;
                    }
                }
                WorkflowEvent::AgentStarted { .. } => {
                    state.agent_started += 1;
                    if reused_agent {
                        state.agent_reused += 1;
                    }
                }
                WorkflowEvent::AgentCompleted { .. } => state.agent_completed += 1,
                WorkflowEvent::AgentFailed { .. } => state.agent_failed += 1,
                WorkflowEvent::Log { .. }
                | WorkflowEvent::NodeStarted { .. }
                | WorkflowEvent::NodeCompleted { .. }
                | WorkflowEvent::NodeFailed { .. }
                | WorkflowEvent::NodeSkipped { .. } => {}
                WorkflowEvent::NodeReused { .. } => {}
            }
            !matches!(event, WorkflowEvent::Log { .. })
                || state.event_count.is_multiple_of(JOURNAL_EVENT_BATCH)
        };
        let result = self
            .queue_json(&persisted)
            .and_then(|_| flush_now.then(|| self.persist_state()).transpose())
            .map(|_| ());
        if let Err(error) = result {
            tracing::warn!(%error, "failed to persist workflow event");
        }
    }
}

pub(super) fn finish_workflow_result(
    store: &WorkflowRunStore,
    task_state: &kcoder_state::AppState,
    workflow_id: &str,
    result: Result<Value, WorkflowError>,
) -> ToolOutput {
    match result {
        Ok(value) => match store.finish(Ok(value.clone())) {
            Ok(()) => ToolOutput::text(
                json!({
                    "run_id": workflow_id,
                    "status": "completed",
                    "result": value,
                    "output_file": store.output_path(),
                })
                .to_string(),
            ),
            Err(error) => ToolOutput::error(error.to_string()),
        },
        Err(WorkflowError::Cancelled) => {
            task_state.update_task(workflow_id, |task| {
                task.status = TaskStatus::Cancelled;
                task.output = Some(WorkflowError::Cancelled.to_string());
                task.updated_at_ms = now_millis();
            });
            if let Err(error) = store.cancel() {
                tracing::warn!(%error, "failed to persist cancelled workflow state");
            }
            ToolOutput::error(WorkflowError::Cancelled.to_string())
        }
        Err(error) => {
            let message = error.to_string();
            if let Err(persist_error) = store.finish(Err(message.clone())) {
                tracing::warn!(%persist_error, "failed to persist failed workflow state");
            }
            ToolOutput::error(message)
        }
    }
}

pub(super) fn cached_agent_request_matches(agent_dir: &Path, request: &AgentRequest) -> bool {
    if !regular_file_without_symlink(&agent_dir.join("output.md"))
        || !regular_file_without_symlink(&agent_dir.join("completed"))
    {
        return false;
    }
    stored_agent_request_matches(agent_dir, request)
}

fn stored_agent_request_matches(agent_dir: &Path, request: &AgentRequest) -> bool {
    if !regular_file_without_symlink(&agent_dir.join("request.json")) {
        return false;
    }
    secure_read_file(&agent_dir.join("request.json"), MAX_SCRIPT_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AgentRequest>(&bytes).ok())
        .is_some_and(|cached| cached == *request)
}

pub(super) fn legacy_agent_request_proven(
    run_dir: &Path,
    agent_id: &str,
    request: &AgentRequest,
) -> bool {
    let directory = run_dir
        .join("agents")
        .join(kcoder_state::artifact_id_path_component(agent_id));
    if cached_agent_request_matches(&directory, request) {
        return true;
    }
    if !stored_agent_request_matches(&directory, request) {
        return false;
    }
    let Some(journal) = secure_read_file(&run_dir.join("journal.jsonl"), 32 * 1024 * 1024)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
    else {
        return false;
    };
    for line in journal.lines().rev() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if event["agent_id"] != agent_id {
            continue;
        }
        match event["type"].as_str() {
            Some("agent_completed") => return false,
            Some("agent_failed") => {
                let Some(error) = event["error"].as_str() else {
                    return false;
                };
                // A rejected recovery attempt is not evidence of host execution.
                if !error.contains("workflow_recovery_settings_required") {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

pub(super) fn regular_file_without_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.file_type().is_file() && !metadata.file_type().is_symlink())
}
