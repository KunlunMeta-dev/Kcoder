use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginManifestFormat {
    Kcoder,
    KcoderLegacy,
    AgentPluginsV1,
    Codex,
    Claude,
    Cursor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginResource {
    pub relative_path: PathBuf,
    pub absolute_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum PluginAsset {
    Local(PluginResource),
    RemoteUrl(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum PluginMcpDeclaration {
    Path(PluginResource),
    Inline(Value),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum PluginHookDeclaration {
    Path(PluginResource),
    Inline(Value),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PluginContributionDeclarations {
    pub skills: Vec<PluginResource>,
    pub mcp_servers: Option<PluginMcpDeclaration>,
    pub apps: Option<PluginResource>,
    pub hooks: Vec<PluginHookDeclaration>,
    pub commands: Vec<PluginResource>,
}

impl PluginContributionDeclarations {
    pub(crate) fn capability_names(&self) -> BTreeSet<String> {
        let mut names = BTreeSet::new();
        if !self.skills.is_empty() {
            names.insert("skills".to_string());
        }
        if self.mcp_servers.is_some() {
            names.insert("mcp_servers".to_string());
        }
        if self.apps.is_some() {
            names.insert("apps".to_string());
        }
        if !self.hooks.is_empty() {
            names.insert("hooks".to_string());
        }
        if !self.commands.is_empty() {
            names.insert("commands".to_string());
        }
        names
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PluginInterface {
    pub display_name: Option<String>,
    pub short_description: Option<String>,
    pub long_description: Option<String>,
    pub developer_name: Option<String>,
    pub category: Option<String>,
    pub capabilities: Vec<String>,
    pub website_url: Option<String>,
    pub privacy_policy_url: Option<String>,
    pub terms_of_service_url: Option<String>,
    pub default_prompt: Vec<String>,
    pub brand_color: Option<String>,
    pub composer_icon: Option<PluginAsset>,
    pub logo: Option<PluginAsset>,
    pub logo_dark: Option<PluginAsset>,
    pub screenshots: Vec<PluginAsset>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub format: PluginManifestFormat,
    pub id: Option<String>,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub keywords: Vec<String>,
    pub enabled_by_default: bool,
    pub contributions: PluginContributionDeclarations,
    pub interface: Option<PluginInterface>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompatibilityLevel {
    FullySupported,
    PartiallySupported,
    MetadataOnly,
    Incompatible,
    Invalid,
}

impl CompatibilityLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FullySupported => "fully_supported",
            Self::PartiallySupported => "partially_supported",
            Self::MetadataOnly => "metadata_only",
            Self::Incompatible => "incompatible",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibilityIssue {
    pub code: String,
    pub capability: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibilityReport {
    pub level: CompatibilityLevel,
    pub supported_capabilities: Vec<String>,
    pub deferred_capabilities: Vec<String>,
    pub issues: Vec<CompatibilityIssue>,
}

impl CompatibilityReport {
    pub(crate) fn for_manifest(manifest: &PluginManifest) -> Self {
        let mut declared = manifest.contributions.capability_names();
        let mut supported = BTreeSet::new();
        let mut deferred = BTreeSet::new();

        if declared.remove("skills") {
            supported.insert("skills".to_string());
        }
        if declared.remove("mcp_servers") {
            supported.insert("mcp_servers".to_string());
        }
        if declared.remove("hooks") {
            supported.insert("hooks".to_string());
        }
        deferred.extend(declared);

        let issues = deferred
            .iter()
            .map(|capability| CompatibilityIssue {
                code: "capability_deferred".to_string(),
                capability: Some(capability.clone()),
                message: format!(
                    "plugin capability `{capability}` is parsed but not activated in this runtime"
                ),
            })
            .collect();
        let level = match (supported.is_empty(), deferred.is_empty()) {
            (false, true) => CompatibilityLevel::FullySupported,
            (false, false) => CompatibilityLevel::PartiallySupported,
            (true, _) => CompatibilityLevel::MetadataOnly,
        };

        Self {
            level,
            supported_capabilities: supported.into_iter().collect(),
            deferred_capabilities: deferred.into_iter().collect(),
            issues,
        }
    }

    pub(crate) fn add_issue(
        &mut self,
        code: impl Into<String>,
        capability: Option<&str>,
        message: impl Into<String>,
    ) {
        self.issues.push(CompatibilityIssue {
            code: code.into(),
            capability: capability.map(str::to_string),
            message: message.into(),
        });
        self.refresh_level();
    }

    pub(crate) fn defer_capability(
        &mut self,
        capability: &str,
        code: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.supported_capabilities
            .retain(|supported| supported != capability);
        if !self
            .deferred_capabilities
            .iter()
            .any(|deferred| deferred == capability)
        {
            self.deferred_capabilities.push(capability.to_string());
            self.deferred_capabilities.sort();
        }
        self.issues.push(CompatibilityIssue {
            code: code.into(),
            capability: Some(capability.to_string()),
            message: message.into(),
        });
        self.refresh_level();
    }

    fn refresh_level(&mut self) {
        self.level = if self.supported_capabilities.is_empty() {
            CompatibilityLevel::MetadataOnly
        } else if self.deferred_capabilities.is_empty() && self.issues.is_empty() {
            CompatibilityLevel::FullySupported
        } else {
            CompatibilityLevel::PartiallySupported
        };
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoadedPluginManifest {
    pub manifest: PluginManifest,
    pub compatibility: CompatibilityReport,
    pub selected_manifest_path: PathBuf,
    pub shadowed_manifest_paths: Vec<PathBuf>,
}

impl LoadedPluginManifest {
    pub(crate) fn new(
        manifest: PluginManifest,
        selected_manifest_path: PathBuf,
        shadowed_manifest_paths: Vec<PathBuf>,
    ) -> Self {
        let compatibility = CompatibilityReport::for_manifest(&manifest);
        Self {
            manifest,
            compatibility,
            selected_manifest_path,
            shadowed_manifest_paths,
        }
    }
}
