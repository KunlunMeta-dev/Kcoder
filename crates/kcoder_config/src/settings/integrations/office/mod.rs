//! Office settings and bounded input schemas. Configuration never grants authority.
mod templates;
pub use templates::{
    BUILTIN_OFFICE_ASSISTANT_VERSION, builtin_octop_assistants, builtin_octop_package,
    builtin_office_assistant, builtin_office_assistant_version, builtin_office_assistants,
};

use anyhow::{Result, ensure};
use kcoder_types::integrations::office::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct OfficeSettings {
    pub enabled: bool,
    pub allow_organization_templates: bool,
    pub allow_external_delivery: bool,
    pub allowed_formats: Vec<OfficeFileFormat>,
    pub max_output_bytes: u64,
    pub max_dataset_rows: usize,
    pub dataset_page_rows: usize,
    pub projection_preview_chars: usize,
    pub generation_timeout_ms: u64,
}
impl Default for OfficeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            allow_organization_templates: false,
            allow_external_delivery: false,
            allowed_formats: vec![
                OfficeFileFormat::Docx,
                OfficeFileFormat::Xlsx,
                OfficeFileFormat::Pptx,
                OfficeFileFormat::Csv,
                OfficeFileFormat::Json,
            ],
            max_output_bytes: OFFICE_MAX_ARTIFACT_BYTES,
            max_dataset_rows: OFFICE_MAX_DATASET_ROWS,
            dataset_page_rows: 100,
            projection_preview_chars: 2000,
            generation_timeout_ms: 30_000,
        }
    }
}
impl OfficeSettings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.allowed_formats.is_empty() && self.allowed_formats.len() <= 6,
            "OFFICE_INVALID_FORMAT_POLICY"
        );
        ensure!(
            self.max_output_bytes > 0 && self.max_output_bytes <= OFFICE_MAX_ARTIFACT_BYTES,
            "OFFICE_INVALID_OUTPUT_LIMIT"
        );
        ensure!(
            self.max_dataset_rows > 0 && self.max_dataset_rows <= OFFICE_MAX_DATASET_ROWS,
            "OFFICE_INVALID_DATASET_LIMIT"
        );
        ensure!(
            self.dataset_page_rows > 0 && self.dataset_page_rows <= 100,
            "OFFICE_INVALID_PAGE_LIMIT"
        );
        ensure!(
            self.projection_preview_chars >= 128 && self.projection_preview_chars <= 8000,
            "OFFICE_INVALID_PROJECTION_LIMIT"
        );
        ensure!(
            self.generation_timeout_ms > 0 && self.generation_timeout_ms <= 60_000,
            "OFFICE_INVALID_WAIT_BUDGET"
        );
        Ok(())
    }
}

/// Return stable error categories only; validation must not echo private input values.
pub fn validate_office_definition(definition: &OfficeAssistantDefinition) -> Result<()> {
    definition.validate()?;
    inspect_schema(&definition.input_schema, 0)?;
    office_validator(&definition.input_schema)
        .map_err(|_| anyhow::anyhow!("OFFICE_INVALID_INPUT_SCHEMA"))?;
    Ok(())
}

pub fn prepare_office_inputs(
    definition: &OfficeAssistantDefinition,
    inputs: &Value,
) -> Result<Value> {
    validate_office_definition(definition)?;
    prepare_office_schema_inputs(&definition.input_schema, inputs)
}

pub fn validate_office_schema(schema: &Value) -> Result<()> {
    ensure!(
        serde_json::to_vec(schema)?.len() <= 16 * 1024,
        "OFFICE_INVALID_INPUT_SCHEMA"
    );
    inspect_schema(schema, 0)?;
    office_validator(schema).map_err(|_| anyhow::anyhow!("OFFICE_INVALID_INPUT_SCHEMA"))?;
    Ok(())
}

pub fn prepare_office_schema_inputs(schema: &Value, inputs: &Value) -> Result<Value> {
    ensure!(
        serde_json::to_vec(schema)?.len() <= 16 * 1024,
        "OFFICE_INVALID_INPUT_SCHEMA"
    );
    inspect_schema(schema, 0)?;
    ensure!(
        serde_json::to_vec(inputs)?.len() <= 128 * 1024,
        "OFFICE_INPUT_TOO_LARGE"
    );
    let mut prepared = inputs.clone();
    apply_defaults(schema, &mut prepared, 0)?;
    let validator =
        office_validator(schema).map_err(|_| anyhow::anyhow!("OFFICE_INVALID_INPUT_SCHEMA"))?;
    ensure!(
        validator.is_valid(&prepared),
        "OFFICE_INPUT_SCHEMA_MISMATCH"
    );
    ensure!(
        serde_json::to_vec(&prepared)?.len() <= 128 * 1024,
        "OFFICE_INPUT_TOO_LARGE"
    );
    Ok(prepared)
}

