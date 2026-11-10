//! One declared transfer into the original Receiver OfficeStore, never a second inbox.
use super::*;
use crate::app_server::integrations::{
    core::{NativeDomain, NativeDomainGuard},
    office::{OfficeReadHeader, OfficeReadWorker},
};
use kcoder_state::integrations::office::{OfficeInputMetadata, OfficeStore};
use kcoder_types::integrations::office::OfficeArtifactRef;
use serde_json::json;
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Default)]
pub(super) struct Materials(Mutex<State>);
#[derive(Default)]
struct State {
    transfers: BTreeMap<String, Transfer>,
    receipts: BTreeMap<String, (String, Option<NativeRemoteReceiptDataV1>)>,
}
struct Transfer {
    offer: NativeRemoteMaterialOfferV1,
    bytes: Vec<u8>,
    finished: bool,
    finishing: bool,
    context: Option<Value>,
    text_bytes: usize,
}

impl Materials {
    pub(super) fn observe(
        &self,
        binding: &NativeAcpReceiverBinding,
        reference: &NativeRemoteContentRefV1,
    ) -> Result<NativeRemoteReceiptDataV1> {
        binding.verify_owner()?;
        let state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
        let transfer = state
            .transfers
            .get(&reference.source.id)
            .context("REMOTE_MATERIAL_OFFER_REQUIRED")?;
        ensure!(
            transfer.offer.content == *reference,
            "REMOTE_MATERIAL_TRANSFER_CONFLICT"
        );
        Ok(NativeRemoteReceiptDataV1::Material {
            content: reference.clone(),
            next_offset: transfer.bytes.len() as u64,
            complete: transfer.finished,
        })
    }
    pub(super) async fn handle(
        &self,
        binding: &NativeAcpReceiverBinding,
        frame: &NativeRemoteControlFrameV1,
    ) -> Result<NativeRemoteReceiptDataV1> {
        binding.verify()?;
        ensure!(
            !binding
                .execution_claimed
                .load(std::sync::atomic::Ordering::Acquire),
            "REMOTE_MATERIAL_EXECUTION_ALREADY_STARTED"
        );
        let policy = binding.policy()?;
        ensure!(
            policy.accept_materials,
            "REMOTE_RECEIVER_MATERIAL_CAPABILITY_REQUIRED"
        );
        let digest = super::super::launch::digest(frame)?;
        {
            let mut state = self
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
            if let Some((intent, receipt)) = state.receipts.get(&frame.request_id) {
                ensure!(intent == &digest, "REMOTE_MATERIAL_REQUEST_CONFLICT");
                return receipt
                    .clone()
                    .context("REMOTE_MATERIAL_RECONCILE_ORIGINAL_REQUIRED");
            }
            ensure!(
                state.receipts.len() < 4096,
                "REMOTE_MATERIAL_RECEIPT_CAPACITY"
            );
            state
                .receipts
                .insert(frame.request_id.clone(), (digest.clone(), None));
        }
        let (reference, finish) = match &frame.message {
            NativeRemoteControlDataV1::OfferMaterial(offer) => {
                ensure!(
                    binding
                        .input()?
                        .materials
                        .iter()
                        .any(|original| original == offer),
                    "REMOTE_MATERIAL_NOT_DECLARED"
                );
                let metadata = OfficeInputMetadata {
                    filename: offer.filename.clone(),
                    media_type: offer.media_type.clone(),
                    expected_bytes: offer.content.bytes,
                    expected_sha256: offer.content.sha256.clone(),
                };
                metadata.validate()?;
                let total = binding
                    .input()?
                    .materials
                    .iter()
                    .try_fold(0u64, |sum, item| {
                        sum.checked_add(item.content.bytes)
                            .context("REMOTE_MATERIAL_LIMIT")
                    })?;
                ensure!(
                    total <= policy.maximum_material_bytes,
                    "REMOTE_RECEIVER_MATERIAL_LIMIT"
                );
                let mut state = self
                    .0
                    .lock()
                    .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
                if let Some(existing) = state.transfers.get(&offer.content.source.id) {
                    ensure!(
                        existing.offer == *offer,
                        "REMOTE_MATERIAL_TRANSFER_CONFLICT"
                    );
                } else {
                    state.transfers.insert(
                        offer.content.source.id.clone(),
                        Transfer {
                            offer: offer.clone(),
                            bytes: Vec::new(),
                            finished: false,
                            finishing: false,
                            context: None,
                            text_bytes: 0,
                        },
                    );
                }
                (offer.content.clone(), false)
            }
            NativeRemoteControlDataV1::MaterialChunk(chunk) => {
                use base64::{Engine as _, engine::general_purpose::STANDARD};
                let bytes = STANDARD.decode(&chunk.bytes_base64)?;
                ensure!(
                    bytes.len() <= NATIVE_REMOTE_MAX_CHUNK_BYTES as usize
                        && format!("{:x}", Sha256::digest(&bytes)) == chunk.chunk_sha256,
                    "REMOTE_MATERIAL_CHUNK_INVALID"
                );
                let mut state = self
                    .0
                    .lock()
                    .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
                let transfer = state
                    .transfers
                    .get_mut(&chunk.content.source.id)
                    .context("REMOTE_MATERIAL_OFFER_REQUIRED")?;
                ensure!(
                    transfer.offer.content == chunk.content
                        && !transfer.finished
                        && !transfer.finishing
                        && chunk.offset == transfer.bytes.len() as u64
                        && (transfer.bytes.len() as u64)
                            .checked_add(bytes.len() as u64)
                            .is_some_and(|total| total <= chunk.content.bytes),
                    "REMOTE_MATERIAL_OFFSET_CONFLICT"
                );
                transfer.bytes.extend(bytes);
                (chunk.content.clone(), false)
            }
            NativeRemoteControlDataV1::FinishMaterial(content) => (content.clone(), true),
            _ => anyhow::bail!("REMOTE_MATERIAL_METHOD_UNAVAILABLE"),
        };
        if finish {
            self.finish(binding, &reference).await?;
        }
        binding.verify()?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
        let transfer = state
            .transfers
            .get(&reference.source.id)
            .context("REMOTE_MATERIAL_OFFER_REQUIRED")?;
        ensure!(
            transfer.offer.content == reference,
            "REMOTE_MATERIAL_TRANSFER_CONFLICT"
        );
        let reply = NativeRemoteReceiptDataV1::Material {
            content: reference,
            next_offset: transfer.bytes.len() as u64,
            complete: transfer.finished,
        };
        state
            .receipts
            .insert(frame.request_id.clone(), (digest, Some(reply.clone())));
        Ok(reply)
    }

