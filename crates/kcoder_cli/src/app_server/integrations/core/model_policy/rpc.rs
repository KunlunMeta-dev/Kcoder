//! Public finite management is captured from the real connection, not an arbitrary Port call.
use super::*;
use kcoder_app_protocol::integrations::ModelPoliciesMethod;
use serde_json::Value;
use std::sync::Weak;

pub(crate) struct OwnedModelPolicyRequest {
    resolver: Arc<NativeModelPolicyResolver>,
    request: IntegrationRequest,
    method: ModelPoliciesMethod,
    owner: Weak<()>,
    cancel: CancellationToken,
}
impl OwnedModelPolicyRequest {
    /// Root supplies the actual inbound connection's owner and cancellation,
    /// after capability negotiation. They cannot be constructed from payload fields.
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        request: IntegrationRequest,
        method: ModelPoliciesMethod,
        owner: Weak<()>,
        cancel: CancellationToken,
    ) -> Result<Self> {
        request.validate(false)?;
        ensure!(
            owner.upgrade().is_some() && !cancel.is_cancelled(),
            "MODEL_POLICY_CALLER_EXPIRED"
        );
        let resolver = Arc::new(NativeModelPolicyResolver::capture(native, engine)?);
        resolver.validate(&request.scope)?;
        Ok(Self {
            resolver,
            request,
            method,
            owner,
            cancel,
        })
    }
    fn check(&self) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some() && !self.cancel.is_cancelled(),
            "MODEL_POLICY_CALLER_EXPIRED"
        );
        self.resolver.validate(&self.request.scope)
    }
    pub(crate) async fn run(self) -> Result<IntegrationReply> {
        self.check()?;
        let result = match self.method {
            ModelPoliciesMethod::ResolveSelection => serde_json::to_value(
                self.resolver
                    .clone()
                    .resolve_owned(self.request.clone(), &self.cancel)
                    .await?,
            )?,
            ModelPoliciesMethod::ReadPolicies
            | ModelPoliciesMethod::ReadHealth
            | ModelPoliciesMethod::ReadUsage => {
                let resolver = self.resolver.clone();
                let request = self.request.clone();
                let method = self.method;
                let cancel = self.cancel.child_token();
                let owned = cancel.clone();
                let mut job = crate::app_server::task_spawn::spawn_blocking(move || {
                    ensure!(!owned.is_cancelled(), "MODEL_POLICY_CANCELLED");
                    let value = match method {
                        ModelPoliciesMethod::ReadPolicies => {
                            serde_json::to_value(resolver.read_policies(&request)?)
                        }
                        ModelPoliciesMethod::ReadHealth => {
                            serde_json::to_value(resolver.read_health(&request)?)
                        }
                        ModelPoliciesMethod::ReadUsage => {
                            serde_json::to_value(resolver.read_usage(&request)?)
                        }
                        ModelPoliciesMethod::ResolveSelection => {
                            return Err(anyhow::anyhow!("MODEL_POLICY_INVALID_REQUEST"));
                        }
                    }
                    .map_err(anyhow::Error::from)?;
                    ensure!(!owned.is_cancelled(), "MODEL_POLICY_CANCELLED");
                    Ok::<_, anyhow::Error>(value)
                });
                let value = tokio::select! {biased;_=self.cancel.cancelled()=>Err(anyhow::anyhow!("MODEL_POLICY_CANCELLED")),_=tokio::time::sleep(std::time::Duration::from_millis(self.request.timeout_ms))=>Err(anyhow::anyhow!("MODEL_POLICY_RESOLUTION_UNAVAILABLE")),result=&mut job=>result.map_err(|_|anyhow::anyhow!("MODEL_POLICY_RESOLUTION_UNAVAILABLE"))?};
                cancel.cancel();
                value?
            }
        };
        self.check()?;
        let Value::Object(result) = result else {
            anyhow::bail!("MODEL_POLICY_INVALID_RESULT")
        };
        Ok(IntegrationReply {
            contract_version: self.request.contract_version,
            request_id: self.request.request_id,
            operation_id: self
                .request
                .operation_id
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            status: IntegrationStatus::Completed,
            observed_at: chrono::Utc::now().to_rfc3339(),
            result: IntegrationNullable::Value(result),
            error: IntegrationNullable::Null,
        })
    }
}
