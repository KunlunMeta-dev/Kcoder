//! Staged retention service behind four trusted-parent receipt handlers.
//! Producer/transfer/deletion lifecycle and public capability remain incomplete;
//! legacy attachment ownership is separate.
#![allow(dead_code)]
pub(super) mod model;
mod owner_init;
mod owner_retirement;
mod release;
mod retirement;
mod storage;
#[cfg(all(test, target_os = "linux"))]
mod tests;
mod upload;

#[cfg(all(test, target_os = "linux"))]
pub(super) fn pause_release_projection_test_hook(phase: &str, retention_id: &str) {
    tests::release_consume_race_review::pause_before_final_projection(phase, retention_id);
}

use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::*;
use kcoder_config::{
    PrivateDirectory, PrivateLeaseMode, PrivateRemovalEntry, VerifiedPrivateEntry,
};
use model::*;
use std::{collections::BTreeSet, ffi::OsStr, io::Read, path::Path};
use storage::{Store, Transaction, digest, missing};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RetentionFailure {
    Conflict,
    Capacity,
    ReservePrepaidSlotUnavailable,
    ProofUnavailable,
    CompletionUnknown,
}
impl std::fmt::Display for RetentionFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(match self {
            Self::Conflict => "Retention identity or revision conflict",
            Self::ReservePrepaidSlotUnavailable => {
                "Referenced attachment prepaid cleanup slot unavailable"
            }
            Self::Capacity => "Retention capacity reached; unresolved records remain charged",
            Self::ProofUnavailable => "Retention terminal proof unavailable",
            Self::CompletionUnknown => "Retention completion unknown; preserve the original ID",
        })
    }
}
impl std::error::Error for RetentionFailure {}

pub(super) struct RetentionService {
    store: Store,
}
/// Keeps the original or recovered exclusive OS lease pinned. Drop releases the
/// lock only; sealed/unknown data and budgets never disappear on connection exit.
pub(super) struct OwnerLease {
    id: String,
    scope_hash: String,
    lease: VerifiedPrivateEntry,
    operation: std::sync::Mutex<()>,
}
/// Private adapter for authoritative turn facts. The future dispatch layer must
/// obtain this from the existing durable turn receipt domain, never RPC fields.
pub(super) trait AcceptedTurnProof {
    fn is_exactly_accepted(&self, scope: &Scope, binding: &TransferBinding) -> Result<bool>;
}
pub(super) struct NoAcceptedTurnProof;
impl AcceptedTurnProof for NoAcceptedTurnProof {
    fn is_exactly_accepted(&self, _: &Scope, _: &TransferBinding) -> Result<bool> {
        Ok(false)
    }
}
fn atom(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(|c| c.is_control()),
        "invalid retention identity atom"
    );
    Ok(())
}
fn sha(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid retention digest"
    );
    Ok(())
}
fn new_id() -> String {
    Uuid::new_v4().simple().to_string()
}
fn scope_key(context: &TrustedRetentionContextV1, workspace_identity: &str) -> Result<Scope> {
    atom(&context.gateway_namespace_id)?;
    atom(&context.device_id)?;
    atom(&context.authorization_generation)?;
    atom(&context.target_fingerprint)?;
    if let RetentionPrincipalV1::VerifiedAccount { principal_id } = &context.principal {
        atom(principal_id)?;
    }
    sha(workspace_identity)?;
    let hash = digest(&serde_json::to_vec(&(context, workspace_identity))?);
    Ok(Scope {
        context: context.clone(),
        workspace_identity: workspace_identity.into(),
        hash,
        version: 1,
        workspace_account: None,
        workspace_target_id: None,
    })
}
fn full_scope_key(
    context: &TrustedRetentionContextV1,
    workspace_identity: &str,
    account: Option<&WorkspaceParentAccountV2>,
    target: &str,
) -> Result<Scope> {
    scope_key(context, workspace_identity)?;
    atom(target)?;
    match (&context.principal, account) {
        (RetentionPrincipalV1::LocalOs, None) => (),
        (RetentionPrincipalV1::VerifiedAccount { .. }, Some(account)) => {
            atom(&account.role)?;
            let generation = account.authorization_generation.parse::<u64>()?;
            ensure!(
                generation.to_string() == account.authorization_generation,
                "invalid account generation"
            );
        }
        _ => anyhow::bail!(RetentionFailure::Conflict),
    }
    let hash = digest(&serde_json::to_vec(&(
        "kcoder.retention.scope.v2",
        context,
        workspace_identity,
        account,
        target,
    ))?);
    Ok(Scope {
        context: context.clone(),
        workspace_identity: workspace_identity.into(),
        hash,
        version: 2,
        workspace_account: account.cloned(),
        workspace_target_id: Some(target.into()),
    })
}
fn canonical_scope(scope: &Scope) -> Result<Scope> {
    match scope.version {
        1 => {
            ensure!(
                scope.workspace_account.is_none() && scope.workspace_target_id.is_none(),
                RetentionFailure::Conflict
            );
            scope_key(&scope.context, &scope.workspace_identity)
        }
        2 => full_scope_key(
            &scope.context,
            &scope.workspace_identity,
            scope.workspace_account.as_ref(),
            scope
                .workspace_target_id
                .as_deref()
                .context("retention target missing")?,
        ),
        _ => anyhow::bail!(RetentionFailure::Conflict),
    }
}
fn checked_id(id: &str, namespace: &str) -> Result<u64> {
    let pieces: Vec<_> = id.split('.').collect();
    ensure!(
        pieces.len() == 4
            && pieces[0] == "r1"
            && pieces[1] == namespace
            && pieces[3].len() == 32
            && pieces[3].bytes().all(|b| b.is_ascii_hexdigit()),
        RetentionFailure::Conflict
    );
    let epoch = pieces[2].parse::<u64>()?;
    ensure!(
        epoch > 0 && epoch.to_string() == pieces[2],
        RetentionFailure::Conflict
    );
    Ok(epoch)
}
fn wire_id(namespace: &str, epoch: u64) -> String {
    format!("r1.{namespace}.{epoch}.{}", new_id())
}
fn upload_key(scope: &Scope, id: &str) -> String {
    format!("{}:{id}", scope.hash)
}
fn intent_key(scope: &Scope, id: &str) -> String {
    format!("{}:{id}", scope.hash)
}
fn stage(namespace: &str, entry: &Entry) -> RetentionStageRefV1 {
    RetentionStageRefV1 {
        root_namespace: namespace.into(),
        epoch: entry.epoch,
        owner_id: entry.owner_id.clone(),
        entry_id: entry.id.clone(),
        revision: entry.revision,
        path: None,
    }
}
fn retired(
    tx: &Transaction<'_>,
    namespace: &str,
    epoch: u64,
) -> Result<Option<RetentionEpochRetiredV1>> {
    ensure!(epoch <= tx.state.current_epoch, RetentionFailure::Conflict);
    Ok(
        (epoch <= tx.state.retired_through).then(|| RetentionEpochRetiredV1 {
            root_namespace: namespace.into(),
            epoch,
            retired_through: tx.state.retired_through,
        }),
    )
}
fn decrement(value: &mut u64, amount: u64) -> Result<()> {
    *value = value
        .checked_sub(amount)
        .context("retention budget invariant underflow")?;
    Ok(())
}

