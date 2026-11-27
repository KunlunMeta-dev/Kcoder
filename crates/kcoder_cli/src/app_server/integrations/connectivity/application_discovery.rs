//! Opaque original public consent for one source's metadata discovery.
use super::{
    application_resources::NativeApplicationResourceConnection,
    main_public::NativeConnectivityPublicCall,
};
use crate::app_server::integrations::core::NativeIntegrationContext;
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::connectivity::ConnectivityMethod;
use kcoder_types::integrations::core::IntegrationTaskCapabilitySourceChoice;
use serde_json::Value;
use std::sync::Arc;
/// No serde constructor or public boolean grants this finite metadata read.
pub(crate) struct NativeApplicationDiscoveryUse {
    caller: Arc<NativeConnectivityPublicCall>,
    choice: IntegrationTaskCapabilitySourceChoice,
}
impl NativeApplicationDiscoveryUse {
    pub(super) fn capture(
        caller: Arc<NativeConnectivityPublicCall>,
        choice: IntegrationTaskCapabilitySourceChoice,
    ) -> Result<Self> {
        caller.verify(caller.context().scope())?;
        choice.validate()?;
        ensure!(
            caller.call().method == ConnectivityMethod::ReadResourceGrant
                && caller.call().request.payload.get("discover") == Some(&Value::Bool(true)),
            "APPLICATION_ORIGINAL_DISCOVERY_REQUIRED"
        );
        Ok(Self { caller, choice })
    }

    pub(crate) fn verify_current(
        &self,
        native: &NativeIntegrationContext,
        connection: &NativeApplicationResourceConnection,
    ) -> Result<()> {
        self.caller.verify(native.scope())?;
        ensure!(
            *connection.choice() == self.choice,
            "APPLICATION_DISCOVERY_SOURCE_CHANGED"
        );
        let original = self.caller.call();
        ensure!(
            original.method == ConnectivityMethod::ReadResourceGrant
                && original.request.payload.get("discover") == Some(&Value::Bool(true)),
            "APPLICATION_ORIGINAL_DISCOVERY_REQUIRED"
        );
        Ok(())
    }
}
