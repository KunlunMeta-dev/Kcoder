//! Account-profile library operations, independent of per-session run artifacts.
use anyhow::{Context, Result};
use kcoder_app_protocol::*;
use kcoder_engine::QueryEngine;
use kcoder_workflow::store::WorkflowStore;
use serde_json::Value;
fn typed_domain<T: serde::de::DeserializeOwned + serde::Serialize>(
    value: impl serde::Serialize,
) -> Result<Value> {
    let value = serde_json::to_value(value)?;
    let typed: T = serde_json::from_value(value)
        .context("workflow_contract: domain result does not match wire contract")?;
    Ok(serde_json::to_value(typed)?)
}
pub(super) fn request(engine: &QueryEngine, method: &str, params: Value) -> Result<Value> {
    if method == method::WORKFLOW_CAPABILITIES_READ {
        let _: WorkflowStorageReadParams = serde_json::from_value(params)?;
        return Ok(serde_json::to_value(WorkflowCapabilitiesResult {
            verification: true,
            storage: true,
            version_history: true,
            scenarios: true,
            conditional_read: true,
            checkpoint_reuse: true,
            run_archive: true,
        })?);
    }
    let path = engine
        .settings_persistence_path()
        .context("Workflow library is unavailable for this runtime")?;
    let root = path
        .parent()
        .context("Workflow profile storage is invalid")?
        .join("workflow-library");
    let store = WorkflowStore::new(root);
    let runs_root = path
        .parent()
        .context("Invalid profile root")?
        .join("workflow-runs");
    Ok(match method {
        method::WORKFLOW_VERIFICATION_READ => {
            let p: WorkflowVerificationReadParams = serde_json::from_value(params)?;
            typed_domain::<WorkflowVerificationReadResult>(
                store.verification_page(&p.id, p.version, p.offset, p.limit)?,
            )?
        }
        method::WORKFLOW_STORAGE_READ => {
            let _: WorkflowStorageReadParams = serde_json::from_value(params)?;
            typed_domain::<WorkflowStorageCapacityResult>(store.capacity()?)?
        }
        method::WORKFLOW_STORAGE_MIGRATE => {
            let p: WorkflowStorageMutationParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                p.confirm,
                "workflow_confirmation_required: migration must be explicitly requested"
            );
            typed_domain::<WorkflowStorageMigrationResult>(store.migrate_storage()?)?
        }
        method::WORKFLOW_STORAGE_ROLLBACK => {
            let p: WorkflowStorageMutationParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                p.confirm,
                "workflow_confirmation_required: rollback must be explicitly requested"
            );
            store.rollback_storage()?;
            serde_json::to_value(WorkflowStorageRollbackResult {
                backend: "legacy_json".into(),
                rolled_back: true,
            })?
        }
        method::WORKFLOW_VERSION_REFERENCES => {
            let p: WorkflowVersionReferenceParams = serde_json::from_value(params)?;
            let runs = kcoder_tools::workflow_runs::version_references(
                runs_root, &store, &p.id, p.version,
            )?;
            typed_domain::<WorkflowVersionReferencesResult>(
                store.version_references(&p.id, p.version, &runs)?,
            )?
        }
        method::WORKFLOW_VERSION_ARCHIVE => {
            let p: WorkflowVersionArchiveParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                p.confirm,
                "workflow_confirmation_required: version archival must be explicitly requested"
            );
            let runs = kcoder_tools::workflow_runs::version_references(
                runs_root, &store, &p.id, p.version,
            )?;
            typed_domain::<WorkflowVersionArchiveResult>(store.archive_version(
                &p.id,
                p.expected_revision,
                p.version,
                &runs,
            )?)?
        }
        method::WORKFLOW_HISTORY_READ => {
            let p: WorkflowVersionReferenceParams = serde_json::from_value(params)?;
            typed_domain::<WorkflowHistoricalVersionResult>(
                store.historical_version(&p.id, p.version)?,
            )?
        }
        method::WORKFLOW_DELETE => {
            let p: WorkflowDeleteParams = serde_json::from_value(params)?;
            store.delete(&p.id, p.expected_revision)?;
            serde_json::json!({ "deleted": true })
        }
        method::WORKFLOW_UPDATE => {
            let p: WorkflowUpdateParams = serde_json::from_value(params)?;
            serde_json::to_value(store.update_metadata(
                &p.id,
                p.expected_revision,
                &p.title,
                &p.description,
                p.input_schema,
            )?)?
        }
        method::WORKFLOW_VERSIONS => {
            let p: WorkflowReadParams = serde_json::from_value(params)?;
            serde_json::to_value(store.versions(&p.id)?)?
        }
        method::WORKFLOW_CLONE => {
            let p: WorkflowCloneParams = serde_json::from_value(params)?;
            serde_json::to_value(store.clone_workflow(&p.id, p.version, p.title.as_deref())?)?
        }
        method::WORKFLOW_EXPORT => {
            let p: WorkflowVersionParams = serde_json::from_value(params)?;
            serde_json::to_value(store.export(&p.id, p.version)?)?
        }
        method::WORKFLOW_IMPORT => {
            let p: WorkflowImportParams = serde_json::from_value(params)?;
            serde_json::to_value(store.import(p.definition)?)?
        }
        method::WORKFLOW_RUNS_ARCHIVE_PREVIEW => {
            let p: WorkflowRunArchivePreviewParams = serde_json::from_value(params)?;
            serde_json::to_value(kcoder_tools::workflow_runs::archive_preview(
                &runs_root, &store, &p.run_ids,
            )?)?
        }
        method::WORKFLOW_RUNS_ARCHIVE => {
            let p: WorkflowRunArchiveParams = serde_json::from_value(params)?;
            serde_json::to_value(kcoder_tools::workflow_runs::archive_runs(
                &runs_root,
                &store,
                &p.run_ids,
                &p.preview_token,
                p.confirm,
            )?)?
        }
        method::WORKFLOW_RUNS_ARCHIVE_READ => {
            let p: WorkflowRunReadParams = serde_json::from_value(params)?;
            serde_json::to_value(run_read_result(
                kcoder_tools::workflow_runs::read_archived(&runs_root, &p.run_id)?,
                &p,
            ))?
        }
        method::WORKFLOW_RUNS_LIST | method::WORKFLOW_RUNS_ARCHIVE_LIST => {
            let p: WorkflowRunsListParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                (1..=32).contains(&p.limit),
                "workflow_invalid: list limit must be 1–32"
            );
            let records = if method == method::WORKFLOW_RUNS_ARCHIVE_LIST {
                kcoder_tools::workflow_runs::list_archived(&runs_root)?
            } else {
                kcoder_tools::workflow_runs::list(runs_root)?
            };
            let all: Vec<_> = records
                .into_iter()
                .filter(|r| {
                    p.definition_id
                        .as_ref()
                        .is_none_or(|id| r.definition_id.as_ref() == Some(id))
                })
                .collect();
            let total = all.len();
            let items: Vec<_> = all
                .into_iter()
                .skip(p.offset)
                .take(p.limit)
                .map(|mut r| {
                    r.node_states.clear();
                    r
                })
                .collect();
            let end = p.offset.saturating_add(items.len());
            {
                let mut value = serde_json::json!({"items":items,"total":total});
                if end < total {
                    value["nextOffset"] = serde_json::json!(end);
                }
                value
            }
        }
        method::WORKFLOW_RUNS_READ => {
            let p: WorkflowRunReadParams = serde_json::from_value(params)?;
            serde_json::to_value(run_read_result(
                kcoder_tools::workflow_runs::read(runs_root, &p.run_id)?,
                &p,
            ))?
        }
        method::WORKFLOW_RUNS_OUTPUT => {
            let p: WorkflowRunOutputParams = serde_json::from_value(params)?;
            kcoder_tools::workflow_runs::output(
                runs_root, &p.run_id, &p.node_id, p.offset, p.limit,
            )?
        }
        method::WORKFLOW_LIST => {
            let p: WorkflowListParams = serde_json::from_value(params)?;
            serde_json::to_value(list_page(&store, p)?)?
        }
        method::WORKFLOW_CREATE => {
            let p: WorkflowCreateParams = serde_json::from_value(params)?;
            serde_json::to_value(store.create(&p.title, &p.description)?)?
        }
        method::WORKFLOW_READ => {
            let p: WorkflowReadParams = serde_json::from_value(params)?;
            serde_json::to_value(definition_read_result(store.read(&p.id)?, &p))?
        }
        method::WORKFLOW_SAVE => {
            let p: WorkflowSaveParams = serde_json::from_value(params)?;
            use kcoder_tools::AgentRunner;
            let draft = store.read(&p.id)?;
            kcoder_tools::workflow_draft::validate_workflow_agent_types(&draft)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let inspector = kcoder_engine::agent::QueryEngineAgentRunner::new(engine.clone());
            let checks =
                kcoder_tools::workflow_draft::validate_workflow_tool_contracts(&draft, |name| {
                    inspector.workflow_tool_contract(name)
                })
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            serde_json::to_value(store.save_with_tool_contracts(
                &p.id,
                p.expected_revision,
                Some(checks),
            )?)?
        }
        method::WORKFLOW_MOVE_NODE => {
            let p: WorkflowMoveNodeParams = serde_json::from_value(params)?;
            serde_json::to_value(store.move_node(
                &p.id,
                &p.node_id,
                p.expected_position,
                p.position,
            )?)?
        }
        method::WORKFLOW_REQUESTS => {
            let p: WorkflowRequestsParams = serde_json::from_value(params)?;
            kcoder_tools::workflow_interactions::page(&runs_root, &p.run_id, p.after.as_deref())?
        }
        method::WORKFLOW_RESPOND => {
            let p: WorkflowRespondParams = serde_json::from_value(params)?;
            kcoder_tools::workflow_interactions::respond(
                &runs_root,
                &p.run_id,
                &p.request_id,
                p.value,
            )?;
            serde_json::json!({"accepted":true})
        }
        method::WORKFLOW_UPSERT_NODE => {
            let p: WorkflowUpsertNodeParams = serde_json::from_value(params)?;
            serde_json::to_value(store.upsert_node(&p.id, p.expected_revision, p.node)?)?
        }
        method::WORKFLOW_REMOVE_NODE => {
            let p: WorkflowRemoveNodeParams = serde_json::from_value(params)?;
            serde_json::to_value(store.remove_node(&p.id, p.expected_revision, &p.node_id)?)?
        }
        _ => anyhow::bail!("Unknown workflow operation"),
    })
}

