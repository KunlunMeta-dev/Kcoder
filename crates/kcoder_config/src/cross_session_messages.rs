//! Account-owned peer communication settings. Model input never supplies this policy.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CrossSessionMessagesSettings {
    /// Explicit user opt-in; every source and destination still requires current authorization.
    #[serde(default)]
    pub enabled: bool,
    /// Waking the original idle session is a distinct side effect and stays opt-in.
    #[serde(default)]
    pub wake_idle: bool,
    /// Destination-owned lifetime, frozen when a new message is admitted.
    #[serde(default = "default_ttl", deserialize_with = "ttl_seconds")]
    pub message_ttl_seconds: u32,
    /// Aggregate new Source operations in this Native account/profile per minute.
    #[serde(default = "default_profile_rate", deserialize_with = "message_rate")]
    pub max_messages_per_minute: u32,
    /// New operations from one complete Source address per minute.
    #[serde(default = "default_source_rate", deserialize_with = "message_rate")]
    pub max_source_messages_per_minute: u32,
    /// Which sources may read this account's conversations with ReadSession. The host
    /// that owns the target checks it on every read. Omitted when default so older
    /// binaries with strict parsing keep accepting a saved policy.
    #[serde(default, skip_serializing_if = "SessionReadAccess::is_default")]
    pub read_access: SessionReadAccess,
}

/// Target-owned ReadSession policy. Visibility rules (not self, sub-agent, channel or
/// deleted conversations) apply in addition to this scope.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionReadAccess {
    /// Same host, same canonical workspace root and same account profile.
    #[default]
    SameProject,
    /// Any workspace of the same host and account profile, and other runtime targets
    /// routed by the same authenticated Studio Gateway account. A peer on another
    /// target can never prove the same project, so `SameProject` refuses it.
    SameAccount,
    /// No conversation of this account can be read by another session.
    None,
}
impl SessionReadAccess {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

impl CrossSessionMessagesSettings {
    pub const DEFAULT_MESSAGE_TTL_SECONDS: u32 = 86_400;
    pub const MAX_MESSAGE_TTL_SECONDS: u32 = 604_800;
    pub const DEFAULT_MAX_MESSAGES_PER_MINUTE: u32 = 32;
    pub const DEFAULT_MAX_SOURCE_MESSAGES_PER_MINUTE: u32 = 8;
    pub const MAX_MESSAGES_PER_MINUTE: u32 = 256;
}
impl Default for CrossSessionMessagesSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            wake_idle: false,
            message_ttl_seconds: default_ttl(),
            max_messages_per_minute: default_profile_rate(),
            max_source_messages_per_minute: default_source_rate(),
            read_access: SessionReadAccess::default(),
        }
    }
}
fn default_ttl() -> u32 {
    CrossSessionMessagesSettings::DEFAULT_MESSAGE_TTL_SECONDS
}
fn default_profile_rate() -> u32 {
    CrossSessionMessagesSettings::DEFAULT_MAX_MESSAGES_PER_MINUTE
}
fn default_source_rate() -> u32 {
    CrossSessionMessagesSettings::DEFAULT_MAX_SOURCE_MESSAGES_PER_MINUTE
}
fn bounded_u32<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
    maximum: u32,
) -> Result<u32, D::Error> {
    let value = u32::deserialize(deserializer)?;
    if !(1..=maximum).contains(&value) {
        return Err(serde::de::Error::custom(format!(
            "peer communication limit must be between 1 and {maximum}"
        )));
    }
    Ok(value)
}
fn ttl_seconds<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    bounded_u32(
        deserializer,
        CrossSessionMessagesSettings::MAX_MESSAGE_TTL_SECONDS,
    )
}
fn message_rate<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    bounded_u32(
        deserializer,
        CrossSessionMessagesSettings::MAX_MESSAGES_PER_MINUTE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_inline_development_and_schema_defaults_agree() {
        let expected = serde_json::to_value(CrossSessionMessagesSettings::default()).unwrap();
        for text in [
            include_str!("../settting_inline.jsonc"),
            include_str!("../setting_dev_user.jsonc"),
        ] {
            let value: serde_json::Value =
                jsonc_parser::parse_to_serde_value(text, &Default::default()).unwrap();
            assert_eq!(value["cross_session_messages"], expected);
        }
        let schema: serde_json::Value = jsonc_parser::parse_to_serde_value(
            include_str!("../settings.schema.jsonc"),
            &Default::default(),
        )
        .unwrap();
        for (field, value) in expected.as_object().unwrap() {
            assert_eq!(
                schema["properties"]["cross_session_messages"]["properties"][field]["default"],
                *value,
                "default mismatch for {field}"
            );
        }
        assert_eq!(
            crate::Settings::default().cross_session_messages,
            CrossSessionMessagesSettings::default()
        );
    }
    #[test]
    fn read_access_defaults_to_same_project_and_is_only_written_when_changed() {
        let schema: serde_json::Value = jsonc_parser::parse_to_serde_value(
            include_str!("../settings.schema.jsonc"),
            &Default::default(),
        )
        .unwrap();
        let field = &schema["properties"]["cross_session_messages"]["properties"]["read_access"];
        assert_eq!(field["default"], "same_project");
        assert_eq!(
            field["enum"],
            serde_json::json!(["same_project", "same_account", "none"])
        );
        let legacy: CrossSessionMessagesSettings =
            serde_json::from_value(serde_json::json!({"enabled":true})).unwrap();
        assert_eq!(legacy.read_access, SessionReadAccess::SameProject);
        assert!(
            serde_json::to_value(&legacy)
                .unwrap()
                .get("read_access")
                .is_none()
        );
        for (raw, expected) in [
            ("same_account", SessionReadAccess::SameAccount),
            ("none", SessionReadAccess::None),
            ("same_project", SessionReadAccess::SameProject),
        ] {
            let parsed: CrossSessionMessagesSettings =
                serde_json::from_value(serde_json::json!({"read_access":raw})).unwrap();
            assert_eq!(parsed.read_access, expected);
        }
        assert!(
            serde_json::from_value::<CrossSessionMessagesSettings>(
                serde_json::json!({"read_access":"everyone"})
            )
            .is_err()
        );
    }
    #[test]
    fn partial_legacy_settings_keep_limits_and_reject_unbounded_values() {
        let legacy: CrossSessionMessagesSettings =
            serde_json::from_value(serde_json::json!({"enabled":true,"wake_idle":true})).unwrap();
        assert_eq!(legacy.message_ttl_seconds, 86_400);
        assert_eq!(legacy.max_messages_per_minute, 32);
        assert_eq!(legacy.max_source_messages_per_minute, 8);
        for (field, maximum) in [
            ("message_ttl_seconds", 604_800),
            ("max_messages_per_minute", 256),
            ("max_source_messages_per_minute", 256),
        ] {
            for value in [
                serde_json::json!(0),
                serde_json::json!(maximum + 1),
                serde_json::Value::Null,
            ] {
                assert!(
                    serde_json::from_value::<CrossSessionMessagesSettings>(
                        serde_json::json!({(field):value})
                    )
                    .is_err()
                );
            }
            for value in [1, maximum] {
                assert!(
                    serde_json::from_value::<CrossSessionMessagesSettings>(
                        serde_json::json!({(field):value})
                    )
                    .is_ok()
                );
            }
        }
    }
}
