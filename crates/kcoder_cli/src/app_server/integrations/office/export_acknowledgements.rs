//! Durable byte receipts follow the real native ACK, never caller-provided receipt metadata.
use super::*;
use kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementParams;
use kcoder_state::integrations::office::OfficeExportAcknowledgementIntent;

fn intent(params: &OfficeExportAcknowledgementParams) -> OfficeExportAcknowledgementIntent {
    OfficeExportAcknowledgementIntent {
        export_id: params.export_id.clone(),
        reference: params.reference.clone(),
        bytes: params.bytes,
        sha256: params.sha256.clone(),
    }
}
impl NativeOfficeFileAssets {
    /// The current connection may admit a new ACK only after its original full stream.
    /// A known same operation reads the existing fact, without reviving that old lease.
    pub(in crate::app_server::integrations) async fn acknowledge_export_receipt(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        params: &OfficeExportAcknowledgementParams,
        cancel: &CancellationToken,
    ) -> Result<OfficeExportAcknowledgementReceipt> {
        native.validate_scope(&request.scope)?;
        ensure!(
            params.automation_run_id.is_none(),
            "OFFICE_OPERATION_CONFLICT"
        );
        let operation = request
            .operation_id
            .as_deref()
            .context("OFFICE_OPERATION_REQUIRED")?;
        let original = intent(params);
        self.check(native, cancel)?;
        if let Some(record) = self
            .store()?
            .read_export_acknowledgement(operation, Some(&original))?
        {
            self.verify_export_acknowledgement(native, &record, cancel)
                .await?;
            return Ok(record);
        }
        let verified = self.acknowledge_export(native, params, cancel).await?;
        self.persist_export_acknowledgement(native, operation, &original, verified, cancel)
            .await
    }
    async fn persist_export_acknowledgement(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
        intent: &OfficeExportAcknowledgementIntent,
        verified: VerifiedOfficeExportAcknowledgement,
        cancel: &CancellationToken,
    ) -> Result<OfficeExportAcknowledgementReceipt> {
        // This non-Serde witness exists only after original bytes/current owner/source/ACK checks.
        native.validate_scope(verified.scope())?;
        let record = OfficeExportAcknowledgementReceipt {
            schema_version: 1,
            kind: OfficeExportAcknowledgementKind::ClientByteReceipt,
            operation_id: operation.into(),
            owner: verified.manifest.owner.clone(),
            task: verified.manifest.task.clone(),
            export_id: verified.export_id,
            reference: OfficeArtifactRef {
                id: verified.manifest.id,
                revision: verified.manifest.revision,
            },
            bytes: verified.bytes,
            sha256: verified.sha256,
            source_identities: verified.source_identities,
            read_completed_at_ms: verified.completed_at_ms,
            acknowledged_at_ms: verified.acknowledged_at_ms,
        };
        self.verify_export_acknowledgement(native, &record, cancel)
            .await?;
        let saved = self
            .store()?
            .record_export_acknowledgement(operation, intent, &record)?;
        // A lost authority/response after commit cannot erase the original atomic receipt.
        self.verify_export_acknowledgement(native, &saved, cancel)
            .await?;
        Ok(saved)
    }
    pub(in crate::app_server::integrations) async fn read_export_acknowledgement_operation(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<OfficeExportAcknowledgementReceipt>> {
        self.check(native, cancel)?;
        let Some(record) = self.store()?.read_export_acknowledgement(operation, None)? else {
            return Ok(None);
        };
        self.verify_export_acknowledgement(native, &record, cancel)
            .await?;
        Ok(Some(record))
    }
    async fn verify_export_acknowledgement(
        &self,
        native: &NativeIntegrationContext,
        record: &OfficeExportAcknowledgementReceipt,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.check(native, cancel)?;
        let request = self.request(json!({"reference":record.reference}));
        super::super::organization_policy::authorize_actions(
            native,
            &["read", "export"],
            &request.request_id,
        )?;
        let store = self.store()?;
        let manifest = store
            .read_artifact(&record.reference)?
            .context("OFFICE_ARTIFACT_NOT_FOUND")?;
        record.validate_for(&manifest)?;
        let history = self.check_manifest(&manifest, &store)?;
        let first = self
            .validate_sources(native, &request, &manifest.source_refs, cancel)
            .await?;
        ensure!(
            first == record.source_identities,
            "OFFICE_INPUT_REVISION_MISMATCH"
        );
        // Verify the original immutable blob without opening or recreating a transfer lease.
        let (_, total) = store.read_artifact_chunk(&record.reference, record.bytes, 1)?;
        ensure!(total == record.bytes, "OFFICE_CONTENT_CORRUPT");
        let current = self
            .validate_sources(native, &request, &manifest.source_refs, cancel)
            .await?;
        ensure!(
            current == first && self.check_manifest(&manifest, &self.store()?)? == history,
            "OFFICE_INPUT_REVISION_MISMATCH"
        );
        self.check(native, cancel)?;
        super::super::organization_policy::authorize_actions(
            native,
            &["read", "export"],
            &request.request_id,
        )?;
        Ok(())
    }
}
