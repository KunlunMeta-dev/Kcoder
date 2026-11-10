//! Explicit native ACP peer availability. Configuration does not grant delegation or tool permissions.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::PathBuf};
mod office;
mod read_only;
pub use office::{
    NativeRemoteOfficePolicy, NativeRemoteOfficeRuntimeConfiguration,
    NativeRemoteOfficeStartupConfiguration,
};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RemoteIntegrationSettings {
    pub enabled: bool,
    pub native_acp_peers: Vec<ConfiguredNativeAcpPeer>,
    pub native_ssh_peers: Vec<ConfiguredNativeSshPeer>,
    pub receiver: NativeRemoteReceiverPolicy,
    pub outbound: NativeRemoteOutboundPolicy,
}
/// Explicit per-accepted-turn outbound ceiling. Native approval still owns each send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct NativeRemoteOutboundPolicy {
    pub enabled: bool,
    pub maximum_total_tokens: u64,
    pub maximum_model_calls: u32,
    pub maximum_duration_seconds: u32,
}
impl Default for NativeRemoteOutboundPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            maximum_total_tokens: 16_384,
            maximum_model_calls: 1,
            maximum_duration_seconds: 120,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct NativeRemoteReceiverPolicy {
    pub enabled: bool,
    /// Explicit opt-in for an actual same-account Native ACP parent, not Source JSON identity.
    pub allow_same_account_acp: bool,
    pub allowed_sender_accounts: Vec<String>,
    pub maximum_total_tokens: u64,
    pub maximum_model_calls: u32,
    pub maximum_duration_seconds: u32,
    pub accept_materials: bool,
    pub maximum_material_bytes: u64,
    pub office: NativeRemoteOfficePolicy,
}
impl Default for NativeRemoteReceiverPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_same_account_acp: false,
            allowed_sender_accounts: Vec::new(),
            maximum_total_tokens: 16_384,
            maximum_model_calls: 1,
            maximum_duration_seconds: 120,
            accept_materials: false,
            maximum_material_bytes: 0,
            office: Default::default(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfiguredNativeAcpPeer {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub enabled: bool,
    /// Independent receiver-owned KCoder profile. The caller's credentials are never copied.
    pub profile_directory: PathBuf,
    #[serde(default = "maximum_duration")]
    pub maximum_duration_seconds: u32,
}
/// A selector into the existing authenticated selected-target owner. These
/// values cannot launch a command or construct Native receiver authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfiguredNativeSshPeer {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub enabled: bool,
    pub target: kcoder_types::integrations::core::NativeRemoteTargetRefV1,
    #[serde(default = "maximum_duration")]
    pub maximum_duration_seconds: u32,
}
fn maximum_duration() -> u32 {
    120
}
impl RemoteIntegrationSettings {
    /// Explicit data selection from this receiver's own held profile snapshot.
    /// This does not authorize startup, tools or a model request.
    pub fn explicit_receiver_model_selection(bytes: &[u8]) -> Result<String> {
        ensure!(
            bytes.len() <= 8 * 1024 * 1024,
            "REMOTE_PROFILE_SETTINGS_LIMIT"
        );
        let document: serde_json::Value =
            jsonc_parser::parse_to_serde_value(std::str::from_utf8(bytes)?, &Default::default())?;
        let requested = document
            .get("model")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("REMOTE_OFFICE_OWN_MODEL_REQUIRED"))?;
        let (provider, model) = match requested.split_once("::") {
            Some((provider, model)) => (provider, model),
            None => (
                document
                    .get("active_provider")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("REMOTE_OFFICE_OWN_MODEL_REQUIRED"))?,
                requested,
            ),
        };
        ensure!(
            !provider.is_empty()
                && !model.is_empty()
                && document
                    .get("providers")
                    .and_then(serde_json::Value::as_object)
                    .is_some_and(|providers| providers.contains_key(provider)),
            "REMOTE_OFFICE_OWN_MODEL_REQUIRED"
        );
        Ok(format!("{provider}::{model}"))
    }
    pub fn admit_native_sender(
        bytes: &[u8],
        actual_sender_account: &str,
    ) -> Result<NativeRemoteReceiverPolicy> {
        let settings = Self::from_native_profile_snapshot(bytes)?;
        ensure!(
            settings.receiver.enabled
                && settings
                    .receiver
                    .allowed_sender_accounts
                    .iter()
                    .any(|id| id == actual_sender_account),
            "REMOTE_RECEIVER_NATIVE_SOURCE_DENIED"
        );
        Ok(settings.receiver)
    }
    /// Parse private Receiver policy only. The caller must separately hold the
    /// actual same-account, same-installation ACP parent; data cannot prove it.
    pub fn same_account_acp_receiver_policy(bytes: &[u8]) -> Result<NativeRemoteReceiverPolicy> {
        let settings = Self::from_native_profile_snapshot(bytes)?;
        ensure!(
            settings.receiver.enabled && settings.receiver.allow_same_account_acp,
            "REMOTE_RECEIVER_SAME_ACCOUNT_ACP_DISABLED"
        );
        Ok(settings.receiver)
    }
    /// Parse only the native profile-owned field from a bounded JSONC snapshot.
    /// Project overlays and caller JSON cannot provide a runner installation.
    pub fn from_native_profile_snapshot(bytes: &[u8]) -> Result<Self> {
        ensure!(
            !bytes.is_empty() && bytes.len() <= 8 * 1024 * 1024,
            "REMOTE_PROFILE_SETTINGS_LIMIT"
        );
        let source = std::str::from_utf8(bytes)?;
        let document: serde_json::Value =
            jsonc_parser::parse_to_serde_value(source, &Default::default())?;
        ensure!(document.is_object(), "REMOTE_PROFILE_SETTINGS_INVALID");
        let value = document
            .pointer("/integrations/remotes")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let settings: Self = serde_json::from_value(value)?;
        settings.validate()?;
        Ok(settings)
    }
    /// A receiver must independently choose either no tools or the exact Office
    /// subset. Normal permissions and a real native component parent remain required.
    pub fn validate_native_receiver(bytes: &[u8]) -> Result<()> {
        ensure!(
            bytes.len() <= 8 * 1024 * 1024,
            "REMOTE_PROFILE_SETTINGS_LIMIT"
        );
        let document: serde_json::Value =
            jsonc_parser::parse_to_serde_value(std::str::from_utf8(bytes)?, &Default::default())?;
        let policy = Self::from_native_profile_snapshot(bytes)?.receiver;
        let expected_profile = if policy.office.enabled {
            "core"
        } else {
            "none"
        };
        ensure!(
            document
                .pointer("/tools/profile")
                .and_then(serde_json::Value::as_str)
                == Some(expected_profile)
                && document
                    .pointer("/session_memory/enabled")
                    .and_then(serde_json::Value::as_bool)
                    == Some(false),
            "REMOTE_RECEIVER_PROFILE_RESTRICTIONS_REQUIRED"
        );
        if policy.office.enabled {
            let settings: crate::integrations::office::OfficeSettings = serde_json::from_value(
                document
                    .pointer("/integrations/office")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )?;
            ensure!(
                settings.enabled
                    && !settings.allowed_formats.is_empty()
                    && settings
                        .allowed_formats
                        .iter()
                        .all(|format| policy.office.allowed_formats.contains(format)),
                "REMOTE_OFFICE_FORMAT_INTERSECTION_REQUIRED"
            );
            ensure!(
                document
                    .get("permission_mode")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|mode| ["ask", "dont_ask"].contains(&mode)),
                "REMOTE_OFFICE_NORMAL_PERMISSIONS_REQUIRED"
            );
        }
        ensure!(
            document
                .get("hooks")
                .is_none_or(|value| value.as_object().is_some_and(serde_json::Map::is_empty)),
            "REMOTE_RECEIVER_HOOKS_UNAVAILABLE"
        );
        ensure!(
            document
                .pointer("/mcp_servers")
                .is_some_and(|value| value.as_array().is_some_and(Vec::is_empty))
                && document
                    .pointer("/plugins/runtime/enabled")
                    .and_then(serde_json::Value::as_bool)
                    == Some(false)
                && document
                    .pointer("/skills/auto_curator_enabled")
                    .and_then(serde_json::Value::as_bool)
                    == Some(false)
                && document
                    .pointer("/skills/auto_skill_review_enabled")
                    .and_then(serde_json::Value::as_bool)
                    == Some(false),
            "REMOTE_RECEIVER_EXTENSION_RESTRICTIONS_REQUIRED"
        );
        Ok(())
    }

    /// Compatibility name for callers that specifically require the no-tool mode.
    pub fn validate_text_only_receiver(bytes: &[u8]) -> Result<()> {
        Self::validate_native_receiver(bytes)?;
        ensure!(
            !Self::from_native_profile_snapshot(bytes)?
                .receiver
                .office
                .enabled,
            "REMOTE_TEXT_ONLY_RECEIVER_PROFILE_REQUIRED"
        );
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        let outbound = &self.outbound;
        ensure!(
            (1..=1_000_000).contains(&outbound.maximum_total_tokens)
                && (1..=64).contains(&outbound.maximum_model_calls)
                && (1..=1800).contains(&outbound.maximum_duration_seconds),
            "REMOTE_OUTBOUND_POLICY_LIMIT"
        );
        let receiver = &self.receiver;
        receiver.office.validate()?;
        ensure!(
            receiver.allowed_sender_accounts.len() <= 32
                && (1..=1_000_000).contains(&receiver.maximum_total_tokens)
                && (1..=64).contains(&receiver.maximum_model_calls)
                && (1..=1800).contains(&receiver.maximum_duration_seconds)
                && receiver.maximum_material_bytes <= 32 * 1024 * 1024
                && (!receiver.accept_materials || receiver.maximum_material_bytes > 0),
            "REMOTE_RECEIVER_POLICY_LIMIT"
        );
        let mut senders = BTreeSet::new();
        for sender in &receiver.allowed_sender_accounts {
            ensure!(
                !sender.is_empty()
                    && sender.len() <= 256
                    && !sender.chars().any(char::is_control)
                    && senders.insert(sender),
                "REMOTE_RECEIVER_NATIVE_SOURCE_INVALID"
            );
        }
        ensure!(
            self.native_acp_peers.len() + self.native_ssh_peers.len() <= 16,
            "REMOTE_RUNNER_LIMIT"
        );
        let mut ids = BTreeSet::new();
        for peer in &self.native_acp_peers {
            ensure!(
                !peer.id.is_empty()
                    && peer.id.len() <= 128
                    && peer.id.trim() == peer.id
                    && peer
                        .id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)),
                "REMOTE_RUNNER_ID_INVALID"
            );
            ensure!(ids.insert(&peer.id), "REMOTE_RUNNER_DUPLICATE");
            ensure!(
                peer.title.len() <= 256 && !peer.title.chars().any(char::is_control),
                "REMOTE_RUNNER_TITLE_INVALID"
            );
            ensure!(
                peer.profile_directory.is_absolute()
                    && (1..=1800).contains(&peer.maximum_duration_seconds),
                "REMOTE_RUNNER_CONFIGURATION_INVALID"
            );
        }
        for peer in &self.native_ssh_peers {
            ensure!(
                !peer.id.is_empty()
                    && peer.id.len() <= 128
                    && peer.id.trim() == peer.id
                    && peer
                        .id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)),
                "REMOTE_RUNNER_ID_INVALID"
            );
            ensure!(ids.insert(&peer.id), "REMOTE_RUNNER_DUPLICATE");
            ensure!(
                peer.title.len() <= 256 && !peer.title.chars().any(char::is_control),
                "REMOTE_RUNNER_TITLE_INVALID"
            );
            ensure!(
                (1..=1800).contains(&peer.maximum_duration_seconds)
                    && [&peer.target.target_id, &peer.target.target_revision]
                        .iter()
                        .all(|value| !value.is_empty()
                            && value.len() <= 256
                            && value.trim() == value.as_str()
                            && !value.chars().any(char::is_control))
                    && peer.target.expected_native_sha256.len() == 64
                    && peer
                        .target
                        .expected_native_sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit()),
                "REMOTE_RUNNER_CONFIGURATION_INVALID"
            );
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn material_receiver_is_independent_explicit_and_bounded() {
        let mut value = RemoteIntegrationSettings::default();
        assert!(!value.receiver.accept_materials && value.receiver.maximum_material_bytes == 0);
        value.receiver.accept_materials = true;
        assert!(value.validate().is_err());
        value.receiver.maximum_material_bytes = 32 * 1024 * 1024;
        value.validate().unwrap();
        value.receiver.maximum_material_bytes += 1;
        assert!(value.validate().is_err());
        for receiver in [
            serde_json::json!({"acceptMaterials":true}),
            serde_json::json!({"acceptMaterials":true,"maximumMaterialBytes":0}),
            serde_json::json!({"acceptMaterials":true,"maximumMaterialBytes":33554433u64}),
        ] {
            assert!(
                crate::schema::validate_settings_schema(&serde_json::json!({
                    "integrations":{"remotes":{"receiver":receiver}}
                }))
                .is_err()
            );
        }
        for receiver in [
            serde_json::json!({}),
            serde_json::json!({"acceptMaterials":false,"maximumMaterialBytes":0}),
            serde_json::json!({"acceptMaterials":true,"maximumMaterialBytes":33554432u64}),
        ] {
            crate::schema::validate_settings_schema(&serde_json::json!({
                "integrations":{"remotes":{"receiver":receiver}}
            }))
            .unwrap();
        }
    }
    #[test]
    fn remote_defaults_are_unavailable_without_implicit_runners() {
        let value: RemoteIntegrationSettings = serde_json::from_str("{}").unwrap();
        assert!(!value.enabled && value.native_acp_peers.is_empty());
        value.validate().unwrap();
        assert!(serde_json::from_str::<RemoteIntegrationSettings>(r#"{"approved":true}"#).is_err());
    }
    #[test]
    fn remote_profiles_and_durations_are_explicit_and_duplicate_peers_reject() {
        let peer = ConfiguredNativeAcpPeer {
            id: "explicit-native".into(),
            title: String::new(),
            enabled: true,
            profile_directory: std::env::temp_dir(),
            maximum_duration_seconds: 120,
        };
        let mut value = RemoteIntegrationSettings {
            enabled: true,
            native_acp_peers: vec![peer.clone()],
            native_ssh_peers: Vec::new(),
            receiver: Default::default(),
            outbound: Default::default(),
        };
        value.validate().unwrap();
        value.native_acp_peers.push(peer);
        assert!(value.validate().is_err());
        value.native_acp_peers.pop();
        value.native_acp_peers[0].profile_directory = "relative".into();
        assert!(value.validate().is_err());
    }
    #[test]
    fn real_loader_accepts_explicit_peers_and_rejects_executable_or_grant_fields() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let profile = temp.path().join("profile");
        let _private = crate::PrivateDirectory::open_or_create(&profile).unwrap();
        let peer = temp.path().join("independent-receiver");
        let settings = serde_json::json!({"integrations":{"remotes":{
            "enabled":true,"nativeAcpPeers":[{"id":"owned-native","enabled":true,
            "profileDirectory":peer,"maximumDurationSeconds":30}]
        }}});
        std::fs::write(
            profile.join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let loaded = crate::SettingsLoader::new(&workspace)
            .with_config_dir(&profile)
            .load()
            .unwrap();
        assert!(loaded.settings.integrations.remotes.enabled);
        assert_eq!(
            loaded.settings.integrations.remotes.native_acp_peers[0].profile_directory,
            peer
        );
        assert!(!profile.join("integrations").exists());
        for field in [
            "approved",
            "command",
            "environment",
            "allowedModels",
            "tools",
        ] {
            let mut forged = settings.clone();
            forged["integrations"]["remotes"]["nativeAcpPeers"][0][field] = serde_json::json!(true);
            std::fs::write(
                profile.join("settings.json"),
                serde_json::to_vec(&forged).unwrap(),
            )
            .unwrap();
            assert!(
                crate::SettingsLoader::new(&workspace)
                    .with_config_dir(&profile)
                    .load()
                    .is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn receiver_restrictions_are_explicit_and_material_is_not_configuration() {
        let valid = serde_json::json!({"tools":{"profile":"none"},"session_memory":{"enabled":false},"mcp_servers":[],"plugins":{"runtime":{"enabled":false}},"skills":{"auto_curator_enabled":false,"auto_skill_review_enabled":false}});
        RemoteIntegrationSettings::validate_text_only_receiver(
            &serde_json::to_vec(&valid).unwrap(),
        )
        .unwrap();
        for invalid in [
            serde_json::json!({}),
            serde_json::json!({"tools":{"profile":"full"},"session_memory":{"enabled":false}}),
            serde_json::json!({"tools":{"profile":"none"},"session_memory":{"enabled":true}}),
            serde_json::json!({"tools":{"profile":"none"},"session_memory":{"enabled":false},"hooks":{"PreToolUse":[]}}),
        ] {
            assert!(
                RemoteIntegrationSettings::validate_text_only_receiver(
                    &serde_json::to_vec(&invalid).unwrap()
                )
                .is_err()
            );
        }
        let source =
            serde_json::json!({"materials":[{"integrations":{"remotes":{"enabled":true}}}]});
        assert!(
            !RemoteIntegrationSettings::from_native_profile_snapshot(
                &serde_json::to_vec(&source).unwrap()
            )
            .unwrap()
            .enabled
        );
    }
    #[test]
    fn same_account_acp_policy_needs_both_private_opt_ins_and_does_not_accept_sender_claims() {
        assert!(!NativeRemoteReceiverPolicy::default().allow_same_account_acp);
        for receiver in [
            serde_json::json!({}),
            serde_json::json!({"enabled":true,"allowedSenderAccounts":["claimed-source"]}),
            serde_json::json!({"allowSameAccountAcp":true}),
        ] {
            let settings = serde_json::json!({"integrations":{"remotes":{"receiver":receiver}}});
            assert!(
                RemoteIntegrationSettings::same_account_acp_receiver_policy(
                    &serde_json::to_vec(&settings).unwrap()
                )
                .is_err()
            );
        }
        let settings = serde_json::json!({"integrations":{"remotes":{"receiver":{"enabled":true,"allowSameAccountAcp":true}}}});
        let bytes = serde_json::to_vec(&settings).unwrap();
        let policy = RemoteIntegrationSettings::same_account_acp_receiver_policy(&bytes).unwrap();
        assert!(policy.allow_same_account_acp);
        assert!(policy.allowed_sender_accounts.is_empty());
        assert!(RemoteIntegrationSettings::admit_native_sender(&bytes, "claimed-source").is_err());
        crate::schema::validate_settings_schema(&settings).unwrap();
    }
    #[test]
    fn independent_receiver_requires_its_own_exact_native_sender_opt_in_and_finite_bounds() {
        assert!(
            RemoteIntegrationSettings::admit_native_sender(b"{}", "actual-native-sender").is_err()
        );
        let settings = serde_json::json!({"integrations":{"remotes":{"receiver":{"enabled":true,"allowedSenderAccounts":["actual-native-sender"],"maximumTotalTokens":2048,"maximumModelCalls":1,"maximumDurationSeconds":30}}}});
        let bytes = serde_json::to_vec(&settings).unwrap();
        let accepted =
            RemoteIntegrationSettings::admit_native_sender(&bytes, "actual-native-sender").unwrap();
        assert_eq!(accepted.maximum_total_tokens, 2048);
        assert!(
            RemoteIntegrationSettings::admit_native_sender(&bytes, "same-label-other-account")
                .is_err()
        );
        crate::schema::validate_settings_schema(&settings).unwrap();
        for patch in [
            serde_json::json!({"approved":true}),
            serde_json::json!({"maximumModelCalls":0}),
            serde_json::json!({"maximumTotalTokens":0}),
            serde_json::json!({"allowedSenderAccounts":["duplicate","duplicate"]}),
        ] {
            let mut invalid = settings.clone();
            for (key, value) in patch.as_object().unwrap() {
                invalid["integrations"]["remotes"]["receiver"][key] = value.clone();
            }
            assert!(
                RemoteIntegrationSettings::from_native_profile_snapshot(
                    &serde_json::to_vec(&invalid).unwrap()
                )
                .is_err()
            );
        }
    }
    #[test]
    fn outbound_ordinary_source_is_explicit_finite_and_cannot_supply_credit_or_commands() {
        let defaults = RemoteIntegrationSettings::default();
        assert!(!defaults.outbound.enabled);
        let valid = serde_json::json!({"integrations":{"remotes":{"enabled":true,"outbound":{"enabled":true,"maximumTotalTokens":2000,"maximumModelCalls":1,"maximumDurationSeconds":30}}}});
        crate::schema::validate_settings_schema(&valid).unwrap();
        assert!(
            RemoteIntegrationSettings::from_native_profile_snapshot(
                &serde_json::to_vec(&valid).unwrap()
            )
            .unwrap()
            .outbound
            .enabled
        );
        for patch in [
            serde_json::json!({"maximumTotalTokens":0}),
            serde_json::json!({"maximumModelCalls":0}),
            serde_json::json!({"maximumDurationSeconds":0}),
            serde_json::json!({"credits":999}),
            serde_json::json!({"command":"runner"}),
        ] {
            let mut invalid = valid.clone();
            for (key, value) in patch.as_object().unwrap() {
                invalid["integrations"]["remotes"]["outbound"][key] = value.clone();
            }
            assert!(
                RemoteIntegrationSettings::from_native_profile_snapshot(
                    &serde_json::to_vec(&invalid).unwrap()
                )
                .is_err()
            );
            assert!(crate::schema::validate_settings_schema(&invalid).is_err());
        }
    }
}

#[cfg(test)]
mod ssh_tests;
