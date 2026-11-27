//! One bounded field in the original profile transaction, and the original operation ledger.
use super::*;
use kcoder_config::{
    ProfileSettingsFile,
    integrations::core::{ConfiguredModelPolicy, CoreIntegrationSettings},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{cell::Cell, ffi::OsStr, sync::Weak};
const FIELD: &str = "integrations.core.modelPolicies";
const PORT: &str = "model-policy-settings";
const METHOD: &str = "savePolicies";

struct Target {
    resolver: NativeModelPolicyResolver,
    file: ProfileSettingsFile,
    profile_identity: String,
}
impl Target {
    fn capture(native: &NativeIntegrationContext, engine: &QueryEngine) -> Result<Self> {
        let resolver = NativeModelPolicyResolver::capture(native, engine)?;
        let path = engine
            .settings_persistence_path()
            .context("MODEL_POLICY_SETTINGS_UNAVAILABLE")?;
        ensure!(
            path.file_name() == Some(OsStr::new("settings.json")),
            "MODEL_POLICY_SETTINGS_CUSTOM_FILE_UNAVAILABLE"
        );
        let profile = native.profile()?;
        let file = ProfileSettingsFile::from_directory_handle(profile)?;
        Ok(Self {
            resolver,
            file,
            profile_identity: profile.directory_identity()?,
        })
    }
    fn check(&self, scope: &IntegrationScope) -> Result<()> {
        self.resolver.validate(scope)?;
        ensure!(
            self.file.directory_identity()? == self.profile_identity,
            "MODEL_POLICY_SETTINGS_TARGET_CHANGED"
        );
        Ok(())
    }
    fn require_file(&self) -> Result<()> {
        let file = self
            .resolver
            .native
            .profile()?
            .open_single_link_regular_file(OsStr::new("settings.json"))?;
        ensure!(
            file.metadata()?.len() > 0 && file.metadata()?.len() <= 16 * 1024 * 1024,
            "MODEL_POLICY_SETTINGS_UNAVAILABLE"
        );
        Ok(())
    }
    fn snapshot(&self, document: &Value) -> Result<IntegrationModelPolicySettingsSnapshot> {
        let raw = document.pointer("/integrations/core/modelPolicies");
        let policies: Vec<ConfiguredModelPolicy> = raw
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        CoreIntegrationSettings {
            model_policies: policies.clone(),
            ..Default::default()
        }
        .validate()?;
        let definitions = serde_json::from_value(serde_json::to_value(policies)?)?;
        let bytes = serde_json::to_vec(&json!([
            "native-model-policy-field-v1",
            self.profile_identity,
            raw
        ]))?;
        Ok(IntegrationModelPolicySettingsSnapshot {
            revision: format!("{:x}", Sha256::digest(bytes)),
            policies: definitions,
            models: Vec::new(),
            models_truncated: false,
        })
    }
    fn read(&self, scope: &IntegrationScope) -> Result<IntegrationModelPolicySettingsSnapshot> {
        self.check(scope)?;
        self.require_file()?;
        let mut result = self.file.inspect_locked(|document| {
            self.check(scope)?;
            self.require_file()?;
            self.snapshot(document)
        })?;
        self.check(scope)?;
        self.require_file()?;
        // Resolve catalog metadata outside profile transaction locks: the
        // actual source may itself acquire those locks and resolve credentials.
        let models = self.resolver.engine.current_configured_model_profiles()?;
        result.models_truncated = models.len() > 512;
        result.models = models
            .into_iter()
            .take(512)
            .map(|model| IntegrationModelPolicyAvailableModel {
                provider: model.provider,
                model: model.model,
                configuration_revision: model
                    .configuration
                    .map(|configuration| configuration.revision),
                available: model.available,
            })
            .collect();
        self.check(scope)?;
        Ok(result)
    }
}

pub(crate) struct NativeModelPolicySettings {
    target: Target,
    request: IntegrationRequest,
    owner: Weak<()>,
    cancel: CancellationToken,
}
impl NativeModelPolicySettings {
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        request: IntegrationRequest,
        owner: Weak<()>,
        cancel: CancellationToken,
    ) -> Result<Self> {
        let target = Target::capture(native, engine)?;
        let result = Self {
            target,
            request,
            owner,
            cancel,
        };
        result.check()?;
        Ok(result)
    }
    fn check(&self) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some() && !self.cancel.is_cancelled(),
            "MODEL_POLICY_SETTINGS_CALLER_EXPIRED"
        );
        self.target.check(&self.request.scope)
    }
    pub(crate) fn read(&self) -> Result<IntegrationModelPolicySettingsSnapshot> {
        self.request.validate(false)?;
        ensure!(
            self.request.payload.is_empty(),
            "MODEL_POLICY_SETTINGS_INVALID_REQUEST"
        );
        self.check()?;
        let value = self.target.read(&self.request.scope)?;
        self.check()?;
        Ok(value)
    }
    pub(crate) fn read_operation(&self) -> Result<Option<IntegrationOperationReceipt>> {
        self.request.validate(false)?;
        self.check()?;
        let input: IntegrationModelPolicySettingsOperationParams =
            serde_json::from_value(Value::Object(self.request.payload.clone()))?;
        ensure!(
            !input.operation_id.is_empty() && input.operation_id.len() <= 256,
            "MODEL_POLICY_SETTINGS_INVALID_REQUEST"
        );
        let Some(operations) = super::super::NativeOperations::load(&self.target.resolver.native)?
        else {
            return Ok(None);
        };
        let receipt = operations.read(&self.target.resolver.native, &input.operation_id)?;
        if let Some(receipt) = &receipt {
            ensure!(
                receipt.port == PORT && receipt.method == METHOD,
                "MODEL_POLICY_SETTINGS_OPERATION_MISMATCH"
            );
        }
        self.check()?;
        Ok(receipt)
    }
    pub(crate) fn save(&self) -> Result<IntegrationModelPolicySettingsSaveResult> {
        self.request.validate(true)?;
        self.check()?;
        self.target.read(&self.request.scope)?;
        let input: IntegrationModelPolicySettingsSaveParams =
            serde_json::from_value(Value::Object(self.request.payload.clone()))?;
        let configured: Vec<ConfiguredModelPolicy> =
            serde_json::from_value(serde_json::to_value(&input.policies)?)?;
        CoreIntegrationSettings {
            model_policies: configured.clone(),
            ..Default::default()
        }
        .validate()?;
        let expected = self
            .request
            .expected_revision
            .as_deref()
            .context("MODEL_POLICY_SETTINGS_REVISION_REQUIRED")?;
        ensure!(
            expected.len() == 64 && expected.bytes().all(|value| value.is_ascii_hexdigit()),
            "MODEL_POLICY_SETTINGS_INVALID_REQUEST"
        );
        // Read-only configuration/model metadata cannot grant a candidate. It
        // merely rejects references not actually configured on this target.
        for policy in configured.iter().filter(|policy| policy.enabled) {
            for candidate in policy
                .candidates
                .iter()
                .filter(|candidate| candidate.enabled)
            {
                let (settings, _) = self
                    .target
                    .resolver
                    .engine
                    .resolve_client_model_configuration(&format!(
                        "{}::{}",
                        candidate.provider, candidate.model
                    ))?;
                ensure!(
                    settings
                        .providers
                        .get(&candidate.provider)
                        .is_some_and(|provider| provider.has_model(&candidate.model)),
                    "MODEL_POLICY_SETTINGS_MODEL_UNAVAILABLE"
                );
            }
        }
        // Opening the original namespace and beginning this mutation occurs
        // only after native owner/input/configuration validation above.
        let native = &self.target.resolver.native;
        let operations = match super::super::NativeOperations::load(native)? {
            Some(operations) => operations,
            None => super::super::NativeOperations::initialize(
                native,
                self.request.operation_id.as_deref().unwrap_or_default(),
            )?,
        };
        let (receipt, fresh) = operations.begin(native, &self.request, PORT, METHOD)?;
        if !fresh {
            return Ok(IntegrationModelPolicySettingsSaveResult {
                operation: receipt,
                current: self.target.read(&self.request.scope)?,
            });
        }
        let prepared = Cell::new(false);
        let saved = self.target.file.update(|document| {
            self.check()?;
            self.target.require_file()?;
            ensure!(
                self.target.snapshot(document)?.revision == expected,
                "MODEL_POLICY_SETTINGS_REVISION_CONFLICT"
            );
            kcoder_config::set_dotted_value(document, FIELD, serde_json::to_value(configured)?)?;
            prepared.set(true);
            Ok(())
        });
        let operation = match saved {
            Ok(document) => {
                // Only the actual transaction return proves this operation's
                // commit. A same-value later read is never promoted to success.
                let written = self.target.snapshot(&document)?;
                operations.transition_with_entity(
                    native,
                    &receipt,
                    IntegrationOperationPhase::Completed,
                    Some(IntegrationEntityRef {
                        kind: IntegrationEntityKind::ModelPolicyConfiguration,
                        id: native.scope().account_id.clone(),
                        revision: Some(written.revision),
                    }),
                    None,
                )?
            }
            Err(error) => {
                let code = if error
                    .chain()
                    .any(|value| value.to_string() == "MODEL_POLICY_SETTINGS_REVISION_CONFLICT")
                {
                    Some("MODEL_POLICY_SETTINGS_REVISION_CONFLICT")
                } else if !prepared.get() && self.cancel.is_cancelled() {
                    Some("MODEL_POLICY_SETTINGS_CANCELLED")
                } else {
                    None
                };
                operations.transition(
                    native,
                    &receipt,
                    if code.is_some() {
                        IntegrationOperationPhase::Rejected
                    } else {
                        IntegrationOperationPhase::Unknown
                    },
                    Some(IntegrationError {
                        code: code
                            .unwrap_or("MODEL_POLICY_SETTINGS_OUTCOME_UNKNOWN")
                            .into(),
                        recovery: IntegrationRecovery::ReconcileOriginal,
                        message_key: "integrations.models.settings.unconfirmed".into(),
                    }),
                )?
            }
        };
        Ok(IntegrationModelPolicySettingsSaveResult {
            operation,
            current: self.target.read(&self.request.scope)?,
        })
    }
}
#[cfg(test)]
mod tests;

mod dispatch;
pub(in crate::app_server) use dispatch::dispatch;
