//! Resolve immutable nested definitions before any node can produce effects.
use crate::AgentExecutor;
use anyhow::{Context, Result, ensure};
use kcoder_types::workflow::{WorkflowDefinition, WorkflowNodeKind, WorkflowStatus};
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) type Catalog = HashMap<(String, u64), WorkflowDefinition>;
pub(crate) async fn resolve(
    root: &WorkflowDefinition,
    host: &Arc<dyn AgentExecutor>,
) -> Result<Catalog> {
    let mut catalog = Catalog::new();
    let mut pending = vec![(
        root.clone(),
        vec![(root.id.clone(), root.saved_version.unwrap_or(0))],
    )];
    let mut visited = 0usize;
    while let Some((definition, ancestors)) = pending.pop() {
        for node in &definition.nodes {
            if node.kind == WorkflowNodeKind::Tool
                && node
                    .config
                    .failure_policy
                    .as_ref()
                    .is_some_and(|policy| policy.max_attempts > 1)
            {
                let tool = node
                    .config
                    .tool
                    .as_ref()
                    .context("workflow_tool: missing config")?;
                ensure!(
                    host.tool_is_read_only(&tool.name),
                    "workflow_tool: automatic retries require a host-verified read-only tool"
                );
            }
        }

        for node in definition.nodes.iter().filter(|n| {
            n.kind == WorkflowNodeKind::Subworkflow
                || n.config
                    .r#loop
                    .as_ref()
                    .is_some_and(|value| value.body.is_some())
        }) {
            visited += 1;
            ensure!(
                visited <= 256,
                "workflow_subworkflow: expanded reference limit is 256"
            );
            let child = node
                .config
                .subworkflow
                .as_ref()
                .or_else(|| {
                    node.config
                        .r#loop
                        .as_ref()
                        .and_then(|value| value.body.as_ref())
                })
                .context("workflow_subworkflow: missing config")?;
            let key = (child.definition_id.clone(), child.version);
            ensure!(
                ancestors.len() < 8,
                "workflow_subworkflow: maximum nesting depth is 8"
            );
            ensure!(
                !ancestors.contains(&key),
                "workflow_subworkflow: recursive version cycle"
            );
            if !catalog.contains_key(&key) {
                let resolved = host
                    .resolve_workflow(&key.0, key.1)
                    .await
                    .map_err(anyhow::Error::msg)
                    .with_context(|| {
                        format!("workflow_subworkflow: missing {}@{}", key.0, key.1)
                    })?;
                ensure!(
                    resolved.id == key.0
                        && resolved.saved_version == Some(key.1)
                        && resolved.status == WorkflowStatus::Saved,
                    "workflow_subworkflow: host returned a different or unpublished version"
                );
                crate::graph::validate(&resolved, true)?;
                catalog.insert(key.clone(), resolved);
            }
            let mut path = ancestors.clone();
            path.push(key.clone());
            pending.push((catalog[&key].clone(), path));
        }
    }
    Ok(catalog)
}
