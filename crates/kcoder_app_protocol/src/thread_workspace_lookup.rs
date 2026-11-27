//! Read-only workspace hints for one existing thread in the current Native profile.
use serde::{Deserialize, Serialize};

pub const CAPABILITY: &str = "threadWorkspaceLookupV1";
pub const METHOD: &str = "thread/workspace/lookup";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadWorkspaceLookupParams {
    #[serde(deserialize_with = "thread_id")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "cursor"
    )]
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub cursor: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "limit"
    )]
    #[cfg_attr(feature = "json-schema", schemars(range(min = 1, max = 64)))]
    pub limit: Option<u32>,
}
impl ThreadWorkspaceLookupParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_thread(&self.thread_id)
            || self.limit.is_some_and(|limit| !(1..=64).contains(&limit))
            || self
                .cursor
                .as_ref()
                .is_some_and(|value| !valid_thread(value))
        {
            return Err("THREAD_WORKSPACE_LOOKUP_PARAMS_INVALID");
        }
        Ok(())
    }
}

fn valid_thread(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn thread_id<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    let value = String::deserialize(decoder)?;
    if !valid_thread(&value) {
        return Err(serde::de::Error::custom(
            "invalid thread workspace selector",
        ));
    }
    Ok(value)
}
fn cursor<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<Option<String>, D::Error> {
    let value = Option::<String>::deserialize(decoder)?;
    if value.as_ref().is_some_and(|value| !valid_thread(value)) {
        return Err(serde::de::Error::custom("invalid thread workspace cursor"));
    }
    Ok(value)
}
fn limit<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<Option<u32>, D::Error> {
    let value = Option::<u32>::deserialize(decoder)?;
    if value.is_some_and(|value| !(1..=64).contains(&value)) {
        return Err(serde::de::Error::custom("invalid thread workspace limit"));
    }
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadWorkspaceHintV1 {
    #[serde(deserialize_with = "workspace_path")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(
            length(min = 1, max = 4096),
            regex(pattern = r"^[^\u0000-\u001F\u007F-\u009F]+$")
        )
    )]
    pub workspace_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ThreadWorkspaceLookupCompleteness {
    Complete,
    Partial,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadWorkspaceLookupResult {
    #[serde(deserialize_with = "thread_id")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub thread_id: String,
    #[serde(deserialize_with = "candidates")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 64)))]
    pub candidates: Vec<ThreadWorkspaceHintV1>,
    pub completeness: ThreadWorkspaceLookupCompleteness,
    pub issue_count: u64,
    pub scanned_projects: u32,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "cursor"
    )]
    #[cfg_attr(
        feature = "json-schema",
        schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9_-]+$"))
    )]
    pub next_cursor: Option<String>,
}

fn workspace_path<'de, D: serde::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    let value = String::deserialize(decoder)?;
    if value.is_empty() || value.chars().count() > 4096 || value.chars().any(char::is_control) {
        return Err(serde::de::Error::custom("invalid thread workspace hint"));
    }
    Ok(value)
}
fn candidates<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> Result<Vec<ThreadWorkspaceHintV1>, D::Error> {
    let value = Vec::<ThreadWorkspaceHintV1>::deserialize(decoder)?;
    if value.len() > 64 {
        return Err(serde::de::Error::custom(
            "thread workspace hint limit exceeded",
        ));
    }
    Ok(value)
}