fn office_validator(
    schema: &Value,
) -> std::result::Result<jsonschema::Validator, jsonschema::ValidationError<'_>> {
    jsonschema::options()
        .with_pattern_options(
            jsonschema::PatternOptions::regex()
                .size_limit(1024 * 1024)
                .dfa_size_limit(1024 * 1024),
        )
        .build(schema)
}
fn inspect_schema(value: &Value, depth: usize) -> Result<()> {
    fn inspect(
        root: &Value,
        value: &Value,
        depth: usize,
        active: &mut std::collections::HashSet<String>,
        visits: &mut usize,
    ) -> Result<()> {
        ensure!(depth <= 32 && *visits < 4096, "OFFICE_SCHEMA_DEPTH_LIMIT");
        *visits += 1;
        match value {
            Value::Object(object) => {
                ensure!(
                    !object.contains_key("$dynamicRef") && !object.contains_key("$recursiveRef"),
                    "OFFICE_INVALID_INPUT_SCHEMA"
                );
                if let Some(reference) = object.get("$ref") {
                    let reference = reference
                        .as_str()
                        .filter(|reference| reference.starts_with("#/"))
                        .ok_or_else(|| {
                            anyhow::anyhow!("OFFICE_EXTERNAL_SCHEMA_REFERENCE_DENIED")
                        })?;
                    ensure!(
                        active.insert(reference.into()),
                        "OFFICE_INVALID_INPUT_SCHEMA"
                    );
                    let target = root
                        .pointer(&reference[1..])
                        .ok_or_else(|| anyhow::anyhow!("OFFICE_INVALID_INPUT_SCHEMA"))?;
                    inspect(root, target, depth + 1, active, visits)?;
                    active.remove(reference);
                }
                for child in object.values() {
                    inspect(root, child, depth + 1, active, visits)?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    inspect(root, child, depth + 1, active, visits)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    inspect(
        value,
        value,
        depth,
        &mut std::collections::HashSet::new(),
        &mut 0,
    )
}

/// Apply literal property defaults only. JSON Schema reference/branch annotations
/// are not evaluated as executable default programs.
fn apply_defaults(schema: &Value, value: &mut Value, depth: usize) -> Result<()> {
    ensure!(depth <= 32, "OFFICE_SCHEMA_DEPTH_LIMIT");
    if let (Some(properties), Some(object)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object_mut(),
    ) {
        for (name, child_schema) in properties {
            if !object.contains_key(name)
                && let Some(default) = child_schema.get("default")
            {
                object.insert(name.clone(), default.clone());
            }
            if let Some(child) = object.get_mut(name) {
                apply_defaults(child_schema, child, depth + 1)?;
            }
        }
    }
    if let (Some(item_schema), Some(array)) = (schema.get("items"), value.as_array_mut()) {
        for item in array {
            apply_defaults(item_schema, item, depth + 1)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn current_and_legacy_templates_validate_in_both_locales() {
        for language in ["zh-CN", "en"] {
            let definitions = builtin_office_assistants(language);
            assert_eq!(definitions.len(), 9);
            for definition in &definitions {
                validate_office_definition(definition).unwrap();
            }
            for definition in definitions.iter().skip(1) {
                let legacy =
                    builtin_office_assistant_version(&definition.id, language, "1").unwrap();
                validate_office_definition(&legacy).unwrap();
                assert!(legacy.input_schema["properties"].get("request").is_none());
            }
        }
    }

    #[test]
    fn required_materials_and_literal_defaults_are_real_input_checks() {
        let definition =
            builtin_office_assistant_version("builtin.meeting-minutes", "zh-CN", "1").unwrap();
        assert!(prepare_office_inputs(&definition, &json!({"title":"会议"})).is_err());
        let value = prepare_office_inputs(
            &definition,
            &json!({"title":"会议","materialRefs":["input@1"]}),
        )
        .unwrap();
        assert_eq!(value["outputLanguage"], "zh-CN");
        assert!(
            prepare_office_inputs(
                &definition,
                &json!({"title":"会议","materialRefs":[],"admin":true})
            )
            .is_err()
        );
    }

    #[test]
    fn current_templates_accept_a_natural_request_without_fabricating_materials_or_columns() {
        for language in ["zh-CN", "en"] {
            for definition in builtin_office_assistants(language) {
                let inputs = prepare_office_inputs(
                    &definition,
                    &json!({"request":"介绍北京，写一份适合初次到访者的简明指南"}),
                )
                .unwrap();
                assert_eq!(inputs["materialRefs"], json!([]));
                assert!(inputs.get("sourceText").is_none());
                for field in [
                    "title",
                    "keyColumn",
                    "compareColumns",
                    "period",
                    "audience",
                    "slideCount",
                ] {
                    assert!(inputs.get(field).is_none(), "invented field {field}");
                }
                assert_eq!(inputs["outputLanguage"], language);
            }
        }
    }

    #[test]
    fn simple_input_keeps_whitespace_unknown_fields_and_material_types_invalid() {
        let definition = builtin_office_assistant("builtin.office-task", "zh-CN").unwrap();
        for invalid in [
            json!({}),
            json!({"request":" \n\t"}),
            json!({"request":"Write a report","admin":true}),
            json!({"request":"Write a report","materialRefs":[{"id":"fake"}]}),
            json!({"request":"Write a report","materialRefs":[""]}),
        ] {
            assert!(prepare_office_inputs(&definition, &invalid).is_err());
        }
        let valid = prepare_office_inputs(
            &definition,
            &json!({
                "request":"Compare these files", "materialRefs":["actual-input-1"],
                "keyColumn":"Invoice ID", "compareColumns":["Amount"],
                "sourceText":"Original supplied notes"
            }),
        );
        // The generic assistant has no reconciliation-only fields.
        assert!(valid.is_err());
        let reconciliation =
            builtin_office_assistant("builtin.spreadsheet-reconciliation", "en").unwrap();
        let inputs = json!({"request":"Compare these files","materialRefs":["actual-input-1"],"keyColumn":"Invoice ID","compareColumns":["Amount"]});
        assert_eq!(
            prepare_office_inputs(&reconciliation, &inputs).unwrap()["keyColumn"],
            "Invoice ID"
        );
    }

    #[test]
    fn old_versions_retain_required_columns_and_never_resolve_to_current_definitions() {
        let old = builtin_office_assistant_version("builtin.spreadsheet-reconciliation", "en", "1")
            .unwrap();
        assert!(
            prepare_office_inputs(&old, &json!({"title":"Compare","materialRefs":["input-1"]}))
                .is_err()
        );
        assert!(prepare_office_inputs(&old, &json!({"title":"Compare","materialRefs":["input-1"],"keyColumn":"ID","compareColumns":["Amount"]})).is_ok());
        assert!(builtin_office_assistant_version("builtin.office-task", "en", "1").is_none());
        assert!(builtin_office_assistant_version("builtin.meeting-minutes", "en", "3").is_none());
        let mut custom = builtin_office_assistant("builtin.office-task", "en").unwrap();
        custom.id = "personal.strict".into();
        custom.input_schema = json!({"type":"object","properties":{"requiredField":{"type":"string"}},"required":["requiredField"],"additionalProperties":false});
        assert!(prepare_office_inputs(&custom, &json!({"request":"Do something"})).is_err());
    }

    #[test]
    fn settings_cannot_escalate_limits_or_resolve_external_schema_urls() {
        let mut settings = OfficeSettings::default();
        settings.dataset_page_rows = 101;
        assert!(settings.validate().is_err());
        let mut definition = builtin_office_assistant("builtin.meeting-minutes", "en").unwrap();
        definition.input_schema = json!({"$ref":"https://example.invalid/private"});
        assert!(validate_office_definition(&definition).is_err());
    }
}

#[cfg(test)]
mod schema_safety_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cyclic_external_and_backtracking_schemas_are_not_executed() {
        assert!(prepare_office_schema_inputs(&json!({"$ref":"#"}), &json!({})).is_err());
        assert!(
            prepare_office_schema_inputs(
                &json!({"definitions":{"A":{"$ref":"#/definitions/A"}},"$ref":"#/definitions/A"}),
                &json!({})
            )
            .is_err()
        );
        assert!(
            prepare_office_schema_inputs(
                &json!({"$dynamicRef":"https://example.invalid/private"}),
                &json!({})
            )
            .is_err()
        );
        assert!(
            prepare_office_schema_inputs(
                &json!({"type":"string","pattern":"(?=private).*"}),
                &json!("private")
            )
            .is_err()
        );
        assert_eq!(
            prepare_office_schema_inputs(
                &json!({"type":"string","pattern":"^[A-Z]{2}[0-9]{2}$"}),
                &json!("AB12")
            )
            .unwrap(),
            json!("AB12")
        );
    }
}
