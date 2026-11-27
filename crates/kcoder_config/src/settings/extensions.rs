//! Extensions configuration types and their defaults.

use crate::*;

/// Plugin runtime, compatible formats, installation boundaries, and user policy.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginsSettings {
    #[serde(default)]
    pub runtime: PluginRuntimeSettings,
    #[serde(default)]
    pub compatibility: PluginCompatibilitySettings,
    #[serde(default)]
    pub installation: PluginInstallationSettings,
    #[serde(default)]
    pub marketplaces: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub installed: BTreeMap<String, PluginPolicySettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginRuntimeSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub project_policy: PluginProjectPolicy,
}

impl Default for PluginRuntimeSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            project_policy: PluginProjectPolicy::TrustedOnly,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginProjectPolicy {
    #[default]
    TrustedOnly,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginCompatibilitySettings {
    #[serde(default = "default_true")]
    pub agent_plugins_v1: bool,
    #[serde(default = "default_true")]
    pub codex: bool,
    #[serde(default = "default_true")]
    pub claude: bool,
    #[serde(default = "default_true")]
    pub cursor: bool,
    #[serde(default = "default_true")]
    pub grok: bool,
    #[serde(default = "default_true")]
    pub codebuddy: bool,
    #[serde(default = "default_true")]
    pub qoder: bool,
    #[serde(default = "default_true")]
    pub trae: bool,
}

impl Default for PluginCompatibilitySettings {
    fn default() -> Self {
        Self {
            agent_plugins_v1: true,
            codex: true,
            claude: true,
            cursor: true,
            grok: true,
            codebuddy: true,
            qoder: true,
            trae: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginInstallationSettings {
    /// Credential-free download proxy on the execution target; omitted uses its proxy environment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub auto_detect_proxy: bool,
    #[serde(default)]
    pub proxy_scan_ports: Vec<u16>,
    #[serde(default = "default_true")]
    pub allow_local: bool,
    #[serde(default = "default_true")]
    pub allow_git: bool,
    #[serde(default = "default_true")]
    pub allow_http: bool,
    #[serde(default = "default_true")]
    pub allow_npm: bool,
    #[serde(default)]
    pub require_git_sha: bool,
    #[serde(default = "default_true")]
    pub require_npm_integrity: bool,
    #[serde(default = "default_plugin_max_files")]
    pub max_files: usize,
    #[serde(default = "default_plugin_max_total_bytes")]
    pub max_total_bytes: u64,
    #[serde(default = "default_plugin_max_file_bytes")]
    pub max_file_bytes: u64,
    #[serde(default = "default_plugin_install_timeout_ms")]
    pub timeout_ms: u64,
}

impl Default for PluginInstallationSettings {
    fn default() -> Self {
        Self {
            proxy_url: None,
            auto_detect_proxy: false,
            proxy_scan_ports: Vec::new(),
            allow_local: true,
            allow_git: true,
            allow_http: true,
            allow_npm: true,
            require_git_sha: false,
            require_npm_integrity: true,
            max_files: default_plugin_max_files(),
            max_total_bytes: default_plugin_max_total_bytes(),
            max_file_bytes: default_plugin_max_file_bytes(),
            timeout_ms: default_plugin_install_timeout_ms(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginPolicySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub skills: PluginCapabilityPolicy,
    #[serde(default)]
    pub hooks: PluginCapabilityPolicy,
    #[serde(default)]
    pub mcp_servers: BTreeMap<String, PluginMcpServerPolicy>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginCapabilityPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginMcpServerPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub enabled_tools: Vec<String>,
    #[serde(default)]
    pub disabled_tools: Vec<String>,
}

pub(crate) fn default_plugin_max_files() -> usize {
    10_000
}

pub(crate) fn default_plugin_max_total_bytes() -> u64 {
    256 * 1024 * 1024
}

pub(crate) fn default_plugin_max_file_bytes() -> u64 {
    32 * 1024 * 1024
}

pub(crate) fn default_plugin_install_timeout_ms() -> u64 {
    120_000
}

/// Skill lifecycle, external directory, and safety settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillsSettings {
    #[serde(default)]
    pub auto_skill_review_enabled: bool,
    /// Minimum new tool calls since the previous background skill review.
    #[serde(default = "default_auto_skill_review_interval")]
    pub auto_skill_review_interval: usize,
    /// Foreground idle minutes after the last completed turn before a
    /// background skill review may start (minimum 1).
    #[serde(default = "default_auto_skill_review_idle_minutes")]
    pub auto_skill_review_idle_minutes: u64,
    #[serde(default = "default_auto_curator_enabled")]
    pub auto_curator_enabled: bool,
    #[serde(default = "default_auto_curator_interval_hours")]
    pub auto_curator_interval_hours: u64,
    #[serde(default = "default_auto_curator_min_idle_hours")]
    pub auto_curator_min_idle_hours: u64,
    #[serde(default = "default_stale_after_days")]
    pub stale_after_days: u64,
    #[serde(default = "default_archive_after_days")]
    pub archive_after_days: u64,
    #[serde(default)]
    pub prune_builtins: bool,
    #[serde(default)]
    pub trust_external: bool,
    #[serde(default)]
    pub auto_lessons_learned: bool,
    #[serde(default)]
    pub external_dirs: Vec<PathBuf>,
    #[serde(default)]
    pub guard: SkillGuardSettings,
    /// Explicit opt-ins that let plugin skill copies outrank bundled/built-in ones.
    #[serde(default)]
    pub source_preference: SkillSourcePreferenceSettings,
}

/// Same-name skill resolution preferences. Built-in and bundled skills win over
/// plugin copies unless the user opts in here; user, external-directory and
/// project skills keep their own higher layers regardless of these choices.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SkillSourcePreferenceSettings {
    /// Skill name -> plugin ID whose copy of that name is used instead of the
    /// built-in/bundled copy. A per-name entry also selects between plugins.
    #[serde(default)]
    pub prefer_plugin_skills: BTreeMap<String, String>,
    /// Plugin IDs whose every skill outranks built-in/bundled copies.
    #[serde(default)]
    pub prefer_plugins: Vec<String>,
}

impl SkillSourcePreferenceSettings {
    pub fn is_empty(&self) -> bool {
        self.prefer_plugin_skills.is_empty() && self.prefer_plugins.is_empty()
    }

    /// Whether `plugin_id`'s copy of `name` is an explicit opt-in.
    pub fn prefers(&self, name: &str, plugin_id: &str) -> bool {
        match self.prefer_plugin_skills.get(name) {
            Some(pinned) => pinned == plugin_id,
            None => self.prefer_plugins.iter().any(|id| id == plugin_id),
        }
    }

    /// Whether `plugin_id` is the per-name pin for `name`.
    pub fn pins(&self, name: &str, plugin_id: &str) -> bool {
        self.prefer_plugin_skills
            .get(name)
            .is_some_and(|pinned| pinned == plugin_id)
    }
}

impl Default for SkillsSettings {
    fn default() -> Self {
        Self {
            auto_skill_review_enabled: false,
            auto_skill_review_interval: default_auto_skill_review_interval(),
            auto_skill_review_idle_minutes: default_auto_skill_review_idle_minutes(),
            auto_curator_enabled: default_auto_curator_enabled(),
            auto_curator_interval_hours: default_auto_curator_interval_hours(),
            auto_curator_min_idle_hours: default_auto_curator_min_idle_hours(),
            stale_after_days: default_stale_after_days(),
            archive_after_days: default_archive_after_days(),
            prune_builtins: false,
            trust_external: false,
            auto_lessons_learned: false,
            external_dirs: Vec::new(),
            guard: SkillGuardSettings::default(),
            source_preference: SkillSourcePreferenceSettings::default(),
        }
    }
}

/// Static safety scanner settings for skills.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillGuardSettings {
    #[serde(default = "default_skill_guard_enabled")]
    pub enabled: bool,
    #[serde(default = "default_skill_guard_block_high_risk")]
    pub block_high_risk: bool,
    #[serde(default = "default_skill_guard_block_medium_risk_for_community")]
    pub block_medium_risk_for_community: bool,
}

impl Default for SkillGuardSettings {
    fn default() -> Self {
        Self {
            enabled: default_skill_guard_enabled(),
            block_high_risk: default_skill_guard_block_high_risk(),
            block_medium_risk_for_community: default_skill_guard_block_medium_risk_for_community(),
        }
    }
}

#[cfg(test)]
mod source_preference_tests {
    use super::*;

    #[test]
    fn per_name_pins_override_per_plugin_preferences_and_unknown_fields_fail() {
        let preference: SkillSourcePreferenceSettings = serde_json::from_value(serde_json::json!({
            "prefer_plugin_skills": {"lark-im": "other@market"},
            "prefer_plugins": ["lark@trae"]
        }))
        .unwrap();
        assert!(preference.prefers("lark-doc", "lark@trae"));
        assert!(!preference.prefers("lark-im", "lark@trae"));
        assert!(preference.prefers("lark-im", "other@market"));
        assert!(preference.pins("lark-im", "other@market"));
        assert!(!preference.pins("lark-doc", "lark@trae"));
        assert!(SkillSourcePreferenceSettings::default().is_empty());
        assert!(
            serde_json::from_value::<SkillSourcePreferenceSettings>(
                serde_json::json!({"prefer_bundled": true})
            )
            .is_err()
        );
        let skills: SkillsSettings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(skills.source_preference.is_empty());
    }
}
