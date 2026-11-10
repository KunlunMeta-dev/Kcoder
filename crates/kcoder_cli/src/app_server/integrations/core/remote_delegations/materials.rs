//! Freeze complete original Office inputs before a single remote send.
use crate::launch_record::RemoteMaterialDescriptor;
use anyhow::{Context, Result, ensure};
use kcoder_integration_storage::integrations::office::{OfficeInputReceipt, OfficeStore};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::office::OfficeArtifactRef;
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, sync::Arc};
use tokio_util::sync::CancellationToken;

pub const MAX_MATERIAL_BYTES: u64 = 32 * 1024 * 1024;

pub struct FrozenRemoteMaterial {
    native: NativeIntegrationContext,
    guard: NativeDomainGuard,
    store: OfficeStore,
    receipt: OfficeInputReceipt,
    descriptor: RemoteMaterialDescriptor,
    content: Arc<[u8]>,
}
impl FrozenRemoteMaterial {
    /// The native Tool backend calls only after normal final Engine approval.
    /// The same actual caller/Accepted/scope is checked before and after reading.
    pub fn capture(
        native: &NativeIntegrationContext,
        reference: &OfficeArtifactRef,
        verify_caller: &dyn Fn() -> Result<()>,
        is_aborted: &dyn Fn() -> bool,
    ) -> Result<Self> {
        verify_caller()?;
        ensure!(reference.revision == 1, "REMOTE_MATERIAL_REVISION_MISMATCH");
        let guard =
            NativeDomainGuard::observe(native.profile()?, native.scope(), NativeDomain::Office)?
                .context("REMOTE_MATERIAL_NATIVE_STORE_REQUIRED")?;
        let store = OfficeStore::open_in(
            &guard.directory(native.profile()?)?,
            OsStr::new("data"),
            kcoder_types::integrations::core::IntegrationOwner::from(native.scope()),
        )?
        .context("REMOTE_MATERIAL_NATIVE_STORE_REQUIRED")?;
        let (receipt, bytes) = store
            .read_stored_input(&reference.id, MAX_MATERIAL_BYTES, || {
                !is_aborted() && native.verify().is_ok()
            })?
            .context("REMOTE_MATERIAL_STORED_SOURCE_REQUIRED")?;
        ensure!(
            receipt.revision == reference.revision
                && receipt.status == "accepted"
                && receipt.owner
                    == kcoder_types::integrations::core::IntegrationOwner::from(native.scope())
                && receipt.bytes == Some(bytes.len() as u64),
            "REMOTE_MATERIAL_SOURCE_CHANGED"
        );
        let hash = format!("{:x}", Sha256::digest(&bytes));
        ensure!(
            receipt
                .sha256
                .as_ref()
                .is_some_and(|expected| expected.eq_ignore_ascii_case(&hash)),
            "REMOTE_MATERIAL_SOURCE_CHANGED"
        );
        let descriptor = RemoteMaterialDescriptor {
            source: reference.clone(),
            filename: receipt.metadata.filename.clone(),
            media_type: receipt.metadata.media_type.clone(),
            bytes: bytes.len() as u64,
            sha256: hash,
        };
        verify_caller()?;
        let result = Self {
            native: native.recapture_for_owned_service()?,
            guard,
            store,
            receipt,
            descriptor,
            content: bytes.into(),
        };
        result.verify(&CancellationToken::new())?;
        Ok(result)
    }

    /// The receiver invokes only from its already-verified original native
    /// launch. A decoded descriptor cannot provide the native source context.
    pub fn observe_original_source(
        native: &NativeIntegrationContext,
        expected: &RemoteMaterialDescriptor,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        ensure!(!cancel.is_cancelled(), "REMOTE_MATERIAL_CANCELLED");
        native.verify()?;
        ensure!(
            expected.source.revision == 1 && expected.bytes <= MAX_MATERIAL_BYTES,
            "REMOTE_MATERIAL_SOURCE_CHANGED"
        );
        let guard =
            NativeDomainGuard::observe(native.profile()?, native.scope(), NativeDomain::Office)?
                .context("REMOTE_MATERIAL_NATIVE_STORE_REQUIRED")?;
        let store = OfficeStore::open_in(
            &guard.directory(native.profile()?)?,
            OsStr::new("data"),
            kcoder_types::integrations::core::IntegrationOwner::from(native.scope()),
        )?
        .context("REMOTE_MATERIAL_NATIVE_STORE_REQUIRED")?;
        let (receipt, bytes) = store
            .read_stored_input(&expected.source.id, MAX_MATERIAL_BYTES, || {
                !cancel.is_cancelled() && native.verify().is_ok()
            })?
            .context("REMOTE_MATERIAL_STORED_SOURCE_REQUIRED")?;
        ensure!(
            receipt.revision == expected.source.revision
                && receipt.status == "accepted"
                && receipt.metadata.filename == expected.filename
                && receipt.metadata.media_type == expected.media_type
                && bytes.len() as u64 == expected.bytes
                && format!("{:x}", Sha256::digest(&bytes)) == expected.sha256,
            "REMOTE_MATERIAL_SOURCE_CHANGED"
        );
        let result = Self {
            native: native.recapture_for_owned_service()?,
            guard,
            store,
            receipt,
            descriptor: expected.clone(),
            content: bytes.into(),
        };
        result.verify(cancel)?;
        Ok(result)
    }
    pub fn descriptor(&self) -> &RemoteMaterialDescriptor {
        &self.descriptor
    }
    pub fn bytes(&self) -> &[u8] {
        &self.content
    }

    /// Reopening a selector cannot replay a transfer. Keep the exact original
    /// immutable input receipt, complete bytes and original domain/store handles.
    pub fn verify(&self, cancel: &CancellationToken) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "REMOTE_MATERIAL_CANCELLED");
        self.native.verify()?;
        ensure!(
            self.store
                .validate_stored_input(&self.descriptor.source.id, || !cancel.is_cancelled()
                    && self.native.verify().is_ok())?
                .as_ref()
                == Some(&self.receipt),
            "REMOTE_MATERIAL_SOURCE_CHANGED"
        );
        let current = OfficeStore::open_in(
            &self.guard.directory(self.native.profile()?)?,
            OsStr::new("data"),
            kcoder_types::integrations::core::IntegrationOwner::from(self.native.scope()),
        )?
        .context("REMOTE_MATERIAL_NATIVE_STORE_REQUIRED")?;
        let receipt = current
            .validate_stored_input(&self.descriptor.source.id, || {
                !cancel.is_cancelled() && self.native.verify().is_ok()
            })?
            .context("REMOTE_MATERIAL_STORED_SOURCE_REQUIRED")?;
        ensure!(
            receipt == self.receipt
                && self.content.len() as u64 == self.descriptor.bytes
                && format!("{:x}", Sha256::digest(&self.content)) == self.descriptor.sha256,
            "REMOTE_MATERIAL_SOURCE_CHANGED"
        );
        Ok(())
    }
}
