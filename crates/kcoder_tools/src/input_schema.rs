use crate::{CoercionOptions, CoercionResult, ToolError, semantic_coerce};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Parse and validate a tool's input JSON against its expected struct.
pub fn parse_input<T: DeserializeOwned>(input: &Value) -> Result<T, ToolError> {
    serde_json::from_value(input.clone())
        .map_err(|e| ToolError::InvalidInput(format!("invalid input: {}", e)))
}

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
        return;
    }

    let Some(typ) = schema_primary_type(schema) else {
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
                } else if let Some(arr) = object_as_wrapped_array(map) {
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

fn select_union_coercion_schema<'a>(
    value: &Value,
    options: &'a [Value],
    root: &'a Value,
) -> Option<&'a Value> {
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
/// follows `$ref`/union schemas, and includes one item for array fields so the
/// model can see where `[...]` is required.
pub fn example_input_for_schema(schema: &Value) -> Option<Value> {
    example_value_for_schema(schema, schema, None)
}

/// Append a compact schema-derived input guide to a tool description.
///
/// The API already receives the full JSON Schema separately, but smaller
/// models often follow the natural-language description more reliably than the
/// schema object. This keeps every tool's description concrete without
/// hand-writing parameter examples for dozens of tools.
pub fn description_with_input_shape(description: &str, schema: &Value) -> String {
    let mut output = description.trim().to_string();
    output.push_str("\n\nInput format: send exactly one JSON object as the tool input.");

    if let Some(example) =
        example_input_for_schema(schema).and_then(|example| serde_json::to_string(&example).ok())
    {
        output.push_str(" JSON shape example: ");
        output.push_str(&truncate_for_description(&example, 900));
        output.push('.');
    }

    let required = required_schema_paths(schema);
    if !required.is_empty() {
        output.push_str(" Required fields: ");
        output.push_str(&required.join(", "));
        output.push('.');
    }

    let arrays = array_schema_paths(schema);
    if !arrays.is_empty() {
        output.push_str(" Array fields must use JSON arrays `[...]`: ");
        output.push_str(&arrays.join(", "));
        output.push('.');
    }

    output.push_str(
        " Do not use string values for booleans or numbers when real JSON booleans/numbers are expected. Do not wrap arrays in objects like {\"item\":[...]} unless the schema explicitly says so.",
    );
    output
}

/// Return a clone of `schema` with richer parameter descriptions for the model.
///
/// The generated JSON Schema already captures the machine-readable shape. This
/// pass enriches the human-readable parameter descriptions with exact JSON
/// shapes, array syntax, aliases, defaults, and common mistakes. Validation
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
    let root = schema.clone();
    let mut inlined = schema.clone();
    inline_local_refs_in_value(&mut inlined, &root, 0);
    if !schema_contains_ref(&inlined)
        && let Some(map) = inlined.as_object_mut()
    {
        map.remove("definitions");
        map.remove("$defs");
    }
    inlined
}

