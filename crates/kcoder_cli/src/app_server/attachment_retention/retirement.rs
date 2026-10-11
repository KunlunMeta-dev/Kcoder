//! Physical owner retirement and bounded metadata collection. No TTL, public
//! RPC or legacy lifecycle entry point: every refund follows exact proof.
use super::*;

fn absent(parent: &PrivateDirectory, name: &str) -> Result<()> {
    match parent.open_child(OsStr::new(name), false) {
        Err(error) if missing(&error) => Ok(()),
        Ok(_) => anyhow::bail!("retention locator still exists; no cancellation/refund"),
        Err(error) => Err(error),
    }
}
impl RetentionService {
    pub(super) fn retirement_ready(&self, tx: &Transaction<'_>, owner: &Owner) -> Result<()> {
        ensure!(owner.bytes == 0, "owner still has charged physical bytes");
        for id in &owner.entries {
            let entry: Entry = tx
                .read(Area::Entries, id)?
                .context("owner entry authority missing")?;
            ensure!(
                entry.owner_id == owner.id
                    && entry.scope_hash == owner.scope.hash
                    && entry.phase.physical_terminal(),
                "owner contains ready/unknown/pending entry"
            );
            if let Some(id) = &entry.retention_id {
                let receipt: Receipt = tx
                    .read(Area::Receipts, id)?
                    .context("owner receipt missing")?;
                let consumed: Tombstone = tx
                    .read(Area::Consumed, id)?
                    .context("owner consume proof missing")?;
                ensure!(
                    receipt.scope_hash == owner.scope.hash
                        && receipt.wire.state == RetentionReceiptStateV1::Consumed
                        && consumed.scope_hash == owner.scope.hash
                        && consumed.retention_id == *id
                        && consumed.revision == receipt.wire.revision,
                    "owner has unconsumed reference"
                );
            } else {
                ensure!(
                    entry.phase == EntryPhase::Cancelled,
                    "unretained terminal source lacks cancellation proof"
                );
            }
        }
        Ok(())
    }
    /// Only the holder of the original/recovered exclusive owner lease may
    /// initiate retirement. A background claimant must first observe it free.
    pub fn retire_owner(&self, scope: &Scope, lease: &OwnerLease) -> Result<()> {
        let _operation = lease
            .operation
            .lock()
            .map_err(|_| anyhow::anyhow!("retention owner operation lock poisoned"))?;
        let layout = {
            let tx = self.store.transaction()?;
            self.owner(&tx, scope, &lease.id)?.layout_version
        };
        if layout == 2 {
            return self.retire_manifest_owner(scope, lease);
        }
        ensure!(layout == 1, "unsupported retirement layout");
        {
            let mut tx = self.store.transaction()?;
            let mut owner = self.owner(&tx, scope, &lease.id)?;
            if matches!(owner.phase, OwnerPhase::Retired | OwnerPhase::Cancelled) {
                return Ok(());
            }
            if owner.phase == OwnerPhase::Active {
                self.leased_owner(&tx, scope, lease)?;
                self.retirement_ready(&tx, &owner)?;
                owner.phase = OwnerPhase::Retiring;
                owner.retirement = Some(OwnerRetirement {
                    data: RemovalPhase::RenamePending,
                    lease: RemovalPhase::RenamePending,
                });
                tx.state.charges.owner_proofs += 1; // Charged BEFORE physical work.
                tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
                tx.commit()?;
            } else {
                ensure!(
                    owner.phase == OwnerPhase::Retiring,
                    "owner retirement is unknown"
                );
            }
        }
        self.retire_data(scope, lease)?;
        self.retire_lease(scope, &lease.id, Some(lease))
    }
    fn retirement_owner(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        lease: &OwnerLease,
    ) -> Result<Owner> {
        let owner = self.owner(tx, scope, &lease.id)?;
        ensure!(
            owner.phase == OwnerPhase::Retiring
                && owner.lease_identity.as_ref() == Some(lease.lease.identity()),
            "retirement lease identity changed"
        );
        self.retirement_ready(tx, &owner)?;
        Ok(owner)
    }
    fn retirement_commit(&self, scope: &Scope, lease: &OwnerLease, owner: &Owner) -> Result<()> {
        let mut tx = self.store.transaction()?;
        let current = self.retirement_owner(&tx, scope, lease)?;
        ensure!(
            current.data_identity == owner.data_identity
                && current.lease_directory_identity == owner.lease_directory_identity,
            "retirement parent changed"
        );
        tx.put(Area::Owners, &owner.id, owner.epoch, owner)?;
        tx.commit()
    }
    fn retire_data(&self, scope: &Scope, lease: &OwnerLease) -> Result<()> {
        let mut owner = {
            let tx = self.store.transaction()?;
            self.retirement_owner(&tx, scope, lease)?
        };
        let parent = self.store.data()?;
        let name = format!("q-owner-{}", owner.id);
        let identity = owner
            .data_identity
            .as_ref()
            .context("owner data identity absent")?
            .clone();
        let marker = owner
            .marker_identity
            .as_ref()
            .context("owner marker identity absent")?
            .clone();
        let state = owner
            .retirement
            .as_ref()
            .context("retirement phases missing")?
            .data;
        if state == RemovalPhase::Gone {
            return Ok(());
        }
        if state == RemovalPhase::RenamePending {
            match parent.open_verified_child(OsStr::new(&name), &identity) {
                Ok(directory) => {
                    absent(&parent, &owner.id)?;
                    directory.open_verified_regular(OsStr::new("marker"), &marker)?;
                    parent.sync()?;
                }
                Err(error) if missing(&error) => {
                    self.owner_data(&owner)?;
                    parent.quarantine_verified_entry(
                        OsStr::new(&owner.id),
                        &identity,
                        OsStr::new(&name),
                    )?;
                }
                Err(error) => return Err(error),
            }
            owner.retirement.as_mut().expect("checked phases").data = RemovalPhase::Quarantined;
            self.retirement_commit(scope, lease, &owner)?;
        }
        if owner.retirement.as_ref().expect("checked phases").data == RemovalPhase::Quarantined {
            let directory = parent.open_verified_child(OsStr::new(&name), &identity)?;
            match directory.open_verified_regular(OsStr::new("marker"), &marker) {
                Ok(_) => {
                    let result = directory.remove_verified_manifest(&[PrivateRemovalEntry {
                        name: "marker".into(),
                        identity: marker,
                    }])?;
                    if let Some(error) = result.failure {
                        return Err(error);
                    }
                }
                Err(error) if missing(&error) => {
                    ensure!(
                        directory.count_regular_files_bounded(|_| true, 1)? == 0,
                        "retiring owner contains unknown child"
                    );
                    directory.sync()?;
                }
                Err(error) => return Err(error),
            }
            owner.retirement.as_mut().expect("checked phases").data = RemovalPhase::LeavesGone;
            self.retirement_commit(scope, lease, &owner)?;
        }
        if owner.retirement.as_ref().expect("checked phases").data == RemovalPhase::LeavesGone {
            match parent.open_verified_child(OsStr::new(&name), &identity) {
                Ok(_) => parent.remove_verified_empty_directory(OsStr::new(&name), &identity)?,
                Err(error) if missing(&error) => parent.sync()?,
                Err(error) => return Err(error),
            }
            owner.retirement.as_mut().expect("checked phases").data = RemovalPhase::Gone;
            self.retirement_commit(scope, lease, &owner)?;
        }
        Ok(())
    }
    /// The tiny lease-directory transition stays under the namespace lock. All
    /// writers already reject Retiring owners. When the durable Quarantined
    /// phase has unlinked its exact lock, recovery cannot recreate that lock:
    /// it completes only the unique empty locator and never claims active data.
    fn retire_lease(&self, scope: &Scope, id: &str, lease: Option<&OwnerLease>) -> Result<()> {
        let mut tx = self.store.transaction()?;
        let mut owner = self.owner(&tx, scope, id)?;
        if owner.phase == OwnerPhase::Retired {
            return Ok(());
        }
        ensure!(
            owner.phase == OwnerPhase::Retiring
                && owner
                    .retirement
                    .as_ref()
                    .is_some_and(|phase| phase.data == RemovalPhase::Gone),
            "owner data retirement incomplete"
        );
        self.retirement_ready(&tx, &owner)?;
        let parent = self.store.leases()?;
        let name = format!("q-lease-{}", owner.id);
        let identity = owner
            .lease_directory_identity
            .as_ref()
            .context("owner lease directory absent")?
            .clone();
        let lock_identity = owner
            .lease_identity
            .as_ref()
            .context("owner lease identity absent")?
            .clone();
        let phase = owner.retirement.as_ref().expect("checked phases").lease;
        if phase == RemovalPhase::RenamePending {
            ensure!(
                lease.is_some_and(|lease| lease.id == owner.id
                    && lease.scope_hash == scope.hash
                    && lease.lease.identity() == &lock_identity),
                "original owner lease required before retirement rename"
            );
            match parent.open_verified_child(OsStr::new(&name), &identity) {
                Ok(_) => {
                    absent(&parent, id)?;
                    parent.sync()?;
                }
                Err(error) if missing(&error) => {
                    parent.quarantine_verified_entry(
                        OsStr::new(id),
                        &identity,
                        OsStr::new(&name),
                    )?;
                }
                Err(error) => return Err(error),
            }
            owner.retirement.as_mut().expect("checked phases").lease = RemovalPhase::Quarantined;
            tx.put(Area::Owners, id, owner.epoch, &owner)?;
            tx.commit()?;
            return self.retire_lease(scope, id, lease);
        }
        if phase == RemovalPhase::Quarantined {
            let directory = parent.open_verified_child(OsStr::new(&name), &identity)?;
            match directory.open_verified_regular(OsStr::new("lock"), &lock_identity) {
                Ok(_) => {
                    ensure!(
                        lease.is_some_and(|lease| lease.id == owner.id
                            && lease.scope_hash == scope.hash
                            && lease.lease.identity() == &lock_identity),
                        "live original lease required while retirement lock exists"
                    );
                    let result = directory.remove_verified_manifest(&[PrivateRemovalEntry {
                        name: "lock".into(),
                        identity: lock_identity,
                    }])?;
                    if let Some(error) = result.failure {
                        return Err(error);
                    }
                }
                Err(error) if missing(&error) => {
                    ensure!(
                        directory.count_regular_files_bounded(|_| true, 1)? == 0,
                        "retiring lease contains unknown child"
                    );
                    directory.sync()?;
                }
                Err(error) => return Err(error),
            }
            owner.retirement.as_mut().expect("checked phases").lease = RemovalPhase::LeavesGone;
            tx.put(Area::Owners, id, owner.epoch, &owner)?;
            tx.commit()?;
            return self.retire_lease(scope, id, lease);
        }
        ensure!(
            matches!(phase, RemovalPhase::LeavesGone | RemovalPhase::Gone),
            "invalid retirement lease phase"
        );
        if phase == RemovalPhase::LeavesGone {
            match parent.open_verified_child(OsStr::new(&name), &identity) {
                Ok(_) => parent.remove_verified_empty_directory(OsStr::new(&name), &identity)?,
                Err(error) if missing(&error) => parent.sync()?,
                Err(error) => return Err(error),
            }
        }
        owner.retirement.as_mut().expect("checked phases").lease = RemovalPhase::Gone;
        owner.phase = OwnerPhase::Retired;
        decrement(&mut tx.state.charges.owners, 1)?;
        decrement(
            &mut tx
                .state
                .epochs
                .get_mut(&owner.epoch)
                .context("retirement epoch missing")?
                .nonterminal_allocations,
            1,
        )?;
        tx.put(Area::Owners, id, owner.epoch, &owner)?;
        tx.commit()
    }
    /// Never steals a live OS lease. Once the service itself durably unlinked a
    /// retirement lock, only its exact quarantined namespace phase may finish.
    pub fn resume_owner_retirement(&self, scope: &Scope, id: &str) -> Result<bool> {
        let owner = {
            let tx = self.store.transaction()?;
            self.owner(&tx, scope, id)?
        };
        if owner.layout_version == 2 {
            return self.resume_manifest_retirement(scope, id);
        }
        ensure!(owner.layout_version == 1, "unsupported retirement layout");
        if matches!(owner.phase, OwnerPhase::Retired | OwnerPhase::Cancelled) {
            return Ok(true);
        }
        ensure!(owner.phase == OwnerPhase::Retiring, "owner not retiring");
        let parent = self.store.leases()?;
        let phase = owner
            .retirement
            .as_ref()
            .context("retirement phase missing")?;
        let locator = if phase.lease == RemovalPhase::RenamePending {
            match parent.open_child(OsStr::new(id), false) {
                Ok(_) => id.to_string(),
                Err(error) if missing(&error) => format!("q-lease-{id}"),
                Err(error) => return Err(error),
            }
        } else {
            format!("q-lease-{id}")
        };
        let directory = match parent.open_verified_child(
            OsStr::new(&locator),
            owner
                .lease_directory_identity
                .as_ref()
                .context("lease directory missing")?,
        ) {
            Ok(directory) => Some(directory),
            Err(error)
                if missing(&error)
                    && phase.data == RemovalPhase::Gone
                    && matches!(phase.lease, RemovalPhase::LeavesGone | RemovalPhase::Gone) =>
            {
                None
            }
            Err(error) => return Err(error),
        };
        if let Some(directory) = directory {
            match directory.try_existing_verified_lock(
                OsStr::new("lock"),
                owner
                    .lease_identity
                    .as_ref()
                    .context("original lease missing")?,
                PrivateLeaseMode::Exclusive,
            ) {
                Ok(Some(lease)) => {
                    let lease = OwnerLease {
                        id: id.into(),
                        scope_hash: scope.hash.clone(),
                        lease,
                        operation: std::sync::Mutex::new(()),
                    };
                    self.retire_owner(scope, &lease)?;
                    return Ok(true);
                }
                Ok(None) => return Ok(false),
                Err(error)
                    if missing(&error)
                        && phase.data == RemovalPhase::Gone
                        && matches!(
                            phase.lease,
                            RemovalPhase::Quarantined
                                | RemovalPhase::LeavesGone
                                | RemovalPhase::Gone
                        ) => {}
                Err(error) => return Err(error),
            }
        }
        self.retire_lease(scope, id, None)?;
        Ok(true)
    }
    pub fn cancel_unstarted_upload(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        id: &str,
    ) -> Result<()> {
        let _operation = lease
            .operation
            .lock()
            .map_err(|_| anyhow::anyhow!("retention owner operation lock poisoned"))?;
        let mut tx = self.store.transaction()?;
        let mut owner = self.leased_owner(&tx, scope, lease)?;
        let mut entry: Entry = tx
            .read(Area::Entries, id)?
            .context("allocation entry missing")?;
        ensure!(
            entry.owner_id == owner.id && entry.scope_hash == scope.hash,
            "allocation cancellation scope mismatch"
        );
        if entry.phase == EntryPhase::Cancelled {
            return Ok(());
        }
        if entry.storage_layout() == UploadStorageLayout::RootLeafV1 {
            ensure!(
                entry.phase == EntryPhase::Allocating
                    && entry.payload_identity.is_none()
                    && entry.retention_id.is_none()
                    && entry.transfer.is_none(),
                "root upload already has effects"
            );
            let progress = entry.upload.as_ref().context("upload progress missing")?;
            ensure!(
                progress.confirmed_bytes == 0
                    && progress.pending.is_none()
                    && !progress.payload_publishing,
                "root upload already admitted bytes"
            );
            entry.phase = EntryPhase::ReleasePending;
            tx.put(Area::Entries, id, entry.epoch, &entry)?;
            tx.commit()?;
            return self.release_root_upload_entry(scope, lease, entry);
        }
        ensure!(
            entry.phase == EntryPhase::Allocating
                && entry.directory_identity.is_none()
                && entry.payload_identity.is_none()
                && entry.retention_id.is_none()
                && entry.transfer.is_none(),
            "allocation already has effects/StageRef; no cancellation refund"
        );
        let data = self.owner_data(&owner)?;
        absent(&data, &entry.id)?;
        absent(&data, &entry.quarantine)?;
        data.sync()?;
        entry.phase = EntryPhase::Cancelled;
        // Tombstone and refund share redo: crashing between records and quota
        // cannot create another allocation or subtract the reservation twice.
        decrement(&mut tx.state.charges.entries, 1)?;
        decrement(&mut tx.state.charges.receipt_slots, 1)?;
        decrement(&mut tx.state.charges.staged_bytes, entry.size)?;
        decrement(&mut owner.bytes, entry.size)?;
        decrement(
            &mut tx
                .state
                .epochs
                .get_mut(&entry.epoch)
                .context("cancel epoch missing")?
                .nonterminal_allocations,
            1,
        )?;
        tx.put(Area::Entries, id, entry.epoch, &entry)?;
        tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
        tx.commit()
    }
    pub fn cancel_owner_without_leaves(&self, scope: &Scope, id: &str) -> Result<()> {
        let layout = {
            let tx = self.store.transaction()?;
            self.owner(&tx, scope, id)?.layout_version
        };
        if layout == 2 {
            return self.cancel_manifest_owner_without_leaves(scope, id);
        }
        ensure!(layout == 1, "unsupported cancellation layout");
        let mut tx = self.store.transaction()?;
        let mut owner = self.owner(&tx, scope, id)?;
        if owner.phase == OwnerPhase::Cancelled {
            return Ok(());
        }
        ensure!(
            owner.phase == OwnerPhase::Allocating
                && owner.entries.is_empty()
                && owner.bytes == 0
                && owner.data_identity.is_none()
                && owner.marker_identity.is_none()
                && owner.lease_directory_identity.is_none()
                && owner.lease_identity.is_none(),
            "owner initialization has unknown effects; no cancellation refund"
        );
        let data = self.store.data()?;
        let leases = self.store.leases()?;
        absent(&data, id)?;
        absent(&data, &format!("q-owner-{id}"))?;
        absent(&leases, id)?;
        absent(&leases, &format!("q-lease-{id}"))?;
        data.sync()?;
        leases.sync()?;
        owner.phase = OwnerPhase::Cancelled;
        tx.state.charges.owner_proofs += 1;
        decrement(&mut tx.state.charges.owners, 1)?;
        decrement(
            &mut tx
                .state
                .epochs
                .get_mut(&owner.epoch)
                .context("owner cancel epoch missing")?
                .nonterminal_allocations,
            1,
        )?;
        tx.put(Area::Owners, id, owner.epoch, &owner)?;
        tx.commit()
    }
}
