use anyhow::{Result, ensure};
use kcoder_types::integrations::{core::*, knowledge::KnowledgeOwner};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

pub struct KnowledgeResource {
    pub kind: &'static str,
    pub id: String,
    pub owner: KnowledgeOwner,
}
/// Implement with authoritative native policy facts, never with request.scope alone.
pub trait KnowledgePolicyEvaluator: Send + Sync {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation>;
}
/// Native caller facts; this type cannot be deserialized from untrusted requests.
pub struct KnowledgeHostContext<'a> {
    pub scope: &'a IntegrationScope,
    pub now_ms: u64,
    pub explicit_user_action: bool,
    pub policy: &'a dyn KnowledgePolicyEvaluator,
}
impl KnowledgeHostContext<'_> {
    pub fn check(
        &self,
        request: &IntegrationRequest,
        mutation: bool,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<()> {
        request.validate(mutation)?;
        ensure!(
            i64::try_from(self.now_ms)
                .ok()
                .and_then(chrono::DateTime::from_timestamp_millis)
                .is_some(),
            "KNOWLEDGE_INVALID_CLOCK"
        );
        ensure!(
            request.scope == *self.scope,
            "KNOWLEDGE_CALLER_SCOPE_MISMATCH"
        );
        let evaluation = self.policy.evaluate_action(self.scope, action, resource)?;
        match evaluation.decision {
            IntegrationPolicyDecision::Allow => Ok(()),
            IntegrationPolicyDecision::Deny => anyhow::bail!("KNOWLEDGE_RESOURCE_DENIED"),
            IntegrationPolicyDecision::Unknown => anyhow::bail!("KNOWLEDGE_POLICY_UNAVAILABLE"),
        }
    }
}
pub fn parse<T: DeserializeOwned>(request: &IntegrationRequest) -> Result<T> {
    serde_json::from_value(Value::Object(request.payload.clone()))
        .map_err(|_| anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))
}
pub fn operation(request: &IntegrationRequest) -> Result<&str> {
    request
        .operation_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_OPERATION_REQUIRED"))
}
pub fn revision(request: &IntegrationRequest, initial_allowed: bool) -> Result<u64> {
    match request.expected_revision.as_deref() {
        None if initial_allowed => Ok(0),
        Some(value) => {
            let n = value
                .parse::<u64>()
                .map_err(|_| anyhow::anyhow!("KNOWLEDGE_INVALID_REVISION"))?;
            ensure!(value == n.to_string(), "KNOWLEDGE_INVALID_REVISION");
            Ok(n)
        }
        None => anyhow::bail!("KNOWLEDGE_REVISION_REQUIRED"),
    }
}
pub fn dispatch(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    mutation: bool,
    action: &str,
    resource: KnowledgeResource,
    perform: impl FnOnce() -> Result<(Value, Option<String>)>,
) -> IntegrationReply {
    let result = (|| {
        ctx.check(request, mutation, action, &resource)?;
        let (result, revision) = perform()?;
        if ctx.check(request, mutation, action, &resource).is_err() {
            if mutation {
                anyhow::bail!("KNOWLEDGE_AUTHORITY_CHANGED_AFTER_OPERATION");
            }
            anyhow::bail!("KNOWLEDGE_RESOURCE_DENIED");
        }
        Ok((result, revision))
    })();
    finish_dispatch(request, ctx, mutation, result)
}

