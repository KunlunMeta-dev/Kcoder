//! Product-level default validation. JSON Schema treats default as an annotation;
//! workflows apply these values, so reject incompatible defaults before saving.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

pub(crate) fn validate(root: &Value) -> Result<()> {
    let mut defaults = Vec::new();
    collect(root, "", &mut defaults)?;
    if defaults.is_empty() {
        return Ok(());
    }
    let registry = jsonschema::Registry::new()
        .add("urn:kcoder:workflow-defaults", root.clone())?
        .prepare()?;
    for (pointer, value) in defaults {
        let fragment: String = pointer
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"/~_-.".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        let reference = json!({"$ref":format!("urn:kcoder:workflow-defaults#{fragment}")});
        let validator = jsonschema::options()
            .with_registry(&registry)
            .with_pattern_options(
                jsonschema::PatternOptions::regex()
                    .size_limit(262_144)
                    .dfa_size_limit(262_144),
            )
            .build(&reference)
            .with_context(|| format!("input_schema{pointer}: default validation failed"))?;
        if let Some(error) = validator.iter_errors(value).next() {
            anyhow::bail!(
                "workflow_schema: input_schema{pointer}/default does not match its schema at {} ({})",
                error.instance_path(),
                error.to_string().chars().take(400).collect::<String>()
            );
        }
    }
    Ok(())
}
fn escaped(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}
fn collect<'a>(
    schema: &'a Value,
    path: &str,
    defaults: &mut Vec<(String, &'a Value)>,
) -> Result<()> {
    let Some(map) = schema.as_object() else {
        return Ok(());
    };
    if let Some(value) = map.get("default") {
        ensure!(
            defaults.len() < 128,
            "workflow_schema: at most 128 defaults are supported"
        );
        defaults.push((path.to_string(), value));
    }
    for key in [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
        "dependencies",
    ] {
        if let Some(children) = map.get(key).and_then(Value::as_object) {
            for (name, child) in children {
                collect(child, &format!("{path}/{key}/{}", escaped(name)), defaults)?;
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
        "allOf",
        "anyOf",
        "oneOf",
        "prefixItems",
    ] {
        if let Some(child) = map.get(key) {
            if let Some(children) = child.as_array() {
                for (index, child) in children.iter().enumerate() {
                    collect(child, &format!("{path}/{key}/{index}"), defaults)?;
                }
            } else {
                collect(child, &format!("{path}/{key}"), defaults)?;
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_default_types_and_keeps_literal_data_opaque() {
        for (typ, value) in [
            ("integer", json!("3")),
            ("boolean", json!("true")),
            ("array", json!({"item":[1,2]})),
        ] {
            let error = validate(
                &json!({"type":"object","properties":{"field":{"type":typ,"default":value}}}),
            )
            .unwrap_err();
            assert!(
                error.to_string().contains("/properties/field/default"),
                "{error}"
            );
        }
        validate(&json!({"type":"object","properties":{"data":{"type":"object","default":{"type":"integer","default":"literal data"}}}})).unwrap();
    }
    #[test]
    fn validates_local_refs_and_escaped_unicode_property_names() {
        let mut schema = json!({"type":"object","$defs":{"Count":{"type":"integer","minimum":1}},"properties":{"天/数~":{"$ref":"#/$defs/Count","default":3}}});
        validate(&schema).unwrap();
        schema["properties"]["天/数~"]["default"] = json!(0);
        assert!(
            validate(&schema)
                .unwrap_err()
                .to_string()
                .contains("/properties/天~1数~0/default")
        );
    }
}
