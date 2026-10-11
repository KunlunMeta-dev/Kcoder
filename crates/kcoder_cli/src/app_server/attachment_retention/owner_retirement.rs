//! Manifest-layout retirement. Never scans or removes a shared data/lease root.
use super::owner_init::{manifest_name, manifest_quarantine};
use super::*;

fn regular_absent(parent: &PrivateDirectory, name: &str) -> Result<()> {
    match parent.open_regular_file(OsStr::new(name)) {
        Err(error) if missing(&error) => Ok(()),
        Ok(_) => anyhow::bail!("owner manifest locator remains present"),
        Err(error) => Err(error),
    }
}
impl RetentionService {
    fn manifest_entries_gone(&self, tx: &Transaction<'_>, owner: &Owner) -> Result<()> {
        self.retirement_ready(tx, owner)?;
        let parent = self.store.data()?;
        for id in &owner.entries {
            let entry: Entry = tx
                .read(Area::Entries, id)?
                .context("owner entry proof missing")?;
            match entry.storage_layout() {
                UploadStorageLayout::DirectoryV1 => {
                    for locator in [&entry.id, &entry.quarantine] {
                        match parent.open_child(OsStr::new(locator), false) {
                            Err(error) if missing(&error) => (),
                            Ok(_) => anyhow::bail!("terminal owner entry still has physical data"),
                            Err(error) => return Err(error),
                        }
                    }
                }
                UploadStorageLayout::RootLeafV1 => {
                    self.upload_location(&entry)?; // full recorded root/native identity and deterministic leaf binding
                    regular_absent(&parent, &entry.upload_leaf())?;
                    regular_absent(&parent, &entry.quarantine)?;
                }
            }
        }
        parent.sync()
    }
    pub(super) fn retire_manifest_owner(&self, scope: &Scope, lease: &OwnerLease) -> Result<()> {
        let mut tx = self.store.transaction()?;
        let mut owner = self.owner(&tx, scope, &lease.id)?;
        ensure!(
            owner.layout_version == 2
                && lease.scope_hash == scope.hash
                && owner.lease_identity.as_ref() == Some(lease.lease.identity()),
            "manifest retirement scope/lease mismatch"
        );
        if matches!(owner.phase, OwnerPhase::Retired | OwnerPhase::Cancelled) {
            return Ok(());
        }
        if owner.phase == OwnerPhase::Active {
            self.leased_owner(&tx, scope, lease)?;
            self.manifest_entries_gone(&tx, &owner)?;
            owner.phase = OwnerPhase::Retiring;
            owner.manifest_retirement = Some(RemovalPhase::RenamePending);
            tx.state.charges.owner_proofs += 1;
            tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
            tx.checkpoint_keep_lock()?;
            pause("v2-retire-reserved", &owner.id);
        }
        ensure!(
            owner.phase == OwnerPhase::Retiring,
            "owner retirement unknown; no refund"
        );
        self.manifest_entries_gone(&tx, &owner)?;
        let operation = self.retire_manifest_steps(&mut tx, &mut owner, lease);
        operation?;
        Ok(())
    }
    fn retire_manifest_steps(
        &self,
        tx: &mut Transaction<'_>,
        owner: &mut Owner,
        lease: &OwnerLease,
    ) -> Result<()> {
        let parent = self.store.leases()?;
        let original = manifest_name(&owner.id);
        let quarantine = manifest_quarantine(&owner.id);
        let identity = owner
            .lease_identity
            .as_ref()
            .context("manifest inode missing")?
            .clone();
        ensure!(
            *lease.lease.identity() == identity,
            "retirement claim inode mismatch"
        );
        if owner.manifest_retirement == Some(RemovalPhase::RenamePending) {
            match self.verified_owner_manifest(owner, &quarantine) {
                Ok(_) => {
                    regular_absent(&parent, &original)?;
                    parent.sync()?;
                }
                Err(error) if missing(&error) => {
                    self.verified_owner_manifest(owner, &original)?;
                    parent.quarantine_verified_entry_unflushed(
                        OsStr::new(&original),
                        &identity,
                        OsStr::new(&quarantine),
                    )?;
                    pause("v2-retire-rename-visible", &owner.id);
                    parent.sync()?;
                }
                Err(error) => return Err(error),
            }
            pause("v2-retire-renamed", &owner.id);
            owner.manifest_retirement = Some(RemovalPhase::Quarantined);
            tx.put(Area::Owners, &owner.id, owner.epoch, owner)?;
            tx.checkpoint_keep_lock()?;
            pause("v2-retire-quarantined", &owner.id);
        }
        if owner.manifest_retirement == Some(RemovalPhase::Quarantined) {
            // Absence is authoritative only after the durable Quarantined phase
            // above. Retry the fsync after a visible unlink with a failed sync.
            regular_absent(&parent, &original)?;
            match self.verified_owner_manifest(owner, &quarantine) {
                Ok(_) => {
                    parent.unlink_verified_regular_leaf_unflushed(
                        OsStr::new(&quarantine),
                        &identity,
                    )?;
                    pause("v2-retire-unlink-visible", &owner.id);
                    parent.sync()?;
                    pause("v2-retire-unlinked", &owner.id);
                }
                Err(error) if missing(&error) => parent.sync()?,
                Err(error) => return Err(error),
            }
            owner.manifest_retirement = Some(RemovalPhase::Gone);
            tx.put(Area::Owners, &owner.id, owner.epoch, owner)?;
            tx.checkpoint_keep_lock()?;
            pause("v2-retire-gone", &owner.id);
        }
        ensure!(
            owner.manifest_retirement == Some(RemovalPhase::Gone),
            "manifest retirement phase invalid"
        );
        regular_absent(&parent, &original)?;
        regular_absent(&parent, &quarantine)?;
        parent.sync()?;
        owner.phase = OwnerPhase::Retired;
        self.charge_owner_terminal(tx, owner)?;
        tx.put(Area::Owners, &owner.id, owner.epoch, owner)?;
        tx.checkpoint_keep_lock()
    }
    pub(super) fn resume_manifest_retirement(&self, scope: &Scope, id: &str) -> Result<bool> {
        let mut tx = self.store.transaction()?;
        let mut owner = self.owner(&tx, scope, id)?;
        ensure!(owner.layout_version == 2, "wrong retirement layout");
        if matches!(owner.phase, OwnerPhase::Retired | OwnerPhase::Cancelled) {
            return Ok(true);
        }
        ensure!(owner.phase == OwnerPhase::Retiring, "owner is not retiring");
        self.manifest_entries_gone(&tx, &owner)?;
        let parent = self.store.leases()?;
        let mut located = None;
        for name in [manifest_name(id), manifest_quarantine(id)] {
            match self.verified_owner_manifest(&owner, &name) {
                Ok(_) => {
                    let Some(file) = parent.try_existing_verified_lock(
                        OsStr::new(&name),
                        owner
                            .lease_identity
                            .as_ref()
                            .context("manifest inode missing")?,
                        PrivateLeaseMode::Exclusive,
                    )?
                    else {
                        return Ok(false);
                    };
                    located = Some(file);
                    break;
                }
                Err(error) if missing(&error) => (),
                Err(error) => return Err(error),
            }
        }
        if let Some(file) = located {
            let lease = OwnerLease {
                id: id.into(),
                scope_hash: scope.hash.clone(),
                lease: file,
                operation: std::sync::Mutex::new(()),
            };
            self.retire_manifest_steps(&mut tx, &mut owner, &lease)?;
            return Ok(true);
        }
        ensure!(
            matches!(
                owner.manifest_retirement,
                Some(RemovalPhase::Quarantined | RemovalPhase::Gone)
            ),
            "owner vanished before durable quarantine; no refund"
        );
        parent.sync()?;
        owner.manifest_retirement = Some(RemovalPhase::Gone);
        owner.phase = OwnerPhase::Retired;
        self.charge_owner_terminal(&mut tx, &owner)?;
        tx.put(Area::Owners, id, owner.epoch, &owner)?;
        tx.checkpoint_keep_lock()?;
        Ok(true)
    }
    pub(super) fn cancel_manifest_owner_without_leaves(
        &self,
        scope: &Scope,
        id: &str,
    ) -> Result<()> {
        let mut tx = self.store.transaction()?;
        let mut owner = self.owner(&tx, scope, id)?;
        if owner.phase == OwnerPhase::Cancelled {
            return Ok(());
        }
        ensure!(
            owner.layout_version == 2
                && matches!(owner.phase, OwnerPhase::Allocating | OwnerPhase::Publishing)
                && owner.bytes == 0
                && owner.entries.is_empty(),
            "manifest cancellation phase unknown"
        );
        regular_absent(&self.store.leases()?, &manifest_name(id))?;
        regular_absent(&self.store.leases()?, &manifest_quarantine(id))?;
        self.store.leases()?.sync()?;
        owner.phase = OwnerPhase::Cancelled;
        self.charge_owner_terminal(&mut tx, &owner)?;
        tx.put(Area::Owners, id, owner.epoch, &owner)?;
        tx.checkpoint_keep_lock()
    }
}
fn pause(step: &str, id: &str) {
    #[cfg(all(test, target_os = "linux"))]
    super::tests::pause_owner_init_test_hook(step, id);
    #[cfg(not(all(test, target_os = "linux")))]
    let _ = (step, id);
}
