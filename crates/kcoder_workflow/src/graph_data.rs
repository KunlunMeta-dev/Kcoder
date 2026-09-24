//! Bounded data access, predicates, templates and local-only JSON Schema.
use anyhow::{bail, ensure, Context, Result};
use kcoder_types::workflow::*;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

pub const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_SCHEMA_BYTES: usize = 16 * 1024;
static SCHEMAS: OnceLock<Mutex<VecDeque<(String, Arc<jsonschema::Validator>)>>> = OnceLock::new();

pub fn bounded_value(value: &Value, max: usize) -> Result<()> {
    ensure!(
        serde_json::to_vec(value)?.len() <= max,
        "workflow_quota: JSON value exceeds {max} bytes"
    );
    Ok(())
}
fn depth(value: &Value, level: usize, count: &mut usize) -> Result<()> {
    *count += 1;
    ensure!(
        level <= 16 && *count <= 2048,
        "workflow_schema: schema depth or element limit exceeded"
    );
    match value {
        Value::Object(map) => {
            for value in map.values() {
                depth(value, level + 1, count)?;
            }
        }
        Value::Array(items) => {
            for value in items {
                depth(value, level + 1, count)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn refs(
    schema: &Value,
    root: &Value,
    stack: &mut Vec<String>,
    level: usize,
    visited: &mut usize,
) -> Result<()> {
    *visited += 1;
    ensure!(
        *visited <= 4096,
        "workflow_schema: reference expansion budget exceeded"
    );
    ensure!(
        level <= 32,
        "workflow_schema: reference expansion exceeds limit"
    );
    let Some(map) = schema.as_object() else {
        return Ok(());
    };
    for key in ["$ref", "$dynamicRef", "$recursiveRef"] {
        if let Some(reference) = map.get(key) {
            let reference = reference
                .as_str()
                .context("workflow_schema: reference must be text")?;
            ensure!(
                reference.starts_with("#/"),
                "workflow_schema: only local JSON Pointer references are supported"
            );
            ensure!(
                !stack.iter().any(|item| item == reference),
                "workflow_schema: cyclic schema reference"
            );
            let target = root
                .pointer(&reference[1..])
                .context("workflow_schema: unresolved local reference")?;
            stack.push(reference.into());
            refs(target, root, stack, level + 1, visited)?;
            stack.pop();
        }
    }
    for key in [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "dependentSchemas",
        "dependencies",
    ] {
        if let Some(items) = map.get(key).and_then(Value::as_object) {
            for item in items.values() {
                if item.is_object() || item.is_boolean() {
                    refs(item, root, stack, level + 1, visited)?;
                }
            }
        }
    }
    for key in [
        "items",
        "additionalItems",
        "additionalProperties",
        "unevaluatedProperties",
        "unevaluatedItems",
        "contains",
        "propertyNames",
        "if",
        "then",
        "else",
        "not",
        "contentSchema",
    ] {
        if let Some(item) = map.get(key) {
            if let Some(items) = item.as_array() {
                for item in items {
                    refs(item, root, stack, level + 1, visited)?;
                }
            } else {
                refs(item, root, stack, level + 1, visited)?;
            }
        }
    }
    for key in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(items) = map.get(key).and_then(Value::as_array) {
            for item in items {
                refs(item, root, stack, level + 1, visited)?;
            }
        }
    }
    Ok(())
}
pub fn schema(schema: &Value) -> Result<Arc<jsonschema::Validator>> {
    bounded_value(schema, MAX_SCHEMA_BYTES)?;
    depth(schema, 0, &mut 0)?;
    refs(schema, schema, &mut Vec::new(), 0, &mut 0)?;
    let key = serde_json::to_string(schema)?;
    let cache = SCHEMAS.get_or_init(|| Mutex::new(VecDeque::new()));
    if let Some((_, validator)) = cache
        .lock()
        .map_err(|_| anyhow::anyhow!("workflow_schema: cache unavailable"))?
        .iter()
        .find(|(stored, _)| *stored == key)
    {
        return Ok(Arc::clone(validator));
    }
    let validator = Arc::new(
        jsonschema::options()
            .with_pattern_options(
                jsonschema::PatternOptions::regex()
                    .size_limit(262_144)
                    .dfa_size_limit(262_144),
            )
            .build(schema)
            .map_err(|_| anyhow::anyhow!("workflow_schema: invalid JSON Schema"))?,
    );
    let mut cache = cache
        .lock()
        .map_err(|_| anyhow::anyhow!("workflow_schema: cache unavailable"))?;
    if cache.len() >= 32 {
        cache.pop_front();
    }
    cache.push_back((key, Arc::clone(&validator)));
    Ok(validator)
}
pub fn validate_value(schema_value: &Value, value: &Value) -> Result<()> {
    bounded_value(value, MAX_VALUE_BYTES)?;
    let validator = schema(schema_value)?;
    if let Some(error) = validator.iter_errors(value).next() {
        bail!(
            "workflow_schema: value does not match schema at {}",
            error.instance_path()
        );
    }
    Ok(())
}

pub fn validate_pointer(pointer: &str, node: &WorkflowNode, iteration: bool) -> Result<()> {
    ensure!(
        pointer.len() <= 1024 && !pointer.contains('\0'),
        "workflow_invalid: pointer too long or invalid"
    );
    let parts: Vec<_> = pointer.split('/').collect();
    ensure!(
        parts.first() == Some(&"") && parts.len() >= 2,
        "workflow_invalid: use an absolute JSON Pointer"
    );
    for part in &parts {
        let mut chars = part.chars();
        while let Some(c) = chars.next() {
            if c == '~' {
                ensure!(
                    matches!(chars.next(), Some('0' | '1')),
                    "workflow_invalid: malformed JSON Pointer escape"
                );
            }
        }
    }
    match parts[1] {
        "input" => {}
        "nodes" => {
            if let Some(id) = parts.get(2) {
                ensure!(
                    node.depends_on.iter().any(|dep| dep == id),
                    "workflow_invalid: node {} pointer references a node outside dependsOn",
                    node.id
                );
            }
        }
        "iteration" if iteration => {}
        _ => bail!("workflow_invalid: pointer root must be input, nodes, or current iteration"),
    }
    Ok(())
}
pub fn validate_predicate(
    predicate: &WorkflowPredicate,
    node: &WorkflowNode,
    iteration: bool,
    level: usize,
) -> Result<()> {
    ensure!(
        level <= 8,
        "workflow_invalid: predicate nesting exceeds limit"
    );
    match predicate {
        WorkflowPredicate::All { conditions } | WorkflowPredicate::Any { conditions } => {
            ensure!(
                !conditions.is_empty() && conditions.len() <= 16,
                "workflow_invalid: predicates need 1–16 children"
            );
            for predicate in conditions {
                validate_predicate(predicate, node, iteration, level + 1)?;
            }
        }
        WorkflowPredicate::Not { condition } => {
            validate_predicate(condition, node, iteration, level + 1)?
        }
        WorkflowPredicate::Exists { pointer } => validate_pointer(pointer, node, iteration)?,
        WorkflowPredicate::Equals { pointer, value }
        | WorkflowPredicate::NotEquals { pointer, value }
        | WorkflowPredicate::Contains { pointer, value } => {
            validate_pointer(pointer, node, iteration)?;
            bounded_value(value, 1024)?;
        }
        WorkflowPredicate::GreaterThan { pointer, value }
        | WorkflowPredicate::LessThan { pointer, value } => {
            validate_pointer(pointer, node, iteration)?;
            ensure!(
                value.is_finite(),
                "workflow_invalid: non-finite predicate number"
            );
        }
    }
    Ok(())
}
pub fn predicate(predicate: &WorkflowPredicate, context: &Value) -> bool {
    match predicate {
        WorkflowPredicate::Exists { pointer } => context.pointer(pointer).is_some(),
        WorkflowPredicate::Equals { pointer, value } => {
            context.pointer(pointer).is_some_and(|found| found == value)
        }
        WorkflowPredicate::NotEquals { pointer, value } => {
            context.pointer(pointer).is_some_and(|found| found != value)
        }
        WorkflowPredicate::GreaterThan { pointer, value } => context
            .pointer(pointer)
            .and_then(Value::as_f64)
            .is_some_and(|found| found > *value),
        WorkflowPredicate::LessThan { pointer, value } => context
            .pointer(pointer)
            .and_then(Value::as_f64)
            .is_some_and(|found| found < *value),
        WorkflowPredicate::Contains { pointer, value } => {
            context.pointer(pointer).is_some_and(|found| {
                found.as_array().is_some_and(|items| items.contains(value))
                    || found
                        .as_str()
                        .zip(value.as_str())
                        .is_some_and(|(text, fragment)| text.contains(fragment))
            })
        }
        WorkflowPredicate::All { conditions } => {
            conditions.iter().all(|item| self::predicate(item, context))
        }
        WorkflowPredicate::Any { conditions } => {
            conditions.iter().any(|item| self::predicate(item, context))
        }
        WorkflowPredicate::Not { condition } => !self::predicate(condition, context),
    }
}
fn template_parts(
    template: &str,
    mut reference: impl FnMut(&str) -> Result<String>,
) -> Result<String> {
    let mut rest = template;
    let mut result = String::new();
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        let end = rest
            .find("}}")
            .context("workflow_invalid: unterminated template pointer")?;
        result.push_str(&reference(rest[..end].trim())?);
        rest = &rest[end + 2..];
        ensure!(
            result.len() <= MAX_VALUE_BYTES,
            "workflow_quota: template output too large"
        );
    }
    result.push_str(rest);
    ensure!(
        result.len() <= MAX_VALUE_BYTES,
        "workflow_quota: template output too large"
    );
    Ok(result)
}
pub fn validate_template(template: &str, node: &WorkflowNode) -> Result<()> {
    ensure!(
        !template.trim().is_empty() && template.len() <= 16 * 1024,
        "workflow_invalid: template must be non-empty and <=16 KiB"
    );
    template_parts(template, |pointer| {
        validate_pointer(pointer, node, false)?;
        Ok(String::new())
    })?;
    Ok(())
}
pub fn render_template(template: &str, context: &Value) -> Result<String> {
    template_parts(template, |pointer| {
        let value = context
            .pointer(pointer)
            .with_context(|| format!("workflow_input: missing pointer {pointer}"))?;
        Ok(value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string()))
    })
}

pub fn validate_node_config(node: &WorkflowNode, complete: bool) -> Result<()> {
    use WorkflowNodeKind::*;
    let config = &node.config;
    ensure!(
        config.validation_retries <= 2,
        "workflow_invalid: validationRetries must be 0–2"
    );
    let allowed: &[&str] = match node.kind {
        Agent => &["outputSchema", "validationRetries"],
        Input | Output => &["pointer"],
        Template => &["template"],
        Condition => &["condition"],
        Merge => &["mergePolicy"],
        Loop => &["loop", "outputSchema", "validationRetries"],
    };
    for key in serde_json::to_value(config)?.as_object().unwrap().keys() {
        ensure!(
            allowed.contains(&key.as_str()),
            "workflow_invalid: configuration {key} is not applicable to node {}",
            node.id
        );
    }
    if let Some(value) = &config.output_schema {
        schema(value)?;
    }
    ensure!(
        config.validation_retries == 0 || config.output_schema.is_some(),
        "workflow_invalid: validation retries require outputSchema"
    );
    if let Some(pointer) = &config.pointer {
        validate_pointer(pointer, node, false)?;
    }
    if let Some(template) = &config.template {
        if complete || !template.is_empty() {
            validate_template(template, node)?;
        }
    }
    if let Some(condition) = &config.condition {
        validate_predicate(condition, node, false, 0)?;
    }
    if let Some(loop_config) = &config.r#loop {
        ensure!(
            (1..=10).contains(&loop_config.max_iterations),
            "workflow_invalid: loop maxIterations must be 1–10"
        );
        if let Some(pointer) = &loop_config.collection_pointer {
            validate_pointer(pointer, node, false)?;
        }
        if let Some(until) = &loop_config.until {
            validate_predicate(until, node, true, 0)?;
        }
        if complete && loop_config.mode == WorkflowLoopMode::ForEach {
            ensure!(
                loop_config.collection_pointer.is_some(),
                "workflow_invalid: for_each needs collectionPointer"
            );
        }
    }
    if complete {
        match node.kind {
            Template => ensure!(
                config
                    .template
                    .as_ref()
                    .is_some_and(|text| !text.trim().is_empty()),
                "workflow_invalid: template node needs template"
            ),
            Condition => ensure!(
                config.condition.is_some(),
                "workflow_invalid: condition node needs predicate"
            ),
            Loop => ensure!(
                config.r#loop.is_some(),
                "workflow_invalid: loop node needs loop config"
            ),
            Merge => ensure!(
                !node.depends_on.is_empty(),
                "workflow_invalid: merge needs dependencies"
            ),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn schemas_reject_external_references_cycles_and_invalid_values() {
        assert!(schema(&json!({"$ref":"https://example.invalid/schema"})).is_err());
        assert!(schema(&json!({"$defs":{"a":{"$ref":"#/$defs/a"}},"$ref":"#/$defs/a"})).is_err());
        let local = json!({"$defs":{"x":{"type":"integer"}},"type":"object","properties":{"$ref":{"type":"string"},"n":{"$ref":"#/$defs/x"}},"required":["n"]});
        assert!(validate_value(&local, &json!({"n":1,"$ref":"literal data"})).is_ok());
        assert!(validate_value(&local, &json!({"n":"wrong"})).is_err());
    }
    #[test]
    fn pointers_templates_and_predicates_treat_input_as_data() {
        let context =
            json!({"input":{"name":"{{/nodes/private}}","null":null,"count":3},"nodes":{}});
        assert_eq!(
            render_template("Hello {{/input/name}}", &context).unwrap(),
            "Hello {{/nodes/private}}"
        );
        assert!(predicate(
            &WorkflowPredicate::Exists {
                pointer: "/input/null".into()
            },
            &context
        ));
        assert!(!predicate(
            &WorkflowPredicate::Exists {
                pointer: "/input/missing".into()
            },
            &context
        ));
        assert!(predicate(
            &WorkflowPredicate::GreaterThan {
                pointer: "/input/count".into(),
                value: 2.0
            },
            &context
        ));
    }
}
