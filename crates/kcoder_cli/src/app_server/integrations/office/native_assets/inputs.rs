//! Native-only finish witness; JSON paths can never construct this token.
use super::*;
use std::fs::File;
use std::io::{Seek, SeekFrom};

pub(crate) struct NativeOfficePreparedInput {
    scope: IntegrationScope,
    operation: String,
    input_id: String,
    metadata: OfficeInputMetadata,
    parent: PrivateDirectory,
    parent_path: PathBuf,
    filename: OsString,
    identity: PortableLeaseIdentity,
    file: File,
}
impl std::fmt::Debug for NativeOfficePreparedInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeOfficePreparedInput")
            .field("bytes", &self.metadata.expected_bytes)
            .finish_non_exhaustive()
    }
}
impl NativeOfficePreparedInput {
    fn verify(&self) -> Result<()> {
        self.parent.verify_private_directory()?;
        let current = PrivateDirectory::open_existing(&self.parent_path)?;
        ensure!(
            current.directory_identity()? == self.parent.directory_identity()?
                && current.portable_regular_identity(&self.filename)? == self.identity
                && current.portable_regular_handle_identity(&self.file)? == self.identity
                && self.file.metadata()?.len() == self.metadata.expected_bytes,
            "OFFICE_INPUT_UNCONFIRMED"
        );
        Ok(())
    }
    fn verify_bytes(&mut self, cancel: &CancellationToken) -> Result<()> {
        self.verify()?;
        self.file.seek(SeekFrom::Start(0))?;
        let mut received = 0u64;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
            let size = self.file.read(&mut buffer)?;
            if size == 0 {
                break;
            }
            received += size as u64;
            ensure!(
                received <= self.metadata.expected_bytes,
                "OFFICE_INPUT_SIZE_MISMATCH"
            );
            digest.update(&buffer[..size]);
        }
        ensure!(
            received == self.metadata.expected_bytes
                && format!("{:x}", digest.finalize())
                    .eq_ignore_ascii_case(&self.metadata.expected_sha256),
            "OFFICE_INPUT_HASH_MISMATCH"
        );
        self.verify()?;
        self.file.seek(SeekFrom::Start(0))?;
        Ok(())
    }
}

