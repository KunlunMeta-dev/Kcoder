//! Model-facing tool input schemas, coercion and validation.

#[path = "syntax/mod.rs"]
pub mod syntax;

#[path = "builtin/mod.rs"]
pub mod builtin;
#[path = "../../image_input.rs"]
pub mod image_input;
#[path = "../../semantic_coerce.rs"]
pub mod semantic_coerce;

use kcoder_tool_error::ToolError;
pub use semantic_coerce::{CoercionOptions, CoercionResult};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Parse and validate a tool's input JSON against its expected struct.
pub fn parse_input<T: DeserializeOwned>(input: &Value) -> Result<T, ToolError> {
    serde_json::from_value(input.clone())
        .map_err(|e| ToolError::InvalidInput(format!("invalid input: {}", e)))
}

// Shared with model-facing schema guidance so enrichment does not append a second policy.
pub const GLOB_PATH_GUIDANCE: &str = "Existing directory to search; pattern is relative to it. Omit only when cwd is the intended project. The default budget refuses filesystem/drive roots, the current user's home and Unix direct children of /; choose a concrete project/subdirectory such as C:/Users/Alice/project/src.";
pub const GLOB_BUDGET_GUIDANCE: &str = "Scan tiers: default (50,000 entries/2s/100 paths), expanded (500,000 entries/10s/500 paths), large (5,000,000 entries/30s/2,000 paths). Expanded/large require an explicit path that is neither cwd itself nor its ancestor. Prefer narrowing path; count mode has the same scope and budgets without a path-result cap.";

/// Maximum UTF-8 bytes accepted in a single `write` tool call.
///
/// This is intentionally a per-call limit, not a filesystem file-size limit.
/// Larger artifacts should be produced in smaller, reviewable steps rather
/// than passed through one huge tool input.
pub const MAX_WRITE_CONTENT_BYTES: usize = 512 * 1024;

/// Convert a schemars `RootSchema` into a clean JSON Schema object suitable for
/// the Anthropic Messages API.
pub fn clean_schema(schema: schemars::schema::RootSchema) -> Value {
    let mut value = serde_json::to_value(schema).unwrap();
    if let Value::Object(ref mut map) = value {
        map.remove("$schema");
        map.remove("title");
        map.remove("$id");
        // Reject properties that are not declared in the schema.
        map.entry("additionalProperties")
            .or_insert(Value::Bool(false));
        // Ollama renders tool definitions through Go chat templates that
        // iterate `.function.parameters.properties` (and sometimes
        // `.required`) without nil guards, so object roots must declare the
        // empty collections explicitly instead of omitting them.
        if is_object_root(map) {
            map.entry("properties")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            map.entry("required")
                .or_insert_with(|| Value::Array(Vec::new()));
        }
    }
    value
}

fn is_object_root(map: &serde_json::Map<String, Value>) -> bool {
    match map.get("type") {
        Some(Value::String(kind)) => kind == "object",
        Some(Value::Array(types)) => types.iter().any(|kind| kind.as_str() == Some("object")),
        _ => false,
    }
}

/// Coerce a raw JSON input value to better match its declared JSON schema.
///
/// Models (especially non-Anthropic providers) sometimes emit string literals
/// such as `"true"` or `"42"` for fields declared as boolean or integer.
/// This helper recursively walks the input and schema in parallel and converts
/// those string representations in place, reducing deserialization failures.
///
/// `schema` should be the root JSON Schema object, which may contain a
/// `definitions` section with `$ref` references (the default schemars output).
pub fn coerce_input(input: &mut Value, schema: &Value) {
    coerce_input_with_options(input, schema, &CoercionOptions::default());
}

pub fn coerce_input_with_options(input: &mut Value, schema: &Value, opts: &CoercionOptions) {
    coerce_value(input, schema, schema, opts);
}

/// Normalize known provider/model wrapper mistakes before schema validation.
///
/// This is intentionally narrow and tool-name based. It handles shapes that are
/// semantically unambiguous but otherwise cause repeated validation failures
/// before the tool implementation can recover.
pub fn normalize_tool_input(tool_name: &str, input: &mut Value) {
    if tool_name == "TodoWrite" {
        normalize_todo_write_input(input);
    }
    let Some(root) = input.as_object_mut() else {
        return;
    };
    match tool_name {
        "grep" => {
            if let Some(alias) = root.get("-C").cloned() {
                match root.get("context") {
                    None => {
                        root.insert("context".into(), alias);
                        root.remove("-C");
                    }
                    Some(canonical) if canonical == &alias => {
                        root.remove("-C");
                    }
                    // Preserve conflicting input for additionalProperties validation.
                    Some(_) => {}
                }
            }
        }
        "WebBrowser" if root.get("action").and_then(Value::as_str) == Some("screenshot") => {
            root.insert("action".into(), Value::String("snapshot".into()));
        }
        _ => {}
    }
}

fn normalize_todo_write_input(input: &mut Value) {
    let Some(root) = input.as_object_mut() else {
        return;
    };

    if root.contains_key("TodoList") {
        root.remove("todos");
    } else if let Some(todos) = root.remove("todos") {
        root.insert("TodoList".to_string(), todos);
    }

    let Some(todos) = root.get_mut("TodoList") else {
        return;
    };
    if todos.is_null() {
        return;
    }
    let Some(items) = todos.as_array_mut() else {
        return;
    };

    let original_items = std::mem::take(items);
    let had_original_items = !original_items.is_empty();
    let mut normalized = Vec::with_capacity(original_items.len());
    for item in original_items.iter().cloned() {
        let mut object = match item {
            Value::Object(object) => object,
            Value::String(content) => {
                let content = content.trim();
                if content.is_empty() {
                    continue;
                }
                serde_json::Map::from_iter([
                    ("content".to_string(), Value::String(content.to_string())),
                    ("activeForm".to_string(), Value::String(content.to_string())),
                    ("status".to_string(), Value::String("pending".to_string())),
                ])
            }
            other => {
                if !other.is_null() {
                    normalized.push(other);
                }
                continue;
            }
        };

        normalize_object_alias_field(&mut object, "activeForm", &["active_form"]);
        remove_null_unknown_fields(&mut object, &["content", "activeForm", "status"]);

        let content = stringish_field(&object, &["content"])
            .or_else(|| stringish_field(&object, &["activeForm"]));
        let Some(content) = content else {
            continue;
        };
        if field_missing_null_or_empty(&object, "content") {
            object.insert("content".to_string(), Value::String(content.clone()));
        }
        if field_missing_null_or_empty(&object, "activeForm") {
            object.insert("activeForm".to_string(), Value::String(content));
        }
        if field_missing_null_or_empty(&object, "status") {
            object.insert("status".to_string(), Value::String("pending".to_string()));
        }

        normalized.push(Value::Object(object));
    }
    if had_original_items && normalized.is_empty() {
        *items = original_items;
        return;
    }
    *items = normalized;
}

fn normalize_object_alias_field(
    object: &mut serde_json::Map<String, Value>,
    canonical: &str,
    aliases: &[&str],
) {
    if !object.contains_key(canonical) {
        if let Some((found_alias, value)) = aliases
            .iter()
            .find_map(|alias| object.remove(*alias).map(|value| (*alias, value)))
        {
            object.insert(canonical.to_string(), value);
            for alias in aliases {
                if *alias != found_alias {
                    object.remove(*alias);
                }
            }
        }
        return;
    }

    for alias in aliases {
        if object.get(*alias).is_some_and(Value::is_null) {
            object.remove(*alias);
        }
    }
}

fn remove_null_unknown_fields(object: &mut serde_json::Map<String, Value>, allowed: &[&str]) {
    object.retain(|key, value| !value.is_null() || allowed.contains(&key.as_str()));
}

fn field_missing_null_or_empty(object: &serde_json::Map<String, Value>, key: &str) -> bool {
    match object.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        Some(_) => false,
    }
}

fn stringish_field(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match object.get(*key) {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    })
}

fn resolve_schema<'a>(root: &'a Value, schema: &'a Value) -> &'a Value {
    if let Some(reference) = schema.get("$ref").and_then(|r| r.as_str())
        && let Some(name) = reference.strip_prefix("#/definitions/")
    {
        return root
            .get("definitions")
            .and_then(|d| d.get(name))
            .unwrap_or(schema);
    }
    schema
}

