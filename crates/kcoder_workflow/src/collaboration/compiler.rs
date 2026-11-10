use super::{contracts, validation};
use anyhow::{Result, ensure};
use kcoder_types::workflow::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const INPUT_ID: &str = "collaboration_input";
pub const CHECKS_ID: &str = "collaboration_checks";
pub const OUTPUT_ID: &str = "collaboration_output";
fn node(id: String, kind: WorkflowNodeKind, title: String) -> WorkflowNode {
    WorkflowNode {
        id,
        kind,
        title,
        config: Default::default(),
        run_if: None,
        prompt: String::new(),
        agent_type: "general".into(),
        max_turns: 5,
        depends_on: vec![],
        position: Default::default(),
        allowed_write_paths: vec![],
        acceptance_criteria: vec![],
        expected_artifacts: vec![],
    }
}
/// Produce an ordinary draft definition. Saving and running retain the existing
/// workflow store, immutable version, scheduler, checkpoints and native launch.
pub fn compile(
    base: &WorkflowDefinition,
    plan: &WorkflowCollaborationPlan,
) -> Result<WorkflowDefinition> {
    ensure!(
        base.nodes.is_empty(),
        "workflow_collaboration: initialize an empty draft; preserve existing workflow content"
    );
    ensure!(
        plan.version == 1 && (2..=12).contains(&plan.members.len()),
        "workflow_collaboration: version 1 requires 2–12 members"
    );
    ensure!(
        plan.input_schema.get("type").and_then(Value::as_str) == Some("object"),
        "workflow_collaboration: named input object schema required"
    );
    ensure!(
        plan.members
            .iter()
            .any(|member| member.role == WorkflowCollaborationRole::Verifier),
        "workflow_collaboration: an independent verifier role is required"
    );
    ensure!(
        plan.members
            .iter()
            .map(|member| member.artifact_requirements.len())
            .sum::<usize>()
            <= 32,
        "workflow_collaboration: at most 32 actual artifact declarations"
    );
    let mut next = base.clone();
    next.input_schema = Some(plan.input_schema.clone());
    let mut prepare = node(
        INPUT_ID.into(),
        WorkflowNodeKind::Code,
        "Validate task inputs".into(),
    );
    prepare.config.code = Some(WorkflowCodeConfig {
        source: "return input;".into(),
        timeout_ms: 1000,
    });
    prepare.config.output_schema = Some(plan.input_schema.clone());
    prepare.config.result_check = Some(WorkflowCodeConfig {
        source: "return JSON.stringify(result) === JSON.stringify(input);".into(),
        timeout_ms: 1000,
    });
    let mut roles = vec![];
    for member in &plan.members {
        crate::graph::validate_id(&member.id)?;
        ensure!(
            member.id.len() <= 48
                && !member.id.starts_with("collaboration_")
                && !member.id.starts_with("check_"),
            "workflow_collaboration: bounded nonreserved member IDs required"
        );
        ensure!(
            !member.instructions.trim().is_empty()
                && !member.title.trim().is_empty()
                && !member.input_bindings.is_empty(),
            "workflow_collaboration: explicit instructions and named input bindings required"
        );
        let mut role = node(
            member.id.clone(),
            WorkflowNodeKind::Agent,
            member.title.clone(),
        );
        role.prompt = format!(
            "{}\n\nUse only the explicitly supplied bindings. Complete your role without delegating more agents. If required information is missing, report the blocker to the parent; do not ask the user directly. Acceptance criteria are checks, not permission to change facts.",
            member.instructions
        );
        role.agent_type = member.role.agent_type().into();
        role.max_turns = member.max_turns;
        role.depends_on = member.depends_on.clone();
        role.allowed_write_paths = member.allowed_write_paths.clone();
        role.acceptance_criteria = member.acceptance_criteria.clone();
        role.expected_artifacts = member
            .artifact_requirements
            .iter()
            .map(|item| item.path.clone())
            .collect();
        role.config.model_selection = Some(member.model_selection.clone());
        role.config.input_bindings = member.input_bindings.clone();
        role.config.artifact_requirements = member.artifact_requirements.clone();
        role.config.output_schema = Some(member.output_schema.clone());
        role.config.result_check = Some(member.result_check.clone());
        role.config.collaboration_role = Some(WorkflowCollaborationRoleContract {
            version: 1,
            role: member.role,
        });
        validation::validate_node(&role)?;
        roles.push(role);
    }
    // The original DAG decides writer order, not declaration-array position.
    let order = validation::topological(&roles)?;
    let mut previous_writer: Option<String> = None;
    for id in order {
        let role = roles
            .iter_mut()
            .find(|role| role.id == id)
            .expect("topological ID belongs to the graph");
        if role
            .config
            .collaboration_role
            .as_ref()
            .is_some_and(|value| value.role.is_writer())
        {
            if let Some(previous) = &previous_writer
                && !role.depends_on.contains(previous)
            {
                role.depends_on.push(previous.clone());
            }
            previous_writer = Some(id);
        }
    }
    for role in &mut roles {
        role.depends_on.push(INPUT_ID.into());
    }
    let writer_ids: Vec<_> = roles
        .iter()
        .filter(|role| {
            role.config
                .collaboration_role
                .as_ref()
                .is_some_and(|value| value.role.is_writer())
        })
        .map(|role| role.id.clone())
        .collect();
    let mut checks = vec![];
    for role in &roles {
        for (index, artifact) in role.config.artifact_requirements.iter().enumerate() {
            contracts::relative_path(&artifact.path)?;
            let mut check = node(
                format!("check_{}_{}", role.id, index),
                WorkflowNodeKind::Tool,
                format!("Read back {}", artifact.path),
            );
            check.depends_on = writer_ids.clone();
            check.config.tool = Some(WorkflowToolConfig {
                name: "read".into(),
                arguments: json!({"file_path":artifact.path,"format":"raw"}),
                bindings: BTreeMap::new(),
            });
            let forbidden = serde_json::to_string(&artifact.forbidden_literals)?;
            check.config.result_check = Some(WorkflowCodeConfig {
                source: format!(
                    "if (result.isError !== false || !Array.isArray(result.content)) return false; const text = result.content.filter(item => item.type === 'text').map(item => item.text).join(''); return text.length > 0 && {forbidden}.every(value => !text.includes(value));"
                ),
                timeout_ms: 1000,
            });
            checks.push(check);
        }
    }
    let check_ids: Vec<_> = checks.iter().map(|check| check.id.clone()).collect();
    let mut merge = node(
        CHECKS_ID.into(),
        WorkflowNodeKind::Merge,
        "Independent file observations".into(),
    );
    merge.depends_on = if check_ids.is_empty() {
        vec![INPUT_ID.into()]
    } else {
        check_ids.clone()
    };
    merge.config.merge_policy = Some(WorkflowMergePolicy::All);
    for role in &mut roles {
        if role
            .config
            .collaboration_role
            .as_ref()
            .is_some_and(|value| value.role == WorkflowCollaborationRole::Verifier)
        {
            let check_dependency = CHECKS_ID.to_string();
            for dependency in writer_ids.iter().chain(std::iter::once(&check_dependency)) {
                if !role.depends_on.contains(dependency) {
                    role.depends_on.push(dependency.clone());
                }
            }
            role.config
                .input_bindings
                .insert("file_observations".into(), format!("/nodes/{CHECKS_ID}"));
        }
    }
    let ids: Vec<_> = roles.iter().map(|role| role.id.clone()).collect();
    let mut output = node(
        OUTPUT_ID.into(),
        WorkflowNodeKind::Code,
        "Collect checked collaboration results".into(),
    );
    output.depends_on = ids
        .iter()
        .cloned()
        .chain(std::iter::once(CHECKS_ID.into()))
        .collect();
    output.config.code = Some(WorkflowCodeConfig {
        source: format!(
            "const ids = {}; return {{ members: Object.fromEntries(ids.map(id => [id, nodes[id]])), fileObservations: nodes.{} }};",
            serde_json::to_string(&ids)?,
            CHECKS_ID
        ),
        timeout_ms: 1000,
    });
    output.config.result_check = Some(WorkflowCodeConfig {
        source: format!(
            "return result !== null && typeof result.members === 'object' && Object.keys(result.members).length === {};",
            ids.len()
        ),
        timeout_ms: 1000,
    });
    next.nodes = std::iter::once(prepare)
        .chain(roles)
        .chain(checks)
        .chain([merge, output])
        .collect();
    // Added verification edges can contradict an input DAG; reject before saving.
    let _ = validation::topological(&next.nodes)?;
    let all: BTreeSet<_> = next.nodes.iter().map(|node| node.id.as_str()).collect();
    ensure!(
        all.len() == next.nodes.len(),
        "workflow_collaboration: generated identity collision"
    );
    crate::graph::validate(&next, true)?;
    validation::validate_definition(&next)?;
    Ok(next)
}