impl NativeOfficeFileAssets {
    /// Call only directly after the real attachment_upload_finish/save return
    /// on the same connection. This captures ownership; it never initializes.
    pub(crate) fn prepare_finished_input(
        &self,
        native: &NativeIntegrationContext,
        staged: &AttachmentDirectories,
        actual: &AttachmentSaveResult,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<NativeOfficePreparedInput> {
        request.validate(true)?;
        native.validate_scope(&request.scope)?;
        self.check(native, cancel)?;
        super::super::organization_policy::authorize(native, "write", &request.request_id)?;
        let metadata: OfficeInputMetadata =
            serde_json::from_value(Value::Object(request.payload.clone()))
                .context("OFFICE_INVALID_INPUT_METADATA")?;
        metadata.validate()?;
        ensure!(
            actual.stage_ref.is_none(),
            "OFFICE_INPUT_PROVIDER_UNAVAILABLE"
        );
        let path = Path::new(&actual.path);
        let file = open_owned_staged_attachment(path, staged)?;
        let parent_path = path
            .parent()
            .context("OFFICE_INPUT_UNCONFIRMED")?
            .to_path_buf();
        let filename = path
            .file_name()
            .context("OFFICE_INPUT_UNCONFIRMED")?
            .to_os_string();
        ensure!(
            filename.to_str() == Some(metadata.filename.as_str()),
            "OFFICE_INPUT_UNCONFIRMED"
        );
        let parent = PrivateDirectory::open_existing(&parent_path)?;
        let identity = parent.portable_regular_handle_identity(&file)?;
        let operation = request
            .operation_id
            .clone()
            .context("OFFICE_OPERATION_REQUIRED")?;
        let input_id = format!(
            "input-{}",
            hash(&serde_json::to_vec(&(native.scope(), &operation))?)
        );
        let prepared = NativeOfficePreparedInput {
            scope: request.scope.clone(),
            operation,
            input_id,
            metadata,
            parent,
            parent_path,
            filename,
            identity,
            file,
        };
        prepared.verify()?;
        Ok(prepared)
    }

    /// Existing owned worker scope may run this synchronous, bounded operation
    /// off the protocol loop. No mutable AttachmentDirectories crosses threads.
    /// The held Native file witness, not JSON, owns the acceptance input.
    pub(crate) fn commit_finished_input(
        &self,
        native: &NativeIntegrationContext,
        mut prepared: NativeOfficePreparedInput,
        cancel: &CancellationToken,
    ) -> Result<OfficeMaterialReceipt> {
        self.check(native, cancel)?;
        native.validate_scope(&prepared.scope)?;
        super::super::organization_policy::authorize(native, "write", &prepared.operation)?;
        prepared.verify_bytes(cancel)?;
        self.check(native, cancel)?;
        super::super::organization_policy::authorize(native, "write", &prepared.operation)?;
        // First write occurs only after complete owned bytes, size and hash were
        // verified. This is the same real OfficeStore/NativeDomain namespace.
        let store = match NativeDomainGuard::observe(
            native.profile()?,
            native.scope(),
            NativeDomain::Office,
        )? {
            Some(_) => self.store()?,
            None => {
                let (_, store) = NativeDomainGuard::initialize(
                    native.profile()?,
                    native.scope(),
                    NativeDomain::Office,
                    &prepared.operation,
                    |directory| {
                        OfficeStore::create_in(
                            directory,
                            OsStr::new("data"),
                            IntegrationOwner::from(native.scope()),
                        )
                    },
                )?;
                store
            }
        };
        self.check(native, cancel)?;
        super::super::organization_policy::authorize(native, "write", &prepared.operation)?;
        let (fresh, previous) = store.begin_input_attempt(
            &prepared.operation,
            &prepared.input_id,
            prepared.metadata.clone(),
        )?;
        if !fresh {
            // An old unknown/pending write is never replayed from a new upload.
            // A known committed blob is read and verified without writing it.
            ensure!(
                previous.receipt.status == "accepted" && previous.stored_content.is_some(),
                "OFFICE_INPUT_RECONCILIATION_REQUIRED"
            );
            let receipt = store
                .validate_stored_input(&prepared.input_id, || !cancel.is_cancelled())?
                .context("OFFICE_INPUT_UNCONFIRMED")?;
            self.check(native, cancel)?;
            super::super::organization_policy::authorize(native, "write", &prepared.operation)?;
            return public_material(&receipt);
        }
        let receipt = store
            .complete_stored_input(
                &prepared.operation,
                &prepared.input_id,
                &mut prepared.file,
                || !cancel.is_cancelled(),
            )
            .map_err(|_| anyhow::anyhow!("OFFICE_INPUT_RECONCILIATION_REQUIRED"))?;
        self.check(native, cancel)
            .map_err(|_| anyhow::anyhow!("OFFICE_INPUT_RECONCILIATION_REQUIRED"))?;
        super::super::organization_policy::authorize(native, "write", &prepared.operation)
            .map_err(|_| anyhow::anyhow!("OFFICE_INPUT_RECONCILIATION_REQUIRED"))?;
        public_material(&receipt)
    }
}
fn public_material(receipt: &OfficeInputReceipt) -> Result<OfficeMaterialReceipt> {
    ensure!(receipt.status == "accepted", "OFFICE_INPUT_UNCONFIRMED");
    let result = OfficeMaterialReceipt {
        kind: OfficeMaterialKind::OfficeInput,
        input_id: receipt.input_id.clone(),
        revision: receipt.revision,
        operation_id: receipt.operation_id.clone(),
        owner: receipt.owner.clone(),
        filename: receipt.metadata.filename.clone(),
        media_type: receipt.metadata.media_type.clone(),
        bytes: receipt.bytes.context("OFFICE_INPUT_UNCONFIRMED")?,
        sha256: receipt.sha256.clone().context("OFFICE_INPUT_UNCONFIRMED")?,
        status: OfficeMaterialStatus::Accepted,
    };
    result.validate()?;
    Ok(result)
}
