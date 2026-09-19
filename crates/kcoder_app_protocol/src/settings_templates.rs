//! Wire types for session-level settings templates (`settings/templates/*`).
//!
//! A template is a JSONC settings overlay frozen into one conversation at
//! `thread/start` time; the store itself lives in the app-server process.

use serde::{Deserialize, Serialize};

/// One saved template as shown in the settings catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateSummary {
    /// Stable slug (`[a-z0-9-]{1,64}`), unique inside the template store.
    pub id: String,
    /// Display name; may repeat across templates.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub updated_at: String,
    pub size_bytes: u64,
    /// Content digest used to detect drift between sessions and the store.
    pub revision_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateReadParams {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateReadResult {
    pub summary: SettingsTemplateSummary,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateSaveParams {
    /// Existing id to overwrite; absent derives a fresh slug from `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSONC overlay content, validated before it is persisted.
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateSaveResult {
    pub template: SettingsTemplateSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateDeleteParams {
    pub id: String,
}

/// Sets (or with `null`/absent id clears) the default new-session template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsTemplateDefaultParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplatesListResult {
    pub templates: Vec<SettingsTemplateSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

/// Result of delete/default: the refreshed catalog in one round trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplatesMutationResult {
    pub templates: Vec<SettingsTemplateSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_id: Option<String>,
}

/// Frozen template identity recorded on a thread for resume drift checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTemplateBinding {
    pub id: String,
    pub revision_sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_summary_wire_shape_is_camel_case_and_optional_description_is_omitted() {
        let summary = SettingsTemplateSummary {
            id: "fast-local".into(),
            name: "Fast local".into(),
            description: None,
            updated_at: "2026-09-18T00:00:00Z".into(),
            size_bytes: 512,
            revision_sha256: "abc".into(),
        };
        let wire = serde_json::to_value(&summary).unwrap();
        assert_eq!(wire["id"], "fast-local");
        assert_eq!(wire["updatedAt"], "2026-09-18T00:00:00Z");
        assert_eq!(wire["sizeBytes"], 512);
        assert_eq!(wire["revisionSha256"], "abc");
        assert!(wire.get("description").is_none());
        let back: SettingsTemplateSummary = serde_json::from_value(wire).unwrap();
        assert_eq!(back, summary);
    }

    #[test]
    fn save_params_make_id_and_description_optional_and_reject_unknown_fields() {
        let params: SettingsTemplateSaveParams = serde_json::from_value(serde_json::json!({
            "name": "Fast local",
            "content": "{}\n"
        }))
        .unwrap();
        assert!(params.id.is_none());
        assert!(params.description.is_none());
        let err = serde_json::from_value::<SettingsTemplateSaveParams>(serde_json::json!({
            "name": "x",
            "content": "{}",
            "bogus": 1
        }))
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"), "{err}");
    }

    #[test]
    fn default_params_accept_null_and_absent_id_as_clear() {
        let clear: SettingsTemplateDefaultParams =
            serde_json::from_value(serde_json::json!({ "id": null })).unwrap();
        assert!(clear.id.is_none());
        let absent: SettingsTemplateDefaultParams =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(absent.id.is_none());
        let set: SettingsTemplateDefaultParams =
            serde_json::from_value(serde_json::json!({ "id": "fast-local" })).unwrap();
        assert_eq!(set.id.as_deref(), Some("fast-local"));
    }

    #[test]
    fn list_and_read_results_carry_default_id_only_when_set() {
        let list = SettingsTemplatesListResult {
            templates: Vec::new(),
            default_id: None,
        };
        let wire = serde_json::to_value(&list).unwrap();
        assert!(wire.get("defaultId").is_none());
        assert_eq!(wire["templates"], serde_json::json!([]));

        let read = SettingsTemplateReadResult {
            summary: SettingsTemplateSummary {
                id: "fast-local".into(),
                name: "Fast local".into(),
                description: Some("tiny ctx".into()),
                updated_at: "2026-09-18T00:00:00Z".into(),
                size_bytes: 512,
                revision_sha256: "abc".into(),
            },
            content: "{ }".into(),
            default_id: Some("fast-local".into()),
        };
        let wire = serde_json::to_value(&read).unwrap();
        assert_eq!(wire["defaultId"], "fast-local");
        assert_eq!(wire["content"], "{ }");
        assert_eq!(wire["summary"]["description"], "tiny ctx");
    }

    #[test]
    fn mutation_result_reports_the_refreshed_catalog() {
        let result = SettingsTemplatesMutationResult {
            templates: Vec::new(),
            default_id: Some("fast-local".into()),
        };
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["defaultId"], "fast-local");
        assert_eq!(wire["templates"], serde_json::json!([]));
    }

    #[test]
    fn thread_binding_round_trips_with_revision() {
        let binding = SettingsTemplateBinding {
            id: "fast-local".into(),
            revision_sha256: "abc".into(),
        };
        let wire = serde_json::to_value(&binding).unwrap();
        assert_eq!(wire["id"], "fast-local");
        assert_eq!(wire["revisionSha256"], "abc");
        let back: SettingsTemplateBinding = serde_json::from_value(wire).unwrap();
        assert_eq!(back, binding);
    }

    #[test]
    fn method_names_are_stable() {
        use crate::method;
        assert_eq!(method::SETTINGS_TEMPLATES_LIST, "settings/templates/list");
        assert_eq!(method::SETTINGS_TEMPLATES_READ, "settings/templates/read");
        assert_eq!(method::SETTINGS_TEMPLATES_SAVE, "settings/templates/save");
        assert_eq!(
            method::SETTINGS_TEMPLATES_DELETE,
            "settings/templates/delete"
        );
        assert_eq!(
            method::SETTINGS_TEMPLATES_DEFAULT,
            "settings/templates/default"
        );
    }
}
