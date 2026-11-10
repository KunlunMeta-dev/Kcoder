//! Explicit public application task consent for its exact selected resource.
use super::{
    application_resources::NativeApplicationResourceConnection,
    main_public::NativeConnectivityPublicCall,
};
use crate::app_server::integrations::core::NativeIntegrationContext;
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::connectivity::ConnectivityMethod;
use kcoder_types::integrations::core::IntegrationTaskCapabilitySourceChoice;
use serde_json::Value;
use std::sync::{Arc, Mutex, Weak};
use tokio_util::sync::CancellationToken;

/// Resource identity includes the original source/account security revision.
/// A descriptor with the same URI on another account is not the old grant.
pub(super) fn resource_revision(
    choice: &IntegrationTaskCapabilitySourceChoice,
    descriptor: &impl serde::Serialize,
) -> Result<String> {
    use sha2::{Digest, Sha256};
    choice.validate()?;
    Ok(format!(
        "native-resource-v2:{:x}:{:x}",
        Sha256::digest(serde_json::to_vec(&serde_json::json!([
            "native-app-resource-source-v2",
            choice
        ]))?),
        Sha256::digest(serde_json::to_vec(descriptor)?)
    ))
}
pub(super) fn verify_resource_revision(
    choice: &IntegrationTaskCapabilitySourceChoice,
    revision: &str,
) -> Result<()> {
    use sha2::{Digest, Sha256};
    choice.validate()?;
    let prefix = format!(
        "native-resource-v2:{:x}:",
        Sha256::digest(serde_json::to_vec(&serde_json::json!([
            "native-app-resource-source-v2",
            choice
        ]))?)
    );
    let descriptor = revision
        .strip_prefix(&prefix)
        .ok_or_else(|| anyhow::anyhow!("APPLICATION_RESOURCE_SOURCE_CHANGED"))?;
    ensure!(
        descriptor.len() == 64 && descriptor.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "APPLICATION_RESOURCE_SOURCE_CHANGED"
    );
    Ok(())
}

