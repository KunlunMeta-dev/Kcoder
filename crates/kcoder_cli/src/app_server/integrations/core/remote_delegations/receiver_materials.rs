//! Complete original material transfer into the receiver's existing OfficeStore.
use super::*;
use kcoder_office_worker::read_worker::{OfficeReadHeader, OfficeReadWorker};
use kcoder_state::integrations::office::{OfficeInputMetadata, OfficeStore};
use kcoder_types::integrations::office::OfficeArtifactRef;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

pub fn prepare<'a>(
    incoming: &'a super::launch::NativeRemoteIncomingLaunch,
    receiver: &'a NativeIntegrationContext,
    cancel: &'a CancellationToken,
) -> futures::future::BoxFuture<'a, Result<Option<String>>> {
    Box::pin(prepare_producer(incoming, receiver, cancel))
}
async fn prepare_producer(
    incoming: &super::launch::NativeRemoteIncomingLaunch,
    receiver: &NativeIntegrationContext,
    cancel: &CancellationToken,
) -> Result<Option<String>> {
    if incoming.value().materials.is_empty() {
        return Ok(None);
    }
    validate_request(
        incoming.receiver_policy(),
        &incoming.value().materials,
        cancel,
    )?;
    ensure!(
        super::launch::now()? < incoming.value().deadline_utc_ms,
        "REMOTE_NATIVE_DEADLINE_EXPIRED"
    );
    incoming.check_source()?;
    receiver.verify()?;
    let (guard, store) = match NativeDomainGuard::observe(
        receiver.profile()?,
        receiver.scope(),
        NativeDomain::Office,
    )? {
        Some(guard) => {
            let store = OfficeStore::open_in(
                &guard.directory(receiver.profile()?)?,
                OsStr::new("data"),
                kcoder_types::integrations::core::IntegrationOwner::from(receiver.scope()),
            )?
            .context("REMOTE_MATERIAL_RECEIVER_STORE_REQUIRED")?;
            (guard, store)
        }
        None => NativeDomainGuard::initialize(
            receiver.profile()?,
            receiver.scope(),
            NativeDomain::Office,
            &incoming.value().operation,
            |directory| {
                OfficeStore::create_in(
                    directory,
                    OsStr::new("data"),
                    kcoder_types::integrations::core::IntegrationOwner::from(receiver.scope()),
                )
            },
        )?,
    };
    let worker = OfficeReadWorker::from_trusted_program(&std::env::current_exe()?)?;
    let mut context = Vec::new();
    let mut text_bytes = 0usize;
    for expected in &incoming.value().materials {
        incoming.check_source()?;
        ensure!(!cancel.is_cancelled(), "REMOTE_MATERIAL_CANCELLED");
        receiver.verify()?;
        guard.directory(receiver.profile()?)?;
        let original = super::materials::FrozenRemoteMaterial::observe_original_source(
            incoming.source(),
            expected,
            cancel,
        )?;
        let suffix = super::launch::digest(&(&incoming.value().operation, &expected.source))?;
        let id = format!("remote-material-{suffix}");
        let operation = format!("receive-material-{suffix}");
        let (fresh, previous) = store.begin_input_attempt(
            &operation,
            &id,
            OfficeInputMetadata {
                filename: expected.filename.clone(),
                media_type: expected.media_type.clone(),
                expected_bytes: expected.bytes,
                expected_sha256: expected.sha256.clone(),
            },
        )?;
        if !fresh {
            ensure!(
                previous.receipt.status == "accepted" && previous.stored_content.is_some(),
                "REMOTE_MATERIAL_RECONCILE_ORIGINAL_REQUIRED"
            );
        } else {
            store.complete_stored_input(
                &operation,
                &id,
                &mut std::io::Cursor::new(original.bytes()),
                || !cancel.is_cancelled() && incoming.check_source().is_ok(),
            )?;
        }
        let (receipt, received) = store
            .read_stored_input(&id, super::materials::MAX_MATERIAL_BYTES, || {
                !cancel.is_cancelled() && receiver.verify().is_ok()
            })?
            .context("REMOTE_MATERIAL_RECEIVER_STORE_REQUIRED")?;
        ensure!(
            received == original.bytes()
                && receipt.bytes == Some(expected.bytes)
                && receipt.sha256.as_ref() == Some(&expected.sha256),
            "REMOTE_MATERIAL_TRANSFER_IDENTITY_CHANGED"
        );
        let mut cursor = None;
        let mut chunks = Vec::new();
        let mut report = None;
        for _ in 0..1024 {
            incoming.check_source()?;
            let timeout = incoming
                .value()
                .deadline_utc_ms
                .checked_sub(super::launch::now()?)
                .context("REMOTE_NATIVE_DEADLINE_EXPIRED")?
                .min(60_000);
            ensure!(timeout > 0, "REMOTE_NATIVE_DEADLINE_EXPIRED");
            let page = worker
                .read(
                    OfficeReadHeader {
                        schema_version: 1,
                        operation: None,
                        reference: OfficeArtifactRef {
                            id: id.clone(),
                            revision: 1,
                        },
                        filename: expected.filename.clone(),
                        byte_length: expected.bytes,
                        sha256: expected.sha256.clone(),
                        scope_sha256: format!(
                            "{:x}",
                            Sha256::digest(serde_json::to_vec(receiver.scope())?)
                        ),
                        cursor,
                        limit: 4,
                    },
                    received.clone(),
                    timeout,
                    cancel,
                )
                .await?;
            ensure!(
                page["sha256"] == expected.sha256
                    && page["reference"]["id"] == id
                    && page["untrustedSourceData"] == true,
                "REMOTE_MATERIAL_READER_IDENTITY_CHANGED"
            );
            report = Some(page["report"].clone());
            let rows = page["chunks"]
                .as_array()
                .context("REMOTE_MATERIAL_READER_SHAPE")?;
            for row in rows {
                text_bytes = text_bytes
                    .checked_add(
                        row["text"]
                            .as_str()
                            .context("REMOTE_MATERIAL_READER_SHAPE")?
                            .len(),
                    )
                    .context("REMOTE_MATERIAL_CONTEXT_LIMIT")?;
                ensure!(
                    text_bytes <= 2 * 1024 * 1024,
                    "REMOTE_MATERIAL_CONTEXT_LIMIT"
                );
                chunks.push(row.clone());
            }
            if page["complete"] == true {
                ensure!(
                    page["nextCursor"].is_null() && page["omittedChunks"] == 0,
                    "REMOTE_MATERIAL_READER_SHAPE"
                );
                cursor = None;
                break;
            }
            cursor = Some(
                page["nextCursor"]
                    .as_str()
                    .context("REMOTE_MATERIAL_READER_SHAPE")?
                    .to_owned(),
            );
        }
        ensure!(
            cursor.is_none() && report.is_some(),
            "REMOTE_MATERIAL_READER_INCOMPLETE"
        );
        original.verify(cancel)?;
        incoming.check_source()?;
        context.push(json!({"source":expected.source,"receiverInput":{"id":id,"revision":1},
            "filename":expected.filename,"mediaType":expected.media_type,"bytes":expected.bytes,"sha256":expected.sha256,
            "byteTransferComplete":true,"readerPagesComplete":true,"untrustedSourceData":true,"report":report,"chunks":chunks}));
    }
    Ok(Some(serde_json::to_string(
        &json!({"kind":"original_remote_material_data","operationId":incoming.value().operation,
        "untrustedSourceData":true,"materials":context}),
    )?))
}