fn coerce_value(value: &mut Value, schema: &Value, root: &Value, opts: &CoercionOptions) {
    let schema = resolve_schema(root, schema);
    if let Some(options) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(|v| v.as_array())
    {
        if let Some(option) = select_union_coercion_schema(value, options, root) {
            coerce_value(value, option, root, opts);
        }
        return;
    }
    if let Some(options) = schema.get("allOf").and_then(|v| v.as_array()) {
        for option in options {
            coerce_value(value, resolve_schema(root, option), root, opts);
        }
        // allOf constraints supplement sibling properties; they do not replace
        // the root object's own field types.
    }

    let Some(typ) = schema_type_for_value(schema, value) else {
        // Without an explicit type there is nothing safe to coerce.
        return;
    };

    coerce_stringified_json(value, typ);
    coerce_enum_value(value, schema);

    match typ {
        "boolean" | "integer" | "number" | "string" => {
            if let CoercionResult::Value(coerced) = semantic_coerce::coerce_value(value, typ, opts)
            {
                *value = coerced;
            }
        }
        "array" => {
            if let Value::String(s) = value
                && let Some(items_schema) = schema.get("items")
                && let Some(arr) = string_as_array(s, items_schema, root)
            {
                *value = Value::Array(arr);
            }
            // Some providers/models return arrays as objects with numeric string keys.
            if let Value::Object(map) = value
                && schema.get("items").is_some()
            {
                if let Some(arr) = object_as_sequential_array(map) {
                    *value = Value::Array(arr);
                } else if let Some(arr) = object_as_wrapped_array(
                    map,
                    schema.get("items").expect("checked is_some"),
                    root,
                ) {
                    *value = Value::Array(arr);
                } else if let Some(arr) =
                    object_values_as_array(map, schema.get("items").expect("checked is_some"), root)
                {
                    *value = Value::Array(arr);
                } else if schema
                    .get("items")
                    .is_some_and(|items| schema_accepts_object(items, root))
                {
                    *value = Value::Array(vec![Value::Object(map.clone())]);
                }
            }
            if let (Value::Array(arr), Some(items_schema)) = (value, schema.get("items")) {
                let items_schema = resolve_schema(root, items_schema);
                for item in arr {
                    coerce_value(item, items_schema, root, opts);
                }
            }
        }
        "object" => {
            coerce_object(value, schema, root, opts);
        }
        _ => {}
    }
}

/// Select tagged object variants by their required literal fields (e.g. op),
/// rather than treating every object-shaped branch as interchangeable.
fn tagged_union_variant<'a>(
    value: &Value,
    options: &'a [Value],
    root: &'a Value,
) -> Option<&'a Value> {
    let object = value.as_object()?;
    let mut selected = None;
    for option in options {
        let option = resolve_schema(root, option);
        let Some(properties) = option.get("properties").and_then(Value::as_object) else {
            continue;
        };
        let required = option.get("required").and_then(Value::as_array);
        let mut matched = false;
        let mut mismatch = false;
        for (key, property) in properties {
            if !required
                .is_some_and(|fields| fields.iter().any(|field| field.as_str() == Some(key)))
            {
                continue;
            }
            let property = resolve_schema(root, property);
            let literal = property.get("const").or_else(|| {
                property
                    .get("enum")
                    .and_then(Value::as_array)
                    .filter(|items| items.len() == 1)
                    .and_then(|items| items.first())
            });
            if let Some(literal) = literal {
                if object.get(key) == Some(literal) {
                    matched = true;
                } else {
                    mismatch = true;
                }
            }
        }
        if matched && !mismatch {
            if selected.is_some() {
                return None;
            }
            selected = Some(option);
        }
    }
    selected
}

fn select_union_coercion_schema<'a>(
    value: &Value,
    options: &'a [Value],
    root: &'a Value,
) -> Option<&'a Value> {
    if let Some(selected) = tagged_union_variant(value, options, root) {
        return Some(selected);
    }
    // Prefer a branch that already accepts the JSON type. A string branch can
    // coerce numbers, but must not override a valid numeric/boolean alternative.
    for option in options {
        let option = resolve_schema(root, option);
        if schema_primary_type(option).is_some_and(|typ| json_value_matches_type(value, typ)) {
            return Some(option);
        }
    }
    let mut first_non_null = None;
    for option in options {
        let option = resolve_schema(root, option);
        if schema_primary_type(option) == Some("null") {
            continue;
        }
        if first_non_null.is_none() {
            first_non_null = Some(option);
        }
        if schema_matches_value_for_coercion(value, option, root) {
            return Some(option);
        }
    }
    first_non_null
}

fn schema_matches_value_for_coercion(value: &Value, schema: &Value, root: &Value) -> bool {
    let schema = resolve_schema(root, schema);
    if enum_schema_matches_value(value, schema) {
        return true;
    }
    match schema_primary_type(schema) {
        Some("object") => {
            value.is_object()
                || value
                    .as_str()
                    .is_some_and(|text| text.trim().starts_with('{'))
        }
        Some("array") => {
            value.is_array()
                || value.is_object()
                || value
                    .as_str()
                    .is_some_and(|text| text.trim().starts_with('['))
        }
        Some("boolean") => {
            value.is_boolean()
                || value.as_str().is_some_and(|text| {
                    matches!(text.trim().to_lowercase().as_str(), "true" | "false")
                })
        }
        Some("integer") => {
            value.as_i64().is_some()
                || value.as_u64().is_some()
                || value
                    .as_str()
                    .is_some_and(|text| text.trim().parse::<i64>().is_ok())
        }
        Some("number") => {
            value.is_number()
                || value
                    .as_str()
                    .is_some_and(|text| text.trim().parse::<f64>().is_ok())
        }
        Some("string") => value.is_string() || value.is_number() || value.is_boolean(),
        _ => false,
    }
}

fn enum_schema_matches_value(value: &Value, schema: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let Some(values) = schema.get("enum").and_then(|values| values.as_array()) else {
        return false;
    };
    let normalized = normalize_schema_token(text);
    values
        .iter()
        .filter_map(|value| value.as_str())
        .any(|candidate| normalize_schema_token(candidate) == normalized)
}

