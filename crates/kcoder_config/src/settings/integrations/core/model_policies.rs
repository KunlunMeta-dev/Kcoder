//! Explicit target-owned AUTO candidate pools; configuration is not runtime authority.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct CoreIntegrationSettings {
    pub model_policies: Vec<ConfiguredModelPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_task_budget: Option<super::ConfiguredChannelTaskBudget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfiguredModelPolicy {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Order is an explicit user/organization preference, never catalog order.
    pub candidates: Vec<ConfiguredModelPolicyCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfiguredModelPolicyCandidate {
    pub provider: String,
    pub model: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_revision: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.trim() == id && !id.chars().any(char::is_control)
}
impl CoreIntegrationSettings {
    pub fn validate(&self) -> Result<()> {
        if let Some(budget) = &self.channel_task_budget {
            budget.validate()?;
        }
        ensure!(
            self.model_policies.len() <= 32,
            "MODEL_POLICY_LIMIT_EXCEEDED"
        );
        let mut ids = BTreeSet::new();
        for policy in &self.model_policies {
            policy.validate()?;
            ensure!(ids.insert(&policy.id), "MODEL_POLICY_DUPLICATE_ID");
        }
        Ok(())
    }
    pub fn policy(&self, id: &str, version: &str) -> Result<&ConfiguredModelPolicy> {
        self.validate()?;
        let policy = self
            .model_policies
            .iter()
            .find(|policy| policy.id == id)
            .ok_or_else(|| anyhow::anyhow!("MODEL_AUTO_POLICY_UNAVAILABLE"))?;
        ensure!(
            policy.version()? == version,
            "MODEL_AUTO_POLICY_VERSION_CHANGED"
        );
        ensure!(policy.enabled, "MODEL_AUTO_POLICY_DISABLED");
        Ok(policy)
    }
}
impl ConfiguredModelPolicy {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            valid_id(&self.id) && self.title.chars().count() <= 256,
            "MODEL_POLICY_INVALID_ID"
        );
        ensure!(
            !self.candidates.is_empty() && self.candidates.len() <= 16,
            "MODEL_POLICY_INVALID_CANDIDATES"
        );
        let mut seen = BTreeSet::new();
        for candidate in &self.candidates {
            ensure!(
                valid_id(&candidate.provider)
                    && !candidate.provider.contains("::")
                    && valid_id(&candidate.model),
                "MODEL_POLICY_INVALID_CANDIDATE"
            );
            ensure!(
                candidate
                    .configuration_revision
                    .as_ref()
                    .is_none_or(|revision| valid_id(revision)),
                "MODEL_POLICY_INVALID_REVISION"
            );
            ensure!(
                seen.insert((&candidate.provider, &candidate.model)),
                "MODEL_POLICY_DUPLICATE_CANDIDATE"
            );
        }
        Ok(())
    }
    /// Only execution semantics affect this version. Labels are presentation.
    /// Arrays retain configured order and no credential/endpoint value is exposed.
    pub fn version(&self) -> Result<String> {
        self.validate()?;
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "native-model-policy-v1",
                &self.id,
                self.enabled,
                &self.candidates,
            ))?)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn policy() -> ConfiguredModelPolicy {
        serde_json::from_value(json!({"id":"office-auto","candidates":[
            {"provider":"Provider-A","model":"Exact-Model"},
            {"provider":"Provider-B","model":"Second-Model"}
        ]}))
        .unwrap()
    }
    #[test]
    fn old_empty_configuration_does_not_enable_auto_and_unknown_fields_are_rejected() {
        let settings: CoreIntegrationSettings = serde_json::from_value(json!({})).unwrap();
        assert!(settings.model_policies.is_empty());
        settings.validate().unwrap();
        assert!(settings.policy("unknown", "version").is_err());
        assert!(
            serde_json::from_value::<CoreIntegrationSettings>(json!({"apiKey":"forbidden"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<ConfiguredModelPolicyCandidate>(
                json!({"provider":"A","model":"B","credentials":"forbidden"})
            )
            .is_err()
        );
    }
    #[test]
    fn actual_order_pin_or_enable_change_invalidates_the_original_semantic_version() {
        let original = policy();
        let version = original.version().unwrap();
        let mut labeled = original.clone();
        labeled.title = "Display only".into();
        assert_eq!(labeled.version().unwrap(), version);
        for mutation in 0..3 {
            let mut next = original.clone();
            match mutation {
                0 => next.candidates.reverse(),
                1 => next.candidates[0].enabled = false,
                _ => {
                    next.candidates[0].configuration_revision = Some("exact-native-revision".into())
                }
            }
            assert_ne!(next.version().unwrap(), version);
            assert!(
                CoreIntegrationSettings {
                    model_policies: vec![next],
                    ..Default::default()
                }
                .policy(&original.id, &version)
                .is_err()
            );
        }
        let mut duplicate = original.clone();
        duplicate.candidates.push(duplicate.candidates[0].clone());
        assert!(duplicate.validate().is_err());
        assert!(
            CoreIntegrationSettings {
                model_policies: vec![original.clone(), original],
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}
