//! Read an actual accepted channel material through the existing Office reader.
use super::*;

impl NativeOfficeFileAssets {
    pub(in crate::app_server::integrations) fn verify_channel_material(
        &self,
        native: &NativeIntegrationContext,
        material: &OfficeMaterialReceipt,
        original_operation: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let _ = self.channel_material_bytes(native, material, original_operation, cancel)?;
        self.check(native, cancel)
    }
    pub(in crate::app_server::integrations) fn channel_material_for_operation(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<OfficeMaterialReceipt>> {
        self.check(native, cancel)?;
        if NativeDomainGuard::observe(native.profile()?, native.scope(), NativeDomain::Office)?
            .is_none()
        {
            return Ok(None);
        }
        let store = self.store()?;
        let Some(original) = store.input_for_operation(operation)? else {
            return Ok(None);
        };
        let actual = store
            .validate_stored_input(&original.input_id, || !cancel.is_cancelled())?
            .context("OFFICE_INPUT_UNCONFIRMED")?;
        ensure!(
            actual == original
                && actual.operation_id == operation
                && actual.status == "accepted"
                && actual.owner == IntegrationOwner::from(native.scope()),
            "CHANNEL_MATERIAL_ORIGINAL_INPUT_CHANGED"
        );
        let material = OfficeMaterialReceipt {
            kind: OfficeMaterialKind::OfficeInput,
            input_id: actual.input_id,
            revision: actual.revision,
            operation_id: actual.operation_id,
            owner: actual.owner,
            filename: actual.metadata.filename,
            media_type: actual.metadata.media_type,
            bytes: actual.bytes.context("OFFICE_INPUT_UNCONFIRMED")?,
            sha256: actual.sha256.context("OFFICE_INPUT_UNCONFIRMED")?,
            status: OfficeMaterialStatus::Accepted,
        };
        material.validate()?;
        self.check(native, cancel)?;
        Ok(Some(material))
    }
    fn channel_material_bytes(
        &self,
        native: &NativeIntegrationContext,
        material: &OfficeMaterialReceipt,
        original_operation: &str,
        cancel: &CancellationToken,
    ) -> Result<(OfficeArtifactRef, OfficeInputReceipt, Vec<u8>)> {
        self.check(native, cancel)?;
        material.validate()?;
        ensure!(
            material.owner == IntegrationOwner::from(native.scope())
                && material.operation_id == original_operation
                && material.revision == 1,
            "CHANNEL_MATERIAL_ORIGINAL_INPUT_REQUIRED"
        );
        let reference = OfficeArtifactRef {
            id: material.input_id.clone(),
            revision: 1,
        };
        let (original, bytes) = self.input_bytes(&reference, cancel)?;
        ensure!(
            original.owner == material.owner
                && original.operation_id == original_operation
                && original.revision == material.revision
                && original.status == "accepted"
                && original.metadata.filename == material.filename
                && original.metadata.media_type == material.media_type
                && original.bytes == Some(material.bytes)
                && original.sha256.as_deref() == Some(material.sha256.as_str())
                && bytes.len() as u64 == material.bytes
                && hash(&bytes) == material.sha256,
            "CHANNEL_MATERIAL_ORIGINAL_INPUT_CHANGED"
        );
        Ok((reference, original, bytes))
    }
    pub(in crate::app_server::integrations) fn read_channel_image(
        &self,
        native: &NativeIntegrationContext,
        material: &OfficeMaterialReceipt,
        original_operation: &str,
        cancel: &CancellationToken,
    ) -> Result<kcoder_app_protocol::UserInput> {
        let (reference, original, bytes) =
            self.channel_material_bytes(native, material, original_operation, cancel)?;
        kcoder_tools::image_input::inspect(&bytes, &material.media_type)
            .map_err(anyhow::Error::msg)?;
        let (after, _) = self.input_bytes(&reference, cancel)?;
        ensure!(after == original, "CHANNEL_MATERIAL_ORIGINAL_INPUT_CHANGED");
        self.check(native, cancel)?;
        Ok(kcoder_app_protocol::UserInput::Image {
            url: format!(
                "data:{};base64,{}",
                material.media_type,
                STANDARD.encode(bytes)
            ),
        })
    }
    pub(in crate::app_server::integrations) async fn read_channel_material(
        &self,
        native: &NativeIntegrationContext,
        material: &OfficeMaterialReceipt,
        original_operation: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let (reference, original, bytes) =
            self.channel_material_bytes(native, material, original_operation, cancel)?;
        let worker = Self::original_read_worker()?;
        let header = OfficeReadHeader {
            schema_version: 1,
            operation: None,
            reference: reference.clone(),
            filename: material.filename.clone(),
            byte_length: material.bytes,
            sha256: material.sha256.clone(),
            scope_sha256: hash(&serde_json::to_vec(native.scope())?),
            cursor: None,
            limit: 4,
        };
        header.validate()?;
        let decoded = worker.read(header, bytes, 30_000, cancel).await?;
        let (after, _) = self.input_bytes(&reference, cancel)?;
        ensure!(after == original, "CHANNEL_MATERIAL_ORIGINAL_INPUT_CHANGED");
        self.check(native, cancel)?;
        Ok(serde_json::json!({"material":material,"reader":decoded,"untrustedSourceData":true}))
    }
}
