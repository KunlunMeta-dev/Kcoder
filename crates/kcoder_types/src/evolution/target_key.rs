use super::EvolutionContractError;
use serde::{Deserialize, Serialize};

/// Kind of learnable target. The snake_case wire name is also the first
/// segment of a [`TargetKey`] and the key under `evolution.targets`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum TargetType {
    Skill,
    Preference,
    ProjectKnowledge,
    ToolUsage,
    WorkflowTemplate,
}

impl TargetType {
    pub const ALL: [TargetType; 5] = [
        TargetType::Skill,
        TargetType::Preference,
        TargetType::ProjectKnowledge,
        TargetType::ToolUsage,
        TargetType::WorkflowTemplate,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Preference => "preference",
            Self::ProjectKnowledge => "project_knowledge",
            Self::ToolUsage => "tool_usage",
            Self::WorkflowTemplate => "workflow_template",
        }
    }

    pub fn parse(value: &str) -> Result<Self, EvolutionContractError> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| EvolutionContractError::UnknownTargetType(value.to_string()))
    }
}

impl std::fmt::Display for TargetType {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Maximum byte length of the `source` segment of a target key.
pub const TARGET_SOURCE_MAX_LEN: usize = 64;
/// Maximum byte length of the `name` segment of a target key.
pub const TARGET_NAME_MAX_LEN: usize = 256;

/// Identity of one learnable target: `<type>:<source>:<name>`.
///
/// - `type` is a [`TargetType`] wire name.
/// - `source` is 1..=64 ASCII characters from `[A-Za-z0-9_.-]`; for skills it
///   matches the `.provenance.json` origin, so equal names from different
///   sources never share statistics.
/// - `name` is 1..=256 bytes without control characters or leading/trailing
///   whitespace. It may itself contain `:` (only the first two separators
///   split the key).
///
/// All segments are case-preserving; `skill:bundled:Docx` and
/// `skill:bundled:docx` are distinct targets.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TargetKey {
    target_type: TargetType,
    source: String,
    name: String,
}

impl TargetKey {
    pub fn new(
        target_type: TargetType,
        source: impl Into<String>,
        name: impl Into<String>,
    ) -> Result<Self, EvolutionContractError> {
        let source = source.into();
        let name = name.into();
        validate_source(&source)?;
        validate_name(&name)?;
        Ok(Self {
            target_type,
            source,
            name,
        })
    }

    pub fn parse(value: &str) -> Result<Self, EvolutionContractError> {
        let mut parts = value.splitn(3, ':');
        let (Some(kind), Some(source), Some(name)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(EvolutionContractError::InvalidTargetKey(
                "expected `<type>:<source>:<name>`",
            ));
        };
        Self::new(TargetType::parse(kind)?, source, name)
    }

    pub fn target_type(&self) -> TargetType {
        self.target_type
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

fn validate_source(source: &str) -> Result<(), EvolutionContractError> {
    if source.is_empty() || source.len() > TARGET_SOURCE_MAX_LEN {
        return Err(EvolutionContractError::InvalidTargetKey(
            "source must be 1..=64 bytes",
        ));
    }
    if !source
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(EvolutionContractError::InvalidTargetKey(
            "source may contain only ASCII letters, digits and `_ . -`",
        ));
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), EvolutionContractError> {
    if name.is_empty() || name.len() > TARGET_NAME_MAX_LEN {
        return Err(EvolutionContractError::InvalidTargetKey(
            "name must be 1..=256 bytes",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(EvolutionContractError::InvalidTargetKey(
            "name must not contain control characters",
        ));
    }
    if name.trim() != name {
        return Err(EvolutionContractError::InvalidTargetKey(
            "name must not start or end with whitespace",
        ));
    }
    Ok(())
}

impl std::fmt::Display for TargetKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}:{}:{}",
            self.target_type.as_str(),
            self.source,
            self.name
        )
    }
}

impl std::str::FromStr for TargetKey {
    type Err = EvolutionContractError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for TargetKey {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for TargetKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(serde::de::Error::custom)
    }
}

#[cfg(feature = "json-schema")]
impl schemars::JsonSchema for TargetKey {
    fn schema_name() -> String {
        "TargetKey".to_string()
    }

    fn json_schema(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
        let mut schema = <String as schemars::JsonSchema>::json_schema(generator);
        if let schemars::schema::Schema::Object(object) = &mut schema {
            // Mirrors `TargetKey::parse` for clients that validate the wire value.
            object.string().pattern = Some(
                "^(?:skill|preference|project_knowledge|tool_usage|workflow_template):[A-Za-z0-9_.-]{1,64}:(?!\\p{White_Space})[^\\p{Cc}]+(?<!\\p{White_Space})$"
                    .to_string(),
            );
            object.extensions.insert(
                "x-max-utf8-bytes".to_string(),
                serde_json::json!(17 + 1 + TARGET_SOURCE_MAX_LEN + 1 + TARGET_NAME_MAX_LEN),
            );
        }
        schema
    }
}

/// Version of a target that a usage or statistic refers to.
///
/// `base_revision` is the target's own opaque revision (for skills the skill
/// store revision); `overlay_revision` is the framework overlay slot revision,
/// with `0` meaning "no overlay applied".
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetRevision {
    pub base_revision: String,
    #[serde(default)]
    pub overlay_revision: u64,
}

impl TargetRevision {
    pub fn new(base_revision: impl Into<String>, overlay_revision: u64) -> Self {
        Self {
            base_revision: base_revision.into(),
            overlay_revision,
        }
    }

    /// Single-string form used by RPC summaries: `<base>@<overlay>`.
    pub fn label(&self) -> String {
        format!("{}@{}", self.base_revision, self.overlay_revision)
    }

    pub fn validate(&self) -> Result<(), EvolutionContractError> {
        if self.base_revision.len() > 256 || self.base_revision.chars().any(char::is_control) {
            return Err(EvolutionContractError::InvalidValue {
                field: "baseRevision",
                reason: "must be at most 256 bytes without control characters",
            });
        }
        Ok(())
    }
}

/// Rollout channel a usage was served from.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    #[default]
    Stable,
    Candidate,
}

/// How far the framework may act on what it learned. Ordered from the most
/// to the least restrictive so `min` yields the narrower mode.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum EvolutionMode {
    /// Collect usages and outcomes only.
    #[default]
    Observe,
    /// Distill and create proposals that wait for user confirmation.
    Propose,
    /// Apply proposals automatically after evaluation and canary.
    Auto,
}
