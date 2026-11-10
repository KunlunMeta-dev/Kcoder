//! Exact selectors for control over a previously accepted task's source binding.
use super::*;
use crate::TurnAttemptIdentity;
use serde::{Deserialize, Serialize};

/// These are lookup data. The native host must still observe the original
/// private Accepted record, held session owner and saved source binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeControlTarget {
    pub initial_attempt: TurnAttemptIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_operation_id: Option<String>,
}
impl IntegrationTaskCapabilityScopeControlTarget {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.initial_attempt
            .validate()
            .map_err(|_| invalid("target.initialAttempt", "invalid original attempt tuple"))?;
        if let Some(operation) = &self.runtime_operation_id {
            id(operation, "target.runtimeOperationId")?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeControlReadParams {
    pub target: IntegrationTaskCapabilityScopeControlTarget,
    pub params: IntegrationTaskCapabilityScopeReadParams,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeControlSetParams {
    pub target: IntegrationTaskCapabilityScopeControlTarget,
    pub params: IntegrationTaskCapabilityScopeSetParams,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeControlOperationParams {
    pub target: IntegrationTaskCapabilityScopeControlTarget,
    pub operation_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_control_wrapper_retains_the_original_tuple_without_changing_source_dtos() {
        let value = json!({"target":{"initialAttempt":{"threadId":"thread","turnId":"turn","attemptId":"attempt"},"runtimeOperationId":"original-op"},
            "params":{"threadId":"thread","selection":{"mode":"none","sources":[]}}});
        let parsed: IntegrationTaskCapabilityScopeControlSetParams =
            serde_json::from_value(value.clone()).unwrap();
        parsed.target.validate().unwrap();
        parsed.params.selection.validate().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        assert!(
            serde_json::from_value::<IntegrationTaskCapabilityScopeSetParams>(
                json!({"threadId":"thread","selection":{"mode":"none","sources":[]}})
            )
            .is_ok()
        );
    }
    #[test]
    fn source_control_wrapper_rejects_missing_target_and_unknown_authority_fields() {
        assert!(
            serde_json::from_value::<IntegrationTaskCapabilityScopeControlSetParams>(
                json!({"params":{"threadId":"thread","selection":{"mode":"none","sources":[]}}})
            )
            .is_err()
        );
        let value = json!({"target":{"initialAttempt":{"threadId":"thread","turnId":"turn","attemptId":"attempt"},"trusted":true},"params":{"threadId":"thread"}});
        assert!(
            serde_json::from_value::<IntegrationTaskCapabilityScopeControlReadParams>(value)
                .is_err()
        );
        let invalid: IntegrationTaskCapabilityScopeControlTarget = serde_json::from_value(
            json!({"initialAttempt":{"threadId":"","turnId":"turn","attemptId":"attempt"}}),
        )
        .unwrap();
        assert!(invalid.validate().is_err());
    }
}
