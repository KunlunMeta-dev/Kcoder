//! Bounded data access, predicates, templates and local-only JSON Schema.
use anyhow::{Context, Result, bail, ensure};
use kcoder_types::workflow::*;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

pub const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_SCHEMA_BYTES: usize = 16 * 1024;
type CompiledSchemaCache = VecDeque<(String, Arc<jsonschema::Validator>)>;
static SCHEMAS: OnceLock<Mutex<CompiledSchemaCache>> = OnceLock::new();

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
    ensure!(
        schema.is_object() || schema.is_boolean(),
        "workflow_schema: expected a JSON Schema object or boolean, not a JSON-encoded string or array"
    );
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
            .map_err(|error| {
                anyhow::anyhow!(
                    "workflow_schema: invalid JSON Schema at {}: {}",
                    error.instance_path(),
                    error.to_string().chars().take(600).collect::<String>()
                )
            })?,
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
        let path = error.instance_path().to_string();
        let actual = value.pointer(&path).unwrap_or(value);
        let kind = match actual {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "number",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        };
        bail!(
            "workflow_schema: value does not match schema at {} (received {kind})",
            if path.is_empty() { "$" } else { &path }
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
/// Loop numeric comparisons must distinguish false from an unreadable operand.
/// Keep boolean short-circuiting so `exists` can guard optional fields.
pub fn loop_predicate(condition: &WorkflowPredicate, context: &Value) -> Result<bool> {
    use WorkflowPredicate::*;
    match condition {
        GreaterThan { pointer, value } | LessThan { pointer, value } => {
            let found = context.pointer(pointer).with_context(|| format!(
                "workflow_condition: until pointer {pointer} is missing; current iteration results are under /iteration/output"))?;
            let number = found.as_f64().with_context(|| format!(
                "workflow_condition: until pointer {pointer} must contain a JSON number; use outputSchema to validate structured iteration output"))?;
            Ok(if matches!(condition, GreaterThan { .. }) {
                number > *value
            } else {
                number < *value
            })
        }
        All { conditions } => {
            for condition in conditions {
                if !loop_predicate(condition, context)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Any { conditions } => {
            for condition in conditions {
                if loop_predicate(condition, context)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Not { condition } => Ok(!loop_predicate(condition, context)?),
        _ => Ok(predicate(condition, context)),
    }
}

pub(crate) fn validate_loop_output_access(
    condition: &WorkflowPredicate,
    node: &WorkflowNode,
) -> Result<()> {
    use WorkflowPredicate::*;
    match condition {
        All { conditions } | Any { conditions } => {
            for condition in conditions {
                validate_loop_output_access(condition, node)?;
            }
        }
        Not { condition } => validate_loop_output_access(condition, node)?,
        Exists { pointer }
        | Equals { pointer, .. }
        | NotEquals { pointer, .. }
        | Contains { pointer, .. }
        | GreaterThan { pointer, .. }
        | LessThan { pointer, .. } => {
            let parts: Vec<_> = pointer.split('/').collect();
            if parts.get(1) == Some(&"iteration") {
                ensure!(
                    parts.len() == 2 || matches!(parts[2], "index" | "item" | "output"),
                    "workflow_invalid: node {} iteration only exposes index, item, output; use /iteration/output/<field> instead of {pointer}",
                    node.id
                );
                ensure!(
                    parts.get(2) != Some(&"index") || parts.len() == 3,
                    "workflow_invalid: /iteration/index is a number, not an object"
                );
            }
            ensure!(
                !pointer.starts_with("/iteration/output/")
                    || node.config.output_schema.is_some()
                    || node
                        .config
                        .r#loop
                        .as_ref()
                        .is_some_and(|value| value.body.is_some()),
                "workflow_invalid: until reads a structured iteration result at {pointer}; configure outputSchema for each iteration response, otherwise output is text"
            );
        }
    }
    Ok(())
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
pub(crate) fn template_pointers(template: &str) -> Result<Vec<String>> {
    let mut pointers = Vec::new();
    template_parts(template, |pointer| {
        pointers.push(pointer.to_owned());
        Ok(String::new())
    })?;
    Ok(pointers)
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
        Code => &["code", "outputSchema"],
        Tool => &["tool", "outputSchema"],
        Subworkflow => &["subworkflow", "outputSchema"],
        Wait => &["wait"],
        Human => &["human"],
        Event => &["event"],
        Transform => &["transform", "outputSchema"],
        Input | Output => &["pointer"],
        Template => &["template"],
        Condition => &["condition"],
        Switch => &["switch"],
        Merge => &["mergePolicy"],
        Loop => &["loop", "outputSchema", "validationRetries"],
    };
    for key in serde_json::to_value(config)?.as_object().unwrap().keys() {
        ensure!(
            allowed.contains(&key.as_str())
                || matches!(
                    key.as_str(),
                    "failurePolicy" | "inputBindings" | "resultCheck" | "outputSchema"
                ),
            "workflow_invalid: configuration {key} is not applicable to node {}",
            node.id
        );
    }
    crate::node_contract::validate_config(node, complete)?;
    if let Some(policy) = &config.failure_policy {
        ensure!(
            (1..=3).contains(&policy.max_attempts) && policy.delay_ms <= 60_000,
            "workflow_invalid: failurePolicy maxAttempts must be 1–3 and delayMs <= 60000"
        );
        ensure!(
            policy.max_attempts == 1
                || matches!(
                    node.kind,
                    Code | Transform
                        | Tool
                        | Input
                        | Template
                        | Condition
                        | Switch
                        | Merge
                        | Output
                ),
            "workflow_invalid: automatic retries are limited to pure nodes and host-verified read-only tools; use resume for effectful work"
        );
    }
    if let Some(value) = &config.output_schema {
        schema(value)
            .map_err(|error| anyhow::anyhow!("node {} config.outputSchema: {error:#}", node.id))?;
    }
    ensure!(
        config.validation_retries == 0 || config.output_schema.is_some(),
        "workflow_invalid: validation retries require outputSchema"
    );
    if let Some(pointer) = &config.pointer {
        validate_pointer(pointer, node, false)?;
    }
    if let Some(template) = &config.template
        && (complete || !template.is_empty())
    {
        validate_template(template, node)?;
    }
    if let Some(condition) = &config.condition {
        validate_predicate(condition, node, false, 0)?;
    }
    if let Some(routes) = &config.switch {
        ensure!(
            !routes.cases.is_empty() && routes.cases.len() <= 16,
            "workflow_invalid: switch requires 1–16 cases"
        );
        let mut labels = std::collections::HashSet::new();
        for label in routes
            .cases
            .iter()
            .map(|case| &case.label)
            .chain(std::iter::once(&routes.default))
        {
            ensure!(
                !label.trim().is_empty() && label.len() <= 128 && !label.contains('\0'),
                "workflow_invalid: route labels must be non-empty and at most 128 bytes"
            );
            ensure!(
                labels.insert(label),
                "workflow_invalid: duplicate route label {label}"
            );
        }
        for case in &routes.cases {
            validate_predicate(&case.condition, node, false, 0)?;
        }
    }
    if let Some(loop_config) = &config.r#loop {
        ensure!(
            loop_config.body.is_none() || config.validation_retries == 0,
            "workflow_invalid: subgraph loops do not use agent validationRetries; configure validation inside the child graph"
        );
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
    if let Some(transform) = &config.transform {
        validate_pointer(&transform.source_pointer, node, false)
            .with_context(|| format!("node {} config.transform.sourcePointer", node.id))?;
        ensure!(
            transform.steps.len() <= 16,
            "workflow_invalid: transform has more than 16 steps"
        );
        let relative = |pointer: &str| -> Result<()> {
            ensure!(
                pointer.len() <= 4096 && (pointer.is_empty() || pointer.starts_with('/')),
                "workflow_invalid: expected a relative JSON pointer"
            );
            Ok(())
        };
        for (index, step) in transform.steps.iter().enumerate() {
            match step {
                WorkflowTransformStep::Map { fields } => {
                    ensure!(
                        fields.len() <= 64,
                        "workflow_invalid: mapping has more than 64 fields"
                    );
                    for (name, pointer) in fields {
                        ensure!(
                            !name.is_empty() && name.len() <= 256,
                            "workflow_invalid: invalid mapped field name"
                        );
                        relative(pointer).with_context(|| {
                            format!(
                                "node {} config.transform.steps[{index}].fields.{name}",
                                node.id
                            )
                        })?;
                    }
                }
                WorkflowTransformStep::Filter { condition } => {
                    validate_predicate(condition, node, false, 0)?
                }
                WorkflowTransformStep::Sort { pointer, .. } => {
                    relative(pointer).with_context(|| {
                        format!("node {} config.transform.steps[{index}].pointer", node.id)
                    })?
                }
                WorkflowTransformStep::Deduplicate { pointer } => {
                    if let Some(pointer) = pointer {
                        relative(pointer)?;
                    }
                }
                WorkflowTransformStep::Limit { count } => ensure!(
                    *count <= 10000,
                    "workflow_invalid: transform limit exceeds 10000"
                ),
            }
        }
    }
    if let Some(wait) = &config.wait {
        ensure!(
            wait.delay_ms.is_some() != wait.until_unix_ms.is_some(),
            "workflow_invalid: wait needs exactly one of delayMs or untilUnixMs"
        );
        ensure!(
            wait.delay_ms.is_none_or(|ms| ms <= 86_400_000),
            "workflow_invalid: wait delay exceeds 24 hours"
        );
        ensure!(
            wait.until_unix_ms
                .is_none_or(|ms| ms <= 9_007_199_254_740_991),
            "workflow_invalid: wait timestamp must be a safe integer"
        );
    }
    if let Some(human) = &config.human {
        ensure!(
            !human.prompt.trim().is_empty() && human.prompt.len() <= 8192,
            "workflow_invalid: human prompt is empty or too large"
        );
        ensure!(
            (1..=86_400_000).contains(&human.timeout_ms),
            "workflow_invalid: human timeoutMs must be 1–86400000"
        );
        validate_template(&human.prompt, node)?;
        schema(&human.response_schema)?;
    }
    if let Some(event) = &config.event {
        ensure!(
            !event.name.is_empty()
                && event.name.len() <= 128
                && !event.name.chars().any(char::is_control),
            "workflow_invalid: invalid event name"
        );
        ensure!(
            (1..=86_400_000).contains(&event.timeout_ms),
            "workflow_invalid: event timeoutMs must be 1–86400000"
        );
        schema(&event.payload_schema)?;
    }
    if let Some(child) = config
        .subworkflow
        .as_ref()
        .or_else(|| config.r#loop.as_ref().and_then(|value| value.body.as_ref()))
    {
        crate::graph::validate_id(&child.definition_id)?;
        ensure!(
            (1..=9_007_199_254_740_991).contains(&child.version),
            "workflow_invalid: subworkflow version must be a positive safe integer"
        );
        ensure!(
            child.arguments.is_object() && child.bindings.len() <= 64,
            "workflow_invalid: subworkflow arguments must be an object with at most 64 bindings"
        );
        bounded_value(&child.arguments, MAX_VALUE_BYTES)?;
        for (name, pointer) in &child.bindings {
            ensure!(
                !name.is_empty() && name.len() <= 256,
                "workflow_invalid: invalid subworkflow binding name"
            );
            validate_pointer(pointer, node, node.kind == WorkflowNodeKind::Loop)?;
        }
    }
    if let Some(tool) = &config.tool {
        ensure!(
            node.allowed_write_paths.is_empty(),
            "workflow_invalid: tool nodes inherit session write permissions; node allowedWritePaths is not supported"
        );
        ensure!(
            !tool.name.trim().is_empty()
                && tool.name.len() <= 256
                && !tool.name.chars().any(char::is_control),
            "workflow_invalid: tool node needs a valid tool name"
        );
        ensure!(
            tool.arguments.is_object() && tool.bindings.len() <= 64,
            "workflow_invalid: tool arguments must be an object with at most 64 bindings"
        );
        bounded_value(&tool.arguments, MAX_VALUE_BYTES)?;
        for (name, pointer) in &tool.bindings {
            ensure!(
                !name.is_empty() && name.len() <= 256,
                "workflow_invalid: invalid tool binding name"
            );
            validate_pointer(pointer, node, false)?;
        }
    }
    if let Some(code) = &config.code {
        ensure!(
            code.source.len() <= 64 * 1024,
            "workflow_invalid: code source exceeds 64 KiB"
        );
        ensure!(
            (1..=10_000).contains(&code.timeout_ms),
            "workflow_invalid: code timeoutMs must be 1–10000"
        );
    }
    if complete {
        if let Some(code) = &config.code {
            if config.input_bindings.is_empty() {
                crate::code_runtime::validate_source(&code.source)?;
            } else {
                crate::code_runtime::validate_bound_source(&code.source)?;
            }
        }
        match node.kind {
            Transform => ensure!(
                config.transform.is_some(),
                "workflow_invalid: transform node needs config.transform"
            ),
            Wait => ensure!(
                config.wait.is_some(),
                "workflow_invalid: wait node needs config.wait"
            ),
            Human => ensure!(
                config.human.is_some(),
                "workflow_invalid: human node needs config.human"
            ),
            Event => ensure!(
                config.event.is_some(),
                "workflow_invalid: event node needs config.event"
            ),
            Subworkflow => ensure!(
                config.subworkflow.is_some(),
                "workflow_invalid: subworkflow node needs config.subworkflow"
            ),
            Tool => ensure!(
                config.tool.is_some(),
                "workflow_invalid: tool node needs config.tool"
            ),
            Code => ensure!(
                config
                    .code
                    .as_ref()
                    .is_some_and(|code| !code.source.trim().is_empty()),
                "workflow_invalid: code node needs code.source"
            ),
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
            Switch => ensure!(
                config.switch.is_some(),
                "workflow_invalid: switch node needs cases and default route"
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
    fn schema_diagnostics_distinguish_serialized_strings_and_invalid_keywords() {
        for valid in [
            json!({}),
            json!({"type":"object"}),
            json!(true),
            json!(false),
        ] {
            assert!(schema(&valid).is_ok(), "{valid}");
        }
        let error = schema(&json!("{\"type\":\"object\"}"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("JSON-encoded string"));
        let error = schema(&json!({"type":"not-a-type"}))
            .unwrap_err()
            .to_string();
        assert!(error.contains("/type"), "{error}");
    }

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

#[cfg(test)]
mod loop_predicate_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numeric_operands_are_strict_but_optional_guards_short_circuit() {
        let greater: WorkflowPredicate = serde_json::from_value(
            json!({"op":"greater_than","pointer":"/iteration/output/score","value":52}),
        )
        .unwrap();
        for output in [json!({}), json!({"score":"54"}), json!({"score":null})] {
            assert!(loop_predicate(&greater, &json!({"iteration":{"output":output}})).is_err());
        }
        assert!(!loop_predicate(&greater, &json!({"iteration":{"output":{"score":52}}})).unwrap());
        assert!(loop_predicate(&greater, &json!({"iteration":{"output":{"score":54}}})).unwrap());
        let guarded: WorkflowPredicate = serde_json::from_value(json!({"op":"all","conditions":[
            {"op":"exists","pointer":"/iteration/output/score"},
            {"op":"greater_than","pointer":"/iteration/output/score","value":52}
        ]}))
        .unwrap();
        assert!(!loop_predicate(&guarded, &json!({"iteration":{"output":{}}})).unwrap());
        let negated = WorkflowPredicate::Not {
            condition: Box::new(greater),
        };
        assert!(loop_predicate(&negated, &json!({})).is_err());
    }
}
