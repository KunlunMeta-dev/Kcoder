//! Source-owned immutable Office inputs, ordered writes and original receipts.
use super::authority_ssh::AcceptedSshRemoteAuthority;
use super::*;
use base64::Engine;
use kcoder_acp::outbound::OutboundAcp;
use kcoder_engine::QueryEngine;
use kcoder_tools::ToolContext;
use kcoder_types::{
    TurnAttemptIdentity,
    integrations::{core::*, office::OfficeArtifactRef},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Mutex};
use tokio_util::sync::CancellationToken;
struct TransferGuard {
    journal: Arc<NativeRemoteJournal>,
    finished: bool,
}
impl Drop for TransferGuard {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.journal.unknown_owned_native_material();
        }
    }
}

pub fn send_all<'a>(
    authority: &'a Arc<AcceptedSshRemoteAuthority>,
    journal: &'a Arc<NativeRemoteJournal>,
    peer: &'a mut OutboundAcp,
    cancel: &'a CancellationToken,
) -> futures::future::BoxFuture<'a, Result<()>> {
    Box::pin(send_all_producer(authority, journal, peer, cancel))
}
async fn send_all_producer(
    authority: &Arc<AcceptedSshRemoteAuthority>,
    journal: &Arc<NativeRemoteJournal>,
    peer: &mut OutboundAcp,
    cancel: &CancellationToken,
) -> Result<()> {
    let offers = authority.materials().offers();
    if offers.is_empty() {
        return Ok(());
    }
    let mut guard = TransferGuard {
        journal: journal.clone(),
        finished: false,
    };
    for (index, offer) in offers.into_iter().enumerate() {
        let content = offer.content.clone();
        let mut offset = 0u64;
        let offer_id = format!(
            "material-{}",
            super::launch::digest(&(authority.operation(), &content, "offer"))?
        );
        let request =
            authority.read_request(&offer_id, NativeRemoteControlDataV1::OfferMaterial(offer))?;
        let reply = peer.write_owned_native_material(&request, cancel).await?;
        authority
            .materials()
            .record_reply(&request, &authority.read_reply(&request, reply)?)?;
        while offset < content.bytes {
            let chunk = authority.materials().chunk(index, offset)?;
            let length = base64::engine::general_purpose::STANDARD
                .decode(&chunk.bytes_base64)?
                .len() as u64;
            let id = format!(
                "material-{}",
                super::launch::digest(&(authority.operation(), &content, "chunk", offset))?
            );
            let request =
                authority.read_request(&id, NativeRemoteControlDataV1::MaterialChunk(chunk))?;
            let reply = peer.write_owned_native_material(&request, cancel).await?;
            authority
                .materials()
                .record_reply(&request, &authority.read_reply(&request, reply)?)?;
            offset += length;
        }
        let id = format!(
            "material-{}",
            super::launch::digest(&(authority.operation(), &content, "finish"))?
        );
        let request =
            authority.read_request(&id, NativeRemoteControlDataV1::FinishMaterial(content))?;
        let reply = peer.write_owned_native_material(&request, cancel).await?;
        authority
            .materials()
            .record_reply(&request, &authority.read_reply(&request, reply)?)?;
    }
    journal.finish_owned_material_transfer()?;
    guard.finished = true;
    Ok(())
}

