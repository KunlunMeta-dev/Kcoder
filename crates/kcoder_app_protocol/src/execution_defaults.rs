//! Wire types for target-level defaults applied when a new conversation starts.

use serde::{Deserialize, Serialize};

/// Permission policy that can be configured as a target's new-session default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPermissionMode {
    Ask,
    Auto,
    AcceptEdits,
    DontAsk,
    Bypass,
    Yolo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDefaultsReadResult {
    /// Explicit value from the target user's settings file, if present.
    pub persisted_permission_mode: Option<ExecutionPermissionMode>,
    /// Value currently resolved for a newly created conversation.
    pub effective_permission_mode: ExecutionPermissionMode,
    /// A command-line permission override, when one was supplied.
    pub cli_permission_mode_override: Option<ExecutionPermissionMode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionDefaultsSaveParams {
    /// `null` removes the explicit target-user setting and follows lower layers.
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_permission_mode_schema")
    )]
    pub permission_mode: Option<ExecutionPermissionMode>,
}

#[cfg(feature = "json-schema")]
fn nullable_permission_mode_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<ExecutionPermissionMode> as schemars::JsonSchema>::json_schema(generator)
}

fn deserialize_required_nullable<'de, D>(
    deserializer: D,
) -> Result<Option<ExecutionPermissionMode>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<ExecutionPermissionMode>::deserialize(deserializer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_modes_use_existing_config_wire_values() {
        let modes = [
            (ExecutionPermissionMode::Ask, "ask"),
            (ExecutionPermissionMode::Auto, "auto"),
            (ExecutionPermissionMode::AcceptEdits, "accept_edits"),
            (ExecutionPermissionMode::DontAsk, "dont_ask"),
            (ExecutionPermissionMode::Bypass, "bypass"),
            (ExecutionPermissionMode::Yolo, "yolo"),
        ];
        for (mode, expected) in modes {
            assert_eq!(serde_json::to_value(mode).unwrap(), expected);
            assert_eq!(
                serde_json::from_value::<ExecutionPermissionMode>(expected.into()).unwrap(),
                mode
            );
        }
    }

    #[test]
    fn read_result_keeps_unset_and_cli_override_explicit() {
        let result = ExecutionDefaultsReadResult {
            persisted_permission_mode: None,
            effective_permission_mode: ExecutionPermissionMode::Ask,
            cli_permission_mode_override: Some(ExecutionPermissionMode::Bypass),
        };
        let wire = serde_json::to_value(result).unwrap();
        assert_eq!(wire["persistedPermissionMode"], serde_json::Value::Null);
        assert_eq!(wire["effectivePermissionMode"], "ask");
        assert_eq!(wire["cliPermissionModeOverride"], "bypass");
        assert!(
            serde_json::from_value::<ExecutionDefaultsSaveParams>(serde_json::json!({
                "permissionMode": "default"
            }))
            .is_err()
        );
    }

    #[test]
    fn save_null_means_clear_and_rejects_unknown_fields() {
        let clear: ExecutionDefaultsSaveParams =
            serde_json::from_value(serde_json::json!({ "permissionMode": null })).unwrap();
        assert_eq!(clear.permission_mode, None);
        assert!(
            serde_json::from_value::<ExecutionDefaultsSaveParams>(serde_json::json!({})).is_err()
        );
        let bad = serde_json::from_value::<ExecutionDefaultsSaveParams>(serde_json::json!({
            "permissionMode": "auto",
            "workspacePath": "/should/not/be/accepted"
        }));
        assert!(bad.is_err());
    }

    #[cfg(feature = "json-schema")]
    #[test]
    fn save_schema_requires_nullable_permission_mode() {
        let schema =
            serde_json::to_value(schemars::schema_for!(ExecutionDefaultsSaveParams)).unwrap();
        let required = schema["required"].as_array().unwrap();
        assert!(required.contains(&serde_json::json!("permissionMode")));
        let nullable = schema["properties"]["permissionMode"]["anyOf"]
            .as_array()
            .unwrap()
            .iter()
            .any(|branch| branch["type"] == "null");
        assert!(
            nullable,
            "the required property schema must still accept null"
        );
    }
}
