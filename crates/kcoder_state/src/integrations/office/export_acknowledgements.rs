//! Original typed acknowledgement data reuses the existing owner-bound atomic receipt map.
use super::*;

/// Intent data only. Native must obtain its own non-Serde complete-byte/ACK proof first.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeExportAcknowledgementIntent {
    pub export_id: String,
    pub reference: OfficeArtifactRef,
    pub bytes: u64,
    pub sha256: String,
}
const METHOD: &str = "office.acknowledgeExport";
impl OfficeStore {
    pub fn record_export_acknowledgement(
        &self,
        operation: &str,
        intent: &OfficeExportAcknowledgementIntent,
        receipt: &OfficeExportAcknowledgementReceipt,
    ) -> Result<OfficeExportAcknowledgementReceipt> {
        ensure!(
            receipt.operation_id == operation
                && receipt.owner == self.owner
                && receipt.export_id == intent.export_id
                && receipt.reference == intent.reference
                && receipt.bytes == intent.bytes
                && receipt.sha256 == intent.sha256,
            "OFFICE_OPERATION_CONFLICT"
        );
        self.mutate(operation, METHOD, intent, |state| {
            let manifest = &state
                .artifacts
                .get(&reference_key(&receipt.reference))
                .context("OFFICE_ARTIFACT_NOT_FOUND")?
                .manifest;
            receipt.validate_for(manifest)?;
            Ok(receipt.clone())
        })
    }
    /// Observes only a typed ACK operation. No namespace/schema/receipt repair occurs.
    pub fn read_export_acknowledgement(
        &self,
        operation: &str,
        expected: Option<&OfficeExportAcknowledgementIntent>,
    ) -> Result<Option<OfficeExportAcknowledgementReceipt>> {
        valid_id(operation)?;
        let _lock = self.lock(false)?;
        let state = self.load()?;
        let Some(record) = state.operations.get(operation) else {
            return Ok(None);
        };
        if record.result.get("kind").and_then(Value::as_str)
            != Some("office_export_acknowledgement")
        {
            ensure!(expected.is_none(), "OFFICE_OPERATION_CONFLICT");
            return Ok(None);
        }
        if let Some(expected) = expected {
            let intent = digest(&serde_json::to_vec(&(METHOD, &self.owner, expected))?);
            ensure!(record.intent_sha256 == intent, "OFFICE_OPERATION_CONFLICT");
        }
        let receipt: OfficeExportAcknowledgementReceipt =
            serde_json::from_value(record.result.clone()).context("OFFICE_RECEIPT_CORRUPT")?;
        // StoredOperation retains an intent digest, not a separate method tag.
        // Reconstruct the exact typed stable intent so a different operation
        // returning a coincidentally equal top-level kind cannot be adopted.
        let original = OfficeExportAcknowledgementIntent {
            export_id: receipt.export_id.clone(),
            reference: receipt.reference.clone(),
            bytes: receipt.bytes,
            sha256: receipt.sha256.clone(),
        };
        ensure!(
            record.intent_sha256 == digest(&serde_json::to_vec(&(METHOD, &self.owner, &original))?),
            "OFFICE_OPERATION_CONFLICT"
        );
        ensure!(
            receipt.operation_id == operation && receipt.owner == self.owner,
            "OFFICE_RECEIPT_CORRUPT"
        );
        let manifest = &state
            .artifacts
            .get(&reference_key(&receipt.reference))
            .context("OFFICE_ARTIFACT_NOT_FOUND")?
            .manifest;
        receipt.validate_for(manifest)?;
        Ok(Some(receipt))
    }
}
