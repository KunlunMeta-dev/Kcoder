//! Current native model configuration without an alternate runtime or credential store.
use super::NativeIntegrationContext;
use anyhow::{Context, Result, ensure};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_config::PrivateDirectory;
use kcoder_engine::{
    QueryEngine,
    integrations::core::{
        NativeModelCandidateAuthorizer, configured_integration_model_policies,
        resolve_integration_model_selection_with_authorizer, validate_integration_auto_model,
    },
};
use kcoder_types::integrations::core::*;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeModelPolicyResolver {
    native: NativeIntegrationContext,
    engine: QueryEngine,
}
impl NativeModelCandidateAuthorizer for NativeModelPolicyResolver {
    fn allows(
        &self,
        engine: &QueryEngine,
        model: &kcoder_types::ModelConfigurationSummary,
    ) -> Result<bool> {
        if self.native.scope().organization_id.is_none() {
            return Ok(true);
        }
        if super::organization_model::validate_model_input(model).is_err() {
            return Ok(false);
        }
        let provider_id = model
            .provider_id
            .as_deref()
            .context("MODEL_NATIVE_PROVIDER_REQUIRED")?;
        let (settings, provider) = engine
            .resolve_client_model_configuration(&format!("{}::{}", provider_id, model.model_id))?;
        let actual = kcoder_engine::model_configuration_summary(
            &settings,
            kcoder_types::ModelConfigurationBoundary::NextTurn,
        )?;
        ensure!(
            actual.revision == model.revision
                && actual.provider_id == model.provider_id
                && actual.model_id == model.model_id,
            "MODEL_NATIVE_CONFIGURATION_CHANGED"
        );
        let endpoint = provider
            .endpoint()
            .context("MODEL_NATIVE_ENDPOINT_REQUIRED")?;
        match self.native.authorize_organization_model(
            model,
            endpoint,
            "native-model-candidate-preview",
        ) {
            Ok(()) => Ok(true),
            Err(error) if error.to_string() == "ORGANIZATION_MODEL_DENIED" => Ok(false),
            Err(error) => Err(error),
        }
    }
}
impl NativeModelPolicyResolver {
    /// Context and actual Engine come from the authenticated native host, never JSON labels.
    pub(crate) fn capture(native: &NativeIntegrationContext, engine: &QueryEngine) -> Result<Self> {
        validate_engine(native, engine)?;
        Ok(Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
        })
    }
    pub(crate) fn validate(&self, scope: &IntegrationScope) -> Result<()> {
        self.native.validate_scope(scope)?;
        validate_engine(&self.native, &self.engine)
    }
    pub(crate) fn read_policies(
        &self,
        request: &IntegrationRequest,
    ) -> Result<IntegrationModelPolicyCatalog> {
        request.validate(false)?;
        self.validate(&request.scope)?;
        ensure!(request.payload.is_empty(), "MODEL_POLICY_INVALID_REQUEST");
        let result = configured_integration_model_policies(&self.engine)?;
        self.validate(&request.scope)?;
        Ok(result)
    }
    pub(crate) fn read_health(
        &self,
        request: &IntegrationRequest,
    ) -> Result<IntegrationModelHealthReport> {
        request.validate(false)?;
        self.validate(&request.scope)?;
        let params: IntegrationModelHealthReadParams =
            rpc_codec::decode(serde_json::Value::Object(request.payload.clone()))?;
        let report = kcoder_engine::integrations::core::read_configured_integration_model_health(
            &self.engine,
            &params,
        )?;
        self.validate(&request.scope)?;
        Ok(report)
    }
    pub(crate) fn read_usage(
        &self,
        request: &IntegrationRequest,
    ) -> Result<IntegrationModelUsageReport> {
        request.validate(false)?;
        self.validate(&request.scope)?;
        let params: IntegrationModelHealthReadParams =
            rpc_codec::decode(serde_json::Value::Object(request.payload.clone()))?;
        let report = kcoder_engine::integrations::core::read_configured_integration_model_usage(
            &self.engine,
            &params,
        )?;
        self.validate(&request.scope)?;
        Ok(report)
    }
    pub(crate) fn resolve(
        &self,
        request: &IntegrationRequest,
    ) -> Result<IntegrationModelResolutionResult> {
        request.validate_method(IntegrationPort::Model, "resolveSelection")?;
        self.validate(&request.scope)?;
        let input: IntegrationModelResolutionRequest =
            rpc_codec::decode(serde_json::Value::Object(request.payload.clone()))?;
        let result =
            resolve_integration_model_selection_with_authorizer(&self.engine, &input, Some(self))?;
        self.validate(&request.scope)?;
        Ok(result)
    }
    pub(crate) async fn resolve_owned(
        self: Arc<Self>,
        request: IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationModelResolutionResult> {
        self.validate(&request.scope)?;
        ensure!(!cancel.is_cancelled(), "MODEL_POLICY_CANCELLED");
        let timeout = std::time::Duration::from_millis(request.timeout_ms);
        let scope = request.scope.clone();
        let checked = self.clone();
        let owned = cancel.child_token();
        let check = owned.clone();
        let mut job = crate::app_server::task_spawn::spawn_blocking(move || {
            ensure!(!check.is_cancelled(), "MODEL_POLICY_CANCELLED");
            let value = checked.resolve(&request)?;
            ensure!(!check.is_cancelled(), "MODEL_POLICY_CANCELLED");
            Ok::<_, anyhow::Error>(value)
        });
        let result = tokio::select! {biased;_=cancel.cancelled()=>Err(anyhow::anyhow!("MODEL_POLICY_CANCELLED")),_=tokio::time::sleep(timeout)=>Err(anyhow::anyhow!("MODEL_POLICY_RESOLUTION_UNAVAILABLE")),result=&mut job=>result.map_err(|_|anyhow::anyhow!("MODEL_POLICY_RESOLUTION_UNAVAILABLE"))?};
        owned.cancel();
        self.validate(&scope)?;
        result
    }
}
fn validate_engine(native: &NativeIntegrationContext, engine: &QueryEngine) -> Result<()> {
    native.verify()?;
    let path = engine
        .native_settings_source_path()
        .context("MODEL_NATIVE_PROFILE_UNAVAILABLE")?;
    ensure!(path.is_absolute(), "MODEL_NATIVE_PROFILE_UNAVAILABLE");
    let directory = PrivateDirectory::open_existing(
        path.parent().context("MODEL_NATIVE_PROFILE_UNAVAILABLE")?,
    )?;
    ensure!(
        directory.directory_identity()? == native.profile()?.directory_identity()?,
        "MODEL_NATIVE_PROFILE_MISMATCH"
    );
    let workspace = PrivateDirectory::open_existing(&engine.state.cwd())?;
    ensure!(
        workspace.directory_identity()? == native.workspace_directory_identity()?,
        "MODEL_NATIVE_WORKSPACE_MISMATCH"
    );
    Ok(())
}

/// Called after the original policy/budget installer, before native Provider dispatch.
/// A policy summary never replaces that installer's actual authority.
pub(crate) fn validate_runtime_model(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    resolution: &IntegrationModelResolutionResult,
) -> Result<()> {
    if resolution.selection_kind != IntegrationModelSelectionKind::AutoPolicy {
        return Ok(());
    }
    ensure!(
        native.scope().organization_id.is_none(),
        "MODEL_ORGANIZATION_POLICY_REQUIRED"
    );
    validate_engine(native, engine)?;
    validate_integration_auto_model(engine, resolution)?;
    native.verify()
}

pub(crate) fn install_runtime_model_policy(
    native: &NativeIntegrationContext,
    engine: QueryEngine,
    resolution: &IntegrationModelResolutionResult,
) -> Result<QueryEngine> {
    validate_runtime_model(native, &engine, resolution)?;
    engine.with_native_auto_model_health(resolution)
}

mod office_port;
pub(crate) use office_port::NativeOfficeModelPorts;
mod rpc;
pub(crate) use rpc::OwnedModelPolicyRequest;
#[cfg(test)]
mod tests;

pub(crate) mod dispatch;

pub(crate) mod settings;
