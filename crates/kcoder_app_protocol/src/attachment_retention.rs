//! Experimental durable staged-attachment contract. Defining these types does
//! not advertise the capability or authorize a client-supplied trusted context.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_STAGED_ATTACHMENT_RETENTION_RECEIPTS_V1: &str =
    "stagedAttachmentRetentionReceiptsV1";
pub const METHOD_ATTACHMENT_RETENTION_RESERVE: &str = "attachment/retention/reserve";
pub const METHOD_ATTACHMENT_RETENTION_READ: &str = "attachment/retention/read";
pub const METHOD_ATTACHMENT_RETENTION_RELEASE: &str = "attachment/retention/release";
pub const METHOD_ATTACHMENT_RETENTION_CONSUME: &str = "attachment/retention/consume";
pub const MAX_RETENTION_BATCH: usize = 32;
// Stable nonsecret errors; an unknown completion never authorizes a new ID.
pub const RETENTION_ERROR_AUTHORITY: i64 = -32001;
// Generic capacity says nothing about whether a preceding operation committed.
pub const RETENTION_ERROR_CAPACITY: i64 = -32032;
/// Only reserve's pre-commit entry check emits this code. The referenced entry's
/// prepaid cleanup slot is unavailable (including legacy records without it), not temporary global load.
/// Repeating reserve with the same stages cannot replenish it. Keep original IDs.
pub const RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE: i64 = -32077;
pub const RETENTION_ERROR_CONFLICT: i64 = -32033;
pub const RETENTION_ERROR_UNKNOWN: i64 = -32034;
pub const RETENTION_ERROR_PROOF_UNAVAILABLE: i64 = -32035;
pub fn is_attachment_retention_method(method: &str) -> bool {
    matches!(
        method,
        METHOD_ATTACHMENT_RETENTION_RESERVE
            | METHOD_ATTACHMENT_RETENTION_READ
            | METHOD_ATTACHMENT_RETENTION_RELEASE
            | METHOD_ATTACHMENT_RETENTION_CONSUME
    ) || is_retention_upload_method(method)
}

/// Experimental owner intent, not a new public RPC or capability. The trusted
/// server adapter binds this to its full authenticated scope and OS root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionOwnerRequestV1 {
    pub client_owner_request_id: String,
    pub immutable_parameters: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RetentionPrincipalV1 {
    VerifiedAccount { principal_id: String },
    LocalOs,
}

