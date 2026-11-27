//! Fixed saved-code service management. Capability negotiation never grants execution.
use kcoder_types::integrations::core::{IntegrationRequest, IntegrationRuntimeAcceptance};
pub use kcoder_types::integrations::core::{NativeCodeServiceGrantView, NativeCodeServiceRecord};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_NATIVE_CODE_SERVICES_V1: &str = "nativeCodeServicesV1";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum NativeCodeServiceMethod {
    #[serde(rename = "integrations/services/code/prepare")]
    Prepare,
    #[serde(rename = "integrations/services/code/read")]
    Read,
    #[serde(rename = "integrations/services/code/start")]
    Start,
    #[serde(rename = "integrations/services/code/revoke")]
    Revoke,
}
impl NativeCodeServiceMethod {
    pub const ALL: &'static [Self] = &[Self::Prepare, Self::Read, Self::Start, Self::Revoke];
    pub fn parse(method: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|value| value.wire_name() == method)
    }
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Prepare => "integrations/services/code/prepare",
            Self::Read => "integrations/services/code/read",
            Self::Start => "integrations/services/code/start",
            Self::Revoke => "integrations/services/code/revoke",
        }
    }
    pub const fn mutation(self) -> bool {
        !matches!(self, Self::Read)
    }
    pub const fn capability(self) -> &'static str {
        CAPABILITY_NATIVE_CODE_SERVICES_V1
    }
    pub fn validate_request(self, request: &IntegrationRequest) -> Result<(), String> {
        request
            .validate(self.mutation())
            .map_err(|_| "NATIVE_CODE_SERVICE_REQUEST_INVALID".to_owned())?;
        let value = serde_json::Value::Object(request.payload.clone());
        match self {
            Self::Prepare => {
                let payload: NativeCodeServicePreparePayload = serde_json::from_value(value)
                    .map_err(|_| "NATIVE_CODE_SERVICE_REQUEST_INVALID".to_owned())?;
                if !payload.explicit_background_consent
                    || payload.expires_in_ms == 0
                    || payload.expires_in_ms > 86400000
                    || payload.code_workflow.version == 0
                    || serde_json::to_vec(&payload.code_workflow.args)
                        .map_or(true, |bytes| bytes.len() > 32768)
                {
                    return Err("NATIVE_CODE_SERVICE_REQUEST_INVALID".into());
                }
            }
            _ => {
                let payload: NativeCodeServiceLocator = serde_json::from_value(value)
                    .map_err(|_| "NATIVE_CODE_SERVICE_REQUEST_INVALID".to_owned())?;
                if payload.lease_id.is_empty() || payload.lease_id.len() > 256 {
                    return Err("NATIVE_CODE_SERVICE_REQUEST_INVALID".into());
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum NativeCodeServicePurpose {
    #[serde(rename = "native_saved_code_service")]
    SavedCode,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeWorkflowSelection {
    pub definition_id: String,
    pub version: u64,
    pub args: serde_json::Value,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServicePreparePayload {
    pub purpose: NativeCodeServicePurpose,
    pub explicit_background_consent: bool,
    pub expires_in_ms: u64,
    pub code_workflow: NativeCodeWorkflowSelection,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceLocator {
    pub lease_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceReadyReceipt {
    pub lease_id: String,
    pub operation_id: String,
    pub acceptance: Option<IntegrationRuntimeAcceptance>,
    pub model_calls: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceReadResult {
    pub record: NativeCodeServiceRecord,
    pub grant: Option<NativeCodeServiceGrantView>,
    pub owner_observation: NativeCodeOwnerObservation,
    pub current_os_state: NativeCodeCurrentOsState,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum NativeCodeOwnerObservation {
    #[serde(rename = "last_persisted")]
    LastPersisted,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum NativeCodeCurrentOsState {
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeCodeServiceMutationResult {
    pub record: NativeCodeServiceRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready: Option<NativeCodeServiceReadyReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<NativeCodeServiceGrantView>,
    #[serde(default)]
    pub reconciled: bool,
    #[serde(default)]
    pub cancellation_requested: bool,
    #[serde(default)]
    pub cancellation_settled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn code_service_methods_are_finite_explicit_and_have_no_default_server_grant() {
        for &method in NativeCodeServiceMethod::ALL {
            assert_eq!(
                NativeCodeServiceMethod::parse(method.wire_name()),
                Some(method)
            );
            assert_eq!(
                serde_json::from_value::<NativeCodeServiceMethod>(
                    serde_json::to_value(method).unwrap()
                )
                .unwrap(),
                method
            );
        }
        assert!(NativeCodeServiceMethod::parse("kcoder/nativeCodeService/startV1").is_none());
        assert_ne!(
            crate::ServerCapabilities::default()
                .experimental
                .get(CAPABILITY_NATIVE_CODE_SERVICES_V1),
            Some(&true)
        );
    }
}
