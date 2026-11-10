use anyhow::{Result, bail};
use jsonschema::error::{TypeKind, ValidationError, ValidationErrorKind};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const SETTINGS_SCHEMA_FILENAME: &str = "settings.schema.jsonc";
pub const SETTINGS_SCHEMA_REFERENCE: &str = "./settings.schema.jsonc";
const SETTINGS_SCHEMA_SOURCE: &str = include_str!("../settings.schema.jsonc");

static SETTINGS_SCHEMA: OnceLock<Value> = OnceLock::new();
static SETTINGS_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();

fn settings_schema() -> &'static Value {
    SETTINGS_SCHEMA.get_or_init(|| {
        jsonc_parser::parse_to_serde_value(SETTINGS_SCHEMA_SOURCE, &Default::default())
            .expect("embedded settings schema must be valid JSONC")
    })
}

/// Describe a setting from the authoritative schema without reading user values.
pub fn settings_schema_for_path(path: &str) -> Option<Value> {
    fn resolve<'a>(root: &'a Value, mut node: &'a Value) -> Option<&'a Value> {
        for _ in 0..32 {
            let Some(reference) = node.get("$ref").and_then(Value::as_str) else {
                return Some(node);
            };
            node = root.pointer(reference.strip_prefix('#')?)?;
        }
        None
    }
    let root = settings_schema();
    let mut node = root;
    for part in path.split('.') {
        if part.is_empty() {
            return None;
        }
        node = resolve(root, node)?.get("properties")?.get(part)?;
    }
    let mut result = resolve(root, node)?.clone();
    // Include only reachable definitions so nested schemas remain self-contained.
    let mut pending = vec![result.clone()];
    let mut definitions = serde_json::Map::new();
    while let Some(value) = pending.pop() {
        match value {
            Value::Object(map) => {
                if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
                    let name = reference.strip_prefix("#/$defs/")?;
                    if !definitions.contains_key(name) {
                        let definition = root.pointer(&reference[1..])?.clone();
                        definitions.insert(name.to_owned(), definition.clone());
                        pending.push(definition);
                    }
                }
                pending.extend(map.into_values());
            }
            Value::Array(items) => pending.extend(items),
            _ => {}
        }
    }
    if !definitions.is_empty() {
        result
            .as_object_mut()?
            .insert("$defs".into(), Value::Object(definitions));
    }
    Some(result)
}

/// Materialize the embedded editor schema beside the user's settings file.
///
/// The file is replaced on every startup so an installed binary cannot leave
/// an older schema behind after an upgrade.
pub fn ensure_user_settings_schema(config_dir: &Path) -> Result<PathBuf> {
    let path = config_dir.join(SETTINGS_SCHEMA_FILENAME);
    crate::loader::write_bytes_atomic(&path, SETTINGS_SCHEMA_SOURCE.as_bytes(), true)?;
    Ok(path)
}

fn settings_validator() -> Result<&'static jsonschema::Validator> {
    match SETTINGS_VALIDATOR.get_or_init(|| {
        jsonschema::validator_for(settings_schema())
            .map_err(|error| format!("embedded settings schema cannot be compiled: {error}"))
    }) {
        Ok(validator) => Ok(validator),
        Err(error) => Err(anyhow::anyhow!(error.clone())),
    }
}

pub(crate) fn validate_settings_schema(value: &Value) -> Result<()> {
    let validator = settings_validator()?;
    let errors = validator
        .iter_errors(value)
        .take(8)
        .map(format_schema_error)
        .collect::<Vec<_>>();
    if errors.is_empty() {
        // JSON Schema lengths count Unicode characters; tool identifiers are bounded in bytes.
        if let Some(studio) = value.pointer("/tools/studio") {
            let selections = serde_json::from_value::<crate::StudioToolSelections>(studio.clone())?;
            crate::validate_studio_tool_selections(&selections)?;
        }
        return Ok(());
    }

    bail!(
        "settings do not match the embedded schema:\n{}\nHint: edit the indicated settings path, then run `kcoder config validate` again.",
        errors.join("\n")
    );
}

fn format_schema_error(error: ValidationError<'_>) -> String {
    let path = error.instance_path().to_string();
    let path = if path.is_empty() {
        "<root>".to_string()
    } else {
        path
    };
    format!(
        "- {path}: {}\n  Suggestion: {}",
        error,
        schema_hint(error.kind())
    )
}