fn coerce_stringified_json(value: &mut Value, expected_type: &str) {
    if !matches!(expected_type, "object" | "array") {
        return;
    }
    let text = match value {
        Value::String(text) => text.trim().to_string(),
        _ => return,
    };
    let starts_with_expected = match expected_type {
        "object" => text.starts_with('{'),
        "array" => text.starts_with('['),
        _ => false,
    };
    if !starts_with_expected {
        return;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if json_value_matches_type(&parsed, expected_type) {
        *value = parsed;
    }
}

fn coerce_enum_value(value: &mut Value, schema: &Value) {
    let text = match value {
        Value::String(text) => text.clone(),
        _ => return,
    };
    let Some(values) = schema.get("enum").and_then(|values| values.as_array()) else {
        return;
    };
    let normalized = normalize_schema_token(&text);
    if normalized.is_empty() {
        return;
    }
    let mut matches = values
        .iter()
        .filter_map(|value| value.as_str())
        .filter(|candidate| normalize_schema_token(candidate) == normalized);
    let Some(candidate) = matches.next() else {
        return;
    };
    if matches.next().is_none() {
        *value = Value::String(enum_wire_value(candidate));
    }
}

fn enum_wire_value(candidate: &str) -> String {
    if candidate.chars().any(|ch| ch.is_ascii_uppercase()) {
        pascal_or_camel_to_snake_case(candidate)
    } else {
        candidate.to_string()
    }
}

fn schema_accepts_object(schema: &Value, root: &Value) -> bool {
    let schema = resolve_schema(root, schema);
    if let Some(options) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(|v| v.as_array())
    {
        return options
            .iter()
            .map(|option| resolve_schema(root, option))
            .any(|option| schema_accepts_object(option, root));
    }
    match schema.get("type") {
        Some(Value::String(typ)) => typ == "object",
        Some(Value::Array(types)) => types.iter().any(|typ| typ.as_str() == Some("object")),
        _ => schema.get("properties").is_some(),
    }
}

pub fn validate_input_against_schema(input: &Value, schema: &Value) -> Result<(), String> {
    validate_value(input, schema, schema, "$")
}

/// Build a compact, model-facing example input from a tool JSON schema.
///
/// The result is intentionally conservative: it prefers required properties,
/// follows `$ref`/union schemas, omits optional fields, honors supported bounds,
/// and returns None rather than guessing unsupported constraints. Placeholder
/// paths/text still require real task-specific values before execution.
pub fn example_input_for_schema(schema: &Value) -> Option<Value> {
    example_value_for_schema(schema, schema, None, 0, &mut 512)
}

/// Keep model-facing descriptions focused on behavior. JSON Schema already
/// supplies input types, required fields and array shapes; repeating them for
/// every tool adds request cost without adding a contract.
///
/// Retained as a compatibility entry point for model definition callers.
pub fn description_with_input_shape(description: &str, _schema: &Value) -> String {
    description.trim().to_string()
}

/// Return a clone of `schema` with richer parameter descriptions for the model.
///
/// The generated JSON Schema already captures the machine-readable shape. This
/// pass adds tool-specific behavior and constraints not expressed by types.
/// Generic JSON syntax is intentionally not repeated on each parameter. Validation
/// semantics are intentionally unchanged.
pub fn schema_with_parameter_guidance(tool_name: &str, schema: &Value) -> Value {
    let mut schema = schema.clone();
    enrich_schema_descriptions(tool_name, &mut schema, "$");
    schema
}

/// Inline local JSON Schema references for model-facing tool definitions.
///
/// Some provider compatibility layers do not fully resolve local `$ref`
/// targets inside tool schemas. Keep the execution schema unchanged, but send
/// models a self-contained shape so nested array item objects remain visible.
pub fn inline_local_schema_refs_for_model(schema: &Value) -> Value {
    let mut inlined = schema.clone();
    let mut budget = InlineSchemaBudget {
        nodes: 4096,
        added_bytes: 64 * 1024,
    };
    inline_local_refs_in_value(&mut inlined, schema, &mut Vec::new(), &mut budget, 0);
    let has_body_ref = inlined.as_object().is_some_and(|map| {
        map.iter()
            .filter(|(key, _)| !matches!(key.as_str(), "definitions" | "$defs"))
            .any(|(_, value)| schema_contains_ref(value))
    });
    if !has_body_ref && let Some(map) = inlined.as_object_mut() {
        map.remove("definitions");
        map.remove("$defs");
    }
    // Repeated rich subgraphs can cost more than the whole user context. Keep
    // the complete referenced schema when expansion adds substantial duplication.
    // Local references and their targets remain intact; no constraints are dropped.
    let source_bytes = serde_json::to_vec(schema).map_or(usize::MAX, |bytes| bytes.len());
    let expanded_bytes = serde_json::to_vec(&inlined).map_or(usize::MAX, |bytes| bytes.len());
    if expanded_bytes > source_bytes.saturating_add(4096) {
        schema.clone()
    } else {
        inlined
    }
}

struct InlineSchemaBudget {
    nodes: usize,
    added_bytes: usize,
}

// Approximate serialized size without allocating another serialized schema.
fn inline_schema_weight(value: &Value) -> usize {
    match value {
        Value::Object(map) => map.iter().fold(2usize, |n, (key, value)| {
            n.saturating_add(key.len())
                .saturating_add(4)
                .saturating_add(inline_schema_weight(value))
        }),
        Value::Array(values) => values.iter().fold(2usize, |n, value| {
            n.saturating_add(1)
                .saturating_add(inline_schema_weight(value))
        }),
        Value::String(value) => value.len().saturating_mul(6).saturating_add(2),
        _ => 24,
    }
}

fn inline_local_refs_in_value(
    value: &mut Value,
    root: &Value,
    refs: &mut Vec<String>,
    budget: &mut InlineSchemaBudget,
    depth: usize,
) {
    if depth > 32 || budget.nodes == 0 {
        return;
    }
    budget.nodes -= 1;
    if let Value::Object(map) = value
        && let Some(reference) = map.get("$ref").and_then(Value::as_str).map(str::to_owned)
    {
        if refs.contains(&reference) {
            return;
        }
        if let Some(target) = resolve_local_schema_ref(root, &reference) {
            let weight = inline_schema_weight(target);
            if weight > budget.added_bytes {
                return;
            }
            budget.added_bytes -= weight;
            let replacement = target.clone();
            let siblings = std::mem::take(map);
            *value = merge_schema_ref_siblings(replacement, siblings);
            refs.push(reference);
            // Visit the merged replacement once. Revisiting it after popping the
            // reference would expand recursive branches again.
            inline_local_refs_in_value(value, root, refs, budget, depth + 1);
            refs.pop();
            return;
        }
    }
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                // Keep the original reference targets intact. They remain necessary
                // whenever cycles or the expansion budget leave a reference behind.
                if depth == 0 && matches!(key.as_str(), "definitions" | "$defs") {
                    continue;
                }
                inline_local_refs_in_value(child, root, refs, budget, depth + 1);
            }
            if let Some(flattened) = flatten_single_all_of(map) {
                *value = flattened;
            }
        }
        Value::Array(values) => {
            for child in values {
                inline_local_refs_in_value(child, root, refs, budget, depth + 1);
            }
        }
        _ => {}
    }
}

fn resolve_local_schema_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    if pointer.is_empty() {
        return Some(root);
    }
    root.pointer(pointer)
}

fn merge_schema_ref_siblings(
    replacement: Value,
    siblings: serde_json::Map<String, Value>,
) -> Value {
    let Value::Object(mut replacement_map) = replacement else {
        return replacement;
    };

    for (key, sibling_value) in siblings {
        if key == "$ref" {
            continue;
        }
        match (replacement_map.get_mut(&key), sibling_value) {
            (Some(Value::String(existing)), Value::String(extra)) if key == "description" => {
                if !existing.contains(&extra) {
                    existing.push(' ');
                    existing.push_str(&extra);
                }
            }
            (_, value) => {
                replacement_map.insert(key, value);
            }
        }
    }

    Value::Object(replacement_map)
}

fn flatten_single_all_of(map: &mut serde_json::Map<String, Value>) -> Option<Value> {
    let options = map.get("allOf")?.as_array()?;
    if options.len() != 1 {
        return None;
    }
    let mut base = options[0].clone();
    let Value::Object(base_map) = &mut base else {
        return None;
    };

    let siblings = std::mem::take(map);
    for (key, value) in siblings {
        if key == "allOf" {
            continue;
        }
        match (base_map.get_mut(&key), value) {
            (Some(Value::String(existing)), Value::String(extra)) if key == "description" => {
                if !existing.contains(&extra) {
                    existing.push(' ');
                    existing.push_str(&extra);
                }
            }
            (_, sibling_value) => {
                base_map.insert(key, sibling_value);
            }
        }
    }

    Some(base)
}

fn schema_contains_ref(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.contains_key("$ref") || map.values().any(schema_contains_ref),
        Value::Array(values) => values.iter().any(schema_contains_ref),
        _ => false,
    }
}

fn enrich_schema_descriptions(tool_name: &str, schema: &mut Value, path: &str) {
    let Value::Object(map) = schema else {
        return;
    };

    if let Some(Value::Object(properties)) = map.get_mut("properties") {
        for (field, property_schema) in properties {
            let field_path = schema_child_path(path, field);
            if let Some(description) =
                specific_parameter_description(tool_name, field, property_schema, &field_path)
                    .or_else(|| {
                        property_schema
                            .get("description")
                            .is_none()
                            .then(|| generic_parameter_description(field))
                            .flatten()
                    })
            {
                if tool_owns_parameter_guidance(tool_name) {
                    replace_schema_description(property_schema, &description);
                } else {
                    merge_schema_description(property_schema, &description);
                }
            }
            enrich_schema_descriptions(tool_name, property_schema, &field_path);
        }
    }

    if let Some(Value::Object(definitions)) = map.get_mut("definitions") {
        for (name, definition) in definitions {
            enrich_schema_descriptions(
                tool_name,
                definition,
                &format!("{path}.definitions.{name}"),
            );
        }
    }

    if let Some(items) = map.get_mut("items") {
        enrich_schema_descriptions(tool_name, items, &format!("{path}[]"));
    }

    for keyword in ["anyOf", "oneOf", "allOf"] {
        if let Some(Value::Array(options)) = map.get_mut(keyword) {
            for (index, option) in options.iter_mut().enumerate() {
                enrich_schema_descriptions(
                    tool_name,
                    option,
                    &format!("{path}.{keyword}[{index}]"),
                );
            }
        }
    }
}

