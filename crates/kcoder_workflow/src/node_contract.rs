//! Required data bindings and bounded, model-independent result checks.
use anyhow::{Context, Result, ensure};
use kcoder_types::workflow::{
    WorkflowDefinition, WorkflowNode, WorkflowNodeKind, WorkflowPredicate, WorkflowTransformStep,
};
use serde_json::{Value, json};

pub(crate) fn validate_config(node: &WorkflowNode, complete: bool) -> Result<()> {
    ensure!(
        node.config.input_bindings.len() <= 64,
        "workflow_invalid: at most 64 inputBindings"
    );
    for (name, pointer) in &node.config.input_bindings {
        crate::graph::validate_id(name)?;
        crate::graph_data::validate_pointer(pointer, node, false)
            .with_context(|| format!("node {} config.inputBindings.{name}", node.id))?;
    }
    if let Some(check) = &node.config.result_check {
        ensure!(
            (1..=10_000).contains(&check.timeout_ms),
            "workflow_invalid: resultCheck timeoutMs must be 1–10000"
        );
        ensure!(
            check.source.len() <= 64 * 1024 && !check.source.trim().is_empty(),
            "workflow_invalid: resultCheck requires at most 64 KiB of JavaScript"
        );
        if complete {
            crate::code_runtime::validate_source(&check.source)
                .with_context(|| format!("node {} config.resultCheck", node.id))?;
        }
    }
    Ok(())
}

pub(crate) fn bind(node: &WorkflowNode, mut context: Value) -> Result<Value> {
    let mut bindings = serde_json::Map::new();
    for (name, pointer) in &node.config.input_bindings {
        let value = context.pointer(pointer).with_context(|| format!(
            "workflow_binding: node {} inputBindings.{name} cannot resolve {pointer}; dependency results have no implicit output wrapper", node.id
        ))?;
        bindings.insert(name.clone(), value.clone());
    }
    if !bindings.is_empty() {
        context["bindings"] = Value::Object(bindings);
    }
    Ok(context)
}

/// Enforce declared field contracts without guessing paths in arbitrary prose/JS.
pub(crate) fn validate_references(definition: &WorkflowDefinition) -> Result<()> {
    for node in &definition.nodes {
        if let Some(check) = &node.config.result_check {
            crate::code_runtime::validate_result_check(&check.source)
                .with_context(|| format!("node {} config.resultCheck", node.id))?;
        }
        for path in &node.allowed_write_paths {
            ensure!(
                !path.contains("${") && !path.contains("{{"),
                "workflow_binding: node {} allowedWritePaths are literal paths, not templates: {path}. Supply a concrete authorized scope relative to the execution workspace; do not invent interpolation or broaden scope to bypass a denial",
                node.id
            );
        }
        for pointer in node.config.input_bindings.values() {
            validate_reference(definition, pointer, true).with_context(|| {
                format!(
                    "workflow_binding: node {} inputBindings pointer {pointer}",
                    node.id
                )
            })?;
        }
        let mut pointers: Vec<&str> = Vec::new();
        pointers.extend(node.config.pointer.as_deref());
        if let Some(tool) = &node.config.tool {
            pointers.extend(tool.bindings.values().map(String::as_str));
        }
        if let Some(child) = &node.config.subworkflow {
            pointers.extend(child.bindings.values().map(String::as_str));
        }
        if let Some(transform) = &node.config.transform {
            pointers.push(&transform.source_pointer);
        }
        if let Some(condition) = &node.config.condition {
            collect_predicate(condition, &mut pointers);
        }
        if let Some(routes) = &node.config.switch {
            for route in &routes.cases {
                collect_predicate(&route.condition, &mut pointers);
            }
        }
        if let Some(config) = &node.config.r#loop {
            if let Some(pointer) = &config.collection_pointer {
                pointers.push(pointer);
            }
            if let Some(until) = &config.until {
                collect_predicate(until, &mut pointers);
            }
            if let Some(body) = &config.body {
                pointers.extend(body.bindings.values().map(String::as_str));
            }
        }
        if let Some(transform) = &node.config.transform {
            for step in &transform.steps {
                if let WorkflowTransformStep::Filter { condition } = step {
                    let mut filter_pointers = Vec::new();
                    collect_predicate(condition, &mut filter_pointers);
                    // Filter /input is the current item, not the graph input.
                    pointers.extend(
                        filter_pointers
                            .into_iter()
                            .filter(|p| p.starts_with("/nodes/")),
                    );
                }
            }
        }
        let template = node
            .config
            .template
            .as_deref()
            .or_else(|| node.config.human.as_ref().map(|h| h.prompt.as_str()));
        let template_pointers = template
            .map(crate::graph_data::template_pointers)
            .transpose()?
            .unwrap_or_default();
        pointers.extend(template_pointers.iter().map(String::as_str));
        for pointer in pointers {
            validate_reference(definition, pointer, false)
                .with_context(|| format!("workflow_binding: node {} pointer {pointer}", node.id))?;
        }
    }
    Ok(())
}