impl RetentionService {
    /// Fixed startup account root only; never constructed from RPC parameters.
    pub(super) fn open_account_root(account: &Path, durable: bool) -> Result<Self> {
        Self::open(account, durable, Limits::default())
    }
    pub(super) fn validate_adapter_scope(
        &self,
        context: &TrustedRetentionContextV1,
        workspace: &str,
    ) -> Result<()> {
        self.scope(context, workspace).map(|_| ())
    }

    fn open(account_config: &Path, durable_engine_storage: bool, limits: Limits) -> Result<Self> {
        Ok(Self {
            store: Store::open(account_config, durable_engine_storage, limits)?,
        })
    }
    fn scope(
        &self,
        context: &TrustedRetentionContextV1,
        canonical_workspace_digest: &str,
    ) -> Result<Scope> {
        scope_key(context, canonical_workspace_digest)
    }
    pub(super) fn full_scope(
        &self,
        context: &TrustedRetentionContextV1,
        workspace: &str,
        account: Option<&WorkspaceParentAccountV2>,
        target: &str,
    ) -> Result<Scope> {
        full_scope_key(context, workspace, account, target)
    }
    pub fn namespace(&self) -> &str {
        &self.store.header.namespace
    }
    fn owner(&self, tx: &Transaction<'_>, scope: &Scope, id: &str) -> Result<Owner> {
        let owner: Owner = tx
            .read(Area::Owners, id)?
            .context("retention owner missing")?;
        ensure!(
            owner.id == id && owner.scope == *scope,
            RetentionFailure::Conflict
        );
        Ok(owner)
    }
    fn leased_owner(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        lease: &OwnerLease,
    ) -> Result<Owner> {
        ensure!(lease.scope_hash == scope.hash, RetentionFailure::Conflict);
        let owner = self.owner(tx, scope, &lease.id)?;
        ensure!(
            owner.phase == OwnerPhase::Active
                && owner.lease_identity.as_ref() == Some(lease.lease.identity()),
            "retention owner is not active"
        );
        if owner.layout_version == 2 {
            self.verified_owner_manifest(&owner, &owner_init::manifest_name(&owner.id))?;
            return Ok(owner);
        }
        ensure!(owner.layout_version == 1, "unsupported owner layout");
        let directory = self.store.leases()?.open_verified_child(
            OsStr::new(&owner.id),
            owner
                .lease_directory_identity
                .as_ref()
                .context("lease parent identity missing")?,
        )?;
        directory.open_verified_regular(OsStr::new("lock"), lease.lease.identity())?;
        Ok(owner)
    }
    fn owner_data(&self, owner: &Owner) -> Result<PrivateDirectory> {
        if owner.layout_version == 2 {
            self.verified_owner_manifest(owner, &owner_init::manifest_name(&owner.id))?;
            return self.store.data();
        }
        ensure!(owner.layout_version == 1, "unsupported owner layout");
        let directory = self.store.data()?.open_verified_child(
            OsStr::new(&owner.id),
            owner
                .data_identity
                .as_ref()
                .context("retention data identity missing")?,
        )?;
        let marker = directory.open_verified_regular(
            OsStr::new("marker"),
            owner
                .marker_identity
                .as_ref()
                .context("retention marker identity missing")?,
        )?;
        let mut actual = Vec::new();
        marker.file().take(1025).read_to_end(&mut actual)?;
        ensure!(
            actual == format!("{}:{}:{}", self.namespace(), owner.id, owner.scope.hash).as_bytes(),
            "retention owner marker mismatch"
        );
        Ok(directory)
    }
    fn create_owner(&self, scope: &Scope) -> Result<OwnerLease> {
        let mut tx = self.store.transaction()?;
        let epoch = tx.state.allocate(&self.store.header.limits)?;
        tx.state.charges.owners += 1;
        let mut owner = Owner {
            id: new_id(),
            epoch,
            scope: scope.clone(),
            phase: OwnerPhase::Allocating,
            data_identity: None,
            marker_identity: None,
            lease_directory_identity: None,
            lease_identity: None,
            entries: Vec::new(),
            bytes: 0,
            retirement: None,
            layout_version: 1,
            request: None,
            manifest: None,
            manifest_retirement: None,
            cleanup_capacity: RECORD_BYTES,
        };
        tx.put(Area::Owners, &owner.id, epoch, &owner)?;
        tx.commit()?; // Capacity and exact private locators precede creation.
        #[cfg(all(test, target_os = "linux"))]
        tests::pause_owner_init_test_hook("reservation", &owner.id);
        let mut tx = self.store.transaction()?;
        let current: Owner = tx
            .read(Area::Owners, &owner.id)?
            .context("owner initialization reservation missing")?;
        ensure!(
            current.phase == OwnerPhase::Allocating
                && current.scope == *scope
                && current.entries.is_empty()
                && current.data_identity.is_none()
                && current.lease_identity.is_none(),
            "owner initialization cancelled or unknown; no replay"
        );
        // Bounded initialization, no upload bytes/network under this lock.
        let leases = self
            .store
            .leases()?
            .open_child(OsStr::new(&owner.id), true)?;
        #[cfg(all(test, target_os = "linux"))]
        tests::pause_owner_init_test_hook("lease-directory", &owner.id);
        let created_lock = leases.open_read_write_file(OsStr::new("lock"), true)?;
        drop(created_lock);
        #[cfg(all(test, target_os = "linux"))]
        tests::pause_owner_init_test_hook("lock-leaf", &owner.id);
        let lock_identity = leases.retention_regular_identity(OsStr::new("lock"))?;
        let lease = leases
            .try_existing_verified_lock(
                OsStr::new("lock"),
                &lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("new retention owner unexpectedly busy")?;
        #[cfg(all(test, target_os = "linux"))]
        tests::pause_owner_init_test_hook("lease-acquired", &owner.id);
        owner.lease_directory_identity = Some(leases.retention_identity()?);
        owner.lease_identity = Some(leases.retention_regular_identity(OsStr::new("lock"))?);
        let data = self.store.data()?.open_child(OsStr::new(&owner.id), true)?;
        #[cfg(all(test, target_os = "linux"))]
        tests::pause_owner_init_test_hook("data-directory", &owner.id);
        data.atomic_replace(
            OsStr::new("marker"),
            format!("{}:{}:{}", self.namespace(), owner.id, scope.hash).as_bytes(),
        )?;
        #[cfg(all(test, target_os = "linux"))]
        tests::pause_owner_init_test_hook("marker", &owner.id);
        owner.data_identity = Some(data.retention_identity()?);
        owner.marker_identity = Some(data.retention_regular_identity(OsStr::new("marker"))?);
        owner.phase = OwnerPhase::Active;
        tx.put(Area::Owners, &owner.id, epoch, &owner)?;
        tx.commit()?;
        #[cfg(all(test, target_os = "linux"))]
        tests::pause_owner_init_test_hook("active-commit", &owner.id);
        Ok(OwnerLease {
            id: owner.id,
            scope_hash: scope.hash.clone(),
            lease,
            operation: std::sync::Mutex::new(()),
        })
    }
    fn recover_owner(&self, scope: &Scope, id: &str) -> Result<Option<OwnerLease>> {
        let owner = {
            let tx = self.store.transaction()?;
            self.owner(&tx, scope, id)?
        };
        if owner.layout_version == 2 {
            return self.recover_manifest_owner(scope, id);
        }
        ensure!(
            owner.phase == OwnerPhase::Active,
            "retention owner requires initialization reconciliation"
        );
        self.owner_data(&owner)?;
        let leases = self.store.leases()?.open_verified_child(
            OsStr::new(id),
            owner
                .lease_directory_identity
                .as_ref()
                .context("lease directory missing")?,
        )?;
        let lease = leases.try_existing_verified_lock(
            OsStr::new("lock"),
            owner
                .lease_identity
                .as_ref()
                .context("original owner lease missing")?,
            PrivateLeaseMode::Exclusive,
        )?;
        Ok(lease.map(|lease| OwnerLease {
            id: id.into(),
            scope_hash: scope.hash.clone(),
            lease,
            operation: std::sync::Mutex::new(()),
        }))
    }
    fn allocate_upload(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        client_upload_id: &str,
        size: u64,
        content_sha256: &str,
    ) -> Result<Entry> {
        let _operation = lease
            .operation
            .lock()
            .map_err(|_| anyhow::anyhow!("retention owner operation lock poisoned"))?;
        atom(client_upload_id)?;
        sha(content_sha256)?;
        ensure!(
            size <= self.store.header.limits.entry_bytes,
            "attachment exceeds entry byte budget"
        );
        let params_hash = digest(&serde_json::to_vec(&(size, content_sha256))?);
        let key = upload_key(scope, client_upload_id);
        let mut tx = self.store.transaction()?;
        if let Some(previous) = tx.read::<UploadIndex>(Area::Uploads, &key)? {
            ensure!(
                previous.scope_hash == scope.hash && previous.params_hash == params_hash,
                "upload identity reused with different parameters"
            );
            let entry: Entry = tx
                .read(Area::Entries, &previous.entry_id)?
                .context("upload index without authority")?;
            ensure!(
                entry.owner_id == lease.id && entry.scope_hash == scope.hash,
                "upload owner mismatch"
            );
            return Ok(entry);
        }
        let mut owner = self.leased_owner(&tx, scope, lease)?;
        ensure!(
            owner.entries.len() < self.store.header.limits.entries_per_owner,
            RetentionFailure::Capacity
        );
        let pending = owner
            .entries
            .iter()
            .map(|id| tx.read::<Entry>(Area::Entries, id))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|e| {
                e.as_ref()
                    .is_none_or(|e| matches!(e.phase, EntryPhase::Allocating | EntryPhase::Sealing))
            })
            .count();
        ensure!(
            pending < self.store.header.limits.pending_uploads_per_owner,
            RetentionFailure::Capacity
        );
        ensure!(
            owner
                .bytes
                .checked_add(size)
                .is_some_and(|value| value <= self.store.header.limits.owner_bytes),
            RetentionFailure::Capacity
        );
        let epoch = tx.state.allocate(&self.store.header.limits)?;
        let entry_id = if owner.layout_version == 2 {
            digest(&serde_json::to_vec(&(
                "owner-entry-v2",
                &owner.id,
                new_id(),
            ))?)
        } else {
            new_id()
        };
        let quarantine = if owner.layout_version == 2 {
            format!("q-entry-{entry_id}")
        } else {
            format!("q-{}", new_id())
        };
        let entry = Entry {
            id: entry_id,
            owner_id: owner.id.clone(),
            epoch,
            scope_hash: scope.hash.clone(),
            client_upload_id: client_upload_id.into(),
            upload: None,
            params_hash: params_hash.clone(),
            size,
            content_sha256: content_sha256.into(),
            phase: EntryPhase::Allocating,
            revision: 1,
            directory_identity: None,
            payload_identity: None,
            retention_id: None,
            quarantine,
            transfer: None,
            cleanup_capacity: RECORD_BYTES,
        };
        owner.entries.push(entry.id.clone());
        owner.bytes += size;
        tx.state.charges.entries += 1;
        tx.state.charges.receipt_slots += 1;
        tx.state.charges.staged_bytes += size;
        tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
        tx.put(Area::Entries, &entry.id, epoch, &entry)?;
        tx.put(
            Area::Uploads,
            &key,
            epoch,
            &UploadIndex {
                scope_hash: scope.hash.clone(),
                owner_id: owner.id,
                entry_id: entry.id.clone(),
                params_hash,
                epoch,
            },
        )?;
        tx.commit()?;
        Ok(entry)
    }
    /// Standalone full-content publication. Wire chunk/start/finish integration
    /// comes later; bytes are already precharged by allocate_upload.
    fn seal_bytes(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        entry_id: &str,
        payload: &[u8],
    ) -> Result<RetentionStageRefV1> {
        let _operation = lease
            .operation
            .lock()
            .map_err(|_| anyhow::anyhow!("retention owner operation lock poisoned"))?;
        let (owner, mut entry) = {
            let mut tx = self.store.transaction()?;
            let owner = self.leased_owner(&tx, scope, lease)?;
            let mut entry: Entry = tx
                .read(Area::Entries, entry_id)?
                .context("upload entry missing")?;
            ensure!(
                entry.owner_id == owner.id
                    && entry.scope_hash == scope.hash
                    && entry.size == payload.len() as u64
                    && entry.content_sha256 == digest(payload),
                "upload content identity mismatch"
            );
            if matches!(entry.phase, EntryPhase::Sealed | EntryPhase::Ready) {
                return Ok(stage(self.namespace(), &entry));
            }
            ensure!(
                matches!(entry.phase, EntryPhase::Allocating | EntryPhase::Sealing),
                "upload phase not publishable"
            );
            entry.phase = EntryPhase::Sealing;
            tx.put(Area::Entries, entry_id, entry.epoch, &entry)?;
            tx.commit()?;
            (owner, entry)
        };
        let data = self.owner_data(&owner)?;
        let directory = match &entry.directory_identity {
            Some(identity) => data.open_verified_child(OsStr::new(&entry.id), identity)?,
            None => {
                let directory = data.open_child(OsStr::new(&entry.id), true)?;
                entry.directory_identity = Some(directory.retention_identity()?);
                let mut tx = self.store.transaction()?;
                self.leased_owner(&tx, scope, lease)?;
                tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
                tx.commit()?;
                directory
            }
        };
        match directory.open_regular_file(OsStr::new("payload")) {
            Ok(file) => {
                ensure!(
                    file.metadata()?.len() == entry.size,
                    "existing sealed upload size mismatch"
                );
                let mut current = Vec::new();
                file.take(entry.size + 1).read_to_end(&mut current)?;
                ensure!(
                    digest(&current) == entry.content_sha256,
                    "existing sealed upload digest mismatch"
                );
            }
            Err(error) if missing(&error) => {
                directory.atomic_publish_from_reader(
                    OsStr::new("payload"),
                    &mut std::io::Cursor::new(payload),
                    false,
                    || Ok(None),
                )?;
            }
            Err(error) => return Err(error),
        }
        entry.payload_identity = Some(directory.retention_regular_identity(OsStr::new("payload"))?);
        directory.sync()?;
        entry.phase = EntryPhase::Sealed;
        let mut tx = self.store.transaction()?;
        self.leased_owner(&tx, scope, lease)?;
        tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
        tx.commit()?;
        Ok(stage(self.namespace(), &entry))
    }
    pub(super) fn reserve(
        &self,
        scope: &Scope,
        client_request_id: &str,
        thread_id: &str,
        refs: &[RetentionStageRefV1],
    ) -> Result<RetentionReceiptV1> {
        atom(thread_id)?;
        ensure!(
            !refs.is_empty() && refs.len() <= MAX_RETENTION_BATCH,
            "invalid retention batch size"
        );
        let epoch = checked_id(client_request_id, self.namespace())?;
        let mut normalized = refs.to_vec();
        normalized.sort_by(|a, b| (&a.owner_id, &a.entry_id).cmp(&(&b.owner_id, &b.entry_id)));
        let mut distinct = BTreeSet::new();
        ensure!(
            normalized
                .iter()
                .all(|reference| distinct.insert(reference.entry_id.clone())),
            RetentionFailure::Conflict
        );
        // Display paths are not authority or identity material.
        for item in &mut normalized {
            item.path = None;
        }
        let hash = digest(&serde_json::to_vec(&(thread_id, &normalized))?);
        let key = intent_key(scope, client_request_id);
        let mut tx = self.store.transaction()?;
        ensure!(
            retired(&tx, self.namespace(), epoch)?.is_none(),
            RetentionFailure::Conflict
        );
        if let Some(prior) = tx.read::<Intent>(Area::Intents, &key)? {
            ensure!(
                prior.scope_hash == scope.hash
                    && prior.params_hash == hash
                    && prior.client_request_id == client_request_id,
                RetentionFailure::Conflict
            );
            let record: Receipt = tx
                .read(Area::Receipts, &prior.retention_id)?
                .context("retention intent exists without projection; reconciliation required")?;
            ensure!(
                record.scope_hash == scope.hash
                    && record.wire.retention_id == prior.retention_id
                    && record.wire.client_request_id == client_request_id
                    && record.epoch == prior.epoch,
                RetentionFailure::Conflict
            );
            return Ok(record.wire);
        }
        if tx
            .registered_binding_scope(
                epoch,
                &RetentionReceiptSelectorV1::ClientRequestId {
                    client_request_id: client_request_id.into(),
                },
            )?
            .is_some()
        {
            anyhow::bail!(RetentionFailure::Conflict);
        }
        ensure!(
            normalized.iter().map(|r| r.epoch).min() == Some(epoch),
            "intent epoch must match oldest stage"
        );
        let retention_id = wire_id(self.namespace(), epoch);
        let mut entries = Vec::new();
        let mut epochs = BTreeSet::new();
        let mut validated = Vec::with_capacity(normalized.len());
        for reference in &normalized {
            ensure!(
                reference.root_namespace == self.namespace(),
                "retention stage namespace mismatch"
            );
            let entry: Entry = tx
                .read(Area::Entries, &reference.entry_id)?
                .context("unregistered retention stage")?;
            let owner = self.owner(&tx, scope, &entry.owner_id)?;
            ensure!(
                owner.phase == OwnerPhase::Active
                    && entry.scope_hash == scope.hash
                    && entry.owner_id == reference.owner_id
                    && entry.epoch == reference.epoch
                    && entry.revision == reference.revision
                    && entry.phase == EntryPhase::Sealed
                    && entry.retention_id.is_none(),
                RetentionFailure::Conflict
            );
            validated.push(entry);
        }
        // Validate every reference before distinguishing legacy prepaid-slot
        // availability. An invalid/foreign reference must remain a conflict.
        for mut entry in validated {
            ensure!(
                entry.cleanup_capacity == RECORD_BYTES,
                RetentionFailure::ReservePrepaidSlotUnavailable
            );
            entry.retention_id = Some(retention_id.clone());
            entry.phase = EntryPhase::Ready;
            epochs.insert(entry.epoch);
            tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
            entries.push(RetentionReceiptEntryV1 {
                stage_ref: stage(self.namespace(), &entry),
                state: RetentionEntryStateV1::Ready,
            });
        }
        let wire = RetentionReceiptV1 {
            client_request_id: client_request_id.into(),
            retention_id: retention_id.clone(),
            thread_id: thread_id.into(),
            revision: 1,
            state: RetentionReceiptStateV1::Ready,
            entries,
        };
        for epoch in &epochs {
            tx.state
                .epochs
                .get_mut(epoch)
                .context("stage epoch missing")?
                .unconsumed_references += 1;
        }
        tx.put(
            Area::Intents,
            &key,
            epoch,
            &Intent {
                scope_hash: scope.hash.clone(),
                client_request_id: client_request_id.into(),
                retention_id: retention_id.clone(),
                params_hash: hash.clone(),
                epoch,
            },
        )?;
        // Bounded authority lookup by issued retention ID survives loss of the
        // receipt projection; the existing quota/epoch transaction charges it.
        tx.put(
            Area::Intents,
            &format!("retention:{retention_id}"),
            epoch,
            &Intent {
                scope_hash: scope.hash.clone(),
                client_request_id: client_request_id.into(),
                retention_id: retention_id.clone(),
                params_hash: hash.clone(),
                epoch,
            },
        )?;
        tx.put(
            Area::Receipts,
            &retention_id,
            epoch,
            &Receipt {
                scope_hash: scope.hash.clone(),
                epoch,
                referenced_epochs: epochs.into_iter().collect(),
                wire: wire.clone(),
                cleanup_capacity: RECORD_BYTES,
                terminal_budget: 2 * RECORD_BYTES,
                release_intent: None,
            },
        )?;
        tx.commit()?;
        Ok(wire)
    }
    pub(super) fn read(
        &self,
        scope: &Scope,
        selector: &RetentionReceiptSelectorV1,
    ) -> Result<AttachmentRetentionResult> {
        let tx = self.store.transaction()?;
        let id = match selector {
            RetentionReceiptSelectorV1::ClientRequestId { client_request_id } => client_request_id,
            RetentionReceiptSelectorV1::RetentionId { retention_id } => retention_id,
        };
        let epoch = checked_id(id, self.namespace())?;
        let epoch_retired = retired(&tx, self.namespace(), epoch)?;
        let receipt = if epoch_retired.is_some() {
            None
        } else {
            match selector {
                RetentionReceiptSelectorV1::ClientRequestId { client_request_id } => {
                    let intent: Option<Intent> =
                        tx.read(Area::Intents, &intent_key(scope, client_request_id))?;
                    match intent {
                        Some(intent) => {
                            ensure!(
                                intent.scope_hash == scope.hash
                                    && intent.client_request_id == *client_request_id,
                                RetentionFailure::Conflict
                            );
                            let receipt = tx
                                .read::<Receipt>(Area::Receipts, &intent.retention_id)?
                                .context(
                                    "intent authority missing projection; reconciliation required",
                                )?;
                            ensure!(
                                receipt.wire.retention_id == intent.retention_id
                                    && receipt.wire.client_request_id == intent.client_request_id
                                    && receipt.epoch == intent.epoch,
                                RetentionFailure::Conflict
                            );
                            Some(receipt)
                        }
                        None => None,
                    }
                }
                RetentionReceiptSelectorV1::RetentionId { retention_id } => {
                    let projection: Option<Receipt> = tx.read(Area::Receipts, retention_id)?;
                    if projection.is_none()
                        && let Some(intent) =
                            tx.read::<Intent>(Area::Intents, &format!("retention:{retention_id}"))?
                    {
                        ensure!(
                            intent.scope_hash == scope.hash && intent.retention_id == *retention_id,
                            RetentionFailure::Conflict
                        );
                        anyhow::bail!(
                            "known retention intent missing projection; reconciliation required"
                        );
                    }
                    projection
                }
            }
        };
        if epoch_retired.is_none() && receipt.is_none() {
            if let Some(known_scope) = tx.registered_binding_scope(epoch, selector)? {
                ensure!(known_scope == scope.hash, RetentionFailure::Conflict);
                anyhow::bail!(
                    "known retention binding missing projection; reconciliation required"
                );
            }
        }
        if let Some(receipt) = &receipt {
            ensure!(
                receipt.scope_hash == scope.hash && receipt.epoch == epoch,
                RetentionFailure::Conflict
            );
            match selector {
                RetentionReceiptSelectorV1::ClientRequestId { client_request_id } => ensure!(
                    receipt.wire.client_request_id == *client_request_id,
                    RetentionFailure::Conflict
                ),
                RetentionReceiptSelectorV1::RetentionId { retention_id } => ensure!(
                    receipt.wire.retention_id == *retention_id,
                    RetentionFailure::Conflict
                ),
            }
        }
        let result = AttachmentRetentionResult {
            receipt: receipt.map(|record| record.wire),
            epoch_retired,
            consume_results: Vec::new(),
        };
        result
            .validate(self.namespace())
            .map_err(anyhow::Error::msg)?;
        Ok(result)
    }
    /// Private, original-owner discard path. A future thread-delete adapter must
    /// supply its durable deletion proof before using the recovered-owner path.
    /// This method never accepts a caller's claimed thread-deleted boolean.
    fn release_original_owner(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        retention_id: &str,
        expected_revision: u64,
    ) -> Result<RetentionReceiptV1> {
        let _operation = lease
            .operation
            .lock()
            .map_err(|_| anyhow::anyhow!("retention owner operation lock poisoned"))?;
        let mut receipt = {
            let mut tx = self.store.transaction()?;
            self.leased_owner(&tx, scope, lease)?;
            let mut receipt: Receipt = tx
                .read(Area::Receipts, retention_id)?
                .context("retention receipt missing")?;
            ensure!(receipt.scope_hash == scope.hash, RetentionFailure::Conflict);
            if matches!(
                receipt.wire.state,
                RetentionReceiptStateV1::Released | RetentionReceiptStateV1::Consumed
            ) {
                return Ok(receipt.wire);
            }
            ensure!(
                receipt.wire.revision == expected_revision
                    || receipt.wire.state == RetentionReceiptStateV1::ReleasePending,
                "retention release revision conflict"
            );
            for reference in &receipt.wire.entries {
                let mut entry: Entry = tx
                    .read(Area::Entries, &reference.stage_ref.entry_id)?
                    .context("receipt entry authority missing")?;
                if entry.owner_id != lease.id {
                    continue;
                }
                ensure!(
                    entry.scope_hash == scope.hash
                        && entry.retention_id.as_deref() == Some(retention_id),
                    "receipt entry binding mismatch"
                );
                if matches!(entry.phase, EntryPhase::Ready | EntryPhase::Sealed) {
                    entry.phase = EntryPhase::ReleasePending;
                    tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
                } else {
                    ensure!(
                        matches!(
                            entry.phase,
                            EntryPhase::ReleasePending
                                | EntryPhase::RenamePending
                                | EntryPhase::Quarantined
                                | EntryPhase::PayloadGone
                                | EntryPhase::Released
                        ),
                        "materializing/unknown source cannot be discarded"
                    );
                }
            }
            if receipt.wire.state != RetentionReceiptStateV1::ReleasePending {
                receipt.wire.state = RetentionReceiptStateV1::ReleasePending;
                receipt.wire.revision += 1;
                tx.put(Area::Receipts, retention_id, receipt.epoch, &receipt)?;
            }
            tx.commit()?;
            receipt
        };
        for reference in &receipt.wire.entries {
            if reference.stage_ref.owner_id == lease.id {
                self.release_entry(scope, lease, &reference.stage_ref.entry_id)?;
            }
        }
        #[cfg(all(test, target_os = "linux"))]
        pause_release_projection_test_hook("owner", retention_id);
        let mut tx = self.store.transaction()?;
        self.leased_owner(&tx, scope, lease)?;
        // Fresh authority read: another owner's partial release must survive.
        receipt = tx
            .read(Area::Receipts, retention_id)?
            .context("retention release projection missing")?;
        ensure!(
            receipt.scope_hash == scope.hash && receipt.wire.retention_id == retention_id,
            RetentionFailure::Conflict
        );
        if receipt.wire.state == RetentionReceiptStateV1::Consumed {
            return Ok(receipt.wire);
        }
        // The first transaction durably enters ReleasePending; concurrent
        // release may advance it to Released, but no other state may regress.
        ensure!(
            matches!(
                receipt.wire.state,
                RetentionReceiptStateV1::ReleasePending | RetentionReceiptStateV1::Released
            ),
            RetentionFailure::CompletionUnknown
        );
        let mut all_released = true;
        for reference in &mut receipt.wire.entries {
            let entry: Entry = tx
                .read(Area::Entries, &reference.stage_ref.entry_id)?
                .context("retention release entry missing")?;
            if entry.phase == EntryPhase::Released {
                reference.state = RetentionEntryStateV1::Released;
            } else {
                all_released = false;
            }
        }
        ensure!(
            receipt.wire.state != RetentionReceiptStateV1::Released || all_released,
            RetentionFailure::CompletionUnknown
        );
        if all_released && receipt.wire.state == RetentionReceiptStateV1::ReleasePending {
            receipt.wire.state = RetentionReceiptStateV1::Released;
            receipt.wire.revision += 1;
        }
        tx.put(Area::Receipts, retention_id, receipt.epoch, &receipt)?;
        tx.commit()?;
        Ok(receipt.wire)
    }
    fn entry_commit(&self, scope: &Scope, lease: &OwnerLease, entry: &Entry) -> Result<()> {
        let mut tx = self.store.transaction()?;
        self.leased_owner(&tx, scope, lease)?;
        let old: Entry = tx
            .read(Area::Entries, &entry.id)?
            .context("entry journal missing")?;
        ensure!(
            old.owner_id == lease.id
                && old.scope_hash == scope.hash
                && old.revision == entry.revision
                && old.retention_id == entry.retention_id
                && old.directory_identity == entry.directory_identity,
            "entry claim changed during physical operation"
        );
        tx.put(Area::Entries, &entry.id, entry.epoch, entry)?;
        tx.commit()
    }
    fn release_entry(&self, scope: &Scope, lease: &OwnerLease, entry_id: &str) -> Result<()> {
        let (owner, mut entry) = {
            let tx = self.store.transaction()?;
            let owner = self.leased_owner(&tx, scope, lease)?;
            let entry: Entry = tx
                .read(Area::Entries, entry_id)?
                .context("entry authority missing")?;
            ensure!(
                entry.owner_id == owner.id && entry.scope_hash == scope.hash,
                "release owner mismatch"
            );
            (owner, entry)
        };
        if entry.phase == EntryPhase::Released {
            return Ok(());
        }
        if entry.storage_layout() == UploadStorageLayout::RootLeafV1 {
            return self.release_root_upload_entry(scope, lease, entry);
        }
        let data = self.owner_data(&owner)?;
        let identity = entry
            .directory_identity
            .as_ref()
            .context("entry directory identity absent")?
            .clone();
        let payload_identity = entry
            .payload_identity
            .as_ref()
            .context("sealed payload identity absent")?
            .clone();
        if entry.phase == EntryPhase::ReleasePending {
            let directory = data.open_verified_child(OsStr::new(&entry.id), &identity)?;
            directory.open_verified_regular(OsStr::new("payload"), &payload_identity)?;
            // Verify allowlisted manifest before renaming. Unknown children never
            // become recursive deletion candidates.
            ensure!(
                directory.count_regular_files_bounded(|_| true, 2)? == 1,
                "entry manifest contains unknown children"
            );
            entry.phase = EntryPhase::RenamePending;
            self.entry_commit(scope, lease, &entry)?;
        }
        if entry.phase == EntryPhase::RenamePending {
            match data.open_verified_child(OsStr::new(&entry.quarantine), &identity) {
                Ok(_) => {
                    ensure!(
                        matches!(data.open_child(OsStr::new(&entry.id), false), Err(ref e) if missing(e)),
                        "source and quarantine both exist"
                    );
                    // Prior rename may be visible although its fsync failed.
                    // Quarantined must not be durable until the parent is synced.
                    data.sync()?;
                }
                Err(error) if missing(&error) => {
                    data.quarantine_verified_entry(
                        OsStr::new(&entry.id),
                        &identity,
                        OsStr::new(&entry.quarantine),
                    )?;
                }
                Err(error) => return Err(error),
            }
            entry.phase = EntryPhase::Quarantined;
            self.entry_commit(scope, lease, &entry)?; // Durable BEFORE unlink.
        }
        if entry.phase == EntryPhase::Quarantined {
            let directory = data.open_verified_child(OsStr::new(&entry.quarantine), &identity)?;
            match directory.open_verified_regular(OsStr::new("payload"), &payload_identity) {
                Ok(_) => {
                    let outcome = directory.remove_verified_manifest(&[PrivateRemovalEntry {
                        name: "payload".into(),
                        identity: payload_identity,
                    }])?;
                    if let Some(error) = outcome.failure {
                        return Err(error);
                    }
                }
                // Negative proof applies only to this durable, unique quarantine
                // phase and the pinned exact parent/owner lease, never source path.
                Err(error) if missing(&error) => {
                    ensure!(
                        directory.count_regular_files_bounded(|_| true, 1)? == 0,
                        "quarantine contains unknown leaf"
                    );
                    directory.sync()?;
                }
                Err(error) => return Err(error),
            }
            entry.phase = EntryPhase::PayloadGone;
            self.entry_commit(scope, lease, &entry)?;
        }
        if entry.phase == EntryPhase::PayloadGone {
            match data.open_verified_child(OsStr::new(&entry.quarantine), &identity) {
                Ok(_) => {
                    data.remove_verified_empty_directory(OsStr::new(&entry.quarantine), &identity)?
                }
                Err(error) if missing(&error) => data.sync()?,
                Err(error) => return Err(error),
            }
            let mut tx = self.store.transaction()?;
            let mut owner = self.leased_owner(&tx, scope, lease)?;
            let mut current: Entry = tx
                .read(Area::Entries, &entry.id)?
                .context("entry completion journal missing")?;
            ensure!(
                current.phase == EntryPhase::PayloadGone
                    && current.directory_identity == entry.directory_identity,
                "entry completion phase conflict"
            );
            current.phase = EntryPhase::Released;
            decrement(&mut tx.state.charges.staged_bytes, current.size)?;
            decrement(&mut owner.bytes, current.size)?;
            decrement(
                &mut tx
                    .state
                    .epochs
                    .get_mut(&entry.epoch)
                    .context("completion epoch missing")?
                    .nonterminal_allocations,
                1,
            )?;
            tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
            tx.put(Area::Entries, &current.id, current.epoch, &current)?;
            tx.commit()?;
        }
        Ok(())
    }
    pub(super) fn consume(
        &self,
        scope: &Scope,
        ack: &RetentionConsumeAckV1,
        proof: &dyn AcceptedTurnProof,
    ) -> Result<RetentionConsumeStatusV1> {
        atom(&ack.client_ack_id)?;
        let epoch = checked_id(&ack.retention_id, self.namespace())?;
        let mut tx = self.store.transaction()?;
        if let Some(proof) = retired(&tx, self.namespace(), epoch)? {
            return Ok(RetentionConsumeStatusV1::EpochRetired { proof });
        }
        let mut receipt: Receipt = tx
            .read(Area::Receipts, &ack.retention_id)?
            .context("consume receipt missing")?;
        ensure!(
            receipt.scope_hash == scope.hash
                && receipt.wire.retention_id == ack.retention_id
                && receipt.epoch == epoch,
            RetentionFailure::Conflict
        );
        if let Some(prior) = tx.read::<Tombstone>(Area::Consumed, &ack.retention_id)? {
            ensure!(
                prior.scope_hash == scope.hash
                    && prior.revision == ack.terminal_revision
                    && prior.client_ack_id == ack.client_ack_id,
                RetentionFailure::Conflict
            );
            return Ok(RetentionConsumeStatusV1::Consumed);
        }
        ensure!(
            receipt.wire.revision == ack.terminal_revision
                && matches!(
                    receipt.wire.state,
                    RetentionReceiptStateV1::Released | RetentionReceiptStateV1::Transferred
                ),
            RetentionFailure::Conflict
        );
        for reference in &receipt.wire.entries {
            let entry: Entry = tx
                .read(Area::Entries, &reference.stage_ref.entry_id)?
                .context("consume entry proof missing")?;
            ensure!(
                entry.scope_hash == scope.hash
                    && entry.retention_id.as_deref() == Some(&ack.retention_id)
                    && entry.phase.physical_terminal(),
                "consume source lacks physical terminal proof"
            );
            if entry.phase == EntryPhase::Transferred {
                ensure!(
                    proof.is_exactly_accepted(
                        scope,
                        entry
                            .transfer
                            .as_ref()
                            .context("transfer acceptance binding absent")?
                    )?,
                    RetentionFailure::ProofUnavailable
                );
            }
        }
        ensure!(
            receipt.cleanup_capacity == RECORD_BYTES && receipt.terminal_budget == 2 * RECORD_BYTES,
            RetentionFailure::Capacity
        );
        for reference in &receipt.wire.entries {
            let mut entry: Entry = tx
                .read(Area::Entries, &reference.stage_ref.entry_id)?
                .context("consume entry missing")?;
            ensure!(
                entry.cleanup_capacity == RECORD_BYTES,
                RetentionFailure::Capacity
            );
            entry.cleanup_capacity = 0;
            tx.put(Area::Entries, &entry.id, entry.epoch, &entry)?;
        }
        receipt.terminal_budget = 0;
        // Spend only this receipt's prepaid tombstone/catalog credit.
        tx.put(Area::Receipts, &ack.retention_id, epoch, &receipt)?;
        let count = receipt.wire.entries.len() as u64;
        decrement(&mut tx.state.charges.entries, count)?;
        decrement(&mut tx.state.charges.receipt_slots, count)?;
        for epoch in &receipt.referenced_epochs {
            decrement(
                &mut tx
                    .state
                    .epochs
                    .get_mut(epoch)
                    .context("consume reference epoch missing")?
                    .unconsumed_references,
                1,
            )?;
        }
        tx.state.charges.tombstones += 1;
        tx.put(
            Area::Consumed,
            &ack.retention_id,
            epoch,
            &Tombstone {
                scope_hash: scope.hash.clone(),
                retention_id: ack.retention_id.clone(),
                revision: ack.terminal_revision,
                client_ack_id: ack.client_ack_id.clone(),
                epoch,
            },
        )?;
        receipt.wire.state = RetentionReceiptStateV1::Consumed;
        receipt.cleanup_capacity = 0;
        tx.put(Area::Receipts, &ack.retention_id, epoch, &receipt)?;
        tx.commit()?;
        Ok(RetentionConsumeStatusV1::Consumed)
    }
}