fn specific_parameter_description(
    tool_name: &str,
    field: &str,
    schema: &Value,
    path: &str,
) -> Option<String> {
    match (tool_name, field) {
        ("TodoWrite", "TodoList") | ("TodoWrite", "todos") => Some(
            "Complete replacement checklist: a real JSON array of todo objects including every still-relevant item, not just the changed one. Never `null`, placeholder strings or null-valued item fields. An empty list clears without claiming completion."
                .to_string(),
        ),
        ("TodoWrite", "content") => Some(
            "Concise imperative outcome, e.g. `Run focused tests`; non-null string."
                .to_string(),
        ),
        ("TodoWrite", "activeForm") | ("TodoWrite", "active_form") => Some(
            "Present-continuous form shown while in progress, e.g. `Running focused tests`; required, non-null string."
                .to_string(),
        ),
        ("TodoWrite", "status") => Some(
            "Exactly one non-null enum string."
                .to_string(),
        ),
        ("read", "file_path") => Some(
            "Absolute or workspace-relative file path; not a directory."
                .to_string(),
        ),
        ("read", "offset") => Some(
            "1-based start line for text and extracted Office text; omit for the default read or continue at the offset an Office read reports."
                .to_string(),
        ),
        ("read", "limit") => Some(
            "Maximum lines to return (JSON integer); omit for 2000 from the offset."
                .to_string(),
        ),
        ("read", "pages") => Some(
            "1-based PDF page range such as `1-5`, at most 20 pages; scanned pages render as images (at most 5 per call)."
                .to_string(),
        ),
        ("glob", "pattern") => Some(
            "Filesystem glob pattern for file names, such as `**/*.rs`, `src/**/*.ts`, or `*.test.{ts,tsx}`. This is not a content search."
                .to_string(),
        ),
        ("glob", "path") => Some(GLOB_PATH_GUIDANCE.to_string()),
        ("glob", "limit") => Some(
            "Positive path limit up to the tier cap (100/500/2000); omit for 100. Ignored in count mode; does not raise scan_budget."
                .to_string(),
        ),
        ("glob", "output_mode") => Some(
            "`paths` (default, bounded list) or `count` (only `matched_files` plus `complete`)."
                .to_string(),
        ),
        ("glob", "scan_budget") => Some(GLOB_BUDGET_GUIDANCE.to_string()),
        ("grep", "pattern") => Some(
            "Ripgrep regular expression for file contents; a leading `-` is passed safely as a pattern, not a flag."
                .to_string(),
        ),
        ("grep", "path") => Some(
            "Existing file or project/subdirectory; omit only when cwd is the intended project. A small head_limit does not make a broad scan cheap."
                .to_string(),
        ),
        ("grep", "glob") => Some(
            "File glob filter such as `*.rs` or `*.{ts,tsx}`; several simple patterns may be separated by spaces or commas."
                .to_string(),
        ),
        ("grep", "output_mode") => Some(
            "`files_with_matches` (default, paths), `content` (matching lines with optional context) or `count` (per-file counts plus an exact aggregate; rows may be paginated)."
                .to_string(),
        ),
        ("grep", "-B") => Some(
            "Content mode: lines before each match."
                .to_string(),
        ),
        ("grep", "-A") => Some(
            "Content mode: lines after each match."
                .to_string(),
        ),
        ("grep", "-C") | ("grep", "context") => Some(
            "Content mode: lines before and after each match; overrides -A/-B."
                .to_string(),
        ),
        ("grep", "-n") => Some(
            "Content mode: show line numbers (default true)."
                .to_string(),
        ),
        ("grep", "-i") => Some(
            "Case-insensitive search."
                .to_string(),
        ),
        ("grep", "type") => Some(
            "Ripgrep file type such as `rust`, `ts` or `py`; usually cheaper than a broad glob."
                .to_string(),
        ),
        ("grep", "head_limit") => Some(
            "Displayed lines/entries, 1..=10000 (default 250; zero is rejected). It does not bound scan cost; count totals include all matches."
                .to_string(),
        ),
        ("grep", "offset") => Some(
            "Output lines/entries to skip before head_limit, for paging a truncated result."
                .to_string(),
        ),
        ("grep", "multiline") => Some(
            "Only for patterns that must span lines; slower."
                .to_string(),
        ),
        ("bash", "command") => Some(
            "Unix shell command to execute in the current working directory. Pass the exact command text. Do not prefix with `cd`; use paths relative to the session cwd or absolute paths. Prefer specialized file tools when attached; otherwise keep shell file operations bounded and within permissions. Quote file paths that contain spaces."
                .to_string(),
        ),
        ("bash", "description") => Some(
            "Clear, concise active-voice description of what the command does, usually 5-10 words for simple commands. Do not write vague labels like `complex command`."
                .to_string(),
        ),
        ("bash", "timeout") => Some(
            "Total command lifetime timeout in milliseconds. Defaults to the session tool_timeout_ms value, which is 300000 (300 seconds) by default. This is separate from the foreground blocking budget: a command still running at that budget is moved to a background task without resetting its total command lifetime. Use a JSON integer."
                .to_string(),
        ),
        ("bash", "run_in_background") => Some(
            "JSON boolean. A persistent server or watcher that must survive the Bash response must set this to true and provide an explicit total lifetime with `timeout`, even when no other work is ready yet. Keep the command in foreground form. Do not append `&`, use `nohup`/`setsid`/`disown`, or check output immediately unless needed; do not poll with `sleep`."
                .to_string(),
        ),
        ("review", "preview") => Some(
            "JSON boolean. Set true first on large diffs to inspect the review scope without calling the OCR LLM."
                .to_string(),
        ),
        ("review", "foregroundTimeoutSeconds") | ("review", "foreground_timeout_seconds") => Some(
            "Seconds to keep OCR in the foreground before KCoder moves the still-running review to a background task. Defaults to 60. Inspect the returned task_id through an attached managed-output control."
                .to_string(),
        ),
        ("review", "timeoutMinutes") | ("review", "timeout_minutes") => Some(
            "OCR per-file task timeout in minutes, also used to bound the wrapper wall timeout. This is not the foreground progress timeout."
                .to_string(),
        ),
        ("PowerShell", "command") => Some(
            "PowerShell command to execute in the current working directory. Pass the exact command text. Do not prefix with `cd` or `Set-Location`; use paths relative to the session cwd or absolute paths. Prefer specialized file tools when attached; otherwise keep shell file operations bounded and within permissions. Quote paths with spaces using double quotes."
                .to_string(),
        ),
        ("PowerShell", "description") => Some(
            "Clear, concise active-voice description of what the PowerShell command does."
                .to_string(),
        ),
        ("PowerShell", "timeout") => Some(
            "Optional timeout in milliseconds. Defaults to the session tool_timeout_ms value, which is 300000 (300 seconds) by default. There is no global hard maximum; use run_in_background for long-running commands. Use a JSON integer."
                .to_string(),
        ),
        ("PowerShell", "run_in_background") => Some(
            "JSON boolean. Set true only for long-running commands when you can continue useful work before checking managed output. Do not wrap with Start-Job, do not poll with Start-Sleep, and do not check output immediately unless you need it."
                .to_string(),
        ),
        ("write", "content") => Some(format!(
            "Complete file content, at most {} KiB / {} UTF-8 bytes per call.",
            MAX_WRITE_CONTENT_BYTES / 1024,
            MAX_WRITE_CONTENT_BYTES
        )),
        ("edit", "old_string") => Some(
            "Exact current text to replace, copied from Read output without the line-number prefix and with whitespace preserved; must be unique unless replace_all=true."
                .to_string(),
        ),
        ("edit", "new_string") => Some(
            "Replacement text; empty only to delete the match."
                .to_string(),
        ),
        ("edit", "replace_all") => Some(
            "Replace every occurrence (deliberate rename); omit for one unique match."
                .to_string(),
        ),
        ("TaskUpdate", "addBlocks") | ("TaskUpdate", "add_blocks") => Some(
            "Task IDs this task blocks (JSON array of strings)."
                .to_string(),
        ),
        ("TaskUpdate", "addBlockedBy") | ("TaskUpdate", "add_blocked_by") => Some(
            "Task IDs that block this task (JSON array of strings)."
                .to_string(),
        ),
        ("TaskOutput", "block") => Some(
            "Wait for completion only when the result is on the current critical path; false performs a non-blocking status/output check."
                .to_string(),
        ),
        ("TaskOutput", "timeout") => Some(
            "Maximum wait in milliseconds when block=true (default 5000, bounded by tool_limits.task_output_timeout_ms)."
                .to_string(),
        ),
        ("Sleep", "duration_seconds") => Some(
            "Seconds to wait (JSON number); interruptible by the user and by background task completion."
                .to_string(),
        ),
        ("Snip", "message_ids") => Some(
            "JSON array of `msg-N` or `N` strings (1-based conversation index); not a single string."
                .to_string(),
        ),
        ("Snip", "reason") => Some(
            "Summary kept in place of the snipped messages; preserve key paths, decisions, errors and outcomes."
                .to_string(),
        ),
        ("memory_search", "scope") => Some(
            "Choose `observations`, `summaries`, or `both` (default). Observation-only filters such as concepts/files do not affect summaries; session_id affects summaries only."
                .to_string(),
        ),
        ("memory_get", "before") | ("memory_get", "after") => Some(
            "Optional non-negative timeline radius for one observation id. Supplying either field switches memory_get from exact lookup to same-session timeline mode; do not combine with ids or kind=summary."
                .to_string(),
        ),
        ("skill", "skill") => Some(
            "Exact registered skill name, including `namespace:name` when listed; a leading slash is accepted."
                .to_string(),
        ),
        ("skill", "args") => Some(
            "Optional argument string, e.g. `123 --strict`; legacy `arguments` arrays are still accepted."
                .to_string(),
        ),
        ("DiscoverSkills", "description") => Some(
            "Concrete task with workflow, technology or artifact details, e.g. `review a pull request for correctness` rather than `review`."
                .to_string(),
        ),
        ("DiscoverSkills", "limit") => Some(
            "Result count (default 5; values above 20 are capped)."
                .to_string(),
        ),
        ("CtxInspect", "query") => Some(
            "Optional text filter for context entries. Omit for an overall token/message/collapse summary; provide a short term only when investigating a specific topic."
                .to_string(),
        ),
        ("ExitPlanMode", "plan") => Some(
            "Optional plan content. Prefer writing the plan to the plan file and passing planFilePath when that workflow is active; keep this field for compatibility or edited-plan flows."
                .to_string(),
        ),
        ("ExitPlanMode", "planFilePath") | ("ExitPlanMode", "plan_file_path") => Some(
            "Optional path to the plan file. If plan is omitted, ExitPlanMode reads this file and presents its contents. Relative paths are interpreted by the process, so prefer an absolute path."
                .to_string(),
        ),
        ("ExitPlanMode", "allowedPrompts") | ("ExitPlanMode", "allowed_prompts") => Some(
            "Optional semantic permissions needed by the approved plan. Must be a JSON array like [{\"tool\":\"Bash\",\"prompt\":\"run tests\"}]; omit unless the plan needs broad command categories."
                .to_string(),
        ),
        ("ExitPlanMode", "tool") => Some(
            "Tool name for a semantic permission, currently usually `Bash`."
                .to_string(),
        ),
        ("ExitPlanMode", "prompt") => Some(
            "Semantic action category for the permission, e.g. `run tests`, `install dependencies`, or `start the dev server`."
                .to_string(),
        ),
        ("EnterWorktree", "path") => Some(
            "Optional existing git worktree path. Use this only when the user gave or asked for a specific existing worktree. Omit when creating a managed worktree by name."
                .to_string(),
        ),
        ("EnterWorktree", "name") => Some(
            "Optional managed worktree name. Use only when the user explicitly asks for a worktree. Each `/`-separated segment may contain letters, digits, dots, underscores, and dashes; max 64 chars. Omit for an auto-generated session name."
                .to_string(),
        ),
        ("ExitWorktree", "action") => Some(
            "Required for the upstream-style flow: `keep` preserves the worktree and branch; `remove` deletes only a managed EnterWorktree session after safety checks. Omit only for legacy keep behavior."
                .to_string(),
        ),
        ("ExitWorktree", "discard_changes") | ("ExitWorktree", "discardChanges") => Some(
            "JSON boolean. With action `remove`, set true only after confirming it is acceptable to discard uncommitted files or commits; otherwise omit/false so the tool can fail closed with details."
                .to_string(),
        ),
        ("LocalMemoryRecall", "action") => Some(
            "Action enum string. Use `list_stores` first when unsure, `list_entries` with a store to see keys, and `fetch` with store+key to read a note."
                .to_string(),
        ),
        ("LocalMemoryRecall", "store") => Some(
            "Local-memory store name. Required for `list_entries` and `fetch`. It may contain spaces or Unicode, but must be a portable path component: no leading dot, trailing dot/space, reserved Windows device name, control character, or platform separator/forbidden character."
                .to_string(),
        ),
        ("LocalMemoryRecall", "key") => Some(
            "Entry key for `fetch`. Required only with action `fetch`; must match `[A-Za-z0-9._-]{1,128}`, must not end in `.`, and must not be a reserved Windows device name."
                .to_string(),
        ),
        ("LocalMemoryRecall", "preview_only") => Some(
            "JSON boolean. Omit or true for the default 2 KiB preview. Set false only when the full note is needed; full fetches are capped at 50 KiB and share a 100 KiB per-turn budget."
                .to_string(),
        ),
        ("TaskCreate", "subject") => Some(
            "Brief imperative title, e.g. `Run focused tests`; check the task list first when duplicates are possible."
                .to_string(),
        ),
        ("TaskCreate", "description") => Some(
            "What needs to be done and why, detailed enough for another agent or a later turn."
                .to_string(),
        ),
        ("TaskCreate", "activeForm") | ("TaskCreate", "active_form") => Some(
            "Present-continuous spinner text while in progress, e.g. `Running focused tests`."
                .to_string(),
        ),
        ("TaskUpdate", "taskId") | ("TaskUpdate", "task_id") => Some(
            "Existing task ID."
                .to_string(),
        ),
        ("TaskUpdate", "status") => Some(
            "New status; completed only after the work is fully done and verified, deleted only for obsolete or erroneous tasks."
                .to_string(),
        ),
        ("TaskUpdate", "subject") => Some(
            "Replacement title, only when the current one is unclear or requirements changed."
                .to_string(),
        ),
        ("TaskUpdate", "description") => Some(
            "Replacement details; keep unresolved blockers visible."
                .to_string(),
        ),
        ("TaskUpdate", "activeForm") | ("TaskUpdate", "active_form") => Some(
            "Replacement present-continuous spinner text."
                .to_string(),
        ),
        ("TaskUpdate", "owner") => Some(
            "Owner or agent identifier, to claim or assign the task."
                .to_string(),
        ),
        ("TaskUpdate", "metadata") | ("TaskCreate", "metadata") => Some(
            "Metadata object to merge; in TaskUpdate a null value deletes that key."
                .to_string(),
        ),
        ("TaskList", "taskId") | ("TaskGet", "taskId") | ("TaskGet", "task_id") => Some(
            "Exact task ID from the task list or a create result."
                .to_string(),
        ),
        ("TaskStop", "task_id") => Some(
            "ID of the running background task to stop."
                .to_string(),
        ),
        ("TaskStop", "shell_id") => Some(
            "Deprecated alias for task_id kept for old transcripts."
                .to_string(),
        ),
        _ => {
            if tool_name.starts_with("Spec") {
                spec_parameter_description(field, schema, path)
            } else {
                None
            }
        }
    }
}

