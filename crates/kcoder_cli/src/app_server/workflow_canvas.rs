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
    Ok(match method {
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
