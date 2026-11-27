//! Unified, read-only extension inventory and same-name skill source preference.
//!
//! The inventory projects what the selected target's app-server actually
//! resolves: every skill copy (effective or shadowed), MCP servers including
//! plugin-contributed and policy-disabled ones (never started), Hook sources,
//! plugins and, only when explicitly requested, CLI binaries on the target's
//! `PATH`. Clients must observe `extensionsInventoryV1` before calling these
//! methods; plugin install/read responses carry `extensionConflicts` only for
//! connections that declared the same capability during `initialize`.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CAPABILITY_EXTENSIONS_INVENTORY_V1: &str = "extensionsInventoryV1";
/// Server support for `plugin/skills/setEnabled` and the plugin items'
/// `skillsEnabled`/`skillPolicyRevision` fields. Independent of
/// `extensionsInventoryV1`; clients must observe it before calling the method.
pub const CAPABILITY_PLUGIN_SKILL_POLICY_V1: &str = "pluginSkillPolicyV1";
/// `error.data.kind` when `expectedRevision` no longer matches the user setting.
pub const PLUGIN_SKILL_POLICY_CONFLICT: &str = "plugin_skill_policy_conflict";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExtensionItemKind {
    Skill,
    McpServer,
    Hook,
    Plugin,
    Binary,
}

/// Discovery layer. Skill precedence (low to high): plugin, builtin/bundled,
/// preferred plugin, project, external, user; `runtime` is the separate
/// `expert:` namespace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExtensionLayer {
    Builtin,
    Bundled,
    Project,
    External,
    Plugin,
    User,
    Runtime,
}

/// Why an item is not enabled. `name` is a by-name switch (`skills/setEnabled`,
/// `mcp/setEnabled`), `plugin` the owning plugin or its component switch,
/// `policy` a settings policy (per-server plugin policy, training isolation),
/// `trust` an untrusted project directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExtensionDisabledBy {
    Name,
    Plugin,
    Policy,
    Trust,
}

/// Identity of another copy, used by `shadowedBy` and `shadows`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionSourceRef {
    pub layer: ExtensionLayer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_plugin_id: Option<String>,
    /// Display path, with the target home directory shown as `~`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Declared upstream identity; never inferred from content hashes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionUpstream {
    /// Repository URL from `UPSTREAM.md` or the plugin manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// Upstream tag, or commit when no tag is recorded.
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionInventoryItem {
    /// Stable key unique within one response.
    pub id: String,
    pub kind: ExtensionItemKind,
    pub name: String,
    pub layer: ExtensionLayer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace_id: Option<String>,
    /// Display path, with the target home directory shown as `~`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_by: Option<ExtensionDisabledBy>,
    /// This copy is what new conversations use. Shadowed and disabled copies are false.
    pub effective: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowed_by: Option<ExtensionSourceRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shadows: Vec<ExtensionSourceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<ExtensionUpstream>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Skill copies only: `skills.source_preference` selects this plugin copy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub preferred: bool,
    /// Skills: shared name prefix of a bundled family (for example `lark`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    /// MCP transport, Hook event or binary role, depending on `kind`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Hooks: number of matchers; plugins: number of contributed components.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// Binaries: the copy shipped with KCoder Studio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled: Option<bool>,
    /// Installed plugins with skills (`pluginSkillPolicyV1`): whether the
    /// plugin's own skill copies are enabled (`plugins.installed.<id>.skills.enabled`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills_enabled: Option<bool>,
    /// Installed plugins with skills: pass as `expectedRevision` to
    /// `plugin/skills/setEnabled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_policy_revision: Option<String>,
    /// Skills: server-provided self-evolution target key
    /// (`skill:<provenance origin>:<name>`); clients never construct it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_key: Option<kcoder_types::evolution::TargetKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExtensionConflictReason {
    /// Several copies share one name; only `effective` is used.
    SameName,
    /// A plugin provides only part of a bundled family, or mixes versions.
    MixedFamily,
    /// Several executables with this name are on `PATH`.
    MultipleBinaries,
    /// The resolved binary differs from the version bundled with KCoder.
    VersionMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionConflict {
    pub kind: ExtensionItemKind,
    pub reason: ExtensionConflictReason,
    /// Item name, or the family prefix for `mixed_family`.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective: Option<ExtensionSourceRef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shadowed: Vec<ExtensionSourceRef>,
    /// All copies declare the same upstream repository (for example larksuite/cli).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub same_upstream: bool,
    /// `mixed_family`: the plugin involved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    /// `mixed_family`: bundled family names the plugin also provides.
    /// `version_mismatch`: the resolved binary version.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provided: Vec<String>,
    /// `mixed_family`: bundled family names the plugin does not provide.
    /// `version_mismatch`: the version bundled with KCoder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    /// `mixed_family`: provided names currently effective from the plugin.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effective_from_plugin: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExtensionIssueSeverity {
    /// The rule fails closed: it blocks its event instead of running.
    Error,
    /// The configuration loads, but part of it is ignored.
    Warning,
}

/// A Hook configuration problem found while parsing (nothing is executed).
/// Messages are redacted; commands, URLs and headers are never echoed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionHookIssue {
    pub layer: ExtensionLayer,
    /// Display path of the settings file.
    pub path: String,
    /// JSON location, for example `hooks.PreToolUse[1].hooks[0]`.
    pub location: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    pub severity: ExtensionIssueSeverity,
    pub message: String,
}

