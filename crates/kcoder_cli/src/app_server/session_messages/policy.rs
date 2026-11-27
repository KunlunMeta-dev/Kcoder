//! User-owned policy. Project and model configuration cannot enable peer communication.
use anyhow::{Result, ensure};
use kcoder_app_protocol::cross_session_messages::AgentMessagePolicyResult;
use kcoder_config::{
    ConfigPaths, ConfigScope, CrossSessionMessagesSettings, PrivateDirectory, read_scope,
    update_scope,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub struct PeerMessagePolicy {
    paths: ConfigPaths,
    profile: PrivateDirectory,
    profile_identity: String,
}
impl PeerMessagePolicy {
    /// Capture the original host's profile path without hydrating credentials or writing settings.
    pub fn capture(paths: ConfigPaths) -> Result<Self> {
        ensure!(
            paths.user_settings == paths.config_dir.join("settings.json"),
            "peer_policy_invalid_profile"
        );
        let profile = PrivateDirectory::open_existing(&paths.config_dir)?;
        profile.verify_private_directory()?;
        let profile_identity = profile.directory_identity()?;
        Ok(Self {
            paths,
            profile,
            profile_identity,
        })
    }
    fn verify(&self) -> Result<()> {
        self.profile.verify_private_directory()?;
        let current = PrivateDirectory::open_existing(&self.paths.config_dir)?;
        current.verify_private_directory()?;
        ensure!(
            self.profile.directory_identity()? == self.profile_identity
                && current.directory_identity()? == self.profile_identity,
            "peer_policy_profile_changed"
        );
        Ok(())
    }
    fn observation(&self, value: &Value) -> Result<AgentMessagePolicyResult> {
        let settings: CrossSessionMessagesSettings = match value.get("cross_session_messages") {
            Some(value) => serde_json::from_value(value.clone())?,
            None => CrossSessionMessagesSettings::default(),
        };
        let revision = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder.peer-message.policy.v1",
                &self.profile_identity,
                &settings,
            ))?)
        );
        Ok(AgentMessagePolicyResult {
            enabled: settings.enabled,
            wake_idle: settings.wake_idle,
            revision,
        })
    }
    pub fn read(&self) -> Result<AgentMessagePolicyResult> {
        self.verify()?;
        let value = read_scope(&self.paths, ConfigScope::User)?;
        let observation = self.observation(&value)?;
        self.verify()?;
        Ok(observation)
    }
    /// Reads only the actual user's policy; project overlays never set admission limits.
    pub fn read_settings(&self) -> Result<CrossSessionMessagesSettings> {
        self.verify()?;
        let value = read_scope(&self.paths, ConfigScope::User)?;
        let settings = value
            .get("cross_session_messages")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()?
            .unwrap_or_default();
        self.verify()?;
        Ok(settings)
    }
    /// The authenticated user management lane calls this; it is never a model tool.
    pub fn save(
        &self,
        expected_revision: &str,
        enabled: bool,
        wake_idle: bool,
    ) -> Result<AgentMessagePolicyResult> {
        ensure!(!wake_idle || enabled, "peer_policy_wake_requires_enabled");
        self.verify()?;
        let value = update_scope(&self.paths, ConfigScope::User, |document| {
            self.verify()?;
            ensure!(
                self.observation(document)?.revision == expected_revision,
                "peer_policy_revision_changed"
            );
            let mut settings: CrossSessionMessagesSettings = document
                .get("cross_session_messages")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()?
                .unwrap_or_default();
            settings.enabled = enabled;
            settings.wake_idle = wake_idle;
            document["cross_session_messages"] = serde_json::to_value(settings)?;
            Ok(())
        })?;
        self.verify()?;
        self.observation(&value)
    }
}

#[cfg(test)]
#[path = "policy/tests.rs"]
mod tests;
