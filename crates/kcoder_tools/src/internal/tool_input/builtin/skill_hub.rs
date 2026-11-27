use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillHubAction {
    Install,
    Uninstall,
    List,
    Search,
    Sync,
    SyncStatus,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillHubSource {
    Url,
    Github,
}

#[derive(Debug, Default, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillHubScope {
    #[default]
    Project,
    User,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkillHubTrustLevel {
    Community,
    Trusted,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SkillHubInput {
    /// Action to perform. `install` accepts inline `content`, a URL/local path,
    /// or a structured GitHub repo/path source; `list` shows installed hub
    /// skills; `search` filters installed hub metadata; `uninstall` archives a
    /// hub skill.
    pub action: SkillHubAction,
    /// Skill name. Required for install if the content lacks frontmatter name,
    /// and required for uninstall.
    #[serde(default)]
    pub name: Option<String>,
    /// Install source kind. Use `github` with repo/path, or `url` with url.
    #[serde(default)]
    pub source: Option<SkillHubSource>,
    /// Raw URL, GitHub blob/raw URL, file:// URL, or local SKILL.md path.
    #[serde(default)]
    pub url: Option<String>,
    /// GitHub repository in owner/repo form when source is github.
    #[serde(default)]
    pub repo: Option<String>,
    /// GitHub path to a skill directory or SKILL.md when source is github.
    #[serde(default)]
    pub path: Option<String>,
    /// GitHub branch, tag, or commit ref for source=github. Defaults to main.
    #[serde(default, rename = "ref", alias = "branch", alias = "git_ref")]
    pub git_ref: Option<String>,
    /// Inline SKILL.md content. Useful for local/private installs and tests.
    #[serde(default)]
    pub content: Option<String>,
    /// Search query for installed hub skills.
    #[serde(default)]
    pub query: Option<String>,
    /// Destination and metadata scope. Project is the backward-compatible
    /// default; user installs are available in every project for this profile.
    #[serde(default)]
    pub scope: SkillHubScope,
    /// Overwrite an existing skill in the selected scope with the same name.
    #[serde(default)]
    pub force: bool,
    /// Report bundled synchronization changes without writing files.
    #[serde(default)]
    pub dry_run: bool,
    /// Trust tier for the install source. Community sources block medium/high
    /// guard findings by default; trusted sources block high findings.
    #[serde(default)]
    pub trust_level: Option<SkillHubTrustLevel>,
    /// Allow installation despite medium-risk guard findings from community
    /// sources. High-risk findings still require `allow_high_risk`.
    #[serde(default)]
    pub allow_medium_risk: bool,
    /// Allow installation despite high-risk guard findings.
    #[serde(default)]
    pub allow_high_risk: bool,
}

builtin_input!(SkillHubInput);
