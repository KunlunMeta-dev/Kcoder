//! Versioned task observations are projections, never execution authority.
use super::{
    IntegrationRuntimeReadTaskParams, IntegrationScope, IntegrationTaskState,
    IntegrationValidationError, id, invalid,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskStateReadParams {
    pub request_id: String,
    pub scope: IntegrationScope,
    pub reference: IntegrationRuntimeReadTaskParams,
}

impl IntegrationTaskStateReadParams {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(&self.request_id, "requestId")?;
        self.scope.validate()?;
        self.reference.validate()
    }
}

/// One observation of an original persisted task binding. The binding's CAS
/// revision also supplies the entity sequence, independent of a connection's
/// transport sequence. A gap requires reading the original current snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskStateObservation {
    pub scope: IntegrationScope,
    pub operation_id: String,
    pub entity_id: String,
    pub sequence: u64,
    pub revision: u64,
    pub observed_at_ms: u64,
    pub snapshot: bool,
    pub reference: IntegrationRuntimeReadTaskParams,
    pub state: IntegrationTaskState,
}

impl IntegrationTaskStateObservation {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        self.scope.validate()?;
        id(&self.operation_id, "operationId")?;
        id(&self.entity_id, "entityId")?;
        self.reference.validate()?;
        if self.entity_id != self.operation_id {
            return Err(invalid(
                "entityId",
                "the original operation is the stable task entity",
            ));
        }
        if self.sequence == 0
            || self.sequence != self.revision
            || self.sequence > 9_007_199_254_740_991
        {
            return Err(invalid(
                "revision",
                "a positive safe binding revision supplies the entity sequence",
            ));
        }
        if self.observed_at_ms == 0 || self.observed_at_ms > 9_007_199_254_740_991 {
            return Err(invalid(
                "observedAtMs",
                "the native observer must supply a safe observation time",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn observation() -> serde_json::Value {
        json!({"scope":{"accountId":"owner","targetId":"target","workspaceId":"workspace",
            "identityGeneration":"1","targetRevision":"1"},"operationId":"original-operation",
            "entityId":"original-operation","sequence":7,"revision":7,"observedAtMs":1234,"snapshot":false,
            "reference":{"threadId":"original-thread","turnId":"original-turn"},"state":"running"})
    }

    #[test]
    fn task_state_observation_roundtrips_without_body_or_authority_fields() {
        let value = observation();
        let parsed: IntegrationTaskStateObservation =
            serde_json::from_value(value.clone()).unwrap();
        parsed.validate().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        for key in ["output", "prompt", "approved", "principal", "credential"] {
            let mut value = observation();
            value[key] = json!("must-not-be-published");
            assert!(serde_json::from_value::<IntegrationTaskStateObservation>(value).is_err());
        }
    }

    #[test]
    fn task_state_observation_rejects_ambiguous_identity_and_sequence() {
        for (key, invalid_value) in [
            ("entityId", json!("another-operation")),
            ("sequence", json!(6)),
            ("revision", json!(0)),
            ("observedAtMs", json!(0)),
            ("sequence", json!(9_007_199_254_740_992u64)),
        ] {
            let mut value = observation();
            value[key] = invalid_value;
            let parsed: IntegrationTaskStateObservation = serde_json::from_value(value).unwrap();
            assert!(parsed.validate().is_err());
        }
    }
}
