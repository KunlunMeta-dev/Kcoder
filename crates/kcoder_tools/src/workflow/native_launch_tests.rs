use super::*;

struct Observer {
    runner: Arc<RecordingRunner>,
    launches: std::sync::Mutex<Vec<WorkflowNativeLaunch>>,
    reject: bool,
}

impl WorkflowNativeLaunchObserver for Observer {
    fn before_dispatch(&self, launch: &WorkflowNativeLaunch) -> Result<(), ToolError> {
        assert!(
            self.runner.0.lock().unwrap().is_empty(),
            "no agent may precede native ownership registration"
        );
        self.launches.lock().unwrap().push(launch.clone());
        if self.reject {
            Err(ToolError::Execution("native_binding_write_failed".into()))
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn native_registration_persists_exact_run_before_agent_dispatch_and_failure_starts_no_agent()
{
    for reject in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let library = kcoder_workflow::store::WorkflowStore::new(profile.join("workflow-library"));
        let draft = library.create("Native launch", "").unwrap();
        let node = serde_json::from_value(
            json!({"id":"worker","title":"Worker","prompt":"inspect","agentType":"review"}),
        )
        .unwrap();
        let draft = library
            .upsert_node(&draft.id, draft.revision, node)
            .unwrap();
        let saved = library.save(&draft.id, draft.revision).unwrap();
        let state = AppState::new(temp.path());
        let project = profile.join("projects/project");
        fs::create_dir_all(&project).unwrap();
        state.with_history_path(project.join("session.jsonl"));
        let runner = Arc::new(RecordingRunner::default());
        let manager = Arc::new(ExecutingWorkflowManager::new(state.clone()));
        let observer = Arc::new(Observer {
            runner: runner.clone(),
            launches: Default::default(),
            reject,
        });
        let context = ToolContext::new(state.clone())
            .with_settings_persistence_path(Some(profile.join("settings.json")))
            .with_agent_runner(runner.clone())
            .with_background_job_manager(manager.clone())
            .with_workflow_native_launch_observer(observer.clone());
        let args = json!({"input":"original-input"});
        let result = WorkflowTool
            .call(
                json!({"definition_id":saved.id,"version":1,"args":args}),
                &context,
            )
            .await;
        let launches = observer.launches.lock().unwrap().clone();
        assert_eq!(launches.len(), 1);
        assert_eq!(launches[0].definition_id, saved.id);
        assert_eq!(launches[0].version, 1);
        use sha2::Digest;
        assert_eq!(
            launches[0].inputs_sha256,
            format!(
                "{:x}",
                sha2::Sha256::digest(serde_json::to_vec(&args).unwrap())
            )
        );
        if reject {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("native_binding_write_failed")
            );
            assert!(runner.0.lock().unwrap().is_empty());
            assert_eq!(
                crate::workflow_runs::read(profile.join("workflow-runs"), &launches[0].run_id)
                    .unwrap()
                    .status,
                "failed"
            );
        } else {
            let result = result.unwrap();
            let kcoder_types::ContentBlock::Text { text } = &result.content[0] else {
                panic!("text")
            };
            let receipt: Value = serde_json::from_str(text).unwrap();
            assert_eq!(receipt["run_id"], launches[0].run_id);
            manager.wait_for_completion(&launches[0].run_id).await;
            assert_eq!(runner.0.lock().unwrap().len(), 1);
        }
    }
}