fn schema_hint(kind: &ValidationErrorKind) -> &'static str {
    match kind {
        ValidationErrorKind::AdditionalProperties { .. }
        | ValidationErrorKind::UnevaluatedProperties { .. } => {
            "Check the field name spelling; remove the field or use one of the fields listed in the schema."
        }
        ValidationErrorKind::Type { kind } => match kind {
            TypeKind::Single(_) | TypeKind::Multiple(_) => {
                "Change the value to the type required by the schema (string, number, boolean, object, or array)."
            }
        },
        ValidationErrorKind::Enum { .. } => "Choose one of the enum values allowed by the schema.",
        ValidationErrorKind::Required { .. } => "Add the required field named in the error.",
        ValidationErrorKind::Minimum { .. } | ValidationErrorKind::ExclusiveMinimum { .. } => {
            "Increase the value to at least the schema minimum."
        }
        ValidationErrorKind::Maximum { .. } | ValidationErrorKind::ExclusiveMaximum { .. } => {
            "Decrease the value to at most the schema maximum."
        }
        ValidationErrorKind::MinLength { .. } => {
            "Provide a non-empty value that meets the schema minimum length."
        }
        ValidationErrorKind::Pattern { .. } | ValidationErrorKind::Format { .. } => {
            "Match the format required by the schema."
        }
        ValidationErrorKind::MinItems { .. } => {
            "Provide at least the number of array items the schema requires."
        }
        ValidationErrorKind::MaxItems { .. } => {
            "Reduce the number of array items to stay within the schema limit."
        }
        _ => "Review the field name, type, and value range against the built-in schema.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_loader_preserves_explicit_oauth_slots_and_legacy_omission() {
        let document = serde_json::json!({"providers":{},"mcp_servers":[
            {"name":"account-a","transport":"http","url":"https://mcp.example.test/mcp","policy":{"oauth_account":"work"}},
            {"name":"account-b","transport":"http","url":"https://mcp.example.test/mcp","policy":{"oauth_account":"personal"}},
            {"name":"legacy","transport":"http","url":"https://mcp.example.test/mcp"}]});
        validate_settings_schema(&document).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join("settings.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let loaded = crate::SettingsLoader::new(&cwd)
            .with_config_dir(&profile)
            .load()
            .unwrap();
        let servers = loaded.settings.mcp_servers;
        assert_eq!(servers[0].policy.oauth_account.as_deref(), Some("work"));
        assert_eq!(servers[1].policy.oauth_account.as_deref(), Some("personal"));
        assert_eq!(servers[2].policy.oauth_account, None);
        let mut invalid = document;
        invalid["mcp_servers"][0]["policy"]["oauth_account"] = "../other".into();
        assert!(validate_settings_schema(&invalid).is_err());
    }

    #[test]
    fn embedded_schema_and_real_loader_accept_only_reviewed_application_actions() {
        let document = serde_json::json!({"providers":{},"mcp_servers":[{"name":"owned-business","command":"owned-fixture","policy":{"application_actions":{"mail_send":{"action":"mail.send","schema_sha256":"a".repeat(64),"resource_uri_input_pointer":"/uri","operation_id_input_pointer":"/operationId","input_template":{"uri":null,"operationId":null,"to":null},"fields":{"/to":{"type":"string","max_bytes":100,"allowed_values":["owned@example.invalid"]}}}}}}]});
        validate_settings_schema(&document).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("workspace");
        let config = temp.path().join("profile");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let loaded = crate::SettingsLoader::new(&cwd)
            .with_config_dir(&config)
            .load()
            .unwrap();
        let rule = &loaded.settings.mcp_servers[0].policy.application_actions["mail_send"];
        assert!(rule.action.is_effect());
        let mut invalid = document.clone();
        invalid["mcp_servers"][0]["policy"]["application_actions"]["mail_send"]["fields"]["/to"]
            ["type"] = serde_json::json!("object");
        assert!(validate_settings_schema(&invalid).is_err());
        let mut annotation = document;
        annotation["mcp_servers"][0]["policy"]["application_actions"]["mail_send"]["readOnly"] =
            serde_json::json!(true);
        assert!(validate_settings_schema(&annotation).is_err());
    }

    #[test]
    fn reviewed_original_lookup_actions_pass_both_embedded_schema_and_real_settings_loader() {
        let actions = [
            "document.read",
            "document.create",
            "document.lookup",
            "mail.list",
            "mail.read",
            "mail.attachment",
            "mail.send",
            "mail.lookup",
            "table.query",
            "table.export",
            "table.lookup",
        ];
        let mut rules = serde_json::Map::new();
        for (index, action) in actions.iter().enumerate() {
            let typed: kcoder_types::McpApplicationAction =
                serde_json::from_value(serde_json::json!(action)).unwrap();
            rules.insert(
                format!("reviewed_{index}"),
                serde_json::json!({"action":typed,"schema_sha256":"a".repeat(64),
                "resource_uri_input_pointer":"/uri","operation_id_input_pointer":"/operationId",
                "input_template":{"uri":null,"operationId":null}}),
            );
        }
        let document = serde_json::json!({"providers":{},"mcp_servers":[{"name":"owned-original-lookup","command":"owned-fixture",
            "policy":{"application_actions":rules}}]});
        validate_settings_schema(&document).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("workspace");
        let profile = temp.path().join("profile");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join("settings.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let loaded = crate::SettingsLoader::new(&cwd)
            .with_config_dir(&profile)
            .load()
            .unwrap();
        assert_eq!(
            loaded.settings.mcp_servers[0]
                .policy
                .application_actions
                .len(),
            actions.len()
        );
        for index in [2, 7, 10] {
            let action = loaded.settings.mcp_servers[0].policy.application_actions
                [&format!("reviewed_{index}")]
                .action;
            assert!(
                !action.is_effect()
                    && action.requires_operation_id()
                    && action.reconciles_effect().is_some()
            );
        }
        let mut invalid = document;
        invalid["mcp_servers"][0]["policy"]["application_actions"]["reviewed_2"]["action"] =
            serde_json::json!("document.unreviewed");
        assert!(validate_settings_schema(&invalid).is_err());
    }

    #[test]
    fn embedded_schema_and_real_loader_accept_only_explicit_resource_read_policy() {
        let document = serde_json::json!({"providers":{},"mcp_servers":[{"name":"owned-resource","command":"owned-fixture",
            "policy":{"task_resource_reads":{"read_document":{"schema_sha256":"a".repeat(64),
                "uri_input_pointer":"/uri","input_template":{"uri":null,"operation":"read"}}}}}]});
        validate_settings_schema(&document).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("workspace");
        let config = temp.path().join("profile");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("settings.json"),
            serde_json::to_vec(&document).unwrap(),
        )
        .unwrap();
        let loaded = crate::SettingsLoader::new(&cwd)
            .with_config_dir(&config)
            .load()
            .unwrap();
        let rule = &loaded.settings.mcp_servers[0].policy.task_resource_reads["read_document"];
        assert_eq!(
            rule.resource_uri(
                &"a".repeat(64),
                &serde_json::json!({"uri":"resource://one","operation":"read"})
            ),
            Some("resource://one")
        );
        let mut annotation = document.clone();
        annotation["mcp_servers"][0]["policy"]["task_resource_reads"]["read_document"]["readOnly"] =
            true.into();
        assert!(validate_settings_schema(&annotation).is_err());
        let mut missing = document.clone();
        missing["mcp_servers"][0]["policy"]["task_resource_reads"]["read_document"]
            .as_object_mut()
            .unwrap()
            .remove("schema_sha256");
        assert!(validate_settings_schema(&missing).is_err());
    }

    #[test]
    fn embedded_schema_accepts_default_document() {
        let document = jsonc_parser::parse_to_serde_value(
            include_str!("../settting_inline.jsonc"),
            &Default::default(),
        )
        .unwrap();
        validate_settings_schema(&document).unwrap();

        let development = jsonc_parser::parse_to_serde_value(
            include_str!("../setting_dev_user.jsonc"),
            &Default::default(),
        )
        .unwrap();
        validate_settings_schema(&development).unwrap();
    }

    #[test]
    fn schema_defaults_match_embedded_goal_limits() {
        let schema = settings_schema();
        assert_eq!(
            schema["properties"]["goal_max_auto_continuations"]["default"],
            serde_json::json!(8)
        );
        assert_eq!(
            schema["$defs"]["goalPro"]["properties"]["verifier_max_turns"]["default"],
            serde_json::json!(64)
        );
        assert_eq!(
            schema["$defs"]["goalPro"]["properties"]["completion_rejection_limit"]["default"],
            serde_json::json!(8)
        );
    }

    #[test]
    fn user_schema_is_replaced_with_the_embedded_source() {
        let directory = tempfile::tempdir().unwrap();
        let path = ensure_user_settings_schema(directory.path()).unwrap();
        assert_eq!(path.file_name().unwrap(), SETTINGS_SCHEMA_FILENAME);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            SETTINGS_SCHEMA_SOURCE
        );

        std::fs::write(&path, "stale schema").unwrap();
        ensure_user_settings_schema(directory.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            SETTINGS_SCHEMA_SOURCE
        );
    }

    #[test]
    fn schema_error_names_path_and_action() {
        let error = validate_settings_schema(&serde_json::json!({
            "permision_mode": "yolo"
        }))
        .unwrap_err()
        .to_string();
        assert!(error.contains("permision_mode"), "{error}");
        assert!(error.contains("spelling"), "{error}");
    }

    #[test]
    fn schema_rejects_unsafe_plugin_policy_identity() {
        let error = validate_settings_schema(&serde_json::json!({
            "plugins": {
                "installed": {
                    "demo..escape@local": { "enabled": false }
                }
            }
        }))
        .unwrap_err();

        assert!(error.to_string().contains("plugins"));
    }

    #[test]
    fn schema_rejects_marketplace_without_typed_source() {
        let error = validate_settings_schema(&serde_json::json!({
            "plugins": {
                "marketplaces": {
                    "team-tools": {
                        "enabled": true,
                        "source": {"path": "/tmp/marketplace.json"}
                    }
                }
            }
        }))
        .unwrap_err();

        assert!(error.to_string().contains("source"));
    }
}