/// Check the receiver's own capability before initializing any material store.
fn validate_request(
    policy: &kcoder_config::integrations::remotes::NativeRemoteReceiverPolicy,
    materials: &[super::materials::RemoteMaterialDescriptor],
    cancel: &CancellationToken,
) -> Result<()> {
    ensure!(!cancel.is_cancelled(), "REMOTE_MATERIAL_CANCELLED");
    ensure!(
        policy.accept_materials && materials.len() <= 8,
        "REMOTE_RECEIVER_MATERIAL_CAPABILITY_REQUIRED"
    );
    let total = materials
        .iter()
        .try_fold(0u64, |sum, item| sum.checked_add(item.bytes))
        .context("REMOTE_MATERIAL_TOTAL_LIMIT")?;
    ensure!(
        total <= policy.maximum_material_bytes && total <= super::materials::MAX_MATERIAL_BYTES,
        "REMOTE_MATERIAL_TOTAL_LIMIT"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::integrations::remotes::NativeRemoteReceiverPolicy;

    fn material(bytes: u64) -> super::super::materials::RemoteMaterialDescriptor {
        super::super::materials::RemoteMaterialDescriptor {
            source: OfficeArtifactRef {
                id: "not-authority".into(),
                revision: 1,
            },
            filename: "untrusted.txt".into(),
            media_type: "text/plain".into(),
            bytes,
            sha256: "a".repeat(64),
        }
    }

    #[test]
    fn receiver_requires_own_capability_and_total_bound_before_store_initialization() {
        let cancel = CancellationToken::new();
        let mut policy = NativeRemoteReceiverPolicy::default();
        let input = [material(32), material(33)];
        assert!(
            validate_request(&policy, &input, &cancel)
                .unwrap_err()
                .to_string()
                .contains("CAPABILITY_REQUIRED")
        );
        policy.accept_materials = true;
        policy.maximum_material_bytes = 64;
        assert!(
            validate_request(&policy, &input, &cancel)
                .unwrap_err()
                .to_string()
                .contains("TOTAL_LIMIT")
        );
        policy.maximum_material_bytes = 65;
        validate_request(&policy, &input, &cancel).unwrap();
        let too_many: [_; 9] = std::array::from_fn(|_| material(1));
        assert!(validate_request(&policy, &too_many, &cancel).is_err());
        policy.maximum_material_bytes = u64::MAX;
        assert!(validate_request(&policy, &[material(u64::MAX), material(1)], &cancel).is_err());
        assert!(
            validate_request(
                &policy,
                &[material(super::super::materials::MAX_MATERIAL_BYTES + 1)],
                &cancel
            )
            .is_err()
        );
    }

    #[test]
    fn cancelled_material_preparation_is_rejected_before_native_store_or_reader() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let policy = NativeRemoteReceiverPolicy {
            accept_materials: true,
            maximum_material_bytes: 32,
            ..Default::default()
        };
        assert_eq!(
            validate_request(&policy, &[material(32)], &cancel)
                .unwrap_err()
                .to_string(),
            "REMOTE_MATERIAL_CANCELLED"
        );
    }
}