/// `skills.source_preference` of the selected target's user settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionSkillPreference {
    /// Skill name to plugin ID whose copy wins over the built-in/bundled copy.
    #[serde(default)]
    pub prefer_plugin_skills: BTreeMap<String, String>,
    /// Plugin IDs whose every skill wins over built-in/bundled copies.
    #[serde(default)]
    pub prefer_plugins: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionsInventoryParams {
    /// Resolve `lark-cli`, `node` and `playwright-mcp` on the target `PATH` and
    /// run bounded `--version` probes. Never set this on polling paths.
    #[serde(default)]
    pub include_binaries: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionsInventoryResult {
    pub items: Vec<ExtensionInventoryItem>,
    pub conflicts: Vec<ExtensionConflict>,
    /// User and project Hook configuration problems, including untrusted projects.
    #[serde(default)]
    pub hook_issues: Vec<ExtensionHookIssue>,
    pub skill_preference: ExtensionSkillPreference,
    /// Pass as `expectedRevision` to `extensions/skillPreference/update`.
    pub skill_preference_revision: String,
    pub binaries_included: bool,
    pub applies_to_new_conversations: bool,
    /// The target accepts `plugin/skills/setEnabled` (mirrors the
    /// `pluginSkillPolicyV1` capability); absent from older targets.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plugin_skill_policy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionSkillPreferenceUpdateParams {
    pub expected_revision: String,
    pub preference: ExtensionSkillPreference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionSkillPreferenceResult {
    pub preference: ExtensionSkillPreference,
    pub revision: String,
    pub applies_to_new_conversations: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionConflictsPreviewParams {
    /// Installed or discovered plugin whose components are checked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    /// Names declared by a plugin that is not installed yet.
    #[serde(default)]
    pub skill_names: Vec<String>,
    #[serde(default)]
    pub mcp_server_names: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ExtensionConflictOutcome {
    /// No other copy of this name.
    None,
    /// Another server with this name stays available alongside (MCP names are namespaced).
    Coexists,
    /// An existing copy stays effective; the plugin copy would be shadowed.
    ShadowedByExisting,
    /// The plugin copy would replace the existing effective copy.
    ShadowsExisting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionConflictPreviewEntry {
    pub kind: ExtensionItemKind,
    pub name: String,
    pub outcome: ExtensionConflictOutcome,
    /// The copy that is effective now, excluding the previewed plugin's own copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing: Option<ExtensionSourceRef>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub same_upstream: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionConflictsPreviewResult {
    pub entries: Vec<ExtensionConflictPreviewEntry>,
    /// Family-level findings such as a partial `lark-*` set.
    pub conflicts: Vec<ExtensionConflict>,
}

/// `plugin/skills/setEnabled`: turn one installed plugin's skills on or off in
/// the selected target's user settings. Other copies of the same names, the
/// plugin's MCP servers and Hooks are unaffected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionPluginSkillsSetEnabledParams {
    pub plugin_id: String,
    pub enabled: bool,
    /// `skillPolicyRevision` from `extensions/inventory`. When present, a
    /// changed setting fails with `plugin_skill_policy_conflict` instead of
    /// being overwritten.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionPluginSkillsResult {
    pub plugin_id: String,
    pub skills_enabled: bool,
    /// Revision of the setting after this request.
    pub revision: String,
    /// False when the setting already had the requested value.
    pub changed: bool,
    /// Plugin store generation after this request.
    pub generation: u64,
    /// Running conversations keep the skill catalog they started with.
    pub applies_to_new_conversations: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inventory_params_default_to_no_binary_probe_and_reject_caller_paths() {
        let params: ExtensionsInventoryParams = serde_json::from_value(json!({})).unwrap();
        assert!(!params.include_binaries);
        for extra in ["path", "profile", "target"] {
            let mut value = json!({"includeBinaries": true});
            value[extra] = "caller".into();
            assert!(serde_json::from_value::<ExtensionsInventoryParams>(value).is_err());
        }
    }

    #[test]
    fn inventory_items_use_stable_camel_case_and_snake_case_enums() {
        let item = ExtensionInventoryItem {
            id: "skill:plugin:lark@trae:lark-doc".into(),
            kind: ExtensionItemKind::Skill,
            name: "lark-doc".into(),
            layer: ExtensionLayer::Plugin,
            owner_plugin_id: Some("lark@trae".into()),
            marketplace_id: Some("trae".into()),
            path: Some("~/.kcoder/plugins/cache/lark/skills/lark-doc/SKILL.md".into()),
            description: None,
            enabled: true,
            disabled_by: None,
            effective: false,
            shadowed_by: Some(ExtensionSourceRef {
                layer: ExtensionLayer::Bundled,
                owner_plugin_id: None,
                path: None,
            }),
            shadows: Vec::new(),
            upstream: Some(ExtensionUpstream {
                repository: Some("https://github.com/larksuite/cli".into()),
                git_ref: Some("v1.0.8".into()),
                version: None,
            }),
            version: Some("1.0.8".into()),
            preferred: false,
            family: Some("lark".into()),
            detail: None,
            count: None,
            bundled: None,
            skills_enabled: None,
            skill_policy_revision: None,
            target_key: None,
        };
        let wire = serde_json::to_value(&item).unwrap();
        assert_eq!(wire["kind"], "skill");
        assert_eq!(wire["layer"], "plugin");
        assert_eq!(wire["ownerPluginId"], "lark@trae");
        assert_eq!(wire["shadowedBy"]["layer"], "bundled");
        assert_eq!(wire["upstream"]["ref"], "v1.0.8");
        assert!(wire.get("preferred").is_none());
        assert!(wire.get("shadows").is_none());
        let decoded: ExtensionInventoryItem = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, item);
    }

    #[test]
    fn preference_update_requires_revision_and_whole_preference() {
        assert!(
            serde_json::from_value::<ExtensionSkillPreferenceUpdateParams>(
                json!({"preference": {}})
            )
            .is_err()
        );
        let params: ExtensionSkillPreferenceUpdateParams = serde_json::from_value(json!({
            "expectedRevision": "0".repeat(64),
            "preference": {"preferPluginSkills": {"lark-doc": "lark@trae"}}
        }))
        .unwrap();
        assert_eq!(
            params.preference.prefer_plugin_skills["lark-doc"],
            "lark@trae"
        );
        assert!(params.preference.prefer_plugins.is_empty());
    }

    #[test]
    fn plugin_skills_switch_has_optional_revision_and_rejects_unknown_fields() {
        let params: ExtensionPluginSkillsSetEnabledParams =
            serde_json::from_value(json!({"pluginId": "lark@trae", "enabled": false})).unwrap();
        assert_eq!(params.expected_revision, None);
        assert!(!params.enabled);
        assert!(
            serde_json::from_value::<ExtensionPluginSkillsSetEnabledParams>(
                json!({"pluginId": "lark@trae"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<ExtensionPluginSkillsSetEnabledParams>(
                json!({"pluginId": "lark@trae", "enabled": true, "component": "mcp"})
            )
            .is_err()
        );
        let wire = serde_json::to_value(ExtensionPluginSkillsSetEnabledParams {
            plugin_id: "lark@trae".into(),
            enabled: true,
            expected_revision: Some("a".repeat(64)),
        })
        .unwrap();
        assert_eq!(wire["expectedRevision"], "a".repeat(64));
        let result: ExtensionPluginSkillsResult = serde_json::from_value(json!({
            "pluginId": "lark@trae", "skillsEnabled": false, "revision": "b".repeat(64),
            "changed": true, "generation": 3, "appliesToNewConversations": true
        }))
        .unwrap();
        assert!(!result.skills_enabled);
        assert_eq!(result.generation, 3);
    }
}
