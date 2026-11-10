//! Turn-scoped restrictions supplied by the channel configuration owner.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelToolRestrictions {
    pub enabled: bool,
    #[serde(deserialize_with = "read_disabled_tools")]
    pub disabled_tools: Vec<String>,
}

fn read_disabled_tools<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let mut names = Vec::<String>::deserialize(deserializer)?;
    if names.len() > 128
        || names.iter().any(|name| {
            name.is_empty()
                || name.len() > 256
                || name.chars().any(char::is_whitespace)
                || name.chars().any(char::is_control)
        })
    {
        return Err(serde::de::Error::custom(
            "invalid channel disabled tool names",
        ));
    }
    names.sort();
    names.dedup();
    Ok(names)
}