fn spec_parameter_description(field: &str, _schema: &Value, _path: &str) -> Option<String> {
    match field {
        "name" => Some(
            "Spec change name. Use the exact kebab-case directory name under `.kcoder/specs/changes/`."
                .to_string(),
        ),
        "change" => Some(
            "Optional spec change name. Omit only when exactly one active change exists and that default is intended."
                .to_string(),
        ),
        "title" => Some(
            "Optional human-readable title for the change; keep it short and descriptive."
                .to_string(),
        ),
        "base_sha" => Some(
            "Optional git base SHA or ref for diff/review context. Omit to use the tool's default base selection."
                .to_string(),
        ),
        "max_turns" => Some(
            "Maximum reviewer/planner sub-agent turns. Use a JSON integer; omit for the default unless the review is unusually broad. Explicit values are clamped into the stated minimum..maximum range."
                .to_string(),
        ),
        "key" => Some(
            "Config key path, e.g. `schema`, `context`, `precheck`, or `rules.<artifact>`."
                .to_string(),
        ),
        "value" => Some(
            "YAML value to write for the config key. For `rules.<artifact>`, provide a YAML list of strings."
                .to_string(),
        ),
        _ => None,
    }
}

fn generic_parameter_description(field: &str) -> Option<String> {
    let description = match field {
        "file_path" => {
            "Path to the target file. Prefer an absolute path; workspace-relative paths are resolved against the current working directory."
        }
        "path" => {
            "Filesystem path. Prefer an absolute path; relative paths are resolved against the current working directory."
        }
        "command" | "cmd" => {
            "Command text to execute. Pass exactly the command/script string, not a JSON-encoded command."
        }
        "timeout" | "timeout_ms" => "Timeout in milliseconds. Use a JSON integer, not a string.",
        "run_in_background" | "background" => {
            "JSON boolean. Set true only for long-running work that can be checked later; omit or false for bounded foreground work."
        }
        "task_id" => "Task id returned by a previous background task or task tool call.",
        "agent_id" => {
            "Agent id returned by `spawn_agent`; do not use background command task ids here."
        }
        "objective" => {
            "Concrete objective to pursue. Use only when the user explicitly requested a persistent goal."
        }
        "token_budget" => {
            "Optional token budget. Use a positive JSON integer and omit unless the user explicitly gave a budget."
        }
        "question" => "Question text shown to the user. Keep it concise and specific.",
        "header" => "Short UI header label, usually 1-3 words.",
        "options" => "Selectable choices. Must be a JSON array of option objects.",
        "preview" => "Optional preview content shown when this option is focused.",
        "old_string" => "Exact existing text to find. Preserve whitespace exactly.",
        "new_string" => {
            "Replacement text. Use an empty string only when deleting the matched text."
        }
        "replace_all" => {
            "JSON boolean. Set true to replace every match; omit or false to replace a single match."
        }
        "pattern" => {
            "Search pattern. For grep, this is a regular expression; for glob, this is a filesystem glob."
        }
        "query" => "Search query text. Be specific enough to retrieve relevant results.",
        "glob" => "Optional glob filter such as `*.rs` or `src/**/*.ts`.",
        "url" => "Fully qualified URL including scheme, e.g. `https://example.com/page`.",
        "plan" => {
            "Plan text to present or persist. Use clear numbered implementation steps when possible."
        }
        "plan_file_path" => "Optional file path where the plan should be saved.",
        "plan_summary" => "Concise summary of the plan that was executed.",
        "all_steps_completed" => {
            "JSON boolean indicating whether every planned step was completed."
        }
        "verification_notes" => {
            "Notes describing verification commands, outputs, gaps, or residual risks."
        }
        "artifact" => "Artifact content to review, such as code, markdown, or a document excerpt.",
        "annotations" => "Array of inline annotation objects.",
        "line" => "Optional 1-based line number for this annotation.",
        "language" => {
            if cfg!(windows) {
                "Optional language hint such as `javascript`, `typescript`, `python`, `shell`, or `powershell`. On Windows, `shell` means PowerShell."
            } else {
                "Optional language hint such as `javascript`, `typescript`, `python`, `shell`, `bash`, or `sh`. On Unix-like platforms, `shell` means bash."
            }
        }
        "fact" => "Durable fact to remember for future sessions.",
        "category" => "Optional memory category such as `user`, `project`, or `general`.",
        "store" => "Local-memory store name.",
        "preview_only" => {
            "JSON boolean. Keep true for a short preview; set false only when full content is needed."
        }
        "force_update" => {
            "JSON boolean. Set true only when existing generated files should be overwritten."
        }
        "file_content" => "Full content for the supporting file being written.",
        _ => return None,
    };
    Some(description.to_string())
}