/// Live task permission is withdrawn before a public mutation may change the
/// connection's selected resources. It stores no data or durable authority.
#[derive(Default)]
pub(super) struct NativeApplicationTaskGrants {
    active: Mutex<Vec<Weak<NativeApplicationTaskGrant>>>,
}
pub(super) struct NativeApplicationTaskGrant {
    owner: super::main_public::NativeConnectivityManagementOwner,
    connection_id: String,
    connection_revision: u64,
    revoked: CancellationToken,
}
impl NativeApplicationTaskGrant {
    pub(super) fn client_cancellation(&self) -> CancellationToken {
        self.owner.client_cancellation()
    }
    pub(super) fn verify(&self, native: &NativeIntegrationContext) -> Result<()> {
        self.owner.verify(native)?;
        ensure!(
            !self.revoked.is_cancelled(),
            "APPLICATION_TASK_RESOURCES_REVOKED"
        );
        Ok(())
    }
}
impl NativeApplicationTaskGrants {
    pub(super) fn bind(
        &self,
        caller: &NativeConnectivityPublicCall,
    ) -> Result<Arc<NativeApplicationTaskGrant>> {
        let grant = Arc::new(NativeApplicationTaskGrant {
            owner: caller.retain_application_task_owner()?,
            connection_id: caller
                .call()
                .request
                .payload
                .get("connectionId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("APPLICATION_ORIGINAL_CONNECTION_REQUIRED"))?
                .into(),
            connection_revision: caller
                .call()
                .request
                .expected_revision
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("APPLICATION_ORIGINAL_REVISION_REQUIRED"))?
                .parse()
                .map_err(|_| anyhow::anyhow!("APPLICATION_ORIGINAL_REVISION_REQUIRED"))?,
            revoked: CancellationToken::new(),
        });
        let mut active = self
            .active
            .lock()
            .map_err(|_| anyhow::anyhow!("APPLICATION_TASK_GRANTS_UNAVAILABLE"))?;
        active.retain(|grant| grant.strong_count() > 0);
        ensure!(active.len() < 128, "APPLICATION_TASK_GRANT_CAPACITY");
        active.push(Arc::downgrade(&grant));
        Ok(grant)
    }
    pub(super) fn before_public_mutation(
        &self,
        caller: &NativeConnectivityPublicCall,
    ) -> Result<()> {
        caller.verify(caller.context().scope())?;
        let call = caller.call();
        if call.method != ConnectivityMethod::PrepareConnectionAction
            || !matches!(
                call.request.payload.get("action").and_then(Value::as_str),
                Some("save" | "setResources" | "disconnect" | "disable" | "stop")
            )
        {
            return Ok(());
        }
        let id = call
            .request
            .payload
            .get("connectionId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("APPLICATION_ORIGINAL_CONNECTION_REQUIRED"))?;
        let Some(revision) = call
            .request
            .expected_revision
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
        else {
            return Ok(());
        };
        let mut active = self
            .active
            .lock()
            .map_err(|_| anyhow::anyhow!("APPLICATION_TASK_GRANTS_UNAVAILABLE"))?;
        active.retain(|weak| {
            if let Some(grant) = weak.upgrade() {
                if grant.connection_id == id && grant.connection_revision <= revision {
                    grant.revoked.cancel();
                }
                true
            } else {
                false
            }
        });
        Ok(())
    }
}

/// Constructed only after the native consumer resolves the original selected
/// refs through the current owned Main. Neither URI text nor registration grants it.
pub(crate) struct NativeApplicationTaskReadUse {
    caller: Arc<NativeConnectivityPublicCall>,
    choice: IntegrationTaskCapabilitySourceChoice,
    resource_uri: String,
    grant: Arc<NativeApplicationTaskGrant>,
}
impl NativeApplicationTaskReadUse {
    pub(super) fn from_selected_resource(
        caller: Arc<NativeConnectivityPublicCall>,
        choice: IntegrationTaskCapabilitySourceChoice,
        resource_uri: String,
        resource_revision: &str,
        grant: Arc<NativeApplicationTaskGrant>,
    ) -> Result<Self> {
        caller.verify(caller.context().scope())?;
        choice.validate()?;
        let body = &caller.call().request.payload;
        ensure!(
            caller.call().method == ConnectivityMethod::PrepareConnectionAction
                && body.get("action").and_then(Value::as_str) == Some("runOfficeTask")
                && matches!(
                    body.get("businessAction").and_then(Value::as_str),
                    Some(
                        "document.summarize"
                            | "document.compare"
                            | "mail.summarize"
                            | "mail.draft"
                            | "table.analyze"
                            | "table.query"
                    )
                )
                && body
                    .get("resourceRefs")
                    .and_then(Value::as_array)
                    .is_some_and(|refs| !refs.is_empty() && refs.len() <= 100)
                && !resource_uri.is_empty()
                && resource_uri.len() <= 4096
                && !resource_uri.chars().any(char::is_control),
            "APPLICATION_ORIGINAL_READ_TASK_REQUIRED"
        );
        verify_resource_revision(&choice, resource_revision)?;
        grant.verify(caller.context())?;
        Ok(Self {
            caller,
            choice,
            resource_uri,
            grant,
        })
    }
    pub(crate) fn resource_uri(&self) -> &str {
        &self.resource_uri
    }
    pub(crate) fn verify_current(
        &self,
        native: &NativeIntegrationContext,
        connection: &NativeApplicationResourceConnection,
    ) -> Result<()> {
        self.caller.verify(native.scope())?;
        self.grant.verify(native)?;
        ensure!(
            connection.choice() == &self.choice,
            "APPLICATION_TASK_RESOURCE_SOURCE_CHANGED"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_app_protocol::integrations::connectivity::{ConnectivityPort, ConnectivityPortCall};
    use kcoder_types::integrations::core::*;
    use serde_json::json;
    #[test]
    fn grant_revision_cannot_cross_account_or_source_epoch_and_legacy_requires_rediscovery() {
        let choice = IntegrationTaskCapabilitySourceChoice {
            source_ref: IntegrationRevisionRef {
                id: "actual-source".into(),
                revision: "actual-source-security".into(),
            },
            account_ref: IntegrationNullable::Value(IntegrationRevisionRef {
                id: "actual-account".into(),
                revision: "account-1".into(),
            }),
        };
        let revision = resource_revision(
            &choice,
            &serde_json::json!({"uri":"resource://same-name","kind":"document"}),
        )
        .unwrap();
        verify_resource_revision(&choice, &revision).unwrap();
        let mut changed = choice.clone();
        changed.account_ref = IntegrationNullable::Value(IntegrationRevisionRef {
            id: "other-account".into(),
            revision: "account-2".into(),
        });
        assert!(verify_resource_revision(&changed, &revision).is_err());
        changed = choice.clone();
        changed.source_ref.revision = "different-endpoint-or-schema".into();
        assert!(verify_resource_revision(&changed, &revision).is_err());
        assert!(verify_resource_revision(&choice, &"a".repeat(64)).is_err());
    }
    fn caller(
        state: &crate::app_server::ConnectionState,
        action: &str,
        revision: &str,
    ) -> Result<Arc<NativeConnectivityPublicCall>> {
        NativeConnectivityPublicCall::capture(state,ConnectivityPortCall {port:ConnectivityPort::Connection,method:ConnectivityMethod::PrepareConnectionAction,
            request:IntegrationRequest {contract_version:IntegrationContractVersion::ParallelV1,request_id:format!("owned-{action}-{revision}"),scope:state.integration_context.as_ref().unwrap().scope().clone(),operation_id:Some(format!("owned-{action}-{revision}")),expected_revision:Some(revision.into()),timeout_ms:1000,cancellation_ref:None,payload:json!({"action":action,"connectionId":"owned-application","businessAction":"mail.summarize","resourceRefs":[{"id":"owned-resource","revision":"1","kind":"mailbox"}]}).as_object().unwrap().clone()} })
    }
    #[test]
    fn only_current_original_application_mutation_revokes_its_task_permission() -> Result<()> {
        let fixture =
            crate::app_server::integrations::core::runtime_driver::test_support::Fixture::new();
        let state = crate::app_server::ConnectionState {
            initialized: true,
            integration_context: Some(fixture.context),
            ..Default::default()
        };
        let grants = NativeApplicationTaskGrants::default();
        let task = caller(&state, "runOfficeTask", "2")?;
        let grant = grants.bind(&task)?;
        grant.verify(task.context())?;
        let stale = caller(&state, "setResources", "1")?;
        grants.before_public_mutation(&stale)?;
        grant.verify(task.context())?;
        let current = caller(&state, "setResources", "2")?;
        grants.before_public_mutation(&current)?;
        assert!(grant.verify(task.context()).is_err());
        let resumed_caller = caller(&state, "runOfficeTask", "3")?;
        let replacement = grants.bind(resumed_caller.as_ref())?;
        grants.before_public_mutation(&current)?;
        replacement.verify(task.context())?;
        let save_caller = caller(&state, "save", "3")?;
        assert!(grants.bind(save_caller.as_ref()).is_err());
        state.input_ended.cancel();
        assert!(replacement.verify(task.context()).is_err());
        Ok(())
    }
}