pub struct FrozenSshMaterials {
    frozen: Vec<super::materials::FrozenRemoteMaterial>,
    progress: Mutex<Progress>,
}
#[derive(Default)]
struct Progress {
    files: Vec<FileProgress>,
    attempted: BTreeSet<String>,
}
#[derive(Default)]
struct FileProgress {
    pending: Option<(String, String)>,
    offered: bool,
    offset: u64,
    finished: bool,
}
impl FrozenSshMaterials {
    pub fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        attempt: &TurnAttemptIdentity,
        actual: &ToolContext,
        references: &[OfficeArtifactRef],
    ) -> Result<Self> {
        ensure!(references.len() <= 8, "REMOTE_MATERIAL_COUNT_LIMIT");
        ensure!(
            references
                .iter()
                .map(|reference| reference.id.as_str())
                .collect::<BTreeSet<_>>()
                .len()
                == references.len(),
            "REMOTE_MATERIAL_DUPLICATE"
        );
        let mut frozen = Vec::new();
        let mut total = 0u64;
        for reference in references {
            let material = super::materials::capture(native, engine, attempt, actual, reference)?;
            total = total
                .checked_add(material.descriptor().bytes)
                .context("REMOTE_MATERIAL_TOTAL_LIMIT")?;
            ensure!(
                total <= super::materials::MAX_MATERIAL_BYTES,
                "REMOTE_MATERIAL_TOTAL_LIMIT"
            );
            frozen.push(material);
        }
        let files = (0..frozen.len()).map(|_| FileProgress::default()).collect();
        Ok(Self {
            frozen,
            progress: Mutex::new(Progress {
                files,
                attempted: BTreeSet::new(),
            }),
        })
    }
    pub fn offers(&self) -> Vec<NativeRemoteMaterialOfferV1> {
        self.frozen
            .iter()
            .map(|material| {
                let source = material.descriptor();
                NativeRemoteMaterialOfferV1 {
                    content: NativeRemoteContentRefV1 {
                        source: source.source.clone(),
                        bytes: source.bytes,
                        sha256: source.sha256.clone(),
                    },
                    filename: source.filename.clone(),
                    media_type: source.media_type.clone(),
                }
            })
            .collect()
    }
    pub fn all_finished(&self) -> Result<bool> {
        Ok(self
            .progress
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_BUSY"))?
            .files
            .iter()
            .all(|file| file.finished))
    }
    pub fn chunk(&self, index: usize, offset: u64) -> Result<NativeRemoteMaterialChunkV1> {
        let material = self
            .frozen
            .get(index)
            .context("REMOTE_MATERIAL_ORIGINAL_REQUIRED")?;
        let start: usize = offset.try_into()?;
        let end = material
            .bytes()
            .len()
            .min(start.saturating_add(NATIVE_REMOTE_MAX_CHUNK_BYTES as usize));
        ensure!(start < end, "REMOTE_MATERIAL_OFFSET_CHANGED");
        let bytes = &material.bytes()[start..end];
        Ok(NativeRemoteMaterialChunkV1 {
            content: self.offers()[index].content.clone(),
            offset,
            chunk_sha256: format!("{:x}", Sha256::digest(bytes)),
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }
    pub fn verify_write(
        &self,
        request: &NativeRemoteControlFrameV1,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let content = match &request.message {
            NativeRemoteControlDataV1::OfferMaterial(value) => &value.content,
            NativeRemoteControlDataV1::MaterialChunk(value) => &value.content,
            NativeRemoteControlDataV1::FinishMaterial(value) => value,
            _ => anyhow::bail!("REMOTE_MATERIAL_WRITE_ONLY_REQUIRED"),
        };
        let offers = self.offers();
        let index = offers
            .iter()
            .position(|offer| &offer.content == content)
            .context("REMOTE_MATERIAL_ORIGINAL_REQUIRED")?;
        self.frozen[index].verify(cancel)?;
        let mut progress = self
            .progress
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_BUSY"))?;
        ensure!(
            !progress.attempted.contains(&request.request_id) && progress.attempted.len() < 512,
            "REMOTE_MATERIAL_RECONCILE_ORIGINAL"
        );
        let file = &progress.files[index];
        ensure!(file.pending.is_none(), "REMOTE_MATERIAL_RECONCILE_ORIGINAL");
        match &request.message {
            NativeRemoteControlDataV1::OfferMaterial(offer) => ensure!(
                !file.offered && *offer == offers[index],
                "REMOTE_MATERIAL_OFFER_CHANGED"
            ),
            NativeRemoteControlDataV1::MaterialChunk(chunk) => ensure!(
                file.offered
                    && !file.finished
                    && chunk.offset == file.offset
                    && *chunk == self.chunk(index, file.offset)?,
                "REMOTE_MATERIAL_CHUNK_CHANGED"
            ),
            NativeRemoteControlDataV1::FinishMaterial(_) => ensure!(
                file.offered && !file.finished && file.offset == content.bytes,
                "REMOTE_MATERIAL_INCOMPLETE"
            ),
            _ => unreachable!(),
        }
        progress.attempted.insert(request.request_id.clone());
        progress.files[index].pending =
            Some((request.request_id.clone(), super::launch::digest(request)?));
        Ok(())
    }
    pub fn record_reply(
        &self,
        request: &NativeRemoteControlFrameV1,
        reply: &NativeRemoteReceiptDataV1,
    ) -> Result<()> {
        let NativeRemoteReceiptDataV1::Material {
            content,
            next_offset,
            complete,
        } = reply
        else {
            anyhow::bail!("REMOTE_MATERIAL_ORIGINAL_RECEIPT_REQUIRED")
        };
        let offers = self.offers();
        let index = offers
            .iter()
            .position(|offer| &offer.content == content)
            .context("REMOTE_MATERIAL_ORIGINAL_REQUIRED")?;
        let mut progress = self
            .progress
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_MATERIAL_OWNER_BUSY"))?;
        ensure!(
            progress.attempted.contains(&request.request_id),
            "REMOTE_MATERIAL_ORIGINAL_REQUEST_REQUIRED"
        );
        let file = &mut progress.files[index];
        ensure!(
            file.pending.as_ref()
                == Some(&(request.request_id.clone(), super::launch::digest(request)?)),
            "REMOTE_MATERIAL_ORIGINAL_REQUEST_REQUIRED"
        );
        match &request.message {
            NativeRemoteControlDataV1::OfferMaterial(expected) => {
                ensure!(
                    &expected.content == content && *next_offset == 0 && !*complete,
                    "REMOTE_MATERIAL_RECEIPT_CHANGED"
                );
                file.offered = true;
            }
            NativeRemoteControlDataV1::MaterialChunk(expected) => {
                let length = base64::engine::general_purpose::STANDARD
                    .decode(&expected.bytes_base64)?
                    .len() as u64;
                ensure!(
                    &expected.content == content
                        && expected.offset == file.offset
                        && *next_offset == expected.offset + length
                        && !*complete,
                    "REMOTE_MATERIAL_RECEIPT_CHANGED"
                );
                file.offset = *next_offset;
            }
            NativeRemoteControlDataV1::FinishMaterial(expected) => {
                ensure!(
                    expected == content
                        && *next_offset == content.bytes
                        && *complete
                        && file.offset == content.bytes,
                    "REMOTE_MATERIAL_RECEIPT_CHANGED"
                );
                file.finished = true;
            }
            _ => anyhow::bail!("REMOTE_MATERIAL_WRITE_ONLY_REQUIRED"),
        }
        file.pending = None;
        Ok(())
    }
}