    async fn finish(
        &self,
        binding: &NativeAcpReceiverBinding,
        reference: &NativeRemoteContentRefV1,
    ) -> Result<()> {
        let (offer, bytes) = {
            let mut state = self
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
            let transfer = state
                .transfers
                .get_mut(&reference.source.id)
                .context("REMOTE_MATERIAL_OFFER_REQUIRED")?;
            ensure!(
                !transfer.finishing && !transfer.finished,
                "REMOTE_MATERIAL_RECONCILE_ORIGINAL_REQUIRED"
            );
            ensure!(
                transfer.offer.content == *reference
                    && transfer.bytes.len() as u64 == reference.bytes
                    && format!("{:x}", Sha256::digest(&transfer.bytes)) == reference.sha256,
                "REMOTE_MATERIAL_INCOMPLETE"
            );
            transfer.finishing = true;
            (transfer.offer.clone(), transfer.bytes.clone())
        };
        let native = &binding.receiver;
        let (guard, store) = match NativeDomainGuard::observe(
            native.profile()?,
            native.scope(),
            NativeDomain::Office,
        )? {
            Some(guard) => {
                let store = OfficeStore::open_in(
                    &guard.directory(native.profile()?)?,
                    OsStr::new("data"),
                    IntegrationOwner::from(native.scope()),
                )?
                .context("REMOTE_MATERIAL_STORE_REQUIRED")?;
                (guard, store)
            }
            None => NativeDomainGuard::initialize(
                native.profile()?,
                native.scope(),
                NativeDomain::Office,
                &binding.original.operation_id,
                |directory| {
                    OfficeStore::create_in(
                        directory,
                        OsStr::new("data"),
                        IntegrationOwner::from(native.scope()),
                    )
                },
            )?,
        };
        let suffix =
            super::super::launch::digest(&(&binding.original.operation_id, &reference.source))?;
        let id = format!("remote-material-{suffix}");
        let operation = format!("receive-material-{suffix}");
        store.begin_input_attempt(
            &operation,
            &id,
            OfficeInputMetadata {
                filename: offer.filename.clone(),
                media_type: offer.media_type.clone(),
                expected_bytes: reference.bytes,
                expected_sha256: reference.sha256.clone(),
            },
        )?;
        store.complete_stored_input(&operation, &id, &mut std::io::Cursor::new(&bytes), || {
            binding.verify().is_ok()
        })?;
        guard.directory(native.profile()?)?;
        let worker = OfficeReadWorker::from_trusted_program(&std::env::current_exe()?)?;
        let mut cursor = None;
        let mut chunks = Vec::new();
        let mut complete = false;
        let mut total = 0usize;
        for _ in 0..1024 {
            binding.verify()?;
            let page = worker
                .read(
                    OfficeReadHeader {
                        schema_version: 1,
                        operation: None,
                        reference: OfficeArtifactRef {
                            id: id.clone(),
                            revision: 1,
                        },
                        filename: offer.filename.clone(),
                        byte_length: reference.bytes,
                        sha256: reference.sha256.clone(),
                        scope_sha256: super::super::launch::digest(native.scope())?,
                        cursor,
                        limit: 4,
                    },
                    bytes.clone(),
                    binding
                        .deadline
                        .saturating_duration_since(Instant::now())
                        .as_millis()
                        .min(60000) as u64,
                    &binding.connection_closed,
                )
                .await?;
            ensure!(
                page["sha256"] == reference.sha256
                    && page["reference"]["id"] == id
                    && page["untrustedSourceData"] == true,
                "REMOTE_MATERIAL_READER_CHANGED"
            );
            for row in page["chunks"]
                .as_array()
                .context("REMOTE_MATERIAL_READER_SHAPE")?
            {
                total = total
                    .checked_add(
                        row["text"]
                            .as_str()
                            .context("REMOTE_MATERIAL_READER_SHAPE")?
                            .len(),
                    )
                    .context("REMOTE_MATERIAL_CONTEXT_LIMIT")?;
                ensure!(total <= 2 * 1024 * 1024, "REMOTE_MATERIAL_CONTEXT_LIMIT");
                chunks.push(row.clone());
            }
            if page["complete"] == true {
                ensure!(
                    page["nextCursor"].is_null() && page["omittedChunks"] == 0,
                    "REMOTE_MATERIAL_READER_INCOMPLETE"
                );
                complete = true;
                break;
            }
            cursor = Some(
                page["nextCursor"]
                    .as_str()
                    .context("REMOTE_MATERIAL_READER_INCOMPLETE")?
                    .to_owned(),
            );
        }
        ensure!(complete, "REMOTE_MATERIAL_READER_INCOMPLETE");
        binding.verify()?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
        let transfer = state
            .transfers
            .get_mut(&reference.source.id)
            .context("REMOTE_MATERIAL_OFFER_REQUIRED")?;
        transfer.finished = true;
        transfer.finishing = false;
        transfer.text_bytes = total;
        transfer.context = Some(
            json!({"source":reference.source,"receiverInput":{"id":id,"revision":1},"filename":offer.filename,
            "bytes":reference.bytes,"sha256":reference.sha256,"byteTransferComplete":true,"readerPagesComplete":true,"untrustedSourceData":true,"chunks":chunks}),
        );
        Ok(())
    }

    pub(super) fn contexts(&self, declared: &[NativeRemoteMaterialOfferV1]) -> Result<Vec<Value>> {
        let state = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_UNAVAILABLE"))?;
        let combined = state.transfers.values().try_fold(0usize, |sum, transfer| {
            sum.checked_add(transfer.text_bytes)
                .context("REMOTE_MATERIAL_CONTEXT_LIMIT")
        })?;
        ensure!(combined <= 2 * 1024 * 1024, "REMOTE_MATERIAL_CONTEXT_LIMIT");
        declared
            .iter()
            .map(|offer| {
                let transfer = state
                    .transfers
                    .get(&offer.content.source.id)
                    .context("REMOTE_MATERIAL_INCOMPLETE")?;
                ensure!(
                    transfer.finished && transfer.offer == *offer,
                    "REMOTE_MATERIAL_INCOMPLETE"
                );
                transfer
                    .context
                    .clone()
                    .context("REMOTE_MATERIAL_READER_INCOMPLETE")
            })
            .collect()
    }
}
