use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

const MAX_ID_PART_BYTES: usize = 64;

/// Stable identity for a managed plugin across all sources.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PluginId {
    plugin_name: String,
    marketplace_name: String,
}

impl PluginId {
    pub fn new(
        plugin_name: impl Into<String>,
        marketplace_name: impl Into<String>,
    ) -> Result<Self, PluginIdError> {
        let plugin_name = plugin_name.into();
        let marketplace_name = marketplace_name.into();
        validate_part("plugin", &plugin_name)?;
        validate_part("marketplace", &marketplace_name)?;
        Ok(Self {
            plugin_name,
            marketplace_name,
        })
    }

    pub fn plugin_name(&self) -> &str {
        &self.plugin_name
    }

    pub fn marketplace_name(&self) -> &str {
        &self.marketplace_name
    }
}

impl fmt::Display for PluginId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}@{}", self.plugin_name, self.marketplace_name)
    }
}

impl FromStr for PluginId {
    type Err = PluginIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (plugin_name, marketplace_name) = value
            .split_once('@')
            .ok_or(PluginIdError::MissingMarketplace)?;
        if marketplace_name.contains('@') {
            return Err(PluginIdError::TooManySeparators);
        }
        Self::new(plugin_name, marketplace_name)
    }
}

impl TryFrom<String> for PluginId {
    type Error = PluginIdError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

impl From<PluginId> for String {
    fn from(value: PluginId) -> Self {
        value.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PluginIdError {
    #[error("plugin id must use the form <plugin>@<marketplace>")]
    MissingMarketplace,
    #[error("plugin id contains more than one '@' separator")]
    TooManySeparators,
    #[error("{part} name must be between 1 and {MAX_ID_PART_BYTES} bytes")]
    InvalidLength { part: &'static str },
    #[error("{part} name must start and end with an ASCII letter or digit")]
    InvalidBoundary { part: &'static str },
    #[error("{part} name may contain only lowercase ASCII letters, digits, '.' and '-'")]
    InvalidCharacter { part: &'static str },
    #[error("{part} name may not contain '..', '--', '.-' or '-.'")]
    ConsecutiveSeparator { part: &'static str },
}

fn validate_part(part: &'static str, value: &str) -> Result<(), PluginIdError> {
    if value.is_empty() || value.len() > MAX_ID_PART_BYTES {
        return Err(PluginIdError::InvalidLength { part });
    }
    let mut characters = value.chars();
    let first = characters.next().expect("empty value handled above");
    let last = value
        .chars()
        .next_back()
        .expect("empty value handled above");
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return Err(PluginIdError::InvalidBoundary { part });
    }
    if !value.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '-')
    }) {
        return Err(PluginIdError::InvalidCharacter { part });
    }
    if value.contains("..") || value.contains("--") || value.contains(".-") || value.contains("-.")
    {
        return Err(PluginIdError::ConsecutiveSeparator { part });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_id_round_trips_through_stable_string() {
        let id: PluginId = "issue-triage@team.tools".parse().unwrap();

        assert_eq!(id.plugin_name(), "issue-triage");
        assert_eq!(id.marketplace_name(), "team.tools");
        assert_eq!(id.to_string(), "issue-triage@team.tools");
        assert_eq!(
            serde_json::to_string(&id).unwrap(),
            "\"issue-triage@team.tools\""
        );
    }

    #[test]
    fn plugin_id_rejects_unsafe_or_ambiguous_names() {
        for value in [
            "demo",
            "demo@",
            "@local",
            "Demo@local",
            "demo@Local",
            "demo_name@local",
            "demo/escape@local",
            "demo@../local",
            "demo..name@local",
            "demo--name@local",
            "demo@local@extra",
            "-demo@local",
            "demo@local-",
        ] {
            assert!(value.parse::<PluginId>().is_err(), "accepted {value:?}");
        }
    }

    #[test]
    fn plugin_id_enforces_each_component_length_limit() {
        let too_long = "a".repeat(MAX_ID_PART_BYTES + 1);
        assert!(PluginId::new(&too_long, "local").is_err());
        assert!(PluginId::new("demo", &too_long).is_err());
        assert!(PluginId::new("a".repeat(MAX_ID_PART_BYTES), "local").is_ok());
    }
}