fn inline_local_refs_in_value(value: &mut Value, root: &Value, depth: usize) {
    const MAX_REF_DEPTH: usize = 32;
    if depth > MAX_REF_DEPTH {
        return;
    }

    match value {
        Value::Object(map) => {
            if let Some(reference) = map.get("$ref").and_then(Value::as_str).map(str::to_owned)
                && let Some(target) = resolve_local_schema_ref(root, &reference)
            {
                let mut replacement = target.clone();
                inline_local_refs_in_value(&mut replacement, root, depth + 1);

                let siblings = std::mem::take(map);
                *value = merge_schema_ref_siblings(replacement, siblings);
                inline_local_refs_in_value(value, root, depth + 1);
                return;
            }

            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                if let Some(child) = map.get_mut(&key) {
                    inline_local_refs_in_value(child, root, depth + 1);
                }
            }

            if let Some(flattened) = flatten_single_all_of(map) {
                *value = flattened;
                inline_local_refs_in_value(value, root, depth + 1);
            }
        }
        Value::Array(values) => {
            for child in values {
                inline_local_refs_in_value(child, root, depth + 1);
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
                    .or_else(|| generic_parameter_description(field, property_schema))
            {
                merge_schema_description(property_schema, &description);
            }
            if schema_type_for_description(property_schema) == Some("array") {
                merge_schema_description(
                    property_schema,
                    "Use a real JSON array `[...]`; do not pass a single object, numeric-key object, or wrapper like {\"item\":[...]}.",
                );
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
        ("AskUserQuestion", "questions") => Some(
            "Questions to show the user. Must be a JSON array with 1-4 question objects; use `[{...}]` even for a single question."
                .to_string(),
        ),
        ("AskUserQuestion", "question") => Some(
            "Single clear sentence shown to the user. Ask for a concrete decision or clarification; avoid asking whether to proceed with an invisible plan."
                .to_string(),
        ),
        ("AskUserQuestion", "header") => Some(
            "Short UI chip label, preferably 1-3 words and 12 or fewer characters, such as `Library`, `Approach`, or `Auth`."
                .to_string(),
        ),
        ("AskUserQuestion", "options") => Some(
            "Available choices for this question. Must be a JSON array with 2-4 option objects; do not include an `Other` option because the UI provides one automatically."
                .to_string(),
        ),
        ("AskUserQuestion", "label") => Some(
            "Short user-facing option label, usually 1-5 words. If recommending an option, put it first and suffix the label with `(Recommended)`."
                .to_string(),
        ),
        ("AskUserQuestion", "description") => Some(
            "One short sentence explaining the impact, trade-off, or consequence if this option is selected."
                .to_string(),
        ),
        ("AskUserQuestion", "multi_select") => Some(
            "JSON boolean. Use `true` only when multiple options may be selected; otherwise omit it or set `false`. Do not send the string \"false\"."
                .to_string(),
        ),
        ("TodoWrite", "TodoList") | ("TodoWrite", "todos") => Some(
            "Complete replacement TodoList for the current session checklist. Must be a real JSON array of todo objects; include every still-relevant item, not just the changed one. Do not send placeholder strings such as `{\"TodoList\":[\"\"]}`; if there is no concrete checklist to track, skip TodoWrite instead. Do not send `null` for this field, and do not include null-valued fields inside todo objects. If every item has status `completed`, TodoWrite clears the stored TodoList and returns `all todos are completed`."
                .to_string(),
        ),
        ("TodoWrite", "content") => Some(
            "Imperative task text describing the outcome, e.g. `Run focused tests`. Must be a non-null string; do not send `null`. Keep it concise and user-visible."
                .to_string(),
        ),
        ("TodoWrite", "activeForm") | ("TodoWrite", "active_form") => Some(
            "Present-continuous form displayed while in progress, e.g. `Running focused tests`. Required for every todo item and must be a non-null string; do not send `null`."
                .to_string(),
        ),
        ("TodoWrite", "status") => Some(
            "Todo state. Use exactly one non-null enum string: `pending`, `in_progress`, or `completed`; do not send `null`."
                .to_string(),
        ),
        ("read", "file_path") => Some(
            "Absolute or workspace-relative path to a file. This tool reads UTF-8 text, common images (png/jpg/jpeg/gif/webp), and Jupyter notebooks; it does not read directories."
                .to_string(),
        ),
        ("read", "offset") => Some(
            "Optional 1-based line number to start reading from for text files. Omit for a full/default read; use only when targeting a known range in a large file."
                .to_string(),
        ),
        ("read", "limit") => Some(
            "Optional maximum number of text lines to return. Use a JSON integer. Omit for the default 2000-line read from the offset; provide a smaller range when targeting a large file."
                .to_string(),
        ),
        ("read", "pages") => Some(
            "Optional PDF page range such as `1-5`. The Rust tool currently reports an explicit unsupported-PDF error instead of reading raw PDF bytes."
                .to_string(),
        ),
        ("glob", "pattern") => Some(
            "Filesystem glob pattern for file names, such as `**/*.rs`, `src/**/*.ts`, or `*.test.{ts,tsx}`. This is not a content search."
                .to_string(),
        ),
        ("glob", "path") => Some(
            "Optional directory to search in. Omit the field to use the current working directory; do not send the strings `undefined` or `null`. If provided, it must be a directory."
                .to_string(),
        ),
        ("glob", "limit") => Some(
            "Optional maximum number of paths. Omit for 100 paths sorted by modification time. Ignored by `output_mode: \"count\"`. Must be positive for path output; unbounded `0` results are disabled."
                .to_string(),
        ),
        ("glob", "output_mode") => Some(
            "One enum string: `paths` (default, bounded path list) or `count` (scan matches and return only `matched_files` plus `complete`; this avoids returning every path)."
                .to_string(),
        ),
        ("glob", "scan_budget") => Some(
            "Optional scan budget: `default` (50,000 entries/2s/100 paths), `expanded` (500,000 entries/10s/500 paths), or `large` (5,000,000 entries/30s/2,000 paths). Count mode still obeys the entry/time budget but does not cap the aggregate count at the path limit. Larger budgets require an explicit narrow `path`; use them only when the default scope is insufficient."
                .to_string(),
        ),
        ("grep", "pattern") => Some(
            "Ripgrep regular expression pattern to search in file contents. If the pattern starts with `-`, the tool safely passes it as a pattern, not as a flag."
                .to_string(),
        ),
        ("grep", "path") => Some(
            "Optional file or directory to search. Omit to search the current working directory."
                .to_string(),
        ),
        ("grep", "glob") => Some(
            "Optional file glob filter, such as `*.rs`, `**/*.tsx`, or `*.{ts,tsx}`. Multiple simple patterns may be separated by spaces or commas."
                .to_string(),
        ),
        ("grep", "output_mode") => Some(
            "One enum string: `files_with_matches` (default, file paths only), `content` (matching lines with optional context), or `count` (per-file counts plus an exact aggregate across the full search; rows may be paginated)."
                .to_string(),
        ),
        ("grep", "-B") => Some(
            "JSON integer. In `output_mode: \"content\"`, include this many lines before each match."
                .to_string(),
        ),
        ("grep", "-A") => Some(
            "JSON integer. In `output_mode: \"content\"`, include this many lines after each match."
                .to_string(),
        ),
        ("grep", "-C") | ("grep", "context") => Some(
            "JSON integer. In `output_mode: \"content\"`, include this many lines before and after each match; takes precedence over -A/-B."
                .to_string(),
        ),
        ("grep", "-n") => Some(
            "JSON boolean. In `output_mode: \"content\"`, show line numbers. Defaults to true."
                .to_string(),
        ),
        ("grep", "-i") => Some(
            "JSON boolean. Set true for case-insensitive search."
                .to_string(),
        ),
        ("grep", "type") => Some(
            "Optional ripgrep file type filter, such as `rust`, `js`, `ts`, `py`, `go`, or `java`; usually more efficient than a broad glob."
                .to_string(),
        ),
        ("grep", "head_limit") => Some(
            "Optional maximum output lines/entries after sorting/filtering. Omit for 250; pass `0` only when an unbounded result is intentional."
                .to_string(),
        ),
        ("grep", "offset") => Some(
            "Optional number of output lines/entries to skip before applying head_limit. Use this for pagination after a truncated search result."
                .to_string(),
        ),
        ("grep", "multiline") => Some(
            "JSON boolean. Set true only for patterns that must span multiple lines; normal searches should omit it for speed."
                .to_string(),
        ),
        ("bash", "command") => Some(
            "Unix shell command to execute in the current working directory. Pass the exact command text. Do not prefix with `cd`; use paths relative to the session cwd or absolute paths. Use dedicated tools for file enumeration (`glob`), content search (`grep`), reading (`read`), editing (`edit`), and writing (`write`) instead of shell `ls`, `find`, glob expansion, `grep`, or `rg`. Quote file paths that contain spaces."
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
        ("ocr", "preview") => Some(
            "JSON boolean. Set true first on large diffs to inspect the review scope without calling the OCR LLM."
                .to_string(),
        ),
        ("ocr", "foregroundTimeoutSeconds") | ("ocr", "foreground_timeout_seconds") => Some(
            "Seconds to keep OCR in the foreground before KCoder moves the still-running review to a background task. Defaults to 60. Use TaskOutput to inspect the returned task_id."
                .to_string(),
        ),
        ("ocr", "timeoutMinutes") | ("ocr", "timeout_minutes") => Some(
            "OCR per-file task timeout in minutes, also used to bound the wrapper wall timeout. This is not the foreground progress timeout."
                .to_string(),
        ),
        ("PowerShell", "command") => Some(
            "PowerShell command to execute in the current working directory. Pass the exact command text. Do not prefix with `cd` or `Set-Location`; use paths relative to the session cwd or absolute paths. Prefer dedicated tools for file search (`glob`), content search (`grep`), reading (`read`), editing (`edit`), and writing (`write`). Quote paths with spaces using double quotes."
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
            "JSON boolean. Set true only for long-running commands when you can continue useful work before checking TaskOutput. Do not wrap with Start-Job, do not poll with Start-Sleep, and do not check output immediately unless you need it."
                .to_string(),
        ),
        ("WebFetch", "url") => Some(
            "Fully formed http/https URL. Public http URLs are upgraded to https; localhost http is preserved for local dev servers. Authenticated/private URLs usually fail; use specialized MCP or CLI tools when available."
                .to_string(),
        ),
        ("WebFetch", "prompt") => Some(
            "Instruction describing what to extract or focus on from the fetched page. Keep it specific, e.g. `Extract installation requirements and version constraints`."
                .to_string(),
        ),
        ("WebBrowser", "url") => Some(
            "Fully formed http/https URL to fetch. This lightweight browser only reads server-rendered HTML; it does not execute JavaScript, click, type, scroll, or capture real screenshots."
                .to_string(),
        ),
        ("WebBrowser", "action") => Some(
            "Action enum string. Use `navigate` to fetch title/text content, or `screenshot` only when a text snapshot is acceptable. Visual screenshots require a full browser runtime."
                .to_string(),
        ),
        ("write", "content") => Some(format!(
            "Complete replacement content for the file. One `write` call accepts at most {} KiB / {} UTF-8 bytes; do not send huge generated files in a single call. Prefer `edit` for targeted changes to existing files; use `write` for new files or deliberate complete rewrites. Do not create README.md, other documentation files, or emoji-containing content unless the user explicitly requested them. Existing UTF-16LE files keep their encoding; new files are UTF-8.",
            crate::write::MAX_WRITE_CONTENT_BYTES / 1024,
            crate::write::MAX_WRITE_CONTENT_BYTES
        )),
        ("edit", "old_string") => Some(
            "Exact existing text to find. Read the target file or relevant line range first, then copy this from the current file content with whitespace preserved exactly. When copying from Read output, omit the line number prefix and include only actual file content. For CRLF files, use the LF-normalized text shown by Read; Edit writes the original line ending style back. It must be unique unless replace_all=true; use an empty string only to create a missing file or fill an empty file."
                .to_string(),
        ),
        ("edit", "new_string") => Some(
            "Replacement text. Use an empty string only when deleting the matched text; keep surrounding whitespace intentional. Do not add emojis unless the user explicitly requested them."
                .to_string(),
        ),
        ("edit", "replace_all") => Some(
            "JSON boolean. Set true only when every occurrence should change, such as a deliberate rename across the file; omit or false for a single targeted replacement."
                .to_string(),
        ),
        ("spawn_agent", "message") => Some(
            "Self-contained task instruction for the sub-agent. Include relevant files, expected output, constraints, and what not to change."
                .to_string(),
        ),
        ("spawn_agent", "agent_type") => Some(
            "Specialized sub-agent role. Prefer `plan`, `review`, `implementer`, `verifier`, or `tool_agent` when the task fits; omit for `general`. Use `explore_agent` for read-only reconnaissance."
                .to_string(),
        ),
        ("spawn_agent", "max_turns") => Some(
            "Maximum internal turns for the sub-agent. Use a small number for bounded work; omit unless the task genuinely needs a custom cap."
                .to_string(),
        ),
        ("explore_agent", "message") => Some(
            "Self-contained read-only reconnaissance task. Include concrete paths, symbols, questions to answer, expected path:line evidence, and explicit boundaries. Do not request edits."
                .to_string(),
        ),
        ("explore_agent", "max_turns") => Some(
            "Maximum internal turns for the Explore sub-agent. Use a JSON integer; omit for normal exploration, or set a small cap for narrow searches."
                .to_string(),
        ),
        ("WebSearch", "allowed_domains") => Some(
            "Optional allowlist of domains such as `[\"example.com\"]`. Must be a JSON array of strings. Use only when results must come from specific sites."
                .to_string(),
        ),
        ("WebSearch", "blocked_domains") => Some(
            "Optional denylist of domains such as `[\"example.com\"]`. Must be a JSON array of strings. Use to exclude unreliable or irrelevant sites."
                .to_string(),
        ),
        ("WebSearch", "num_results") => Some(
            "Optional result count. Use a JSON integer; default is 8. Increase only when broader coverage is needed."
                .to_string(),
        ),
        ("WebSearch", "livecrawl") => Some(
            "Optional crawl mode enum. Use `fallback` for cached-first behavior or `preferred` to prioritize live crawling."
                .to_string(),
        ),
        ("WebSearch", "search_type") => Some(
            "Optional search depth enum. Use `auto` by default, `fast` for quick lookups, or `deep` for comprehensive research."
                .to_string(),
        ),
        ("WebSearch", "context_max_characters") => Some(
            "Optional maximum characters of search context to return. Use a JSON integer; default is 10000."
                .to_string(),
        ),
        ("TaskUpdate", "addBlocks") | ("TaskUpdate", "add_blocks") => Some(
            "Task IDs this task blocks. Must be a JSON array of strings; omit when not updating dependency edges."
                .to_string(),
        ),
        ("TaskUpdate", "addBlockedBy") | ("TaskUpdate", "add_blocked_by") => Some(
            "Task IDs that block this task. Must be a JSON array of strings; omit when not updating dependency edges."
                .to_string(),
        ),
        ("TaskOutput", "block") => Some(
            "JSON boolean. Set `true` only when the result is on the current critical path; otherwise leave false for a non-blocking status/output check."
                .to_string(),
        ),
        ("TaskOutput", "timeout") => Some(
            "Maximum wait time in milliseconds when `block=true`. Use a JSON integer; keep short unless the current step genuinely depends on completion."
                .to_string(),
        ),
        ("Sleep", "duration_seconds") => Some(
            "Number of seconds to wait. Use a JSON number, not a string. Use Sleep instead of Bash sleep when idling or waiting; the user can interrupt it."
                .to_string(),
        ),
        ("Snip", "message_ids") => Some(
            "Message ids to replace with compact summaries: `msg-N` or `N`, the 1-based index of the message in the conversation. Must be a JSON array of strings; do not pass a single string. Only snip messages you are confident you will not need verbatim again."
                .to_string(),
        ),
        ("Snip", "reason") => Some(
            "Optional summary/reason for snipping. Preserve key facts such as file paths, decisions, errors, and outcomes because snipping cannot be undone."
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
        ("REPL", "code") => Some(
            "Script text to execute. Use REPL for batch operations across files, complex multi-step transformations, or programmatic control flow. The script runs in the KCoder session current working directory."
                .to_string(),
        ),
        ("REPL", "language") => Some(if cfg!(windows) {
            "Optional language hint: `javascript`, `typescript`, `python`, `shell`, or `powershell`. On Windows, `shell` means PowerShell.".to_string()
        } else {
            "Optional language hint: `javascript`, `typescript`, `python`, `shell`, `bash`, or `sh`. On Unix-like platforms, `shell` means bash.".to_string()
        }),
        ("REPL", "timeout") => Some(
            "Optional timeout in seconds. Use a JSON integer; omit for the default 60 seconds."
                .to_string(),
        ),
        ("skill", "skill") => Some(
            "Exact skill name string, e.g. `commit`, `review-pr`, `pdf`, or `plugin-name:skill`. A leading slash is accepted but not required. Use DiscoverSkills first if unsure."
                .to_string(),
        ),
        ("skill", "args") => Some(
            "Optional argument string for the skill, e.g. `-m 'Fix bug'` or `123 --strict`. Omit when the skill takes no arguments. Legacy `arguments: [..]` arrays are accepted but `args` string is preferred."
                .to_string(),
        ),
        ("DiscoverSkills", "description") => Some(
            "Concrete task description to search for relevant skills. Include workflow, technology, or artifact details, e.g. `review a pull request for correctness` rather than `review`."
                .to_string(),
        ),
        ("DiscoverSkills", "limit") => Some(
            "Optional maximum result count. Use a JSON integer; default is 5 and values above 20 are capped."
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
            "Brief actionable task title in imperative form, e.g. `Run focused tests`. Check TaskList first when duplicate tasks are possible."
                .to_string(),
        ),
        ("TaskCreate", "description") => Some(
            "Concrete explanation of what needs to be done and why it matters. Include enough detail for another agent or later turn to execute it."
                .to_string(),
        ),
        ("TaskCreate", "activeForm") | ("TaskCreate", "active_form") => Some(
            "Present-continuous spinner text while the task is in progress, e.g. `Running focused tests`. Omit if the subject is already clear."
                .to_string(),
        ),
        ("TaskUpdate", "taskId") | ("TaskUpdate", "task_id") => Some(
            "Task ID returned by TaskCreate/TaskList. Use TaskGet first when you need the latest state before updating."
                .to_string(),
        ),
        ("TaskUpdate", "status") => Some(
            "Task status enum. Use `pending`, `in_progress`, `completed`, or `deleted`. Mark completed only after the work is fully done and verified; use deleted only for obsolete/erroneous tasks."
                .to_string(),
        ),
        ("TaskUpdate", "subject") => Some(
            "Optional replacement task title. Use only when the current title is unclear or requirements changed."
                .to_string(),
        ),
        ("TaskUpdate", "description") => Some(
            "Optional replacement task details. Keep unresolved blockers visible instead of marking partial work completed."
                .to_string(),
        ),
        ("TaskUpdate", "activeForm") | ("TaskUpdate", "active_form") => Some(
            "Optional present-continuous spinner text while in progress, e.g. `Fixing parser bug`."
                .to_string(),
        ),
        ("TaskUpdate", "owner") => Some(
            "Optional owner or agent identifier. Use to claim or assign a task; omit when not changing ownership."
                .to_string(),
        ),
        ("TaskUpdate", "metadata") | ("TaskCreate", "metadata") => Some(
            "Optional JSON object of metadata. Values must be valid JSON; in TaskUpdate, set a key to null to delete that metadata key."
                .to_string(),
        ),
        ("TaskList", "taskId") | ("TaskGet", "taskId") | ("TaskGet", "task_id") => Some(
            "Task ID to retrieve. Use an exact ID from TaskList or TaskCreate."
                .to_string(),
        ),
        ("TaskStop", "task_id") => Some(
            "ID of the running background task to stop. Use TaskOutput or TaskList first if unsure."
                .to_string(),
        ),
        ("TaskStop", "shell_id") => Some(
            "Deprecated alias for task_id retained for old transcripts; prefer task_id in new calls."
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
            "Maximum reviewer/planner sub-agent turns. Use a JSON integer; omit for the default unless the review is unusually broad."
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

fn generic_parameter_description(field: &str, schema: &Value) -> Option<String> {
    let typ = schema_type_for_description(schema);
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
        "description" => "Brief human-readable description of purpose or impact.",
        "timeout" | "timeout_ms" => "Timeout in milliseconds. Use a JSON integer, not a string.",
        "run_in_background" | "background" => {
            "JSON boolean. Set true only for long-running work that can be checked later; omit or false for bounded foreground work."
        }
        "task_id" => "Task id returned by a previous background task or task tool call.",
        "agent_id" => {
            "Agent id returned by `spawn_agent`; do not use background command task ids here."
        }
        "id" => "Stable identifier string used to map results back to this item.",
        "objective" => {
            "Concrete objective to pursue. Use only when the user explicitly requested a persistent goal."
        }
        "token_budget" => {
            "Optional token budget. Use a positive JSON integer and omit unless the user explicitly gave a budget."
        }
        "status" => "Status enum string. Use one of the values listed in the schema.",
        "question" => "Question text shown to the user. Keep it concise and specific.",
        "header" => "Short UI header label, usually 1-3 words.",
        "options" => "Selectable choices. Must be a JSON array of option objects.",
        "label" => "Short user-facing label.",
        "preview" => "Optional preview content shown when this option is focused.",
        "content" => "Text content for this item or file.",
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
        "prompt" => "Instruction describing what information to extract or analyze.",
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
        "title" => "Optional artifact title or file path used for display.",
        "annotations" => "Array of inline annotation objects.",
        "line" => "Optional 1-based line number for this annotation.",
        "severity" => "Severity enum string. Use one of the values listed in the schema.",
        "summary" => "Overall summary text.",
        "action" => "Action enum string. Use exactly one of the actions listed in the schema.",
        "name" => "Name identifier for the requested resource.",
        "arguments" => "Optional positional arguments. Must be a JSON array.",
        "language" => {
            if cfg!(windows) {
                "Optional language hint such as `javascript`, `typescript`, `python`, `shell`, or `powershell`. On Windows, `shell` means PowerShell."
            } else {
                "Optional language hint such as `javascript`, `typescript`, `python`, `shell`, `bash`, or `sh`. On Unix-like platforms, `shell` means bash."
            }
        }
        "code" => "Source code or script text to execute.",
        "fact" => "Durable fact to remember for future sessions.",
        "category" => "Optional memory category such as `user`, `project`, or `general`.",
        "store" => "Local-memory store name.",
        "key" => "Entry key or config key, depending on the tool.",
        "preview_only" => {
            "JSON boolean. Keep true for a short preview; set false only when full content is needed."
        }
        "force_update" => {
            "JSON boolean. Set true only when existing generated files should be overwritten."
        }
        "value" => "Value to write or set.",
        "file_content" => "Full content for the supporting file being written.",
        _ => return generic_type_description(field, typ),
    };
    Some(description.to_string())
}

fn generic_type_description(field: &str, typ: Option<&str>) -> Option<String> {
    match typ {
        Some("array") => Some(format!(
            "`{field}` must be a JSON array. Use `[]` for empty and `[...]` for one or more items."
        )),
        Some("boolean") => Some(format!(
            "`{field}` must be a JSON boolean (`true` or `false`), not a string."
        )),
        Some("integer") => Some(format!(
            "`{field}` must be a JSON integer, not a quoted string."
        )),
        Some("number") => Some(format!(
            "`{field}` must be a JSON number, not a quoted string."
        )),
        _ => None,
    }
}

fn schema_type_for_description(schema: &Value) -> Option<&str> {
    let schema = first_non_null_union_branch(schema).unwrap_or(schema);
    schema_primary_type(schema)
}

fn first_non_null_union_branch(schema: &Value) -> Option<&Value> {
    schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(|v| v.as_array())
        .and_then(|options| {
            options
                .iter()
                .find(|option| schema_primary_type(option) != Some("null"))
        })
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

    let Some(expected_type) = schema_primary_type(schema) else {
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
) -> Option<Value> {
    let schema = resolve_schema(root, schema);
    if let Some(default) = schema.get("default") {
        return Some(default.clone());
    }
    if let Some(values) = schema.get("enum").and_then(|values| values.as_array()) {
        return values
            .iter()
            .find(|value| !value.is_null())
            .or_else(|| values.first())
            .cloned();
    }
    if let Some(options) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(|v| v.as_array())
    {
        return options
            .iter()
            .map(|option| resolve_schema(root, option))
            .filter(|option| schema_primary_type(option) != Some("null"))
            .find_map(|option| example_value_for_schema(option, root, field_name));
    }

    let expected_type = schema_primary_type(schema)?;
    match expected_type {
        "object" => Some(example_object_for_schema(schema, root)),
        "array" => {
            let item = schema
                .get("items")
                .and_then(|items| example_value_for_schema(items, root, field_name))
                .unwrap_or(Value::Null);
            Some(Value::Array(vec![item]))
        }
        "string" => Some(Value::String(string_example_for_field(field_name))),
        "boolean" => Some(Value::Bool(false)),
        "integer" => Some(Value::Number(0.into())),
        "number" => serde_json::Number::from_f64(0.0).map(Value::Number),
        "null" => Some(Value::Null),
        _ => None,
    }
}

fn example_object_for_schema(schema: &Value, root: &Value) -> Value {
    let Some(properties) = schema.get("properties").and_then(|props| props.as_object()) else {
        return Value::Object(serde_json::Map::new());
    };
    let mut fields: Vec<&str> = schema
        .get("required")
        .and_then(|required| required.as_array())
        .map(|required| {
            required
                .iter()
                .filter_map(|field| field.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for key in properties.keys().map(String::as_str) {
        if fields.len() >= 8 {
            break;
        }
        if !fields.contains(&key) {
            fields.push(key);
        }
    }

    let mut object = serde_json::Map::new();
    for field in fields {
        let Some(prop_schema) = properties.get(field) else {
            continue;
        };
        let value = example_value_for_schema(prop_schema, root, Some(field))
            .unwrap_or_else(|| fallback_example_for_field(field));
        object.insert(field.to_string(), value);
    }
    Value::Object(object)
}

fn fallback_example_for_field(field_name: &str) -> Value {
    Value::String(string_example_for_field(Some(field_name)))
}

fn string_example_for_field(field_name: Option<&str>) -> String {
    match field_name.unwrap_or_default() {
        "absolute_path" | "file_path" | "path" => "/absolute/path/to/file".to_string(),
        "command" | "cmd" => "echo hello".to_string(),
        "description" => "What happens if selected".to_string(),
        "header" => "choice".to_string(),
        "id" | "task_id" | "tool_call_id" => "id".to_string(),
        "label" => "Option A".to_string(),
        "pattern" | "query" => "search terms".to_string(),
        "question" => "Which option should I choose?".to_string(),
        "status" => "pending".to_string(),
        "url" => "https://example.com".to_string(),
        _ => "string".to_string(),
    }
}

fn required_schema_paths(schema: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_required_schema_paths(schema, schema, "$", 0, &mut paths);
    paths.truncate(16);
    paths
}

fn collect_required_schema_paths(
    schema: &Value,
    root: &Value,
    path: &str,
    depth: usize,
    paths: &mut Vec<String>,
) {
    if depth > 5 || paths.len() >= 16 {
        return;
    }
    let schema = resolve_schema(root, schema);
    if let Some(options) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(|v| v.as_array())
    {
        if let Some(option) = options
            .iter()
            .map(|option| resolve_schema(root, option))
            .find(|option| schema_primary_type(option) != Some("null"))
        {
            collect_required_schema_paths(option, root, path, depth + 1, paths);
        }
        return;
    }

    match schema_primary_type(schema) {
        Some("object") => {
            if let Some(required) = schema
                .get("required")
                .and_then(|required| required.as_array())
            {
                for field in required.iter().filter_map(|field| field.as_str()) {
                    let field_path = schema_child_path(path, field);
                    if !paths.contains(&field_path) {
                        paths.push(field_path);
                    }
                }
            }
            if let Some(properties) = schema.get("properties").and_then(|props| props.as_object()) {
                for (field, child_schema) in properties {
                    collect_required_schema_paths(
                        child_schema,
                        root,
                        &schema_child_path(path, field),
                        depth + 1,
                        paths,
                    );
                    if paths.len() >= 16 {
                        break;
                    }
                }
            }
        }
        Some("array") => {
            if let Some(items) = schema.get("items") {
                collect_required_schema_paths(items, root, &format!("{path}[]"), depth + 1, paths);
            }
        }
        _ => {}
    }
}

fn array_schema_paths(schema: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_array_schema_paths(schema, schema, "$", 0, &mut paths);
    paths.truncate(16);
    paths
}

fn collect_array_schema_paths(
    schema: &Value,
    root: &Value,
    path: &str,
    depth: usize,
    paths: &mut Vec<String>,
) {
    if depth > 5 || paths.len() >= 16 {
        return;
    }
    let schema = resolve_schema(root, schema);
    if let Some(options) = schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(|v| v.as_array())
    {
        if let Some(option) = options
            .iter()
            .map(|option| resolve_schema(root, option))
            .find(|option| schema_primary_type(option) != Some("null"))
        {
            collect_array_schema_paths(option, root, path, depth + 1, paths);
        }
        return;
    }

    match schema_primary_type(schema) {
        Some("array") => {
            if !paths.contains(&path.to_string()) {
                paths.push(path.to_string());
            }
            if let Some(items) = schema.get("items") {
                collect_array_schema_paths(items, root, &format!("{path}[]"), depth + 1, paths);
            }
        }
        Some("object") => {
            if let Some(properties) = schema.get("properties").and_then(|props| props.as_object()) {
                for (field, child_schema) in properties {
                    collect_array_schema_paths(
                        child_schema,
                        root,
                        &schema_child_path(path, field),
                        depth + 1,
                        paths,
                    );
                    if paths.len() >= 16 {
                        break;
                    }
                }
            }
        }
        _ => {}
    }
}

fn schema_child_path(parent: &str, field: &str) -> String {
    if parent == "$" {
        format!("$.{field}")
    } else {
        format!("{parent}.{field}")
    }
}

fn truncate_for_description(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(3);
    let mut truncated = value.chars().take(keep).collect::<String>();
    truncated.push_str("...");
    truncated
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
fn object_as_wrapped_array(map: &serde_json::Map<String, Value>) -> Option<Vec<Value>> {
    if map.len() != 1 {
        return None;
    }
    let (key, value) = map.iter().next()?;
    if !matches!(key.as_str(), "item" | "items" | "value" | "values") {
        return None;
    }
    if let Some(values) = value.as_array() {
        Some(values.clone())
    } else if value.is_null() {
        None
    } else {
        Some(vec![value.clone()])
    }
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
    fn full_registry_object_schemas_always_declare_properties() {
        let mut missing = Vec::new();
        for tool in crate::default_registry().all() {
            let schema = tool.input_schema();
            if schema.get("type").and_then(Value::as_str) == Some("object")
                && schema.get("properties").is_none()
            {
                missing.push(tool.name());
            }
        }
        assert!(missing.is_empty(), "tools missing properties: {missing:?}");
    }
}
