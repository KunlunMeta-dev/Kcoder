//! Channel management is available by default. Connections and credentials remain explicit.
use serde::{Deserialize, Serialize};

fn connections() -> u16 {
    16
}
fn pending() -> u32 {
    1_000
}
fn metadata() -> u64 {
    64 * 1024 * 1024
}
fn attachments() -> u64 {
    100 * 1024 * 1024
}
fn retention() -> u64 {
    30 * 24 * 60 * 60 * 1_000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivitySettings {
    pub enabled: bool,
    #[serde(default = "connections")]
    pub max_connections: u16,
    #[serde(default = "pending")]
    pub max_pending_events: u32,
    #[serde(default = "metadata")]
    pub max_metadata_bytes: u64,
    #[serde(default = "attachments")]
    pub max_attachment_bytes: u64,
    #[serde(default = "retention")]
    pub replay_retention_ms: u64,
}
impl Default for ConnectivitySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_connections: connections(),
            max_pending_events: pending(),
            max_metadata_bytes: metadata(),
            max_attachment_bytes: attachments(),
            replay_retention_ms: retention(),
        }
    }
}
impl ConnectivitySettings {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.max_connections == 0 || self.max_connections > 64 {
            return Err("invalid connection capacity");
        }
        if self.max_pending_events == 0 || self.max_pending_events > 10_000 {
            return Err("invalid event capacity");
        }
        if self.max_metadata_bytes < 1024 * 1024 || self.max_metadata_bytes > 1024 * 1024 * 1024 {
            return Err("invalid metadata capacity");
        }
        if self.max_attachment_bytes == 0 || self.max_attachment_bytes > 100 * 1024 * 1024 {
            return Err("attachment capacity exceeds native boundary");
        }
        if self.replay_retention_ms < 24 * 60 * 60 * 1000
            || self.replay_retention_ms > 365 * 24 * 60 * 60 * 1000
        {
            return Err("retention is outside the supported safety window");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_is_enabled_and_valid() {
        let value: ConnectivitySettings = serde_json::from_str("{}").unwrap();
        assert_eq!(value, ConnectivitySettings::default());
        assert!(value.enabled);
        value.validate().unwrap();
    }
    #[test]
    fn settings_reject_secrets_and_unbounded_capacity() {
        assert!(serde_json::from_str::<ConnectivitySettings>(r#"{"secret":"synthetic"}"#).is_err());
        let value = ConnectivitySettings {
            max_connections: 0,
            ..Default::default()
        };
        assert!(value.validate().is_err());
    }
}