/// A tool-specific table entry is the complete model-facing text for its field,
/// so it replaces the source doc comment instead of repeating it. Shell tools
/// keep the historical append behavior while their guidance is revised separately.
fn tool_owns_parameter_guidance(tool_name: &str) -> bool {
    !matches!(tool_name, "bash" | "PowerShell")
}

fn replace_schema_description(schema: &mut Value, description: &str) {
    if let Value::Object(map) = schema {
        map.insert(
            "description".to_string(),
            Value::String(description.to_string()),
        );
    }
}

fn merge_schema_description(schema: &mut Value, addition: &str) {
    let Value::Object(map) = schema else {
        return;
    };
    match map.get_mut("description") {
        Some(Value::String(existing)) => {
            if !existing.contains(addition) {
                if !existing.ends_with('.') {
                    existing.push('.');
                }
                existing.push(' ');
                existing.push_str(addition);
            }
        }
        _ => {
            map.insert(
                "description".to_string(),
                Value::String(addition.to_string()),
            );
        }
    }
}

fn validate_value(value: &Value, schema: &Value, root: &Value, path: &str) -> Result<(), String> {
    let schema = resolve_schema(root, schema);
    if let Some(options) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(|v| v.as_array())
    {
        if let Some(selected) = tagged_union_variant(value, options, root) {
            return validate_value(value, selected, root, path);
        }
        let mut first_error = None;
        for option in options {
            let option = resolve_schema(root, option);
            match validate_value(value, option, root, path) {
                Ok(()) => return Ok(()),
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        return Err(first_error
            .unwrap_or_else(|| format!("{path}: value did not match any allowed schema variant")));
    }

    let Some(expected_type) = schema_type_for_value(schema, value) else {
        return Ok(());
    };
    // schemars renders `Option<T>` as `type: ["T", "null"]` and `Option<Enum>`
    // as an enum list containing null — both explicitly allow JSON null. The
    // primary-type check below must not reject it.
    if value.is_null()
        && (schema
            .get("type")
            .and_then(|t| t.as_array())
            .is_some_and(|types| types.iter().any(|t| t.as_str() == Some("null")))
            || schema
                .get("enum")
                .and_then(|e| e.as_array())
                .is_some_and(|values| values.iter().any(Value::is_null)))
    {
        return Ok(());
    }
    if !json_value_matches_type(value, expected_type) {
        return Err(format!(
            "{path}: expected {}, but got {}. Received value: {}",
            expected_json_shape(expected_type),
            json_value_kind(value),
            concise_json(value)
        ));
    }

    match expected_type {
        "object" => validate_object_value(value, schema, root, path),
        "array" => validate_array_value(value, schema, root, path),
        _ => Ok(()),
    }
}

fn example_value_for_schema(
    schema: &Value,
    root: &Value,
    field_name: Option<&str>,
    depth: usize,
    remaining_nodes: &mut usize,
) -> Option<Value> {
    if depth > 24 || *remaining_nodes == 0 {
        return None;
    }
    *remaining_nodes -= 1;
    let schema = resolve_schema(root, schema);
    // Schemars wraps a referenced field with annotations in a single allOf.
    // This is a reference wrapper, not a general intersection of constraints.
    if let Some(parts) = schema.get("allOf").and_then(Value::as_array) {
        if parts.len() == 1
            && schema.as_object()?.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "allOf" | "description" | "title" | "default" | "examples"
                )
            })
        {
            return example_value_for_schema(
                &parts[0],
                root,
                field_name,
                depth + 1,
                remaining_nodes,
            );
        }
        return None;
    }
    // Do not invent examples for constraints this small generator cannot satisfy.
    if [
        "pattern",
        "const",
        "minProperties",
        "maxProperties",
        "propertyNames",
        "dependentSchemas",
        "unevaluatedProperties",
        "prefixItems",
        "format",
        "not",
        "if",
        "dependentRequired",
        "dependencies",
        "contains",
        "uniqueItems",
        "allOf",
        "oneOf",
    ]
    .iter()
    .any(|key| schema.get(*key).is_some())
    {
        return None;
    }
    if let Some(options) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
    {
        return options
            .iter()
            .filter(|option| schema_primary_type(option) != Some("null"))
            .find_map(|option| {
                example_value_for_schema(option, root, field_name, depth + 1, remaining_nodes)
            });
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        // Combined enum constraints need a full validator, not a first-value guess.
        if [
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "multipleOf",
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
        ]
        .iter()
        .any(|key| schema.get(*key).is_some())
        {
            return None;
        }
        return values
            .iter()
            .find(|value| !value.is_null())
            .or_else(|| values.first())
            .cloned();
    }
    match schema_primary_type(schema)? {
        "object" => {
            let mut object = serde_json::Map::new();
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for field in required.iter().filter_map(Value::as_str) {
                    let property = schema.get("properties")?.get(field)?;
                    object.insert(
                        field.to_string(),
                        example_value_for_schema(
                            property,
                            root,
                            Some(field),
                            depth + 1,
                            remaining_nodes,
                        )?,
                    );
                }
            }
            Some(Value::Object(object))
        }
        "array" => {
            let minimum = schema.get("minItems").and_then(Value::as_u64).unwrap_or(0);
            let maximum = schema.get("maxItems").and_then(Value::as_u64).unwrap_or(8);
            let preferred = if field_name == Some("options") { 2 } else { 1 };
            let count = minimum.max(preferred.min(maximum));
            if count > maximum || count > 8 {
                return None;
            }
            let mut items = Vec::new();
            for index in 0..count {
                let mut item = example_value_for_schema(
                    schema.get("items")?,
                    root,
                    field_name,
                    depth + 1,
                    remaining_nodes,
                )?;
                let label_is_free_text = schema
                    .get("items")
                    .map(|items| resolve_schema(root, items))
                    .and_then(|items| items.get("properties"))
                    .and_then(|properties| properties.get("label"))
                    .map(|label| resolve_schema(root, label))
                    .is_some_and(|label| label.get("enum").is_none());
                if field_name == Some("options")
                    && index > 0
                    && label_is_free_text
                    && let Some(label) = item.get_mut("label")
                {
                    *label = Value::String(format!("Option {}", (b'A' + index as u8) as char));
                }
                items.push(item);
            }
            Some(Value::Array(items))
        }
        "string" => {
            let mut text = string_example_for_field(field_name);
            let minimum = schema.get("minLength").and_then(Value::as_u64).unwrap_or(0) as usize;
            let maximum = schema
                .get("maxLength")
                .and_then(Value::as_u64)
                .unwrap_or(256) as usize;
            if minimum > maximum || minimum > 256 {
                return None;
            }
            text = text.chars().take(maximum).collect();
            while text.chars().count() < minimum {
                text.push('x');
            }
            Some(Value::String(text))
        }
        "integer" | "number" => {
            let integer = schema_primary_type(schema) == Some("integer");
            let mut lower = schema.get("minimum").and_then(Value::as_f64).unwrap_or(1.0);
            if let Some(exclusive) = schema.get("exclusiveMinimum").and_then(Value::as_f64) {
                lower = lower.max(exclusive + 1.0);
            }
            let upper = schema
                .get("maximum")
                .and_then(Value::as_f64)
                .unwrap_or(f64::MAX);
            let mut value = lower.min(upper);
            if schema
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|min| value < min)
            {
                return None;
            }
            if integer {
                value = value.ceil();
            }
            if let Some(step) = schema.get("multipleOf").and_then(Value::as_f64) {
                if step <= 0.0 {
                    return None;
                }
                value = (value / step).ceil() * step;
            }
            if value > upper
                || schema
                    .get("exclusiveMaximum")
                    .and_then(Value::as_f64)
                    .is_some_and(|max| value >= max)
                || schema
                    .get("exclusiveMinimum")
                    .and_then(Value::as_f64)
                    .is_some_and(|min| value <= min)
            {
                return None;
            }
            if integer {
                if value.fract() != 0.0 || value < i64::MIN as f64 || value >= i64::MAX as f64 {
                    return None;
                }
                Some(Value::from(value as i64))
            } else {
                serde_json::Number::from_f64(value).map(Value::Number)
            }
        }
        "boolean" => Some(Value::Bool(false)),
        "null" => Some(Value::Null),
        _ => None,
    }
}

