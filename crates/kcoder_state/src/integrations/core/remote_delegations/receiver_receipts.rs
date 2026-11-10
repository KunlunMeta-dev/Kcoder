//! Exact original Native Accepted receipt. This journal never becomes a second task authority.
use super::*;
use crate::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteReceiverObservation {
    pub identity: TurnAttemptIdentity,
    pub accepted_input_sha256: String,
    pub accepted_receipt_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteReceiverDiagnostic {
    pub identity: TurnAttemptIdentity,
    pub code: String,
}
/// Native-only fact token loaded from the actual receiver's authoritative store.
/// Neither ACP metadata nor a caller JSON task ID can construct this token.
pub struct NativeRemoteAcceptedReceiver {
    receipt: NativeRemoteReceiverObservation,
    accepted: TurnAttemptRecord,
}
impl NativeRemoteAcceptedReceiver {
    /// The host supplies the actual receiver store only after verifying its independent
    /// profile, workspace, current State and task-local Accepted execution identity.
    pub fn read_accepted(store: &TurnAttemptStore, identity: &TurnAttemptIdentity) -> Result<Self> {
        let accepted = store
            .load(identity)?
            .context("REMOTE_RECEIVER_NATIVE_TASK_MISSING")?;
        accepted.validate()?;
        ensure!(
            accepted.identity == *identity
                && accepted.status == TurnAttemptStatus::Accepted
                && accepted.completion.is_none(),
            "REMOTE_RECEIVER_NATIVE_TASK_NOT_ACTIVE"
        );
        let receipt = NativeRemoteReceiverObservation {
            identity: identity.clone(),
            accepted_input_sha256: accepted.input_context_hash.clone(),
            accepted_receipt_sha256: receipt_digest(&accepted)?,
        };
        Ok(Self { receipt, accepted })
    }
}
impl NativeRemoteDelegationStore {
    /// Private native history locations are bound only by the actual retained
    /// receiver Accepted receipt. They are never part of a public observation.
    pub fn freeze_receiver_private_witness(
        &self,
        operation: &str,
        store: &TurnAttemptStore,
        accepted: &NativeRemoteAcceptedReceiver,
        witness: &Value,
    ) -> Result<()> {
        ensure!(
            witness.is_object() && serde_json::to_vec(witness)?.len() <= 16 * 1024,
            "REMOTE_RECEIVER_PRIVATE_WITNESS_INVALID"
        );
        ensure!(
            store.load(&accepted.receipt.identity)?.as_ref() == Some(&accepted.accepted),
            "REMOTE_RECEIVER_NATIVE_TASK_CHANGED"
        );
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                record.receiver.as_ref() == Some(&accepted.receipt),
                "REMOTE_RECEIVER_NATIVE_TASK_CONFLICT"
            );
            if let Some(original) = &record.receiver_private_witness {
                ensure!(
                    original == witness,
                    "REMOTE_RECEIVER_PRIVATE_WITNESS_CHANGED"
                );
                return Ok(());
            }
            record.receiver_private_witness = Some(witness.clone());
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok(())
        })
    }
    /// Pure lookup cannot repair or infer an absent native history witness.
    pub fn read_receiver_private_witness(&self, operation: &str) -> Result<Option<Value>> {
        label(operation)?;
        Ok(self
            .load()?
            .entries
            .get(operation)
            .and_then(|record| record.receiver_private_witness.clone()))
    }

    /// Only an actual retained receiver Accepted receipt can append a bounded
    /// native failure explanation. This fact neither grants work nor claims success.
    pub fn record_receiver_diagnostic(
        &self,
        operation: &str,
        store: &TurnAttemptStore,
        accepted: &NativeRemoteAcceptedReceiver,
        code: &str,
    ) -> Result<()> {
        ensure!(
            code.len() <= 160
                && !code.is_empty()
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
            "REMOTE_RECEIVER_DIAGNOSTIC_INVALID"
        );
        ensure!(
            store.load(&accepted.receipt.identity)?.as_ref() == Some(&accepted.accepted),
            "REMOTE_RECEIVER_NATIVE_TASK_CHANGED"
        );
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                record.receiver.as_ref() == Some(&accepted.receipt),
                "REMOTE_RECEIVER_NATIVE_TASK_CONFLICT"
            );
            let value = NativeRemoteReceiverDiagnostic {
                identity: accepted.receipt.identity.clone(),
                code: code.into(),
            };
            if record.receiver_diagnostic.as_ref() != Some(&value) {
                record.receiver_diagnostic = Some(value);
                record.revision = next(record.revision)?;
                ledger.revision = next(ledger.revision)?;
            }
            Ok(())
        })
    }
    /// Link a real receiver Accepted record to the original dispatched prompt once.
    /// This does not allocate a task, send a prompt, or infer any terminal state.
    pub fn link_accepted_receiver(
        &self,
        operation: &str,
        actual_recipient: &Value,
        authoritative_store: &TurnAttemptStore,
        accepted: &NativeRemoteAcceptedReceiver,
    ) -> Result<NativeRemoteObservation> {
        label(operation)?;
        ensure!(
            authoritative_store
                .load(&accepted.receipt.identity)?
                .as_ref()
                == Some(&accepted.accepted),
            "REMOTE_RECEIVER_NATIVE_TASK_CHANGED"
        );
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                &record.recipient_identity == actual_recipient,
                "REMOTE_RECEIVER_NATIVE_OWNER_MISMATCH"
            );
            ensure!(
                record.stages.contains_key(&NativeRemoteStage::Prompt),
                "REMOTE_ORIGINAL_PROMPT_DISPATCH_REQUIRED"
            );
            if let Some(original) = &record.receiver {
                ensure!(
                    original == &accepted.receipt,
                    "REMOTE_RECEIVER_NATIVE_TASK_CONFLICT"
                );
                return Ok((&*record).into());
            }
            record.receiver = Some(accepted.receipt.clone());
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok((&*record).into())
        })
    }
    /// Read the exact original task through the actual receiver ledger. A task
    /// lookup never creates/resumes/replaces a missing receiver or reruns a prompt.
    pub fn read_receiver_task(
        &self,
        operation: &str,
        actual_recipient: &Value,
        authoritative_store: &TurnAttemptStore,
    ) -> Result<TurnAttemptRecord> {
        let ledger = self.load()?;
        let record = ledger
            .entries
            .get(operation)
            .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
        ensure!(
            &record.recipient_identity == actual_recipient,
            "REMOTE_RECEIVER_NATIVE_OWNER_MISMATCH"
        );
        let original = record
            .receiver
            .as_ref()
            .context("REMOTE_RECEIVER_NATIVE_ACCEPTANCE_UNKNOWN")?;
        let actual = authoritative_store
            .load(&original.identity)?
            .context("REMOTE_RECEIVER_NATIVE_TASK_MISSING_OUTCOME_UNKNOWN")?;
        actual.validate()?;
        ensure!(
            actual.identity == original.identity
                && actual.input_context_hash == original.accepted_input_sha256
                && receipt_digest(&actual)? == original.accepted_receipt_sha256,
            "REMOTE_RECEIVER_NATIVE_TASK_CHANGED"
        );
        self.verify()?;
        Ok(actual)
    }
}
fn receipt_digest(record: &TurnAttemptRecord) -> Result<String> {
    // Completion changes are authoritative task facts, not changes to the original acceptance.
    digest(&serde_json::json!([
        record.version,
        record.identity,
        record.parent_attempt_id,
        record.retry_operation_id,
        record.accepted_at_ms,
        record.input_context_hash,
        record.request_fingerprint,
        record.retained_input,
        record.client_presentation
    ]))
}