fn finish_dispatch(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    mutation: bool,
    result: Result<(Value, Option<String>)>,
) -> IntegrationReply {
    match result {
        Ok((result, revision)) => reply(
            request,
            ctx,
            IntegrationStatus::Completed,
            result.as_object().cloned(),
            revision,
            None,
        ),
        Err(error) => {
            let safe = public_error_code(&error).to_owned();
            let unknown = safe.contains("UNCONFIRMED") || safe.contains("AFTER_OPERATION");
            let unavailable = safe.contains("UNAVAILABLE")
                || safe.contains("CORRUPT")
                || safe.contains("BUSY")
                || safe.contains("INDEX_STALE")
                || safe.contains("_STORE_");
            let recovery = if unknown {
                IntegrationRecovery::ReconcileOriginal
            } else if safe == "KNOWLEDGE_INVALID_CURSOR" {
                IntegrationRecovery::RetryRead
            } else if safe.contains("EXPLICIT_DECISION_REQUIRED") {
                IntegrationRecovery::ExplicitUserDecision
            } else if safe.contains("DENIED") {
                IntegrationRecovery::RequestAuthorization
            } else if unavailable {
                if mutation {
                    IntegrationRecovery::ExplicitUserDecision
                } else {
                    IntegrationRecovery::RetryRead
                }
            } else if safe.contains("REVISION") || safe.contains("EXPIRED") {
                IntegrationRecovery::RepairConfiguration
            } else {
                IntegrationRecovery::None
            };
            let status = if unknown {
                IntegrationStatus::Unknown
            } else if unavailable {
                IntegrationStatus::Unavailable
            } else {
                IntegrationStatus::Rejected
            };
            reply(
                request,
                ctx,
                status,
                None,
                None,
                Some(IntegrationError {
                    code: safe,
                    message_key: "integrations.knowledge.operationFailed".into(),
                    recovery,
                }),
            )
        }
    }
}
pub fn reply(
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    status: IntegrationStatus,
    result: Option<Map<String, Value>>,
    entity_revision: Option<String>,
    error: Option<IntegrationError>,
) -> IntegrationReply {
    let at = i64::try_from(ctx.now_ms)
        .ok()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339();
    IntegrationReply {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: request.request_id.clone(),
        status,
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        entity_revision: entity_revision
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        observed_at: at,
        result: result.map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        error: error.map_or(IntegrationNullable::Null, IntegrationNullable::Value),
    }
}

