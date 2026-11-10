//! Frozen connectivity port routing. It is not an authorization check.
mod control;
mod sdk_readback;
mod task_bindings;
mod task_commands;
pub use control::{CAPABILITY_NATIVE_CONNECTIVITY_V1, ConnectivityControlMethod};
use kcoder_types::integrations::core::{IntegrationRequest, IntegrationValidationError};
pub use sdk_readback::*;
use serde::{Deserialize, Serialize};
pub use task_bindings::*;
pub use task_commands::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum ConnectivityPort {
    #[serde(rename = "P-CONNECTION")]
    Connection,
    #[serde(rename = "P-READINESS")]
    Readiness,
    #[serde(rename = "P-DELIVERY")]
    Delivery,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum ConnectivityMethod {
    ListConnections,
    ReadConnection,
    ResolveCapability,
    ReadResourceGrant,
    PrepareConnectionAction,
    InspectReadiness,
    ReadReadiness,
    VerifyCapability,
    SubmitDelivery,
    ReadDelivery,
    CancelDelivery,
    ReconcileDelivery,
}
impl ConnectivityMethod {
    pub const fn port(self) -> ConnectivityPort {
        match self {
            Self::ListConnections
            | Self::ReadConnection
            | Self::ResolveCapability
            | Self::ReadResourceGrant
            | Self::PrepareConnectionAction => ConnectivityPort::Connection,
            Self::InspectReadiness | Self::ReadReadiness | Self::VerifyCapability => {
                ConnectivityPort::Readiness
            }
            Self::SubmitDelivery
            | Self::ReadDelivery
            | Self::CancelDelivery
            | Self::ReconcileDelivery => ConnectivityPort::Delivery,
        }
    }
    pub const fn is_mutation(self) -> bool {
        matches!(
            self,
            Self::PrepareConnectionAction
                | Self::VerifyCapability
                | Self::SubmitDelivery
                | Self::CancelDelivery
                | Self::ReconcileDelivery
        )
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectivityPortCall {
    pub port: ConnectivityPort,
    pub method: ConnectivityMethod,
    pub request: IntegrationRequest,
}
impl ConnectivityPortCall {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        if self.port != self.method.port() {
            return Err(IntegrationValidationError {
                field: "port",
                reason: "method does not belong to this port",
            });
        }
        self.request.validate(self.method.is_mutation())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_public_methods_match_the_frozen_ports() {
        use ConnectivityMethod::*;
        for method in [
            ListConnections,
            ReadConnection,
            ResolveCapability,
            ReadResourceGrant,
            PrepareConnectionAction,
            InspectReadiness,
            ReadReadiness,
            VerifyCapability,
            SubmitDelivery,
            ReadDelivery,
            CancelDelivery,
            ReconcileDelivery,
        ] {
            let encoded = serde_json::to_value(method).unwrap();
            assert_eq!(
                serde_json::from_value::<ConnectivityMethod>(encoded).unwrap(),
                method
            );
        }
        assert!(PrepareConnectionAction.is_mutation());
        assert!(ReconcileDelivery.is_mutation());
        assert!(!ReadDelivery.is_mutation());
    }
}
