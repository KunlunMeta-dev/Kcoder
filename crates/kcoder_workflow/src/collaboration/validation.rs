use super::contracts;
use anyhow::{Result, ensure};
use kcoder_types::workflow::*;
use std::collections::{BTreeMap, BTreeSet};

pub fn validate_node(node: &WorkflowNode) -> Result<()> {
    if let Some(selection) = &node.config.model_selection {
        contracts::model(selection)?;
    }
    contracts::artifacts(&node.config.artifact_requirements)?;
    if let Some(contract) = &node.config.collaboration_role {
        ensure!(
            contract.version == 1
                && node.kind == WorkflowNodeKind::Agent
                && node.agent_type == contract.role.agent_type(),
            "workflow_collaboration: role must match the original executable agent kind"
        );
        ensure!(
            node.config.model_selection.is_some()
                && node.config.output_schema.is_some()
                && node.config.result_check.is_some()
                && !node.config.input_bindings.is_empty()
                && !node.acceptance_criteria.is_empty(),
            "workflow_collaboration: model, explicit inputs, output contract and independent checks are required"
        );
        if contract.role.is_writer() {
            ensure!(
                !node.allowed_write_paths.is_empty()
                    && !node.config.artifact_requirements.is_empty(),
                "workflow_collaboration: writers require concrete scopes and actual artifact checks"
            );
            for path in &node.allowed_write_paths {
                contracts::relative_path(path)?;
            }
            for artifact in &node.config.artifact_requirements {
                ensure!(
                    artifact.required
                        && artifact.require_changed
                        && artifact.min_bytes > 0
                        && contracts::inside(&artifact.path, &node.allowed_write_paths),
                    "workflow_collaboration: writer artifact must be required, changed and inside its declared scope"
                );
            }
        } else {
            ensure!(
                node.allowed_write_paths.is_empty() && node.config.artifact_requirements.is_empty(),
                "workflow_collaboration: read-only roles cannot declare write or production requirements"
            );
        }
    }
    Ok(())
}

pub(super) fn topological(nodes: &[WorkflowNode]) -> Result<Vec<String>> {
    let mut pending: BTreeMap<String, BTreeSet<String>> = nodes
        .iter()
        .map(|node| (node.id.clone(), node.depends_on.iter().cloned().collect()))
        .collect();
    ensure!(
        pending.len() == nodes.len(),
        "workflow_collaboration: duplicate member identity"
    );
    let ids: BTreeSet<_> = pending.keys().cloned().collect();
    ensure!(
        pending.values().all(|deps| deps.is_subset(&ids)),
        "workflow_collaboration: unknown dependency"
    );
    let mut order = vec![];
    while !pending.is_empty() {
        let ready = pending
            .iter()
            .find(|(_, deps)| deps.is_empty())
            .map(|(id, _)| id.clone());
        let Some(id) = ready else {
            anyhow::bail!("workflow_collaboration: cyclic dependencies");
        };
        pending.remove(&id);
        for deps in pending.values_mut() {
            deps.remove(&id);
        }
        order.push(id);
    }
    Ok(order)
}
fn ancestor(nodes: &[WorkflowNode], from: &str, target: &str) -> bool {
    let by_id: BTreeMap<_, _> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut pending = vec![from];
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id) {
            continue;
        }
        if id == target {
            return true;
        }
        if let Some(node) = by_id.get(id) {
            pending.extend(node.depends_on.iter().map(String::as_str));
        }
    }
    false
}
pub fn validate_definition(definition: &WorkflowDefinition) -> Result<()> {
    for node in &definition.nodes {
        validate_node(node)?;
    }
    let roles: Vec<_> = definition
        .nodes
        .iter()
        .filter(|node| node.config.collaboration_role.is_some())
        .collect();
    if roles.is_empty() {
        return Ok(());
    }
    let _ = topological(&definition.nodes)?;
    ensure!(
        definition.nodes.iter().all(|node| matches!(
            node.kind,
            WorkflowNodeKind::Agent
                | WorkflowNodeKind::Code
                | WorkflowNodeKind::Tool
                | WorkflowNodeKind::Input
                | WorkflowNodeKind::Output
                | WorkflowNodeKind::Merge
        )),
        "workflow_collaboration: nested/interactive graph nodes require a separate explicit workflow contract"
    );
    ensure!(
        definition
            .nodes
            .iter()
            .filter(|node| matches!(node.kind, WorkflowNodeKind::Agent | WorkflowNodeKind::Loop))
            .all(|node| node.config.collaboration_role.is_some()),
        "workflow_collaboration: every executable member needs its explicit role contract"
    );
    let writers: Vec<_> = roles
        .iter()
        .filter(|node| {
            node.config
                .collaboration_role
                .as_ref()
                .is_some_and(|role| role.role.is_writer())
        })
        .collect();
    for (index, left) in writers.iter().enumerate() {
        for right in &writers[index + 1..] {
            ensure!(
                ancestor(&definition.nodes, &left.id, &right.id)
                    || ancestor(&definition.nodes, &right.id, &left.id),
                "workflow_collaboration: write roles must be explicitly ordered; path strings do not prove disjoint filesystem identities"
            );
        }
    }
    for role in roles.iter().filter(|node| {
        node.config
            .collaboration_role
            .as_ref()
            .is_some_and(|role| role.role == WorkflowCollaborationRole::Verifier)
    }) {
        ensure!(
            writers
                .iter()
                .all(|writer| ancestor(&definition.nodes, &role.id, &writer.id)),
            "workflow_collaboration: independent verification must follow every writer"
        );
    }
    Ok(())
}