/// Only reviewed domain literals cross the public boundary; arbitrary provider errors never do.
fn public_error_code(error: &anyhow::Error) -> &'static str {
    match error.to_string().as_str() {
        "KNOWLEDGE_INVALID_PUBLICATION_METADATA" => "KNOWLEDGE_INVALID_PUBLICATION_METADATA",
        "KNOWLEDGE_INVALID_CURSOR" => "KNOWLEDGE_INVALID_CURSOR",
        "AUTOMATION_EVENT_MIN_INTERVAL" => "AUTOMATION_EVENT_MIN_INTERVAL",
        "AUTOMATION_EVENT_PROVIDER_UNAVAILABLE" => "AUTOMATION_EVENT_PROVIDER_UNAVAILABLE",
        "AUTOMATION_FILE_SELECTION_AUTHORITY_UNAVAILABLE" => {
            "AUTOMATION_FILE_SELECTION_AUTHORITY_UNAVAILABLE"
        }
        "AUTOMATION_FILE_READ_AUTHORITY_UNAVAILABLE" => {
            "AUTOMATION_FILE_READ_AUTHORITY_UNAVAILABLE"
        }
        "AUTOMATION_EVENT_SOURCE_SCAN_LIMIT" => "AUTOMATION_EVENT_SOURCE_SCAN_LIMIT",
        "AUTOMATION_EVENT_STORM_BACKPRESSURE" => "AUTOMATION_EVENT_STORM_BACKPRESSURE",
        "AUTOMATION_EVENT_STALE_QUARANTINED" => "AUTOMATION_EVENT_STALE_QUARANTINED",
        "AUTOMATION_EVENT_CLOCK_QUARANTINED" => "AUTOMATION_EVENT_CLOCK_QUARANTINED",
        "AUTOMATION_EVENT_CLOCK_REGRESSED" => "AUTOMATION_EVENT_CLOCK_REGRESSED",
        "AUTOMATION_EVENT_TIME_REQUIRED" => "AUTOMATION_EVENT_TIME_REQUIRED",
        "AUTOMATION_EVENT_SEQUENCE_EXHAUSTED" => "AUTOMATION_EVENT_SEQUENCE_EXHAUSTED",
        "AUTOMATION_EVENT_ADMISSION_CAPACITY" => "AUTOMATION_EVENT_ADMISSION_CAPACITY",
        "AUTOMATION_EVENT_QUARANTINE_CAPACITY" => "AUTOMATION_EVENT_QUARANTINE_CAPACITY",
        "AUTOMATION_DELIVERY_NOT_SUBMITTED" => "AUTOMATION_DELIVERY_NOT_SUBMITTED",
        "AUTOMATION_DELIVERY_EXPLICIT_DECISION_REQUIRED" => {
            "AUTOMATION_DELIVERY_EXPLICIT_DECISION_REQUIRED"
        }
        "KNOWLEDGE_ADOPTION_REVISION_CONFLICT" => "KNOWLEDGE_ADOPTION_REVISION_CONFLICT",
        "KNOWLEDGE_ADOPTION_CAPACITY" => "KNOWLEDGE_ADOPTION_CAPACITY",
        "KNOWLEDGE_ADOPTION_STORAGE_CORRUPT" => "KNOWLEDGE_ADOPTION_STORAGE_CORRUPT",
        "KNOWLEDGE_ADOPTION_DISABLED" => "KNOWLEDGE_ADOPTION_DISABLED",
        "KNOWLEDGE_ADOPTION_NOT_FOUND" => "KNOWLEDGE_ADOPTION_NOT_FOUND",
        "AUTOMATION_TEMPLATE_VERSION_UNAVAILABLE" => "AUTOMATION_TEMPLATE_VERSION_UNAVAILABLE",
        "AUTOMATION_TEMPLATE_NOT_FOUND" => "AUTOMATION_TEMPLATE_NOT_FOUND",
        "MEMORY_PROPOSAL_TOO_LARGE" => "MEMORY_PROPOSAL_TOO_LARGE",
        "AUTOMATION_DRAFT_TOO_LARGE" => "AUTOMATION_DRAFT_TOO_LARGE",
        "AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED" => {
            "AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED"
        }
        "AUTOMATION_DESTINATION_DENIED" => "AUTOMATION_DESTINATION_DENIED",
        "AUTOMATION_EVENT_CURSOR_GAP" => "AUTOMATION_EVENT_CURSOR_GAP",
        "AUTOMATION_EVENT_SOURCE_MISMATCH" => "AUTOMATION_EVENT_SOURCE_MISMATCH",
        "AUTOMATION_EVENT_LOOP_REJECTED" => "AUTOMATION_EVENT_LOOP_REJECTED",
        "AUTOMATION_TRIGGER_MISSING" => "AUTOMATION_TRIGGER_MISSING",
        "KNOWLEDGE_AUDIENCE_DENIED" => "KNOWLEDGE_AUDIENCE_DENIED",
        "KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED" => "KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED",
        "AUTOMATION_ARTIFACT_REVISION_REQUIRED" => "AUTOMATION_ARTIFACT_REVISION_REQUIRED",
        "AUTOMATION_WORKFLOW_UNAVAILABLE" => "AUTOMATION_WORKFLOW_UNAVAILABLE",
        "AUTOMATION_INVALID_SCHEDULE" => "AUTOMATION_INVALID_SCHEDULE",
        "AUTOMATION_SCHEDULE_IN_PAST" => "AUTOMATION_SCHEDULE_IN_PAST",
        "AUTOMATION_EXPLICIT_CONSENT_REQUIRED" => "AUTOMATION_EXPLICIT_CONSENT_REQUIRED",
        "AUTOMATION_CANCELLED_BEFORE_SUBMISSION" => "AUTOMATION_CANCELLED_BEFORE_SUBMISSION",
        "AUTOMATION_RUNTIME_UNAVAILABLE" => "AUTOMATION_RUNTIME_UNAVAILABLE",
        "AUTOMATION_DEPENDENCY_UNCONFIRMED" => "AUTOMATION_DEPENDENCY_UNCONFIRMED",
        "AUTOMATION_NATIVE_RECEIPT_INVALID" => "AUTOMATION_NATIVE_RECEIPT_INVALID",
        "AUTOMATION_DELIVERY_UNAVAILABLE" => "AUTOMATION_DELIVERY_UNAVAILABLE",
        "AUTOMATION_DELIVERY_RECEIPT_INVALID" => "AUTOMATION_DELIVERY_RECEIPT_INVALID",
        "AUTOMATION_CANCEL_RECONCILIATION_REQUIRED" => "AUTOMATION_CANCEL_RECONCILIATION_REQUIRED",
        "AUTOMATION_CANCEL_UNCONFIRMED" => "AUTOMATION_CANCEL_UNCONFIRMED",
        "KNOWLEDGE_PUBLICATION_NOT_INITIALIZED" => "KNOWLEDGE_PUBLICATION_NOT_INITIALIZED",
        "AUTOMATION_BUDGET_REQUIRED" => "AUTOMATION_BUDGET_REQUIRED",
        "AUTOMATION_BUSY" => "AUTOMATION_BUSY",
        "AUTOMATION_CAPACITY" => "AUTOMATION_CAPACITY",
        "AUTOMATION_CONSENT_MISMATCH" => "AUTOMATION_CONSENT_MISMATCH",
        "AUTOMATION_DELIVERY_CONFLICT" => "AUTOMATION_DELIVERY_CONFLICT",
        "AUTOMATION_DELIVERY_TERMINAL_CONFLICT" => "AUTOMATION_DELIVERY_TERMINAL_CONFLICT",
        "AUTOMATION_DISABLED" => "AUTOMATION_DISABLED",
        "AUTOMATION_EVENT_SCHEDULE_MISMATCH" => "AUTOMATION_EVENT_SCHEDULE_MISMATCH",
        "AUTOMATION_EVENT_TOO_LARGE" => "AUTOMATION_EVENT_TOO_LARGE",
        "AUTOMATION_IMMUTABLE_WORKFLOW_REQUIRED" => "AUTOMATION_IMMUTABLE_WORKFLOW_REQUIRED",
        "AUTOMATION_INITIALIZATION_UNCONFIRMED" => "AUTOMATION_INITIALIZATION_UNCONFIRMED",
        "AUTOMATION_INVALID_DELIVERY_OBSERVATION" => "AUTOMATION_INVALID_DELIVERY_OBSERVATION",
        "AUTOMATION_INVALID_ERROR_CODE" => "AUTOMATION_INVALID_ERROR_CODE",
        "AUTOMATION_INVALID_ID" => "AUTOMATION_INVALID_ID",
        "AUTOMATION_INVALID_INPUTS" => "AUTOMATION_INVALID_INPUTS",
        "AUTOMATION_INVALID_STORE_PATH" => "AUTOMATION_INVALID_STORE_PATH",
        "AUTOMATION_INVALID_TITLE" => "AUTOMATION_INVALID_TITLE",
        "AUTOMATION_NATIVE_ACCEPTANCE_REQUIRED" => "AUTOMATION_NATIVE_ACCEPTANCE_REQUIRED",
        "AUTOMATION_NATIVE_RECEIPT_CONFLICT" => "AUTOMATION_NATIVE_RECEIPT_CONFLICT",
        "AUTOMATION_NEXT_FIRE_MISSING" => "AUTOMATION_NEXT_FIRE_MISSING",
        "AUTOMATION_NEXT_FIRE_NOT_FUTURE" => "AUTOMATION_NEXT_FIRE_NOT_FUTURE",
        "AUTOMATION_NOT_DUE" => "AUTOMATION_NOT_DUE",
        "AUTOMATION_NOT_FOUND" => "AUTOMATION_NOT_FOUND",
        "AUTOMATION_ONE_TRIGGER_REQUIRED" => "AUTOMATION_ONE_TRIGGER_REQUIRED",
        "AUTOMATION_OPERATION_CONFLICT" => "AUTOMATION_OPERATION_CONFLICT",
        "AUTOMATION_OUTPUT_TOO_LARGE" => "AUTOMATION_OUTPUT_TOO_LARGE",
        "AUTOMATION_OUTPUT_UNOBSERVED" => "AUTOMATION_OUTPUT_UNOBSERVED",
        "AUTOMATION_RECEIPT_CAPACITY" => "AUTOMATION_RECEIPT_CAPACITY",
        "AUTOMATION_RESULT_NOT_READY" => "AUTOMATION_RESULT_NOT_READY",
        "AUTOMATION_REVISION_CONFLICT" => "AUTOMATION_REVISION_CONFLICT",
        "AUTOMATION_REVISION_EXHAUSTED" => "AUTOMATION_REVISION_EXHAUSTED",
        "AUTOMATION_RUN_CAPACITY" => "AUTOMATION_RUN_CAPACITY",
        "AUTOMATION_RUN_MISSING" => "AUTOMATION_RUN_MISSING",
        "AUTOMATION_RUN_NOT_FOUND" => "AUTOMATION_RUN_NOT_FOUND",
        "AUTOMATION_RUN_NOT_PREPARING" => "AUTOMATION_RUN_NOT_PREPARING",
        "AUTOMATION_SCHEDULE_PREVIEW_REQUIRED" => "AUTOMATION_SCHEDULE_PREVIEW_REQUIRED",
        "AUTOMATION_SCOPE_MISMATCH" => "AUTOMATION_SCOPE_MISMATCH",
        "AUTOMATION_STORE_BINDING_CHANGED" => "AUTOMATION_STORE_BINDING_CHANGED",
        "AUTOMATION_STORE_BINDING_INVALID" => "AUTOMATION_STORE_BINDING_INVALID",
        "AUTOMATION_STORE_CREATE_UNAVAILABLE" => "AUTOMATION_STORE_CREATE_UNAVAILABLE",
        "AUTOMATION_STORE_FULL" => "AUTOMATION_STORE_FULL",
        "AUTOMATION_STORE_LOCK_CHANGED" => "AUTOMATION_STORE_LOCK_CHANGED",
        "AUTOMATION_STORE_UNAVAILABLE" => "AUTOMATION_STORE_UNAVAILABLE",
        "AUTOMATION_STORE_VERSION_UNSUPPORTED" => "AUTOMATION_STORE_VERSION_UNSUPPORTED",
        "AUTOMATION_SUBSCRIPTION_BUSY" => "AUTOMATION_SUBSCRIPTION_BUSY",
        "AUTOMATION_SUBSCRIPTION_REVISION_UNAVAILABLE" => {
            "AUTOMATION_SUBSCRIPTION_REVISION_UNAVAILABLE"
        }
        "AUTOMATION_TERMINAL_CONFLICT" => "AUTOMATION_TERMINAL_CONFLICT",
        "AUTOMATION_TRIGGER_CAPACITY" => "AUTOMATION_TRIGGER_CAPACITY",
        "AUTOMATION_TRIGGER_CONFLICT" => "AUTOMATION_TRIGGER_CONFLICT",
        "AUTOMATION_TRIGGER_STALE" => "AUTOMATION_TRIGGER_STALE",
        "AUTOMATION_WRITE_UNCONFIRMED" => "AUTOMATION_WRITE_UNCONFIRMED",
        "KNOWLEDGE_AUDIENCE_REQUIRED" => "KNOWLEDGE_AUDIENCE_REQUIRED",
        "KNOWLEDGE_AUTHORITY_CHANGED_AFTER_OPERATION" => {
            "KNOWLEDGE_AUTHORITY_CHANGED_AFTER_OPERATION"
        }
        "KNOWLEDGE_CALLER_SCOPE_MISMATCH" => "KNOWLEDGE_CALLER_SCOPE_MISMATCH",
        "KNOWLEDGE_CITATION_NOT_FOUND" => "KNOWLEDGE_CITATION_NOT_FOUND",
        "KNOWLEDGE_DUPLICATE_SOURCE" => "KNOWLEDGE_DUPLICATE_SOURCE",
        "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED" => "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED",
        "KNOWLEDGE_INDEX_STALE" => "KNOWLEDGE_INDEX_STALE",
        "KNOWLEDGE_INVALID_CLOCK" => "KNOWLEDGE_INVALID_CLOCK",
        "KNOWLEDGE_INVALID_ID" => "KNOWLEDGE_INVALID_ID",
        "KNOWLEDGE_INVALID_LIMIT" => "KNOWLEDGE_INVALID_LIMIT",
        "KNOWLEDGE_INVALID_PAYLOAD" => "KNOWLEDGE_INVALID_PAYLOAD",
        "KNOWLEDGE_INVALID_QUERY" => "KNOWLEDGE_INVALID_QUERY",
        "KNOWLEDGE_INVALID_REVISION" => "KNOWLEDGE_INVALID_REVISION",
        "KNOWLEDGE_INVALID_TITLE" => "KNOWLEDGE_INVALID_TITLE",
        "KNOWLEDGE_INVALID_UNRESOLVED" => "KNOWLEDGE_INVALID_UNRESOLVED",
        "KNOWLEDGE_INVALID_VALIDITY" => "KNOWLEDGE_INVALID_VALIDITY",
        "KNOWLEDGE_METHOD_UNSUPPORTED" => "KNOWLEDGE_METHOD_UNSUPPORTED",
        "KNOWLEDGE_NATIVE_SCOPE_MISMATCH" => "KNOWLEDGE_NATIVE_SCOPE_MISMATCH",
        "KNOWLEDGE_OPERATION_CONFLICT" => "KNOWLEDGE_OPERATION_CONFLICT",
        "KNOWLEDGE_OPERATION_REQUIRED" => "KNOWLEDGE_OPERATION_REQUIRED",
        "KNOWLEDGE_OPERATION_UNAVAILABLE" => "KNOWLEDGE_OPERATION_UNAVAILABLE",
        "KNOWLEDGE_POLICY_UNAVAILABLE" => "KNOWLEDGE_POLICY_UNAVAILABLE",
        "KNOWLEDGE_PUBLICATION_CAPACITY" => "KNOWLEDGE_PUBLICATION_CAPACITY",
        "KNOWLEDGE_PUBLICATION_CORRUPT" => "KNOWLEDGE_PUBLICATION_CORRUPT",
        "KNOWLEDGE_PUBLICATION_EXPIRED" => "KNOWLEDGE_PUBLICATION_EXPIRED",
        "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH" => "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH",
        "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE" => "KNOWLEDGE_PUBLICATION_NOT_EFFECTIVE",
        "KNOWLEDGE_PUBLICATION_NOT_FOUND" => "KNOWLEDGE_PUBLICATION_NOT_FOUND",
        "KNOWLEDGE_PUBLICATION_REVISION_CONFLICT" => "KNOWLEDGE_PUBLICATION_REVISION_CONFLICT",
        "KNOWLEDGE_PUBLICATION_REVOKED" => "KNOWLEDGE_PUBLICATION_REVOKED",
        "KNOWLEDGE_PUBLICATION_SCHEMA_UNSUPPORTED" => "KNOWLEDGE_PUBLICATION_SCHEMA_UNSUPPORTED",
        "KNOWLEDGE_PUBLICATION_STORAGE_CORRUPT" => "KNOWLEDGE_PUBLICATION_STORAGE_CORRUPT",
        "KNOWLEDGE_PUBLICATION_TOO_LARGE" => "KNOWLEDGE_PUBLICATION_TOO_LARGE",
        "KNOWLEDGE_QUERY_HAS_NO_TERMS" => "KNOWLEDGE_QUERY_HAS_NO_TERMS",
        "KNOWLEDGE_RESOURCE_DENIED" => "KNOWLEDGE_RESOURCE_DENIED",
        "KNOWLEDGE_REVISION_REQUIRED" => "KNOWLEDGE_REVISION_REQUIRED",
        "KNOWLEDGE_SOURCE_REQUIRED" => "KNOWLEDGE_SOURCE_REQUIRED",
        "KNOWLEDGE_VERSION_EXHAUSTED" => "KNOWLEDGE_VERSION_EXHAUSTED",
        "MEMORY_ALREADY_REVIEWED" => "MEMORY_ALREADY_REVIEWED",
        "MEMORY_BUSY" => "MEMORY_BUSY",
        "MEMORY_CAPACITY" => "MEMORY_CAPACITY",
        "MEMORY_EXPLICIT_REQUEST_REQUIRED" => "MEMORY_EXPLICIT_REQUEST_REQUIRED",
        "MEMORY_ID_EXHAUSTED" => "MEMORY_ID_EXHAUSTED",
        "MEMORY_INITIALIZATION_UNCONFIRMED" => "MEMORY_INITIALIZATION_UNCONFIRMED",
        "MEMORY_INVALID_CATEGORY" => "MEMORY_INVALID_CATEGORY",
        "MEMORY_INVALID_CONTENT" => "MEMORY_INVALID_CONTENT",
        "MEMORY_INVALID_ID" => "MEMORY_INVALID_ID",
        "MEMORY_INVALID_SOURCE" => "MEMORY_INVALID_SOURCE",
        "MEMORY_INVALID_STORE_PATH" => "MEMORY_INVALID_STORE_PATH",
        "MEMORY_INVALID_TITLE" => "MEMORY_INVALID_TITLE",
        "MEMORY_NOT_FOUND" => "MEMORY_NOT_FOUND",
        "MEMORY_OPERATION_CONFLICT" => "MEMORY_OPERATION_CONFLICT",
        "MEMORY_RECEIPT_CAPACITY" => "MEMORY_RECEIPT_CAPACITY",
        "MEMORY_REVIEW_REQUIRED" => "MEMORY_REVIEW_REQUIRED",
        "MEMORY_REVISION_CONFLICT" => "MEMORY_REVISION_CONFLICT",
        "MEMORY_REVISION_EXHAUSTED" => "MEMORY_REVISION_EXHAUSTED",
        "MEMORY_SCOPE_MISMATCH" => "MEMORY_SCOPE_MISMATCH",
        "MEMORY_SENSITIVE_CONTENT" => "MEMORY_SENSITIVE_CONTENT",
        "MEMORY_SNAPSHOT_CAPACITY" => "MEMORY_SNAPSHOT_CAPACITY",
        "MEMORY_SOURCE_REQUIRED" => "MEMORY_SOURCE_REQUIRED",
        "MEMORY_STORE_BINDING_CHANGED" => "MEMORY_STORE_BINDING_CHANGED",
        "MEMORY_STORE_BINDING_INVALID" => "MEMORY_STORE_BINDING_INVALID",
        "MEMORY_STORE_CREATE_UNAVAILABLE" => "MEMORY_STORE_CREATE_UNAVAILABLE",
        "MEMORY_STORE_FULL" => "MEMORY_STORE_FULL",
        "MEMORY_STORE_LOCK_CHANGED" => "MEMORY_STORE_LOCK_CHANGED",
        "MEMORY_STORE_UNAVAILABLE" => "MEMORY_STORE_UNAVAILABLE",
        "MEMORY_STORE_VERSION_UNSUPPORTED" => "MEMORY_STORE_VERSION_UNSUPPORTED",
        "MEMORY_WRITE_UNCONFIRMED" => "MEMORY_WRITE_UNCONFIRMED",
        _ => "KNOWLEDGE_OPERATION_UNAVAILABLE",
    }
}
#[cfg(test)]
#[path = "api/tests.rs"]
mod tests;
