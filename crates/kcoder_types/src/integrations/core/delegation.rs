//! Narrow service delegation locators and facts. None of these fields grants authority.
use super::{IntegrationEntityRef, IntegrationNullable, IntegrationValidationError, id, invalid};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_INTEGRATION_DELEGATION_TTL_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRevisionRef {
    pub id: String,
    pub revision: String,
}
impl IntegrationRevisionRef {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(&self.id, "reference.id")?;
        id(&self.revision, "reference.revision")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationDelegationPurpose {
    ChannelBinding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum IntegrationDelegationAction {
    #[serde(rename = "runtime.acceptTask")]
    AcceptTask,
    #[serde(rename = "runtime.readOperation")]
    ReadOperation,
    #[serde(rename = "runtime.readTask")]
    ReadTask,
    #[serde(rename = "runtime.steerTask")]
    SteerTask,
    #[serde(rename = "runtime.cancelTask")]
    CancelTask,
    #[serde(rename = "runtime.respondInteraction")]
    RespondInteraction,
    #[serde(rename = "delivery.submit")]
    SubmitDelivery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationDelegationPrepareParams {
    pub purpose: IntegrationDelegationPurpose,
    pub connection_id: String,
    pub observed_subject_ref: IntegrationRevisionRef,
    pub actions: BTreeSet<IntegrationDelegationAction>,
    pub resource_refs: Vec<IntegrationEntityRef>,
    pub expires_in_ms: super::IntegrationAuthorizationTime,
}
impl IntegrationDelegationPrepareParams {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(&self.connection_id, "connectionId")?;
        self.observed_subject_ref.validate()?;
        if self.actions.is_empty() || self.actions.len() > 7 {
            return Err(invalid(
                "actions",
                "a nonempty reviewed action set is required",
            ));
        }
        if self.resource_refs.is_empty() || self.resource_refs.len() > 32 {
            return Err(invalid(
                "resourceRefs",
                "between one and 32 native resource references are required",
            ));
        }
        let mut unique = BTreeSet::new();
        for resource in &self.resource_refs {
            id(&resource.id, "resourceRefs.id")?;
            let revision = resource.revision.as_deref().ok_or_else(|| {
                invalid(
                    "resourceRefs.revision",
                    "an immutable native resource revision is required",
                )
            })?;
            id(revision, "resourceRefs.revision")?;
            let key = serde_json::to_string(resource)
                .map_err(|_| invalid("resourceRefs", "invalid native resource reference"))?;
            if !unique.insert(key) {
                return Err(invalid(
                    "resourceRefs",
                    "duplicate native resource reference",
                ));
            }
        }
        if !self.expires_in_ms.valid_duration() {
            return Err(invalid(
                "expiresInMs",
                "delegation lifetime is outside the approved bound",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationDelegationStatus {
    Active,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationDelegationView {
    pub delegation_ref: IntegrationRevisionRef,
    pub status: IntegrationDelegationStatus,
    pub expires_at_ms: super::IntegrationAuthorizationTime,
    pub policy_revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationDelegationReadParams {
    pub delegation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationDelegationReadResult {
    pub delegation: IntegrationNullable<IntegrationDelegationView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationDelegationRevokeResult {
    pub delegation_ref: IntegrationRevisionRef,
    pub status: IntegrationDelegationStatus,
    pub cancellation_requested: bool,
    pub cancellation_settled: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn caller_cannot_supply_execution_scope_keys_or_approval_actions() {
        let legal = json!({"purpose":"channel_binding","connectionId":"connection","observedSubjectRef":{"id":"subject","revision":"1"},
            "actions":["runtime.acceptTask"],"resourceRefs":[{"kind":"connection","id":"connection","revision":"1"}],"expiresInMs":1000});
        serde_json::from_value::<IntegrationDelegationPrepareParams>(legal.clone())
            .unwrap()
            .validate()
            .unwrap();
        for key in ["executionScope", "trusted", "publicKey"] {
            let mut bad = legal.clone();
            bad[key] = json!(true);
            assert!(serde_json::from_value::<IntegrationDelegationPrepareParams>(bad).is_err());
        }
        let mut bad = legal;
        bad["actions"] = json!(["approval.respond"]);
        assert!(serde_json::from_value::<IntegrationDelegationPrepareParams>(bad).is_err());
    }
    #[test]
    fn empty_or_unversioned_resources_and_unbounded_lifetimes_are_not_delegations() {
        let mut request: IntegrationDelegationPrepareParams = serde_json::from_value(json!({"purpose":"channel_binding","connectionId":"c",
            "observedSubjectRef":{"id":"s","revision":"1"},"actions":["runtime.readTask"],"resourceRefs":[],"expiresInMs":1000})).unwrap();
        assert!(request.validate().is_err());
        request.resource_refs.push(IntegrationEntityRef {
            kind: super::super::IntegrationEntityKind::Connection,
            id: "c".into(),
            revision: None,
        });
        assert!(request.validate().is_err());
        request.resource_refs[0].revision = Some("1".into());
        request.expires_in_ms = (0).into();
        assert!(request.validate().is_err());
        request.expires_in_ms = (MAX_INTEGRATION_DELEGATION_TTL_MS + 1).into();
        assert!(request.validate().is_err());
    }
}
