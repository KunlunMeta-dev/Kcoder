use super::*;
use std::{collections::BTreeMap, sync::Mutex};
struct Held {
    peer: AuthorizedMigrationPeer,
    entry: TransferAttemptRecord,
    lease: TransferAttemptLease,
}
#[derive(Default)]
pub(in super::super) struct AttemptOwners(Mutex<BTreeMap<String, Held>>);
impl AttemptOwners {
    pub(in super::super) fn clear(&self) {
        self.0.lock().unwrap_or_else(|v| v.into_inner()).clear();
    }
    pub(in super::super) fn activity(&self) -> usize {
        self.0.lock().map(|v| v.len()).unwrap_or(1)
    }
    fn claim(&self, peer: &AuthorizedMigrationPeer, entry: TransferAttemptRecord) -> Result<Value> {
        ensure!(
            !peer.recovery_only() || entry.kind != TransferAttemptKind::Run,
            "source_transfer_recovery_scope"
        );
        let target = target(peer)?;
        let mut owners = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        let lease = target.claim_attempt(peer.request_id(), peer.source_authority(), &entry)?;
        let admitted = lease.is_some();
        if let Some(lease) = lease {
            ensure!(
                owners.len() < 256 && !owners.contains_key(peer.request_id()),
                "source_transfer_attempt_owner_conflict"
            );
            owners.insert(
                peer.request_id().into(),
                Held {
                    peer: peer.clone(),
                    entry: entry.clone(),
                    lease,
                },
            );
        }
        let view = target.read_attempt(
            peer.request_id(),
            peer.source_authority(),
            Some(&entry.attempt_id),
        )?;
        Ok(json!({"admitted":admitted,"view":view}))
    }
    fn release(&self, peer: &AuthorizedMigrationPeer, id: &str) -> Result<Value> {
        ensure!(
            kcoder_app_protocol::canonical_transfer_uuid(id),
            "source_transfer_invalid_attempt"
        );
        let mut owners = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        let Some(held) = owners.get(peer.request_id()) else {
            return Ok(json!({"released":false}));
        };
        ensure!(
            held.entry.attempt_id == id && held.peer.same_authorization(peer),
            "source_transfer_attempt_owner_conflict"
        );
        held.lease.verify()?;
        owners.remove(peer.request_id());
        Ok(json!({"released":true}))
    }
    pub(super) fn require(&self, peer: &AuthorizedMigrationPeer, operation: &str) -> Result<()> {
        if !matches!(
            operation,
            "target/begin" | "target/part/write" | "target/finish" | "target/resume"
        ) {
            return Ok(());
        }
        let target = target(peer)?;
        if !target
            .read_attempt(peer.request_id(), peer.source_authority(), None)?
            .tracked
        {
            return Ok(());
        }
        let owners = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("source_transfer_busy"))?;
        let held = owners
            .get(peer.request_id())
            .context("source_transfer_attempt_owner_required")?;
        ensure!(
            held.peer.same_authorization(peer),
            "source_transfer_attempt_owner_conflict"
        );
        held.lease.verify()?;
        ensure!(
            held.entry.kind == TransferAttemptKind::Run
                || held.entry.kind == TransferAttemptKind::Finish && operation == "target/finish"
                || held.entry.kind == TransferAttemptKind::TargetResume
                    && operation == "target/resume",
            "source_transfer_attempt_kind_mismatch"
        );
        Ok(())
    }
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    peer: &AuthorizedMigrationPeer,
    operation: &str,
    value: Value,
) -> Result<Value> {
    use kcoder_app_protocol::{
        MigrationSourceAttemptClaimV1, MigrationSourceAttemptKindV1 as Kind,
        MigrationSourceAttemptReadV1, MigrationSourceAttemptReleaseV1,
    };
    match operation {
        "target/attempt/read" => {
            let p: MigrationSourceAttemptReadV1 = params(peer, value)?;
            Ok(
                json!({"view":target(peer)?.read_attempt(peer.request_id(), peer.source_authority(), p.attempt_id.as_deref())?}),
            )
        }
        "target/attempt/claim" => {
            let p: MigrationSourceAttemptClaimV1 = params(peer, value)?;
            processor.source_attempt_owners.claim(
                peer,
                TransferAttemptRecord {
                    attempt_id: p.attempt_id,
                    kind: match p.kind {
                        Kind::Run => TransferAttemptKind::Run,
                        Kind::Finish => TransferAttemptKind::Finish,
                        Kind::TargetResume => TransferAttemptKind::TargetResume,
                    },
                    call_digest: p.call_digest,
                    selection_digest: p.selection_digest,
                },
            )
        }
        "target/attempt/release" => {
            let p: MigrationSourceAttemptReleaseV1 = params(peer, value)?;
            processor.source_attempt_owners.release(peer, &p.attempt_id)
        }
        _ => anyhow::bail!("source_transfer_method_unavailable"),
    }
}
