//! Read-only public metadata from the original private acceptance under the store lock.
use super::*;

pub(super) fn project_original_native_task(
    data: &Data,
    original: &AutomationRun,
) -> Result<AutomationRun> {
    ensure!(
        original.owner == data.owner,
        "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
    );
    let mut run = original.clone();
    // A serialized projection cannot become authority, including after an old
    // client or imported history wrote an unverified optional public field.
    run.native_task_id = None;
    let Some(accepted) = data.native_acceptances.get(&run.id) else {
        return Ok(run);
    };
    accepted.validate().map_err(anyhow::Error::msg)?;
    ensure!(
        run.native_thread_id.as_deref() == Some(accepted.thread_id.as_str())
            && run.native_turn_id == accepted.turn_id,
        "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
    );
    if let Some(task) = &accepted.task_id {
        let key = run
            .id
            .strip_prefix("run-")
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_CONFLICT"))?;
        ensure!(
            data.triggers
                .get(key)
                .is_some_and(|trigger| trigger.run_id == run.id)
                && run.native_operation_id == format!("automation-{key}"),
            "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
        );
        run.native_task_id = Some(task.clone());
    }
    Ok(run)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{draft, fixture_root, scope};
    use super::*;
    fn prepared() -> Result<(
        tempfile::TempDir,
        std::path::PathBuf,
        AutomationStore,
        AutomationRun,
    )> {
        let root = fixture_root()?;
        let actor = scope("task-projection");
        let path = root.path().join("private");
        let store = AutomationStore::create(&path, &actor)?;
        let d = draft();
        let consent = ApprovedAutomationConsent::from_explicit_user_action(
            &actor,
            "explicit-task-projection",
            &d,
        )?;
        store.save_subscription("save-task-projection", 0, d, &consent, Some(1000), 100)?;
        let run = store.prepare_run(
            "weekly-report",
            1,
            "original-task-trigger",
            json!({"due":1000}),
            Some(2000),
            1000,
        )?;
        Ok((root, path, store, run))
    }
    #[test]
    fn original_private_workflow_task_is_projected_without_rewriting_legacy_run_bytes() -> Result<()>
    {
        let (_root, path, store, run) = prepared()?;
        assert!(store.read_run(&run.id)?.native_task_id.is_none());
        assert!(store.claim_native_submission(&run.id)?);
        // State accepts metadata only from its native consumer. The real Core
        // receipt and task/run are independently exercised by the normal E2E.
        let acceptance = kcoder_types::integrations::core::IntegrationRuntimeAcceptance {
            thread_id: "original-thread".into(),
            turn_id: None,
            task_id: Some("original-workflow".into()),
            state: kcoder_types::integrations::core::IntegrationTaskState::Queued,
        };
        store.record_native_acceptance_receipt(&run.id, &acceptance, 1001)?;
        let before = std::fs::read(path.join(FILE))?;
        let legacy: Value = serde_json::from_slice(&before)?;
        assert!(legacy["runs"][&run.id].get("nativeTaskId").is_none());
        assert_eq!(
            store.read_run(&run.id)?.native_task_id.as_deref(),
            Some("original-workflow")
        );
        assert_eq!(
            store.list_runs(None)?.items[0].native_task_id.as_deref(),
            Some("original-workflow")
        );
        assert_eq!(before, std::fs::read(path.join(FILE))?);
        let reopened = AutomationStore::open(&path, &scope("task-projection"))?;
        assert_eq!(
            reopened.read_run(&run.id)?.native_task_id.as_deref(),
            Some("original-workflow")
        );
        assert_eq!(before, std::fs::read(path.join(FILE))?);
        Ok(())
    }
    #[test]
    fn serialized_task_label_without_private_receipt_is_not_a_projection() -> Result<()> {
        let (_root, path, store, run) = prepared()?;
        let mut value: Value = serde_json::from_slice(&std::fs::read(path.join(FILE))?)?;
        value["runs"][&run.id]["nativeTaskId"] = json!("unverified-caller-label");
        store
            .directory
            .atomic_replace(OsStr::new(FILE), &serde_json::to_vec(&value)?)?;
        let before = std::fs::read(path.join(FILE))?;
        assert!(store.read_run(&run.id)?.native_task_id.is_none());
        assert!(store.list_runs(None)?.items[0].native_task_id.is_none());
        assert_eq!(before, std::fs::read(path.join(FILE))?);
        Ok(())
    }
    #[test]
    fn changed_original_operation_or_foreign_accepted_thread_cannot_supply_task_metadata()
    -> Result<()> {
        let (_root, path, store, run) = prepared()?;
        assert!(store.claim_native_submission(&run.id)?);
        let accepted = kcoder_types::integrations::core::IntegrationRuntimeAcceptance {
            thread_id: "original-thread".into(),
            turn_id: None,
            task_id: Some("original-workflow".into()),
            state: kcoder_types::integrations::core::IntegrationTaskState::Queued,
        };
        store.record_native_acceptance_receipt(&run.id, &accepted, 1001)?;
        let original: Value = serde_json::from_slice(&std::fs::read(path.join(FILE))?)?;
        for field in ["operation", "thread", "owner"] {
            let mut changed = original.clone();
            match field {
                "operation" => {
                    changed["runs"][&run.id]["nativeOperationId"] = json!("foreign-operation")
                }
                "thread" => {
                    changed["nativeAcceptances"][&run.id]["threadId"] = json!("foreign-thread")
                }
                _ => changed["runs"][&run.id]["owner"]["targetId"] = json!("foreign-target"),
            }
            store
                .directory
                .atomic_replace(OsStr::new(FILE), &serde_json::to_vec(&changed)?)?;
            assert!(store.read_run(&run.id).is_err(), "{field}");
            assert!(store.list_runs(None).is_err(), "{field}");
        }
        Ok(())
    }
}