fn definition_read_result(
    snapshot: kcoder_types::workflow::WorkflowDefinition,
    params: &WorkflowReadParams,
) -> WorkflowDefinitionReadResult {
    if params.known_revision == Some(snapshot.revision)
        && params.known_updated_at_ms == Some(snapshot.updated_at_ms)
    {
        WorkflowDefinitionReadResult::Unchanged(WorkflowDefinitionUnchanged {
            unchanged: true,
            id: snapshot.id,
            revision: snapshot.revision,
            updated_at_ms: snapshot.updated_at_ms,
        })
    } else {
        WorkflowDefinitionReadResult::Snapshot(snapshot)
    }
}

fn run_read_result(
    snapshot: kcoder_types::workflow_runs::WorkflowRunSnapshot,
    params: &WorkflowRunReadParams,
) -> WorkflowRunReadResult {
    if params.known_revision == Some(snapshot.revision) {
        WorkflowRunReadResult::Unchanged(WorkflowRunUnchanged {
            unchanged: true,
            run_id: snapshot.run_id,
            revision: snapshot.revision,
        })
    } else {
        WorkflowRunReadResult::Snapshot(snapshot)
    }
}

fn list_page(store: &WorkflowStore, p: WorkflowListParams) -> Result<WorkflowListResult> {
    anyhow::ensure!(
        (1..=32).contains(&p.limit),
        "workflow_invalid: list limit must be 1–32"
    );
    let all = store.list()?;
    let total = all.len();
    let items: Vec<_> = all.into_iter().skip(p.offset).take(p.limit).collect();
    let end = p.offset.saturating_add(items.len());
    let next_offset = (end < total).then_some(end);
    Ok(WorkflowListResult {
        items,
        total,
        truncated: next_offset.is_some(),
        next_offset,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn list_pages_are_bounded_and_explicit_about_remaining_items() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        for i in 0..35 {
            store.create(&format!("Item {i}"), "").unwrap();
        }
        let first = list_page(
            &store,
            serde_json::from_value(serde_json::json!({})).unwrap(),
        )
        .unwrap();
        assert_eq!(first.items.len(), 32);
        assert_eq!(first.total, 35);
        assert!(first.truncated);
        assert_eq!(first.next_offset, Some(32));
        let last = list_page(
            &store,
            WorkflowListParams {
                offset: 32,
                limit: 32,
            },
        )
        .unwrap();
        assert_eq!(last.items.len(), 3);
        assert!(!last.truncated);
        assert!(last.next_offset.is_none());
        for limit in [0, 33] {
            assert!(list_page(&store, WorkflowListParams { offset: 0, limit }).is_err());
        }
    }
    #[test]
    fn conditional_definition_reads_include_same_revision_layout_changes() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let draft = store.create("Conditional", "").unwrap();
        let node: kcoder_types::workflow::WorkflowNode =
            serde_json::from_value(serde_json::json!({"id":"A"})).unwrap();
        let draft = store.upsert_node(&draft.id, draft.revision, node).unwrap();
        let p = WorkflowReadParams {
            id: draft.id.clone(),
            known_revision: Some(draft.revision),
            known_updated_at_ms: Some(draft.updated_at_ms),
        };
        assert!(matches!(
            definition_read_result(store.read(&p.id).unwrap(), &p),
            WorkflowDefinitionReadResult::Unchanged(_)
        ));
        let moved = store
            .move_node(
                &draft.id,
                "A",
                draft.nodes[0].position,
                kcoder_types::workflow::WorkflowPosition { x: 50., y: 80. },
            )
            .unwrap();
        assert_eq!(moved.revision, draft.revision);
        assert!(moved.updated_at_ms > draft.updated_at_ms);
        match definition_read_result(store.read(&p.id).unwrap(), &p) {
            WorkflowDefinitionReadResult::Snapshot(actual) => {
                assert_eq!(actual.nodes[0].position, moved.nodes[0].position)
            }
            _ => panic!("layout change cannot be represented as unchanged"),
        }
        let old = WorkflowReadParams {
            id: draft.id,
            known_revision: None,
            known_updated_at_ms: None,
        };
        assert!(matches!(
            definition_read_result(moved, &old),
            WorkflowDefinitionReadResult::Snapshot(_)
        ));
    }

    #[test]
    fn conditional_run_reads_are_compact_and_resume_returns_a_snapshot() {
        let mut snapshot: kcoder_types::workflow_runs::WorkflowRunSnapshot = serde_json::from_value(serde_json::json!({
            "revision":3,"runId":"run","definitionId":"flow","version":1,"threadId":"thread","workspace":"/owned",
            "status":"completed","startedAtMs":1,"updatedAtMs":2,"resumeCount":0,"nodeStates":[]
        })).unwrap();
        for i in 0..64 {
            snapshot.node_states.push(serde_json::from_value(serde_json::json!({"nodeId":format!("node-{i}"),"status":"completed","attempt":1,"reused":false,"outputPreview":"Recorded actual output"})).unwrap());
        }
        let full_bytes = serde_json::to_vec(&snapshot).unwrap().len();
        let p = WorkflowRunReadParams {
            run_id: snapshot.run_id.clone(),
            known_revision: Some(3),
        };
        let unchanged = serde_json::to_value(run_read_result(snapshot.clone(), &p)).unwrap();
        assert_eq!(
            unchanged,
            serde_json::json!({"unchanged":true,"runId":"run","revision":3})
        );
        let unchanged_bytes = serde_json::to_vec(&unchanged).unwrap().len();
        assert!(
            unchanged_bytes * 100 < full_bytes,
            "conditional bytes {unchanged_bytes}; full bytes {full_bytes}"
        );
        snapshot.revision += 1;
        snapshot.resume_count += 1;
        snapshot.status = "running".into();
        assert!(matches!(
            run_read_result(snapshot.clone(), &p),
            WorkflowRunReadResult::Snapshot(_)
        ));
        let old = WorkflowRunReadParams {
            run_id: snapshot.run_id.clone(),
            known_revision: None,
        };
        assert!(matches!(
            run_read_result(snapshot, &old),
            WorkflowRunReadResult::Snapshot(_)
        ));
    }
}