fn collect_predicate<'a>(predicate: &'a WorkflowPredicate, pointers: &mut Vec<&'a str>) {
    use WorkflowPredicate::*;
    match predicate {
        Exists { .. } => {} // Existence tests may intentionally probe absent fields.
        Equals { pointer, .. }
        | NotEquals { pointer, .. }
        | GreaterThan { pointer, .. }
        | LessThan { pointer, .. }
        | Contains { pointer, .. } => pointers.push(pointer),
        All { conditions } | Any { conditions } => {
            for condition in conditions {
                collect_predicate(condition, pointers);
            }
        }
        Not { condition } => collect_predicate(condition, pointers),
    }
}

fn validate_reference(
    definition: &WorkflowDefinition,
    pointer: &str,
    strict_declared: bool,
) -> Result<()> {
    let parts: Vec<String> = pointer
        .split('/')
        .skip(1)
        .map(|p| p.replace("~1", "/").replace("~0", "~"))
        .collect();
    let (schema, tail) = match parts.first().map(String::as_str) {
        Some("input") => (definition.input_schema.as_ref(), &parts[1..]),
        Some("nodes") if parts.len() >= 2 => {
            let source = definition
                .nodes
                .iter()
                .find(|n| n.id == parts[1])
                .context("unknown source node")?;
            if source.kind == WorkflowNodeKind::Loop {
                return Ok(());
            } // Iteration schema is not the aggregate schema.
            if source.kind == WorkflowNodeKind::Agent && source.config.output_schema.is_none() {
                ensure!(
                    parts.len() == 2,
                    "Agent output is text; declare outputSchema before reading fields"
                );
            }
            (source.config.output_schema.as_ref(), &parts[2..])
        }
        _ => return Ok(()),
    };
    if let Some(schema) = schema {
        if strict_declared {
            validate_schema_path(schema, tail)?;
        } else {
            validate_schema_path_policy(schema, tail, false)?;
        }
    }
    Ok(())
}

fn validate_schema_path(schema: &Value, parts: &[String]) -> Result<()> {
    validate_schema_path_policy(schema, parts, true)
}
fn validate_schema_path_policy(
    mut schema: &Value,
    parts: &[String],
    strict_declared: bool,
) -> Result<()> {
    for field in parts {
        // Recursive refs, unions and unconstrained objects are resolved by the
        // actual runtime binding, rather than inventing a schema interpretation.
        if ["$ref", "anyOf", "oneOf", "allOf"]
            .iter()
            .any(|key| schema.get(key).is_some())
        {
            return Ok(());
        }
        match schema.get("type").and_then(Value::as_str) {
            Some("array") => {
                ensure!(
                    field.parse::<usize>().is_ok(),
                    "array reference requires an index, received {field}"
                );
                let Some(items) = schema.get("items").filter(|v| v.is_object()) else {
                    return Ok(());
                };
                schema = items;
            }
            Some("string" | "number" | "integer" | "boolean" | "null") => {
                anyhow::bail!("cannot read field {field} from a scalar")
            }
            _ => {
                let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
                    return Ok(());
                };
                if let Some(next) = properties.get(field) {
                    schema = next;
                } else if let Some(extra) =
                    schema.get("additionalProperties").filter(|v| v.is_object())
                {
                    schema = extra;
                } else if schema.get("additionalProperties") == Some(&Value::Bool(true))
                    || (!strict_declared && schema.get("additionalProperties").is_none())
                {
                    return Ok(());
                } else {
                    anyhow::bail!(
                        "field {field} is not declared by the source schema; use the direct result or declare the real field (there is no implicit output wrapper)"
                    );
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn verification_summary(
    definition: &WorkflowDefinition,
    completed: &serde_json::Map<String, Value>,
) -> Value {
    let checked: Vec<_> = definition
        .nodes
        .iter()
        .filter(|node| node.config.result_check.is_some() && completed.contains_key(&node.id))
        .map(|node| &node.id)
        .collect();
    json!({"status":if checked.is_empty(){"not_requested"}else{"passed"},"scope":"configured_result_checks","checkedNodes":checked})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_pointer_fields_keep_json_schema_open_object_semantics() {
        let schema = json!({"type":"object","properties":{"known":{"type":"string"}}});
        assert!(validate_schema_path_policy(&schema, &["dynamic".into()], false).is_ok());
        assert!(validate_schema_path(&schema, &["dynamic".into()]).is_err());
        assert!(
            validate_schema_path_policy(
                &json!({"type":"object","properties":{},"additionalProperties":false}),
                &["dynamic".into()],
                false
            )
            .is_err()
        );
    }
    #[test]
    fn declared_fields_catch_phantom_output_but_preserve_real_output_fields() {
        let schema = json!({"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"}}}}}});
        assert!(validate_schema_path(&schema, &["output".into(), "rows".into()]).is_err());
        assert!(validate_schema_path(&schema, &["rows".into(), "0".into(), "name".into()]).is_ok());
        assert!(
            validate_schema_path(
                &json!({"type":"object","properties":{"output":schema}}),
                &["output".into(), "rows".into()]
            )
            .is_ok()
        );
        assert!(
            validate_schema_path(
                &json!({"type":"object","additionalProperties":true,"properties":{}}),
                &["dynamic".into()]
            )
            .is_ok()
        );
    }
}