/// Only a trusted Gateway/desktop parent may populate this context. A backend
/// must still bind it to its own OS authority, account root and workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedRetentionContextV1 {
    pub gateway_namespace_id: String,
    pub device_id: String,
    pub authorization_generation: String,
    pub target_fingerprint: String,
    pub principal: RetentionPrincipalV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionStageRefV1 {
    pub root_namespace: String,
    pub epoch: u64,
    pub owner_id: String,
    pub entry_id: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RetentionEntryStateV1 {
    Uploaded,
    Ready,
    Materializing,
    Copied,
    SourceDeleting,
    Transferred,
    ReleasePending,
    Released,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RetentionReceiptStateV1 {
    Reserved,
    Ready,
    Materializing,
    ReleasePending,
    Released,
    Transferred,
    Unknown,
    Consumed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionReceiptEntryV1 {
    pub stage_ref: RetentionStageRefV1,
    pub state: RetentionEntryStateV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionReceiptV1 {
    pub client_request_id: String,
    pub retention_id: String,
    pub thread_id: String,
    pub revision: u64,
    pub state: RetentionReceiptStateV1,
    pub entries: Vec<RetentionReceiptEntryV1>,
}

/// A retired watermark does not assert that any arbitrary ID existed or was
/// released. Mobile may use it only to settle an already durable consume outbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionEpochRetiredV1 {
    pub root_namespace: String,
    pub epoch: u64,
    pub retired_through: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionConsumeAckV1 {
    pub retention_id: String,
    pub terminal_revision: u64,
    pub client_ack_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RetentionConsumeStatusV1 {
    Consumed,
    EpochRetired { proof: RetentionEpochRetiredV1 },
    Rejected { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionConsumeResultV1 {
    pub client_ack_id: String,
    pub status: RetentionConsumeStatusV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRetentionReserveParams {
    pub trusted_context: TrustedRetentionContextV1,
    pub client_request_id: String,
    pub thread_id: String,
    pub stage_refs: Vec<RetentionStageRefV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume_acks: Vec<RetentionConsumeAckV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "by",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RetentionReceiptSelectorV1 {
    ClientRequestId { client_request_id: String },
    RetentionId { retention_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRetentionReadParams {
    pub trusted_context: TrustedRetentionContextV1,
    pub selector: RetentionReceiptSelectorV1,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume_acks: Vec<RetentionConsumeAckV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RetentionReleaseReasonV1 {
    ThreadDeleted,
    Discard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRetentionReleaseParams {
    pub trusted_context: TrustedRetentionContextV1,
    pub retention_id: String,
    pub expected_revision: u64,
    pub reason: RetentionReleaseReasonV1,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume_acks: Vec<RetentionConsumeAckV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRetentionConsumeParams {
    pub trusted_context: TrustedRetentionContextV1,
    pub acks: Vec<RetentionConsumeAckV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRetentionResult {
    /// Null only within a valid nonretired epoch with no authoritative intent.
    #[serde(deserialize_with = "required_optional_receipt")]
    pub receipt: Option<RetentionReceiptV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch_retired: Option<RetentionEpochRetiredV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume_results: Vec<RetentionConsumeResultV1>,
}

/// Trusted-parent retained RPC response. The scope is derived by the backend
/// from its captured authority, never accepted from public request parameters.
/// Keep the service/legacy result contract intact inside this wire envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopedAttachmentRetentionResultV1 {
    pub scope_id: String,
    pub result: AttachmentRetentionResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRetentionUploadOptions {
    pub trusted_context: TrustedRetentionContextV1,
    /// Persisted before save/upload-start; reused even if the first ACK is lost.
    pub client_upload_id: String,
    pub content_sha256: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume_acks: Vec<RetentionConsumeAckV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRetentionUploadContinuation {
    pub trusted_context: TrustedRetentionContextV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume_acks: Vec<RetentionConsumeAckV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RetentionUploadStateV1 {
    Allocating,
    Uploading,
    Sealed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionUploadRecoveryV1 {
    pub root_namespace: String,
    pub epoch: u64,
    pub state: RetentionUploadStateV1,
    pub confirmed_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_ref: Option<RetentionStageRefV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnRetentionReferenceV1 {
    pub retention_id: String,
    pub expected_revision: u64,
    pub entry_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnRetentionAuthorizationV1 {
    pub trusted_context: TrustedRetentionContextV1,
    pub references: Vec<TurnRetentionReferenceV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consume_acks: Vec<RetentionConsumeAckV1>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_contract_keeps_legacy_nil_and_rejects_unknown_context_fields() {
        let legacy: crate::AttachmentUploadStartParams =
            serde_json::from_value(serde_json::json!({"filename":"file.txt","size":2})).unwrap();
        assert!(legacy.retention.is_none());
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            serde_json::json!({"filename":"file.txt","size":2})
        );
        assert!(serde_json::from_value::<TrustedRetentionContextV1>(serde_json::json!({
            "gatewayNamespaceId":"gateway","deviceId":"device","authorizationGeneration":"epoch",
            "targetFingerprint":"target","principal":{"kind":"localOs"},"accessToken":"forged"
        })).is_err());
        let retired = AttachmentRetentionResult {
            receipt: None,
            epoch_retired: Some(RetentionEpochRetiredV1 {
                root_namespace: "root".into(),
                epoch: 1,
                retired_through: 2,
            }),
            consume_results: vec![],
        };
        let value = serde_json::to_value(retired).unwrap();
        assert!(value["receipt"].is_null());
        assert_eq!(value["epochRetired"]["retiredThrough"], 2);
    }
}

fn required_optional_receipt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RetentionReceiptV1>, D::Error> {
    Option::<RetentionReceiptV1>::deserialize(deserializer)
}

impl AttachmentRetentionResult {
    /// Consumers must validate this before interpreting null as absence or an
    /// epoch watermark as a consume-outbox acknowledgement.
    pub fn validate(&self, expected_root: &str) -> Result<(), &'static str> {
        if self.receipt.is_some() && self.epoch_retired.is_some() {
            return Err("receipt and epochRetired are mutually exclusive");
        }
        if self.consume_results.len() > MAX_RETENTION_BATCH {
            return Err("consume result batch exceeds 32");
        }
        if let Some(proof) = &self.epoch_retired
            && (proof.root_namespace != expected_root
                || proof.epoch == 0
                || proof.epoch > proof.retired_through)
        {
            return Err("invalid retired epoch proof");
        }
        if let Some(receipt) = &self.receipt
            && (receipt.entries.is_empty()
                || receipt.entries.len() > MAX_RETENTION_BATCH
                || receipt.revision == 0
                || receipt.entries.iter().any(|entry| {
                    entry.stage_ref.root_namespace != expected_root
                        || entry.stage_ref.epoch == 0
                        || entry.stage_ref.revision == 0
                }))
        {
            return Err("invalid retention receipt entries");
        }
        Ok(())
    }
}
fn check_batch(len: usize) -> Result<(), &'static str> {
    if len > MAX_RETENTION_BATCH {
        Err("retention batch exceeds 32")
    } else {
        Ok(())
    }
}
fn valid_atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn operation_id(value: &str) -> bool {
    let pieces: Vec<_> = value.split('.').collect();
    valid_atom(value)
        && pieces.len() == 4
        && pieces[0] == "r1"
        && valid_atom(pieces[1])
        && pieces[2]
            .parse::<u64>()
            .ok()
            .is_some_and(|epoch| epoch > 0 && epoch.to_string() == pieces[2])
        && pieces[3].len() == 32
        && pieces[3].bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn check_acks(acks: &[RetentionConsumeAckV1]) -> Result<(), &'static str> {
    check_batch(acks.len())?;
    let mut ids = std::collections::BTreeSet::new();
    let mut receipts = std::collections::BTreeSet::new();
    for ack in acks {
        if !valid_atom(&ack.client_ack_id)
            || !operation_id(&ack.retention_id)
            || ack.terminal_revision == 0
            || !ids.insert(&ack.client_ack_id)
            || !receipts.insert(&ack.retention_id)
        {
            return Err("invalid or duplicate retention ACK");
        }
    }
    Ok(())
}
impl AttachmentRetentionReserveParams {
    pub fn validate_batch(&self) -> Result<(), &'static str> {
        if self.stage_refs.is_empty()
            || !operation_id(&self.client_request_id)
            || !valid_atom(&self.thread_id)
        {
            return Err("invalid retention reserve");
        }
        check_batch(self.stage_refs.len())?;
        let mut ids = std::collections::BTreeSet::new();
        for stage in &self.stage_refs {
            if !valid_atom(&stage.root_namespace)
                || !valid_atom(&stage.owner_id)
                || !valid_atom(&stage.entry_id)
                || stage.epoch == 0
                || stage.revision == 0
                || !ids.insert(&stage.entry_id)
            {
                return Err("invalid or duplicate retention stage");
            }
        }
        check_acks(&self.consume_acks)
    }
}
impl AttachmentRetentionReadParams {
    pub fn validate_batch(&self) -> Result<(), &'static str> {
        let id = match &self.selector {
            RetentionReceiptSelectorV1::ClientRequestId { client_request_id } => client_request_id,
            RetentionReceiptSelectorV1::RetentionId { retention_id } => retention_id,
        };
        if !operation_id(id) {
            return Err("invalid retention selector");
        }
        check_acks(&self.consume_acks)
    }
}
impl AttachmentRetentionReleaseParams {
    pub fn validate_batch(&self) -> Result<(), &'static str> {
        if !operation_id(&self.retention_id) || self.expected_revision == 0 {
            return Err("invalid retention release");
        }
        check_acks(&self.consume_acks)
    }
}
impl AttachmentRetentionConsumeParams {
    pub fn validate_batch(&self) -> Result<(), &'static str> {
        if self.acks.is_empty() {
            return Err("empty retention consume batch");
        }
        check_acks(&self.acks)
    }
}
impl AttachmentRetentionUploadOptions {
    pub fn validate_batch(&self) -> Result<(), &'static str> {
        check_batch(self.consume_acks.len())
    }
}
impl AttachmentRetentionUploadContinuation {
    pub fn validate_batch(&self) -> Result<(), &'static str> {
        check_batch(self.consume_acks.len())
    }
}
impl TurnRetentionAuthorizationV1 {
    pub fn validate_batch(&self) -> Result<(), &'static str> {
        check_batch(self.references.len())?;
        check_batch(self.consume_acks.len())?;
        let mut entries = 0usize;
        for reference in &self.references {
            if reference.entry_ids.is_empty() {
                return Err("empty turn retention entry batch");
            }
            entries = entries
                .checked_add(reference.entry_ids.len())
                .ok_or("retention batch overflow")?;
        }
        check_batch(entries)
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    #[test]
    fn retention_result_rejects_incompatible_watermark_and_oversized_batches() {
        let mut value = AttachmentRetentionResult {
            receipt: None,
            epoch_retired: None,
            consume_results: vec![],
        };
        assert!(value.validate("root").is_ok());
        assert!(
            serde_json::from_value::<AttachmentRetentionResult>(serde_json::json!({})).is_err()
        );
        value.epoch_retired = Some(RetentionEpochRetiredV1 {
            root_namespace: "root".into(),
            epoch: 2,
            retired_through: 1,
        });
        assert!(value.validate("root").is_err());
        value.epoch_retired.as_mut().unwrap().retired_through = 2;
        assert!(value.validate("other").is_err());
        assert!(value.validate("root").is_ok());
        value.receipt = Some(RetentionReceiptV1 {
            client_request_id: "id".into(),
            retention_id: "receipt".into(),
            thread_id: "thread".into(),
            revision: 1,
            state: RetentionReceiptStateV1::Released,
            entries: vec![],
        });
        assert!(value.validate("root").is_err());
        assert!(check_batch(32).is_ok());
        assert!(check_batch(33).is_err());
        let invalid: AttachmentRetentionResult = serde_json::from_value(serde_json::json!({"receipt": null, "epochRetired": {"rootNamespace":"root","epoch":4,"retiredThrough":3}})).unwrap();
        assert!(invalid.validate("root").is_err());
    }
}

pub const METHOD_RETENTION_UPLOAD_SAVE: &str = "attachment/retention/upload/save";
pub const METHOD_RETENTION_UPLOAD_START: &str = "attachment/retention/upload/start";
pub const METHOD_RETENTION_UPLOAD_READ: &str = "attachment/retention/upload/read";
pub const METHOD_RETENTION_UPLOAD_CHUNK: &str = "attachment/retention/upload/chunk";
pub const METHOD_RETENTION_UPLOAD_FINISH: &str = "attachment/retention/upload/finish";
pub const METHOD_RETENTION_UPLOAD_CANCEL: &str = "attachment/retention/upload/cancel";
pub const RETENTION_UPLOAD_CHUNK_BYTES: u64 = 512 * 1024;
pub const RETENTION_UPLOAD_SAVE_BYTES: u64 = 256 * 1024;
pub fn is_retention_upload_method(method: &str) -> bool {
    matches!(
        method,
        METHOD_RETENTION_UPLOAD_SAVE
            | METHOD_RETENTION_UPLOAD_START
            | METHOD_RETENTION_UPLOAD_READ
            | METHOD_RETENTION_UPLOAD_CHUNK
            | METHOD_RETENTION_UPLOAD_FINISH
            | METHOD_RETENTION_UPLOAD_CANCEL
    )
}

/// Root facts, not permission. A cached epoch cannot authorize new allocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionUploadAdmissionV1 {
    pub version: u8,
    pub root_namespace: String,
    pub admission_epoch: u64,
}

/// Kept separate to avoid changing existing initialize constructors/legacy wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionInitializeResultV1 {
    #[serde(flatten)]
    pub initialized: crate::InitializeResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_upload_admission: Option<RetentionUploadAdmissionV1>,
}

/// One bounded typed envelope; validate_for enforces each method's exact fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionUploadParamsV1 {
    pub owner_request: RetentionOwnerRequestV1,
    pub client_upload_id: String,
    pub trusted_context: TrustedRetentionContextV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_base64: Option<String>,
}

pub fn retention_upload_generation_id(id: &str, prefix: &str) -> Result<(String, u64), String> {
    let parts: Vec<_> = id.split('.').collect();
    if id.len() > 256
        || parts.len() != 4
        || parts[0] != prefix
        || parts[1].is_empty()
        || !parts[1]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || parts[3].len() != 32
        || !parts[3].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid retained upload generation ID".into());
    }
    let epoch = parts[2]
        .parse::<u64>()
        .map_err(|_| "Invalid retained upload epoch")?;
    if epoch == 0 || epoch.to_string() != parts[2] {
        return Err("Invalid retained upload epoch".into());
    }
    Ok((parts[1].into(), epoch))
}
impl RetentionUploadParamsV1 {
    pub fn validate_for(&self, method: &str) -> Result<(), String> {
        retention_upload_generation_id(&self.owner_request.client_owner_request_id, "o1")?;
        retention_upload_generation_id(&self.client_upload_id, "u1")?;
        let atom = |s: &str| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control);
        let sha = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
        if self.owner_request.immutable_parameters.len() > 32
            || self
                .owner_request
                .immutable_parameters
                .iter()
                .any(|(k, v)| !atom(k) || !atom(v))
            || serde_json::to_vec(&self.owner_request)
                .map_err(|e| e.to_string())?
                .len()
                > 16384
        {
            return Err("Invalid owner request".into());
        }
        let is_start = matches!(
            method,
            METHOD_RETENTION_UPLOAD_START | METHOD_RETENTION_UPLOAD_SAVE
        );
        let is_chunk = method == METHOD_RETENTION_UPLOAD_CHUNK;
        let is_bytes = is_chunk || method == METHOD_RETENTION_UPLOAD_SAVE;
        if !is_retention_upload_method(method)
            || is_start != self.filename.is_some()
            || is_start != self.size.is_some()
            || is_start != self.content_sha256.is_some()
            || is_chunk != self.offset.is_some()
            || is_chunk != self.length.is_some()
            || is_chunk != self.chunk_sha256.is_some()
            || is_bytes != self.content_base64.is_some()
            || self.filename.as_ref().is_some_and(|s| !atom(s))
            || self.size.is_some_and(|n| n > 100 * 1024 * 1024)
            || self.content_sha256.as_ref().is_some_and(|s| !sha(s))
            || self.chunk_sha256.as_ref().is_some_and(|s| !sha(s))
            || self
                .length
                .is_some_and(|n| n == 0 || n > RETENTION_UPLOAD_CHUNK_BYTES)
            || (method == METHOD_RETENTION_UPLOAD_SAVE
                && self.size.is_some_and(|n| n > RETENTION_UPLOAD_SAVE_BYTES))
            || self
                .content_base64
                .as_ref()
                .is_some_and(|s| s.len() > (RETENTION_UPLOAD_CHUNK_BYTES as usize).div_ceil(3) * 4)
        {
            return Err("Invalid retained upload method fields".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RetentionUploadLookupV1 {
    Absent,
    Present {
        filename: String,
        size: u64,
        content_sha256: String,
        recovery: RetentionUploadRecoveryV1,
    },
    EpochRetired {
        proof: RetentionEpochRetiredV1,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionUploadResultV1 {
    pub client_owner_request_id: String,
    pub client_upload_id: String,
    pub scope_id: String,
    pub lookup: RetentionUploadLookupV1,
}
