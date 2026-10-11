//! Persist evidence from actual host execution, without publishing input/output bodies.
use super::*;
use kcoder_workflow::store::{RuntimeVerification, WorkflowStore, definition_fingerprint};
use sha2::{Digest, Sha256};

fn fingerprint(value: &Value) -> Result<String, ToolError> {
    let bytes = serde_json::to_vec(value).map_err(|e| ToolError::Execution(e.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
pub(super) fn decode_scenario(
    native: Option<Value>,
    text: Option<String>,
) -> Result<Option<kcoder_workflow::store::WorkflowScenarioRequest>, ToolError> {
    if native.is_some() && text.is_some() {
        return Err(ToolError::InvalidInput(
            "verification_scenario and verification_scenario_json are mutually exclusive".into(),
        ));
    }
    let value = if let Some(text) = text {
        if text.len() > 16 * 1024 {
            return Err(ToolError::InvalidInput(
                "verification_scenario_json exceeds 16 KiB".into(),
            ));
        }
        Some(
            serde_json::from_str(&text)
                .map_err(|e| ToolError::InvalidInput(format!("verification_scenario_json: {e}")))?,
        )
    } else {
        native
    };
    value
        .map(|value| {
            serde_json::from_value(value)
                .map_err(|e| ToolError::InvalidInput(format!("verification_scenario: {e}")))
        })
        .transpose()
}

pub(super) struct WorkflowAgentConfigurationObserver {
    store: Arc<WorkflowRunStore>,
    agent_id: String,
    run_id: String,
    artifact_attempt: u32,
}
impl WorkflowAgentConfigurationObserver {
    pub(super) fn for_agent(
        store: Arc<WorkflowRunStore>,
        agent_id: &str,
    ) -> Result<Option<Arc<dyn crate::AgentConfigurationObserver>>, String> {
        let guard = store
            .verification
            .lock()
            .map_err(|_| "workflow verification lock poisoned")?;
        let Some((_, evidence, _)) = guard.as_ref() else {
            return Ok(None);
        };
        let observer = Self {
            store: store.clone(),
            agent_id: agent_id.into(),
            run_id: evidence.run_id.clone(),
            artifact_attempt: evidence.artifact_attempt.unwrap_or(evidence.resume_count),
        };
        Ok(Some(Arc::new(observer)))
    }
}
impl std::fmt::Debug for WorkflowAgentConfigurationObserver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkflowAgentConfigurationObserver")
            .field("agent_id", &self.agent_id)
            .finish()
    }
}
impl crate::AgentConfigurationObserver for WorkflowAgentConfigurationObserver {
    fn capture(
        &self,
        configuration: kcoder_types::ModelConfigurationSummary,
        selection_source: &'static str,
    ) -> Result<(), String> {
        if !super::execution_adapter::valid_agent_artifact_id(&self.agent_id) {
            return Err("workflow_invalid: unsafe agent configuration identity".into());
        }
        let mut guard = self
            .store
            .verification
            .lock()
            .map_err(|_| "workflow verification lock poisoned")?;
        let Some((library, evidence, pinned)) = guard.as_mut() else {
            return Ok(());
        };
        if evidence.run_id != self.run_id
            || evidence.artifact_attempt.unwrap_or(evidence.resume_count) != self.artifact_attempt
        {
            return Err("workflow_invalid: stale agent configuration attempt".into());
        }
        let entry = json!({"agentId":self.agent_id,"runId":evidence.run_id,
            "artifactAttempt":evidence.artifact_attempt.unwrap_or(evidence.resume_count),
            "selectionSource":selection_source,"configuration":configuration});
        let snapshots = evidence
            .model_snapshot
            .as_object_mut()
            .ok_or("workflow_invalid: model snapshot")?
            .entry("agents")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("workflow_invalid: agent snapshots")?;
        if snapshots
            .iter()
            .any(|old| old["agentId"] == entry["agentId"])
        {
            return if snapshots.iter().any(|old| old == &entry) {
                Ok(())
            } else {
                Err("workflow_invalid: agent runtime changed within an attempt".into())
            };
        }
        if snapshots.len() >= 64 {
            evidence.model_snapshot["agentsIncomplete"] = json!(true);
            return library
                .record_verification_pinned(evidence, pinned)
                .map_err(|error| error.to_string());
        }
        snapshots.push(entry);
        if serde_json::to_vec(&evidence.model_snapshot)
            .map_err(|_| "workflow_invalid: model snapshot")?
            .len()
            > 47 * 1024
        {
            evidence.model_snapshot["agents"]
                .as_array_mut()
                .unwrap()
                .pop();
            evidence.model_snapshot["agentsIncomplete"] = json!(true);
            return library
                .record_verification_pinned(evidence, pinned)
                .map_err(|error| error.to_string());
        }
        if let Err(error) = library.record_verification_pinned(evidence, pinned) {
            evidence.model_snapshot["agents"]
                .as_array_mut()
                .unwrap()
                .pop();
            return Err(error.to_string());
        }
        Ok(())
    }
}

impl WorkflowRunStore {
    pub(super) fn configure_verification(
        &self,
        ctx: &ToolContext,
        definition: &kcoder_types::workflow::WorkflowDefinition,
        args: &Value,
    ) -> Result<(), ToolError> {
        let library = WorkflowStore::new(crate::workflow_draft::library_root(ctx)?);
        let state = self.state.lock().unwrap().clone();
        let count = library
            .next_verification_attempt(&state.run_id)
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        let mut model = json!({});
        let mut safety = None;
        if let Some(settings) = &ctx.runtime_settings {
            let settings = settings
                .read()
                .map_err(|_| ToolError::Execution("Workflow settings lock poisoned".into()))?;
            model = json!({"model":ctx.runtime_model.as_ref().unwrap_or(&settings.model),"provider":ctx.runtime_provider.as_ref().or(settings.active_provider.as_ref()),"reasoningEffort":settings.model_reasoning_effort});
            safety = Some(fingerprint(
                &json!({"sandbox":settings.sandbox,"arrangementMode":ctx.arrangement_mode}),
            )?);
        } else if let Some(runtime_model) = &ctx.runtime_model {
            model = json!({"model":runtime_model,"provider":ctx.runtime_provider});
        }
        if let Some(runner) = ctx.agent_runner.as_ref()
            && let Some(configuration) = runner
                .workflow_model_configuration()
                .map_err(|error| ToolError::Execution(error.to_string()))?
        {
            // Capture once at admission. Subsequent file/model changes never rewrite this evidence.
            model["configuration"] = serde_json::to_value(configuration)
                .map_err(|error| ToolError::Execution(error.to_string()))?;
            model["selectionSource"] = json!("inherited_session");
        }
        atomic_write_file(
            &self.run_dir.join(format!("verification-args-{count}.json")),
            serde_json::to_vec(args).map_err(|e| ToolError::Execution(e.to_string()))?,
        )
        .map_err(|e| ToolError::Execution(e.to_string()))?;
        let evidence = RuntimeVerification {
            definition_id: definition.id.clone(),
            saved_version: definition
                .saved_version
                .ok_or_else(|| ToolError::Execution("workflow_unsaved".into()))?,
            definition_sha256: definition_fingerprint(definition)
                .map_err(|e| ToolError::Execution(e.to_string()))?,
            run_id: state.run_id.clone(),
            resume_count: state.resume_count.min(u32::MAX as usize) as u32,
            artifact_attempt: Some(count),
            started_at_ms: state.updated_at_ms,
            updated_at_ms: now_millis(),
            execution_status: "running".into(),
            outcome_certainty: "unknown".into(),
            check_status: "pending".into(),
            scope: "configured_result_checks".into(),
            checked_nodes: Vec::new(),
            configured_nodes: definition
                .nodes
                .iter()
                .filter(|node| node.config.result_check.is_some())
                .map(|node| node.id.clone())
                .collect(),
            skipped_nodes: Vec::new(),
            input_sha256: fingerprint(args)?,
            private_input_ref: format!("run:{}:attempt:{count}:input", state.run_id),
            output_sha256: None,
            private_output_ref: None,
            model_snapshot: model,
            safety_sha256: safety,
            interaction_modified: false,
            scenario: None,
        };
        let mut guard = self.verification.lock().unwrap();
        *guard = Some((library, evidence, definition.clone()));
        let (library, evidence, pinned) = guard.as_ref().expect("verification was initialized");
        if state.resume_count == 0 {
            library.admit_verification(evidence, pinned)
        } else {
            library.record_verification_pinned(evidence, pinned)
        }
        .map_err(|e| ToolError::Execution(e.to_string()))
    }

    pub(super) fn configure_verification_scenario(
        &self,
        request: kcoder_workflow::store::WorkflowScenarioRequest,
    ) -> Result<(), ToolError> {
        let mut guard = self.verification.lock().unwrap();
        let (library, evidence, pinned) = guard.as_mut().ok_or_else(|| {
            ToolError::InvalidInput(
                "workflow_invalid: verification scenarios require a pinned saved definition".into(),
            )
        })?;
        request
            .validate(pinned)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        evidence.scenario = Some(kcoder_workflow::store::WorkflowScenarioVerification {
            request,
            status: "pending".into(),
            scope: "declared_configured_checks".into(),
        });
        library
            .record_verification_pinned(evidence, pinned)
            .map_err(|e| ToolError::Execution(e.to_string()))
    }

    pub(super) fn record_verification_event(&self, event: &WorkflowEvent) -> Result<(), ToolError> {
        let mut guard = self.verification.lock().unwrap();
        let Some((library, evidence, pinned)) = guard.as_mut() else {
            return Ok(());
        };
        if evidence.execution_status != "running" {
            return Ok(());
        }
        let mut candidate = evidence.clone();
        let changed = match event {
            WorkflowEvent::NodeCompleted {
                node_id,
                iteration: None,
                ..
            } if evidence.configured_nodes.contains(node_id)
                && !evidence.checked_nodes.contains(node_id) =>
            {
                candidate.checked_nodes.push(node_id.clone());
                true
            }
            WorkflowEvent::NodeSkipped {
                node_id,
                iteration: None,
                ..
            } if pinned.nodes.iter().any(|node| &node.id == node_id)
                && !evidence.skipped_nodes.contains(node_id) =>
            {
                candidate.skipped_nodes.push(node_id.clone());
                true
            }
            _ => false,
        };
        if changed {
            candidate.updated_at_ms = now_millis();
            library
                .record_verification_pinned(&candidate, pinned)
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            *evidence = candidate;
        }
        Ok(())
    }

    fn effect_outcomes_known(&self) -> Result<bool, ToolError> {
        let state = self.state.lock().unwrap().clone();
        if state.agent_failed > 0 || state.agent_started > state.agent_completed {
            return Ok(false);
        }
        let directory = kcoder_config::PrivateDirectory::open_existing(&self.run_dir)
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        for (_, file) in directory
            .open_regular_files(|name| {
                name.to_string_lossy().starts_with("tool-")
                    && name.to_string_lossy().ends_with(".json")
            })
            .map_err(|e| ToolError::Execution(e.to_string()))?
        {
            if file
                .metadata()
                .map_err(|e| ToolError::Execution(e.to_string()))?
                .len()
                > 256 * 1024
            {
                return Ok(false);
            }
            let receipt: Value = serde_json::from_reader(file.take(256 * 1024 + 1))
                .map_err(|e| ToolError::Execution(e.to_string()))?;
            if !matches!(receipt["status"].as_str(), Some("completed" | "blocked")) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) fn finish_verification(&self, output: &Value) -> Result<(), ToolError> {
        let mut guard = self.verification.lock().unwrap();
        let Some((library, evidence, pinned)) = guard.as_mut() else {
            return Ok(());
        };
        evidence.execution_status = output["status"].as_str().unwrap_or("unknown").into();
        evidence.updated_at_ms = now_millis();
        evidence.outcome_certainty = if self.effect_outcomes_known()? {
            "known"
        } else {
            "unknown"
        }
        .into();
        let result = &output["result"];
        evidence.check_status = if evidence.execution_status == "completed" {
            result["verification"]["status"]
                .as_str()
                .unwrap_or("not_requested")
                .into()
        } else if output["error"]
            .as_str()
            .is_some_and(|error| error.contains("workflow_verification"))
        {
            "failed".into()
        } else {
            "incomplete".into()
        };
        for id in result["verification"]["checkedNodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !evidence.checked_nodes.iter().any(|node| node == id) {
                evidence.checked_nodes.push(id.into());
            }
        }
        for id in result["skipped"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !evidence.skipped_nodes.iter().any(|node| node == id) {
                evidence.skipped_nodes.push(id.into());
            }
        }
        if let Some(mut scenario) = evidence.scenario.take() {
            scenario.status = scenario.outcome(evidence).into();
            evidence.scenario = Some(scenario);
        }
        // Each attempt owns an immutable body reference, including when resume replaces output.json.
        atomic_write_file(
            &self.run_dir.join(format!(
                "verification-output-{}.json",
                evidence.artifact_attempt.unwrap_or(evidence.resume_count)
            )),
            serde_json::to_vec(output).map_err(|e| ToolError::Execution(e.to_string()))?,
        )
        .map_err(|e| ToolError::Execution(e.to_string()))?;
        evidence.output_sha256 = Some(fingerprint(output)?);
        evidence.private_output_ref = Some(format!(
            "run:{}:attempt:{}:output",
            evidence.run_id,
            evidence.artifact_attempt.unwrap_or(evidence.resume_count)
        ));
        library
            .record_verification_pinned(evidence, pinned)
            .map_err(|e| ToolError::Execution(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::workflow::WorkflowNode;
    #[test]
    fn agent_configuration_capture_is_bounded_and_rejects_late_attempts() {
        // This test covers the observer/record state machine; actual Engine
        // resolver and Provider request alignment are covered in Engine tests.
        let fixtures: Value =
            serde_json::from_str(include_str!("../../../../scripts/contracts/fixtures.json"))
                .unwrap();
        let configuration: kcoder_types::ModelConfigurationSummary = serde_json::from_value(
            fixtures["ModelConfigurationSummary"]["valid"][0]["value"].clone(),
        )
        .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let library = WorkflowStore::new(crate::workflow_draft::library_root(&ctx).unwrap());
        let draft = library.create("Observer attempts", "").unwrap();
        let node = serde_json::from_value(json!({"id":"pure","title":"Pure","kind":"code","config":{"code":{"source":"return input;"}}})).unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let store = WorkflowRunStore::create(
            temp.path().join("workflow-observer"),
            "workflow-observer".into(),
            "Observer".into(),
            format!("definition:{}@1", saved.id),
            "",
            &json!({}),
            WorkflowRunLimits {
                max_concurrency: 1,
                ..Default::default()
            },
        )
        .unwrap();
        store
            .configure_verification(&ctx, &saved, &json!({}))
            .unwrap();
        let old = WorkflowAgentConfigurationObserver::for_agent(store.clone(), "old-agent")
            .unwrap()
            .unwrap();
        old.capture(configuration.clone(), "inherited_session")
            .unwrap();
        for index in 0..100 {
            WorkflowAgentConfigurationObserver::for_agent(store.clone(), &format!("agent-{index}"))
                .unwrap()
                .unwrap()
                .capture(configuration.clone(), "inherited_session")
                .unwrap();
        }
        let recorded = library.verification(&saved.id, 1).unwrap();
        let prior = recorded.runs[0].model_snapshot.clone();
        assert!(prior["agents"].as_array().unwrap().len() <= 64);
        assert_eq!(prior["agentsIncomplete"], true);
        assert!(serde_json::to_vec(&prior).unwrap().len() <= 48 * 1024);
        store.finish(Err("known failure".into())).unwrap();
        store
            .begin_resume(
                &json!({"retry":true}),
                WorkflowRunLimits {
                    max_concurrency: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .configure_verification(&ctx, &saved, &json!({"retry":true}))
            .unwrap();
        assert!(
            old.capture(configuration.clone(), "inherited_session")
                .unwrap_err()
                .contains("stale")
        );
        WorkflowAgentConfigurationObserver::for_agent(store.clone(), "new-agent")
            .unwrap()
            .unwrap()
            .capture(configuration, "inherited_session")
            .unwrap();
        let recorded = library.verification(&saved.id, 1).unwrap();
        assert_eq!(recorded.runs.len(), 2);
        assert_eq!(
            recorded
                .runs
                .iter()
                .find(|run| run.artifact_attempt == Some(0))
                .unwrap()
                .model_snapshot,
            prior
        );
        assert_eq!(
            recorded
                .runs
                .iter()
                .find(|run| run.artifact_attempt == Some(1))
                .unwrap()
                .model_snapshot["agents"][0]["artifactAttempt"],
            1
        );
    }
    struct NoAgents;
    #[async_trait]
    impl AgentExecutor for NoAgents {
        async fn execute(&self, _: &str, _: AgentRequest) -> Result<String, String> {
            panic!("authoring and deterministic verification must not invoke agents")
        }
    }
    #[tokio::test]
    async fn actual_branch_checks_are_version_bound_private_and_do_not_cover_skipped_nodes() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let library = WorkflowStore::new(crate::workflow_draft::library_root(&ctx).unwrap());
        let draft = library.create("Private branches", "").unwrap();
        let nodes: Vec<WorkflowNode> = serde_json::from_value(json!([
            {"id":"route","title":"Route","kind":"condition","config":{"condition":{"op":"equals","pointer":"/input/flag","value":true}}},
            {"id":"yes","title":"Yes","kind":"code","dependsOn":["route"],"runIf":{"nodeId":"route","equals":true},"config":{"code":{"source":"return {count: 2};"},"resultCheck":{"source":"return result.count === 2;"}}},
            {"id":"no","title":"No","kind":"code","dependsOn":["route"],"runIf":{"nodeId":"route","equals":false},"config":{"code":{"source":"throw new Error('skipped branch executed');"},"resultCheck":{"source":"return false;"}}}
        ])).unwrap();
        let draft = library
            .patch_nodes(&draft.id, draft.revision, nodes, vec![])
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let before = library.verification(&saved.id, 1).unwrap();
        assert!(before.runs.is_empty());
        assert_eq!(before.static_check.unwrap().checked_nodes.len(), 3);
        let args = json!({"flag":true,"credential":"PRIVATE_TEST_SECRET"});
        let run = WorkflowRunStore::create(
            temp.path().join("workflow-evidence"),
            "workflow-evidence".into(),
            "Branches".into(),
            format!("definition:{}@1", saved.id),
            "",
            &args,
            WorkflowRunLimits {
                max_concurrency: 1,
                ..Default::default()
            },
        )
        .unwrap();
        run.configure_verification(&ctx, &saved, &args).unwrap();
        run.configure_verification_scenario(kcoder_workflow::store::WorkflowScenarioRequest {
            id: "true-route".into(),
            required_check_nodes: vec!["yes".into()],
            expected_skipped_nodes: Some(vec!["no".into()]),
        })
        .unwrap();
        let output = WorkflowRuntime::execute_definition(
            &saved,
            args,
            Arc::new(NoAgents),
            run.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap();
        run.finish(Ok(output)).unwrap();
        let summary = library.verification(&saved.id, 1).unwrap();
        assert_eq!(summary.runs[0].execution_status, "completed");
        assert_eq!(summary.runs[0].check_status, "passed");
        assert_eq!(summary.runs[0].checked_nodes, ["yes"]);
        assert_eq!(summary.runs[0].skipped_nodes, ["no"]);
        assert_eq!(summary.runs[0].scope, "configured_result_checks");
        assert_eq!(summary.runs[0].scenario.as_ref().unwrap().status, "passed");
        for index in 0..40 {
            let mut paged = summary.runs[0].clone();
            paged.run_id = format!("workflow-page-{index}");
            library.record_verification(&paged).unwrap();
        }
        let page = library.verification_page(&saved.id, 1, 0, 32).unwrap();
        assert_eq!(page.total_run_count, 41);
        assert_eq!(page.runs.len(), 32);
        assert_eq!(page.next_offset, Some(32));
        let last = library.verification_page(&saved.id, 1, 32, 32).unwrap();
        assert_eq!(last.runs.len(), 9);
        assert_eq!(last.next_offset, None);
        assert!(library.verification_page(&saved.id, 1, 0, 0).is_err());

        let public = serde_json::to_string(&summary).unwrap();
        assert!(!public.contains("PRIVATE_TEST_SECRET"));
        assert!(!public.contains(temp.path().to_str().unwrap()));
        assert!(run.run_dir.join("verification-args-0.json").exists());
        assert!(run.run_dir.join("verification-output-0.json").exists());
        let draft = library
            .update_metadata(&saved.id, saved.revision, "Revised", "", None)
            .unwrap();
        assert_eq!(
            library.verification(&saved.id, 1).unwrap().draft_status,
            "new_draft_unverified"
        );
        let version2 = library.save(&draft.id, draft.revision).unwrap();
        assert!(library.verification(&saved.id, 2).unwrap().runs.is_empty());
        assert_ne!(
            summary.runs[0].definition_sha256,
            definition_fingerprint(&version2).unwrap()
        );
        assert_eq!(
            library.verification(&saved.id, 1).unwrap().total_run_count,
            41
        );
    }
    #[tokio::test]
    async fn failed_check_keeps_earlier_coverage_and_terminal_receipts_cannot_be_rewritten() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let library = WorkflowStore::new(crate::workflow_draft::library_root(&ctx).unwrap());
        let draft = library.create("Failure coverage", "").unwrap();
        let nodes: Vec<WorkflowNode> = serde_json::from_value(json!([
            {"id":"first","title":"First","kind":"code","config":{"code":{"source":"return 1;"},"resultCheck":{"source":"return result === 1;"}}},
            {"id":"failed","title":"Failed","kind":"code","dependsOn":["first"],"config":{"code":{"source":"return 2;"},"resultCheck":{"source":"return result === 3;"}}}
        ])).unwrap();
        let draft = library
            .patch_nodes(&draft.id, draft.revision, nodes, vec![])
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let run = WorkflowRunStore::create(
            temp.path().join("workflow-failed-evidence"),
            "workflow-failed-evidence".into(),
            "Failure".into(),
            format!("definition:{}@1", saved.id),
            "",
            &json!({}),
            WorkflowRunLimits {
                max_concurrency: 1,
                ..Default::default()
            },
        )
        .unwrap();
        run.configure_verification(&ctx, &saved, &json!({}))
            .unwrap();
        library
            .mark_run_interaction_modified("workflow-failed-evidence")
            .unwrap();
        let result = WorkflowRuntime::execute_definition(
            &saved,
            json!({}),
            Arc::new(NoAgents),
            run.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("workflow_verification"));
        run.finish(Err(error)).unwrap();
        let evidence = library.verification(&saved.id, 1).unwrap().runs.remove(0);
        assert_eq!(evidence.execution_status, "failed");
        assert_eq!(evidence.check_status, "failed");
        assert_eq!(evidence.checked_nodes, ["first"]);
        assert!(evidence.interaction_modified);
        let mut overwritten = evidence.clone();
        overwritten.execution_status = "completed".into();
        overwritten.check_status = "passed".into();
        assert!(
            library
                .record_verification(&overwritten)
                .unwrap_err()
                .to_string()
                .contains("terminal evidence is immutable")
        );
        overwritten.input_sha256 = "different".into();
        assert!(
            library
                .record_verification(&overwritten)
                .unwrap_err()
                .to_string()
                .contains("identity/input changed")
        );
        assert_eq!(
            library.verification(&saved.id, 1).unwrap().runs[0].check_status,
            "failed"
        );
    }
    struct FixtureFiles {
        ctx: ToolContext,
        calls: std::sync::atomic::AtomicUsize,
    }
    #[async_trait]
    impl AgentRunner for FixtureFiles {
        async fn run_agent(&self, _: String, _: usize) -> Result<String, crate::AgentError> {
            panic!("file verification must not call a model")
        }
        async fn run_workflow_tool(
            &self,
            _: &str,
            name: &str,
            input: Value,
        ) -> Result<(ToolOutput, bool), crate::AgentError> {
            if input["file_path"] != "artifact.json" {
                return Err(crate::AgentError::Execution("fixture path denied".into()));
            }
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let result = match name {
                "write" => crate::FileWriteTool.call(input, &self.ctx).await,
                "read" => crate::FileReadTool.call(input, &self.ctx).await,
                _ => return Err(crate::AgentError::NotAvailable),
            };
            result
                .map(|output| (output, true))
                .map_err(|e| crate::AgentError::Execution(e.to_string()))
        }
        fn workflow_tool_is_read_only(&self, name: &str) -> bool {
            name == "read"
        }
    }
    #[tokio::test]
    async fn actual_file_artifact_is_read_back_and_checked_without_generation_side_effects() {
        let temp = tempfile::tempdir().unwrap();
        let state = kcoder_state::AppState::new(temp.path());
        let ctx = ToolContext::new(state.clone())
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let library = WorkflowStore::new(crate::workflow_draft::library_root(&ctx).unwrap());
        let draft = library.create("Actual artifact", "").unwrap();
        let rows = json!([{"id":"α","count":2,"enabled":false}]);
        let nodes: Vec<WorkflowNode> = serde_json::from_value(json!([
            {"id":"write","title":"Write","kind":"tool","config":{"tool":{"name":"write","arguments":{"file_path":"artifact.json","content":serde_json::to_string(&rows).unwrap()}}}},
            {"id":"read","title":"Read back","kind":"tool","dependsOn":["write"],"config":{"tool":{"name":"read","arguments":{"file_path":"artifact.json","format":"raw"}},"resultCheck":{"source":"if (result.isError !== false || result.content.length !== 1 || result.content[0].type !== 'text') return false; const rows = JSON.parse(result.content[0].text); return Array.isArray(rows) && rows.length === 1 && rows[0].id === 'α' && typeof rows[0].count === 'number' && rows[0].count === 2 && rows[0].enabled === false;"}}},
            {"id":"output","title":"Artifact result","kind":"output","dependsOn":["read"],"config":{"pointer":"/nodes/read"}}
        ])).unwrap();
        let draft = library
            .patch_nodes(&draft.id, draft.revision, nodes, vec![])
            .unwrap();
        let checks =
            crate::workflow_draft::validate_workflow_tool_contracts(&draft, |name| match name {
                "write" => Some(kcoder_types::ToolDefinition {
                    name: name.into(),
                    description: String::new(),
                    input_schema: crate::FileWriteTool.input_schema(),
                }),
                "read" => Some(kcoder_types::ToolDefinition {
                    name: name.into(),
                    description: String::new(),
                    input_schema: crate::FileReadTool.input_schema(),
                }),
                _ => None,
            })
            .unwrap();
        let saved = library
            .save_with_tool_contracts(&draft.id, draft.revision, Some(checks))
            .unwrap();
        assert!(!temp.path().join("artifact.json").exists());
        let runner = Arc::new(FixtureFiles {
            ctx: ToolContext::new(state),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let run = WorkflowRunStore::create(
            temp.path().join("workflow-file-evidence"),
            "workflow-file-evidence".into(),
            "Artifact".into(),
            format!("definition:{}@1", saved.id),
            "",
            &json!({}),
            WorkflowRunLimits {
                max_concurrency: 1,
                ..Default::default()
            },
        )
        .unwrap();
        run.configure_verification(&ctx, &saved, &json!({}))
            .unwrap();
        let executor = Arc::new(ToolAgentExecutor {
            require_checkpoint_match: false,
            require_legacy_agent_request: false,
            verification_store: None,
            isolate_context: true,
            runner: runner.clone(),
            arrangement_mode: false,
            resume_run_dir: None,
            checkpoint_run_dir: None,
            tool_run_dir: Some(run.run_dir.clone()),
            library_root: Some(crate::workflow_draft::library_root(&ctx).unwrap()),
            wait_root: None,
            run_id: "workflow-file-evidence".into(),
            cancellation: CancellationToken::new(),
        });
        let result = WorkflowRuntime::execute_definition(
            &saved,
            json!({}),
            executor,
            run.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap();
        run.finish(Ok(result)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(
                &std::fs::read_to_string(temp.path().join("artifact.json")).unwrap()
            )
            .unwrap(),
            rows
        );
        assert_eq!(runner.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        let evidence = library.verification(&saved.id, 1).unwrap();
        assert_eq!(
            evidence.static_check.unwrap().tool_contracts,
            "known_arguments_checked"
        );
        assert_eq!(evidence.runs[0].check_status, "passed");
        assert_eq!(evidence.runs[0].checked_nodes, ["read"]);
        assert_eq!(evidence.runs[0].outcome_certainty, "known");
        assert!(evidence.runs[0].output_sha256.is_some());
    }
    struct PureSubgraphs(WorkflowStore);
    #[async_trait]
    impl AgentExecutor for PureSubgraphs {
        async fn execute(&self, _: &str, _: AgentRequest) -> Result<String, String> {
            panic!("pure Loop verification must not call a model")
        }
        async fn resolve_workflow(
            &self,
            id: &str,
            version: u64,
        ) -> Result<kcoder_types::workflow::WorkflowDefinition, String> {
            self.0
                .read_saved(id, Some(version))
                .map_err(|e| e.to_string())
        }
    }
    #[tokio::test]
    async fn declared_loop_scenarios_check_early_equality_and_limit_against_the_same_saved_version()
    {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let library = WorkflowStore::new(crate::workflow_draft::library_root(&ctx).unwrap());
        let child = library.create("Pure score", "").unwrap();
        let node: WorkflowNode = serde_json::from_value(json!({"id":"score","title":"Score","kind":"code","config":{"code":{"source":"return {score: input.baseScore + input.step * (input.index + 1)};"},"outputSchema":{"type":"object","required":["score"],"properties":{"score":{"type":"number"}}}}})).unwrap();
        let child = library
            .upsert_node(&child.id, child.revision, node)
            .unwrap();
        let child = library.save(&child.id, child.revision).unwrap();
        let parent = library.create("Loop cases", "").unwrap();
        let node: WorkflowNode = serde_json::from_value(json!({"id":"loop","title":"Loop","kind":"loop","config":{"loop":{"mode":"repeat","maxIterations":3,"until":{"op":"greater_than","pointer":"/iteration/output/outputs/0/output/score","value":52},"body":{"definitionId":child.id,"version":1,"arguments":{},"bindings":{"baseScore":"/input/baseScore","step":"/input/step","index":"/iteration/index"}}},"resultCheck":{"source":"return Number.isInteger(result.count) && result.count === input.expectedCount && result.exitReason === input.expectedExit && Array.isArray(result.iterations) && result.iterations.length === result.count && result.iterations.every(value => typeof value.outputs[0].output.score === 'number');"}}})).unwrap();
        let parent = library
            .upsert_node(&parent.id, parent.revision, node)
            .unwrap();
        let saved = library.save(&parent.id, parent.revision).unwrap();
        for (id, args) in [
            (
                "early",
                json!({"baseScore":51,"step":2,"expectedCount":1,"expectedExit":"condition_met"}),
            ),
            (
                "equality",
                json!({"baseScore":50,"step":1,"expectedCount":3,"expectedExit":"condition_met"}),
            ),
            (
                "limit",
                json!({"baseScore":52,"step":0,"expectedCount":3,"expectedExit":"iteration_limit"}),
            ),
        ] {
            let run_id = format!("workflow-loop-{id}");
            let run = WorkflowRunStore::create(
                temp.path().join(&run_id),
                run_id.clone(),
                id.into(),
                format!("definition:{}@1", saved.id),
                "",
                &args,
                WorkflowRunLimits {
                    max_concurrency: 1,
                    ..Default::default()
                },
            )
            .unwrap();
            run.configure_verification(&ctx, &saved, &args).unwrap();
            run.configure_verification_scenario(kcoder_workflow::store::WorkflowScenarioRequest {
                id: id.into(),
                required_check_nodes: vec!["loop".into()],
                expected_skipped_nodes: Some(vec![]),
            })
            .unwrap();
            let result = WorkflowRuntime::execute_definition(
                &saved,
                args,
                Arc::new(PureSubgraphs(library.clone())),
                run.clone(),
                WorkflowRuntimeConfig::default(),
            )
            .await
            .unwrap();
            run.finish(Ok(result)).unwrap();
        }
        let evidence = library.verification(&saved.id, 1).unwrap();
        assert_eq!(evidence.total_run_count, 3);
        for run in &evidence.runs {
            assert_eq!(run.saved_version, 1);
            assert_eq!(
                run.definition_sha256,
                definition_fingerprint(&saved).unwrap()
            );
            assert_eq!(run.check_status, "passed");
            assert_eq!(run.checked_nodes, ["loop"]);
            assert_eq!(run.scenario.as_ref().unwrap().status, "passed");
            assert_eq!(
                run.scenario.as_ref().unwrap().scope,
                "declared_configured_checks"
            );
        }
    }
    #[tokio::test]
    async fn unknown_effect_receipts_survive_a_completed_run_and_never_become_known_cleanup_proof()
    {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let library = WorkflowStore::new(crate::workflow_draft::library_root(&ctx).unwrap());
        let draft = library.create("Unknown effect", "").unwrap();
        let node:WorkflowNode=serde_json::from_value(json!({"id":"pure","title":"Pure","kind":"code","config":{"code":{"source":"return 1;"},"resultCheck":{"source":"return result === 1;"}}})).unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let run = WorkflowRunStore::create(
            temp.path().join("workflow-unknown-effect"),
            "workflow-unknown-effect".into(),
            "Unknown".into(),
            format!("definition:{}@1", saved.id),
            "",
            &json!({}),
            WorkflowRunLimits {
                max_concurrency: 1,
                ..Default::default()
            },
        )
        .unwrap();
        run.configure_verification(&ctx, &saved, &json!({}))
            .unwrap();
        atomic_write_file(
            &run.run_dir.join("tool-unconfirmed.json"),
            serde_json::to_vec(&json!({"status":"pending"})).unwrap(),
        )
        .unwrap();
        let result = WorkflowRuntime::execute_definition(
            &saved,
            json!({}),
            Arc::new(NoAgents),
            run.clone(),
            WorkflowRuntimeConfig::default(),
        )
        .await
        .unwrap();
        run.finish(Ok(result)).unwrap();
        let evidence = library.verification(&saved.id, 1).unwrap();
        assert_eq!(evidence.runs[0].execution_status, "completed");
        assert_eq!(evidence.runs[0].check_status, "passed");
        assert_eq!(evidence.runs[0].outcome_certainty, "unknown");
    }
    #[tokio::test]
    async fn rejected_resume_publication_does_not_reuse_or_overwrite_the_prior_artifact_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_settings_persistence_path(Some(temp.path().join("owner/settings.json")));
        let library = WorkflowStore::new(crate::workflow_draft::library_root(&ctx).unwrap());
        let draft = library.create("Resume attempts", "").unwrap();
        let node:WorkflowNode=serde_json::from_value(json!({"id":"pure","title":"Pure","kind":"code","config":{"code":{"source":"return input;"}}})).unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let run = WorkflowRunStore::create(
            temp.path().join("workflow-attempts"),
            "workflow-attempts".into(),
            "Attempts".into(),
            format!("definition:{}@1", saved.id),
            "",
            &json!({"value":1}),
            WorkflowRunLimits {
                max_concurrency: 1,
                ..Default::default()
            },
        )
        .unwrap();
        run.configure_verification(&ctx, &saved, &json!({"value":1}))
            .unwrap();
        run.finish(Err("known pure failure".into())).unwrap();
        let rollback = run
            .begin_resume(
                &json!({"value":2}),
                WorkflowRunLimits {
                    max_concurrency: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        run.configure_verification(&ctx, &saved, &json!({"value":2}))
            .unwrap();
        run.finish_verification(&json!({"status":"not_started"}))
            .unwrap();
        run.rollback_resume(rollback).unwrap();
        let rollback = run
            .begin_resume(
                &json!({"value":3}),
                WorkflowRunLimits {
                    max_concurrency: 1,
                    ..Default::default()
                },
            )
            .unwrap();
        run.configure_verification(&ctx, &saved, &json!({"value":3}))
            .unwrap();
        run.finish_verification(&json!({"status":"not_started"}))
            .unwrap();
        run.rollback_resume(rollback).unwrap();
        let evidence = library.verification(&saved.id, 1).unwrap();
        assert_eq!(evidence.total_run_count, 3);
        let attempts: std::collections::BTreeSet<_> = evidence
            .runs
            .iter()
            .map(|evidence| evidence.artifact_attempt.unwrap())
            .collect();
        assert_eq!(attempts, [0, 1, 2].into_iter().collect());
        assert_eq!(
            serde_json::from_slice::<Value>(
                &secure_read_file(&run.run_dir.join("verification-args-1.json"), 4096).unwrap()
            )
            .unwrap(),
            json!({"value":2})
        );
        assert_eq!(
            serde_json::from_slice::<Value>(
                &secure_read_file(&run.run_dir.join("verification-args-2.json"), 4096).unwrap()
            )
            .unwrap(),
            json!({"value":3})
        );
        assert_eq!(run.state.lock().unwrap().resume_count, 0);
    }
}
