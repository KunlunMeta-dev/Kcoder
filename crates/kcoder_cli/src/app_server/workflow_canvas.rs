//! Account-profile library operations, independent of per-session run artifacts.
use anyhow::{Context, Result};
use kcoder_app_protocol::*;
use kcoder_engine::QueryEngine;
use kcoder_workflow::store::WorkflowStore;
use serde_json::Value;
pub(super) fn request(engine: &QueryEngine, method: &str, params: Value) -> Result<Value> {
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
        method::WORKFLOW_RUNS_LIST => {
            let p: WorkflowRunsListParams = serde_json::from_value(params)?;
            anyhow::ensure!(
                (1..=32).contains(&p.limit),
                "workflow_invalid: list limit must be 1–32"
            );
            let all: Vec<_> = kcoder_tools::workflow_runs::list(runs_root)?
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
            serde_json::to_value(kcoder_tools::workflow_runs::read(runs_root, &p.run_id)?)?
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
            serde_json::to_value(store.read(&p.id)?)?
        }
        method::WORKFLOW_SAVE => {
            let p: WorkflowSaveParams = serde_json::from_value(params)?;
            kcoder_tools::workflow_draft::validate_workflow_agent_types(&store.read(&p.id)?)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            serde_json::to_value(store.save(&p.id, p.expected_revision)?)?
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
}