fn string_example_for_field(field_name: Option<&str>) -> String {
    match field_name.unwrap_or_default() {
        "absolute_path" | "file_path" | "path" => "/absolute/path/to/file".to_string(),
        "command" | "cmd" => "echo hello".to_string(),
        "description" => "Describe the operation".to_string(),
        "header" => "choice".to_string(),
        "id" | "task_id" | "tool_call_id" => "id".to_string(),
        "label" => "Option A".to_string(),
        "pattern" => "README".to_string(),
        "query" => "search terms".to_string(),
        "pages" => "1-5".to_string(),
        "question" => "Which option should I choose?".to_string(),
        "status" => "pending".to_string(),
        "url" => "https://example.com".to_string(),
        _ => "string".to_string(),
    }
}

fn schema_child_path(parent: &str, field: &str) -> String {
    if parent == "$" {
        format!("$.{field}")
    } else {
        format!("{parent}.{field}")
    }
}

fn validate_object_value(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    if let Some(required) = schema.get("required").and_then(|v| v.as_array()) {
        for field in required.iter().filter_map(|field| field.as_str()) {
            if !object.contains_key(field) {
                return Err(format!(
                    "{path}.{field}: missing required field. Expected field `{field}` to be present."
                ));
            }
        }
    }
    let Some(properties) = schema.get("properties").and_then(|p| p.as_object()) else {
        return Ok(());
    };
    for (key, prop_schema) in properties {
        if let Some(child) = object.get(key) {
            validate_value(child, prop_schema, root, &format!("{path}.{key}"))?;
        }
    }
    Ok(())
}

fn validate_array_value(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
) -> Result<(), String> {
    let Some(array) = value.as_array() else {
        return Ok(());
    };
    let Some(items_schema) = schema.get("items") else {
        return Ok(());
    };
    for (index, item) in array.iter().enumerate() {
        validate_value(item, items_schema, root, &format!("{path}[{index}]"))?;
    }
    Ok(())
}

fn schema_primary_type(schema: &Value) -> Option<&str> {
    match schema.get("type") {
        Some(Value::String(typ)) => Some(typ.as_str()),
        Some(Value::Array(types)) => types
            .iter()
            .filter_map(|typ| typ.as_str())
            .find(|typ| *typ != "null"),
        _ if schema.get("properties").is_some() => Some("object"),
        _ if schema.get("items").is_some() => Some("array"),
        _ => schema_enum_type(schema),
    }
}

fn schema_enum_type(schema: &Value) -> Option<&'static str> {
    let values = schema.get("enum").and_then(|values| values.as_array())?;
    values
        .iter()
        .find(|value| !value.is_null())
        .map(json_value_kind)
}

fn schema_type_for_value<'a>(schema: &'a Value, value: &Value) -> Option<&'a str> {
    schema
        .get("type")
        .and_then(Value::as_array)
        .and_then(|types| {
            types
                .iter()
                .filter_map(Value::as_str)
                .find(|typ| json_value_matches_type(value, typ))
        })
        .or_else(|| schema_primary_type(schema))
}

fn json_value_matches_type(value: &Value, expected_type: &str) -> bool {
    match expected_type {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.is_number(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn json_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn expected_json_shape(expected_type: &str) -> &'static str {
    match expected_type {
        "array" => "array `[...]`",
        "object" => "object `{...}`",
        "string" => "string",
        "boolean" => "boolean `true` or `false`",
        "integer" => "integer number",
        "number" => "number",
        "null" => "null",
        _ => "value matching the schema",
    }
}

fn concise_json(value: &Value) -> String {
    let preview = safe_json_preview(value, 0);
    let raw = match serde_json::to_string(&preview) {
        Ok(raw) => raw,
        Err(_) => preview.to_string(),
    };
    const MAX: usize = 240;
    if raw.chars().count() <= MAX {
        raw
    } else {
        let mut shortened = raw.chars().take(MAX.saturating_sub(3)).collect::<String>();
        shortened.push_str("...");
        shortened
    }
}

fn safe_json_preview(value: &Value, depth: usize) -> Value {
    const MAX_DEPTH: usize = 4;
    const MAX_ARRAY_ITEMS: usize = 5;
    const MAX_OBJECT_FIELDS: usize = 12;

    match value {
        Value::String(text) => Value::String(format!("<string:{} chars>", text.chars().count())),
        Value::Array(items) => {
            if depth >= MAX_DEPTH {
                return Value::String(format!("<array:{} items>", items.len()));
            }
            let mut preview = items
                .iter()
                .take(MAX_ARRAY_ITEMS)
                .map(|item| safe_json_preview(item, depth + 1))
                .collect::<Vec<_>>();
            if items.len() > MAX_ARRAY_ITEMS {
                preview.push(Value::String(format!(
                    "<{} more items>",
                    items.len() - MAX_ARRAY_ITEMS
                )));
            }
            Value::Array(preview)
        }
        Value::Object(map) => {
            if depth >= MAX_DEPTH {
                return Value::String(format!("<object:{} fields>", map.len()));
            }
            let mut preview = serde_json::Map::new();
            for (idx, (key, child)) in map.iter().enumerate() {
                if idx >= MAX_OBJECT_FIELDS {
                    preview.insert(
                        "...".to_string(),
                        Value::String(format!("<{} more fields>", map.len() - MAX_OBJECT_FIELDS)),
                    );
                    break;
                }
                if is_sensitive_preview_key(key) {
                    preview.insert(key.clone(), Value::String("[redacted]".to_string()));
                } else {
                    preview.insert(key.clone(), safe_json_preview(child, depth + 1));
                }
            }
            Value::Object(preview)
        }
        _ => value.clone(),
    }
}

fn is_sensitive_preview_key(key: &str) -> bool {
    let normalized = key.trim().to_ascii_lowercase().replace(['-', '.'], "_");
    normalized == "authorization"
        || normalized == "secret"
        || normalized == "token"
        || normalized == "password"
        || normalized == "auth_token"
        || normalized == "api_key"
        || normalized.ends_with("_api_key")
        || normalized.ends_with("_token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_password")
        || normalized.contains("access_token")
        || normalized.contains("refresh_token")
}

fn coerce_object(input: &mut Value, schema: &Value, root: &Value, opts: &CoercionOptions) {
    let schema = resolve_schema(root, schema);
    let Some(properties) = schema.get("properties").and_then(|p| p.as_object()) else {
        return;
    };
    let Some(obj) = input.as_object_mut() else {
        return;
    };
    coerce_object_property_aliases(obj, properties);
    for (key, prop_schema) in properties {
        let prop_schema = resolve_schema(root, prop_schema);
        let Some(value) = obj.get_mut(key) else {
            continue;
        };
        coerce_value(value, prop_schema, root, opts);
    }
}

fn coerce_object_property_aliases(
    obj: &mut serde_json::Map<String, Value>,
    properties: &serde_json::Map<String, Value>,
) {
    let keys = obj.keys().cloned().collect::<Vec<_>>();
    for expected in properties.keys() {
        if obj.contains_key(expected) {
            continue;
        }
        let expected_token = normalize_schema_token(expected);
        if expected_token.is_empty() {
            continue;
        }
        let mut aliases = keys
            .iter()
            .filter(|key| obj.contains_key(key.as_str()))
            .filter(|key| normalize_schema_token(key) == expected_token);
        let Some(alias) = aliases.next().cloned() else {
            continue;
        };
        if aliases.next().is_some() {
            continue;
        }
        if let Some(value) = obj.remove(&alias) {
            obj.insert(expected.clone(), value);
        }
    }
}

/// Convert an object whose keys are sequential integers starting at 0 into an
/// array. This handles providers that accidentally serialize arrays as JSON
/// objects with numeric string keys.
fn object_as_sequential_array(map: &serde_json::Map<String, Value>) -> Option<Vec<Value>> {
    let mut pairs: Vec<(usize, Value)> = Vec::with_capacity(map.len());
    for (key, value) in map {
        let idx = key.parse::<usize>().ok()?;
        pairs.push((idx, value.clone()));
    }
    if pairs.is_empty() {
        return None;
    }
    pairs.sort_by_key(|(idx, _)| *idx);
    if pairs
        .iter()
        .enumerate()
        .any(|(expected, (actual, _))| expected != *actual)
    {
        return None;
    }
    Some(pairs.into_iter().map(|(_, value)| value).collect())
}

/// Accept common model/provider wrappers for arrays, e.g.
/// `{ "item": [{...}] }` instead of `[{...}]`.
fn object_as_wrapped_array(
    map: &serde_json::Map<String, Value>,
    items_schema: &Value,
    root: &Value,
) -> Option<Vec<Value>> {
    fn wrapped(map: &serde_json::Map<String, Value>) -> Option<&Value> {
        if map.len() != 1 {
            return None;
        }
        let (key, value) = map.iter().next()?;
        matches!(key.as_str(), "item" | "items" | "value" | "values").then_some(value)
    }
    let mut value = wrapped(map)?;
    for _ in 0..8 {
        if let Some(values) = value.as_array() {
            return Some(values.clone());
        }
        if value.is_null() {
            return None;
        }
        // Unwrap another transport wrapper only when it cannot already be an
        // array element according to the item schema. Preserve opaque data.
        if validate_value(value, items_schema, root, "$").is_err()
            && let Some(next) = value.as_object().and_then(wrapped)
        {
            value = next;
            continue;
        }
        return Some(vec![value.clone()]);
    }
    None
}

fn object_values_as_array(
    map: &serde_json::Map<String, Value>,
    items_schema: &Value,
    root: &Value,
) -> Option<Vec<Value>> {
    if map.is_empty() {
        return None;
    }
    let items_schema = resolve_schema(root, items_schema);
    let item_type = schema_primary_type(items_schema)?;
    if item_type == "object" && object_looks_like_schema_instance(map, items_schema) {
        return None;
    }
    let values = map
        .iter()
        .filter(|(key, _)| key.parse::<usize>().is_err())
        .collect::<Vec<_>>();
    if values.len() != map.len() {
        return None;
    }
    if !values
        .iter()
        .all(|(_, value)| value_is_plausible_array_item(value, item_type))
    {
        return None;
    }
    let mut values = values;
    values.sort_by_key(|(key, _)| *key);
    Some(values.into_iter().map(|(_, value)| value.clone()).collect())
}

fn object_looks_like_schema_instance(map: &serde_json::Map<String, Value>, schema: &Value) -> bool {
    let Some(properties) = schema.get("properties").and_then(|props| props.as_object()) else {
        return false;
    };
    map.keys().any(|key| {
        let key_token = normalize_schema_token(key);
        properties
            .keys()
            .any(|property| normalize_schema_token(property) == key_token)
    })
}

fn value_is_plausible_array_item(value: &Value, item_type: &str) -> bool {
    match item_type {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string() || value.is_number() || value.is_boolean(),
        "boolean" => value.is_boolean() || value.is_string(),
        "integer" | "number" => value.is_number() || value.is_string(),
        _ => false,
    }
}

fn string_as_array(text: &str, items_schema: &Value, root: &Value) -> Option<Vec<Value>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(Vec::new());
    }
    let items_schema = resolve_schema(root, items_schema);
    let item_type = schema_primary_type(items_schema)?;
    if item_type == "object" || item_type == "array" {
        return None;
    }
    let parts = if trimmed.contains('\n') || trimmed.contains(',') {
        trimmed
            .split([',', '\n'])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
    } else {
        vec![trimmed]
    };
    if parts.is_empty() {
        return Some(Vec::new());
    }
    Some(
        parts
            .into_iter()
            .map(|part| Value::String(part.to_string()))
            .collect(),
    )
}

fn normalize_schema_token(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn pascal_or_camel_to_snake_case(value: &str) -> String {
    let mut output = String::new();
    let mut previous_was_lower_or_digit = false;
    for ch in value.chars() {
        if ch == '-' || ch == ' ' {
            if !output.ends_with('_') && !output.is_empty() {
                output.push('_');
            }
            previous_was_lower_or_digit = false;
            continue;
        }
        if ch == '_' {
            if !output.ends_with('_') && !output.is_empty() {
                output.push('_');
            }
            previous_was_lower_or_digit = false;
            continue;
        }
        if ch.is_ascii_uppercase() {
            if previous_was_lower_or_digit && !output.ends_with('_') {
                output.push('_');
            }
            output.push(ch.to_ascii_lowercase());
            previous_was_lower_or_digit = false;
        } else {
            output.push(ch);
            previous_was_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn all_of_does_not_hide_sibling_property_coercion() {
        let schema = serde_json::json!({"type":"object","properties":{"count":{"type":"integer"}},"allOf":[{"type":"object"}]});
        let mut input = serde_json::json!({"count":"3"});
        coerce_input(&mut input, &schema);
        assert_eq!(input["count"], 3);
    }

    #[test]
    fn concise_json_uses_safe_preview_without_raw_string_values() {
        let value = serde_json::json!({
            "command": "curl -H 'Authorization: Bearer secret-token' https://example.test",
            "env": {
                "OPENAI_API_KEY": "sk-secret-value",
                "PUBLIC_FLAG": "visible"
            },
            "count": 3
        });

        let preview = concise_json(&value);

        assert!(preview.contains(r#""command":"<string:"#));
        assert!(preview.contains(r#""OPENAI_API_KEY":"[redacted]""#));
        assert!(preview.contains(r#""PUBLIC_FLAG":"<string:7 chars>""#));
        assert!(preview.contains(r#""count":3"#));
        assert!(!preview.contains("secret-token"));
        assert!(!preview.contains("sk-secret-value"));
        assert!(!preview.contains("visible"));
    }

    #[test]
    fn clean_schema_declares_empty_properties_and_required_for_object_roots() {
        #[derive(schemars::JsonSchema)]
        struct EmptyInput {}

        let schema = clean_schema(schemars::schema_for!(EmptyInput));

        assert_eq!(schema["properties"], serde_json::json!({}));
        assert_eq!(schema["required"], serde_json::json!([]));
    }

    #[test]
    fn recursive_three_branch_schema_keeps_its_reference_target() {
        let schema = json!({"type":"object","properties":{"root":{"$ref":"#/definitions/Node"}},"definitions":{"Node":{"anyOf":[{"type":"object","properties":{"all":{"type":"array","items":{"$ref":"#/definitions/Node"}}}},{"type":"object","properties":{"any":{"type":"array","items":{"$ref":"#/definitions/Node"}}}},{"type":"object","properties":{"not":{"$ref":"#/definitions/Node"}}}]}}});
        let rendered = inline_local_schema_refs_for_model(&schema);
        assert!(serde_json::to_vec(&rendered).unwrap().len() < 8192);
        assert_eq!(rendered["definitions"], schema["definitions"]);
        assert!(schema_contains_ref(&rendered["properties"]));
    }

    #[test]
    fn repeated_nonrecursive_subgraphs_share_one_expansion_budget() {
        let mut properties = serde_json::Map::new();
        for index in 0..512 {
            properties.insert(format!("field{index}"), json!({"$ref":"#/$defs/Large"}));
        }
        let schema = json!({"type":"object","properties":properties,"$defs":{"Large":{"type":"string","description":"x".repeat(2048)}}});
        let rendered = inline_local_schema_refs_for_model(&schema);
        assert!(serde_json::to_vec(&rendered).unwrap().len() < 100_000);
        assert_eq!(rendered["$defs"], schema["$defs"]);
    }

    #[test]
    fn unions_preserve_native_scalar_types_instead_of_stringifying_numbers() {
        let schema = json!({"anyOf":[{"type":"string"},{"type":"number"},{"type":"boolean"}]});
        for original in [json!(20), json!(true), json!("20")] {
            let mut input = original.clone();
            coerce_input(&mut input, &schema);
            assert_eq!(input, original);
        }
    }
}
