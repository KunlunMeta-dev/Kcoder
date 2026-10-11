//! V2 owner initialization: one immutable lease manifest, no named bootstrap
//! temp and no unsigned filesystem adoption. This service remains unadvertised.
use super::*;

pub(super) struct OwnerCreation {
    pub id: String,
    pub phase: OwnerPhase,
    pub lease: Option<OwnerLease>,
}

pub(super) fn manifest_name(id: &str) -> String {
    format!("owner-v2-{id}.manifest")
}
pub(super) fn manifest_quarantine(id: &str) -> String {
    format!("q-owner-v2-{id}.manifest")
}

fn domain_digest(domain: &[u8], bytes: &[u8]) -> String {
    let mut material = domain.to_vec();
    material.extend_from_slice(bytes);
    digest(&material)
}
fn manifest_bytes(record: &OwnerManifestV2) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(&record.payload)?;
    ensure!(
        record.payload_sha256 == domain_digest(b"owner-manifest-payload-v2\0", &payload),
        "owner manifest payload digest mismatch"
    );
    let encoded = serde_json::to_vec(&OwnerManifestFileV2 {
        payload: record.payload.clone(),
        payload_sha256: record.payload_sha256.clone(),
    })?;
    ensure!(
        encoded.len() as u64 <= RECORD_BYTES && digest(&encoded) == record.file_sha256,
        "owner manifest final digest mismatch"
    );
    Ok(encoded)
}
fn validate_request(request: &RetentionOwnerRequestV1) -> Result<()> {
    atom(&request.client_owner_request_id)?;
    ensure!(
        request.immutable_parameters.len() <= 32,
        "owner request parameter bound"
    );
    for (key, value) in &request.immutable_parameters {
        atom(key)?;
        atom(value)?;
    }
    ensure!(
        serde_json::to_vec(request)?.len() <= 16_384,
        "owner request byte bound"
    );
    Ok(())
}

impl RetentionService {
    pub(super) fn owner_request_locator(
        &self,
        scope: &Scope,
        request: &RetentionOwnerRequestV1,
    ) -> Result<(String, String)> {
        validate_request(request)?;
        ensure!(
            canonical_scope(scope)? == *scope,
            "owner request scope is not canonical"
        );
        // BTreeMap and typed tuples have canonical field order. The account
        // root/native identity and namespace are server facts, never RPC input.
        let authority = (
            &self.store.header.namespace,
            &self.store.header.identity,
            scope,
        );
        let locator = if request.client_owner_request_id.starts_with("o1.") {
            let (namespace, _) =
                retention_upload_generation_id(&request.client_owner_request_id, "o1")
                    .map_err(|_| RetentionFailure::Conflict)?;
            ensure!(namespace == self.namespace(), RetentionFailure::Conflict);
            domain_digest(
                b"owner-create-generation-v1\0",
                &serde_json::to_vec(&(self.namespace(), &request.client_owner_request_id))?,
            )
        } else {
            // Existing opaque request locators retain their original semantics.
            domain_digest(
                b"owner-create-v1\0",
                &serde_json::to_vec(&(&authority, &request.client_owner_request_id))?,
            )
        };
        let params = domain_digest(
            b"owner-parameters-v1\0",
            &serde_json::to_vec(&(&authority, &request.immutable_parameters))?,
        );
        Ok((locator, params))
    }
    pub(super) fn owner_request_match(
        &self,
        owner: &Owner,
        scope: &Scope,
        request: &RetentionOwnerRequestV1,
        id: &str,
        params: &str,
    ) -> Result<()> {
        ensure!(
            owner.id == id && owner.scope == *scope && owner.layout_version == 2,
            "owner request scope/layout conflict"
        );
        let binding = owner
            .request
            .as_ref()
            .context("owner request authority missing")?;
        ensure!(
            binding.client_request_id == request.client_owner_request_id
                && binding.params_sha256 == params,
            "owner request parameter conflict"
        );
        Ok(())
    }
    fn checked_owner_manifest_bytes(&self, owner: &Owner) -> Result<Vec<u8>> {
        ensure!(owner.layout_version == 2, "owner is not manifest layout");
        let record = owner
            .manifest
            .as_ref()
            .context("owner manifest authority missing")?;
        let parent = self.store.leases()?;
        parent.verify_retention_identity(&record.payload.lease_parent)?;
        ensure!(
            record.payload.version == 2
                && record.payload.namespace == self.namespace()
                && record.payload.owner_id == owner.id
                && record.payload.epoch == owner.epoch
                && record.payload.scope_hash == owner.scope.hash
                && record.payload.mode == 0o600
                && owner.lease_identity.as_ref() == Some(&record.payload.inode),
            "owner manifest binding mismatch"
        );
        manifest_bytes(record)
    }
    pub(super) fn verified_owner_manifest(
        &self,
        owner: &Owner,
        name: &str,
    ) -> Result<VerifiedPrivateEntry> {
        // Validate journal authority even if the published file is absent.
        let expected = self.checked_owner_manifest_bytes(owner)?;
        let record = owner
            .manifest
            .as_ref()
            .context("owner manifest authority missing")?;
        let parent = self.store.leases()?;
        let file = parent.open_verified_regular(OsStr::new(name), &record.payload.inode)?;
        file.verify_manifest_mode()?;
        let mut bytes = Vec::new();
        file.file().take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(bytes == expected, "owner manifest immutable bytes mismatch");
        Ok(file)
    }
    fn owner_manifest_absent(&self, owner: &Owner) -> Result<()> {
        let parent = self.store.leases()?;
        for name in [manifest_name(&owner.id), manifest_quarantine(&owner.id)] {
            match parent.open_regular_file(OsStr::new(&name)) {
                Err(error) if missing(&error) => (),
                Ok(_) => anyhow::bail!("owner locator present without authoritative proof"),
                Err(error) => return Err(error),
            }
        }
        parent.sync()
    }
    fn manifest_quarantine_absent(&self, owner: &Owner) -> Result<()> {
        match self
            .store
            .leases()?
            .open_regular_file(OsStr::new(&manifest_quarantine(&owner.id)))
        {
            Err(error) if missing(&error) => Ok(()),
            Ok(_) => anyhow::bail!("owner quarantine locator already exists"),
            Err(error) => Err(error),
        }
    }
    pub(super) fn charge_owner_terminal(
        &self,
        tx: &mut Transaction<'_>,
        owner: &Owner,
    ) -> Result<()> {
        // This retained owner row IS the request tombstone. No GC removes it in
        // this batch; absence of a trusted generation fence means fail closed.
        if owner.manifest_retirement.is_none() {
            tx.state.charges.owner_proofs += 1;
        }
        decrement(&mut tx.state.charges.owners, 1)?;
        decrement(
            &mut tx
                .state
                .epochs
                .get_mut(&owner.epoch)
                .context("owner epoch missing")?
                .nonterminal_allocations,
            1,
        )
    }
    fn cancel_manifest_owner(&self, tx: &mut Transaction<'_>, owner: &mut Owner) -> Result<()> {
        ensure!(
            matches!(owner.phase, OwnerPhase::Allocating | OwnerPhase::Publishing)
                && owner.entries.is_empty()
                && owner.bytes == 0,
            "owner cancellation lacks exact phase"
        );
        if let Err(error) = self.owner_manifest_absent(owner) {
            self.unknown_manifest_owner(tx, owner)?;
            return Err(error);
        }
        owner.phase = OwnerPhase::Cancelled;
        self.charge_owner_terminal(tx, owner)?;
        tx.put(Area::Owners, &owner.id, owner.epoch, owner)?;
        tx.checkpoint_keep_lock()
    }
    fn unknown_manifest_owner(&self, tx: &mut Transaction<'_>, owner: &mut Owner) -> Result<()> {
        owner.phase = OwnerPhase::Unknown;
        tx.put(Area::Owners, &owner.id, owner.epoch, owner)?;
        tx.checkpoint_keep_lock()
    }
    fn publish_upload_owner_manifest(
        &self,
        tx: &mut Transaction<'_>,
        owner: &mut Owner,
    ) -> Result<OwnerLease> {
        let id = owner.id.clone();
        let epoch = owner.epoch;
        let scope = owner.scope.clone();
        let parent = self.store.leases()?;
        let mut anonymous = parent.create_anonymous_private_entry()?;
        let payload = OwnerManifestPayloadV2 {
            version: 2,
            namespace: self.namespace().into(),
            owner_id: id.clone(),
            epoch,
            scope_hash: scope.hash.clone(),
            lease_parent: parent.retention_identity()?,
            inode: anonymous.identity().clone(),
            mode: 0o600,
        };
        let payload_sha256 = domain_digest(
            b"owner-manifest-payload-v2\0",
            &serde_json::to_vec(&payload)?,
        );
        let bytes = serde_json::to_vec(&OwnerManifestFileV2 {
            payload: payload.clone(),
            payload_sha256: payload_sha256.clone(),
        })?;
        anonymous.seal(&bytes)?;
        pause("v2-anonymous-sealed", &id);
        owner.lease_identity = Some(payload.inode.clone());
        owner.manifest = Some(OwnerManifestV2 {
            payload,
            payload_sha256,
            file_sha256: digest(&bytes),
        });
        owner.phase = OwnerPhase::Publishing;
        tx.put(Area::Owners, &id, epoch, owner)?;
        tx.checkpoint_keep_lock()?;
        pause("v2-publishing", &id);
        if let Err(error) = self.manifest_quarantine_absent(owner) {
            self.unknown_manifest_owner(tx, owner)?;
            return Err(error);
        }
        let published = match parent
            .publish_anonymous_private_entry(&anonymous, OsStr::new(&manifest_name(&id)))
        {
            Ok(file) => file,
            Err(error) => {
                self.unknown_manifest_owner(tx, owner)?;
                return Err(error);
            }
        };
        pause("v2-linked", &id);
        parent.sync()?;
        pause("v2-parent-synced", &id);
        self.verified_owner_manifest(owner, &manifest_name(&id))?;
        ensure!(
            published.try_exclusive_lease()?,
            "new owner manifest unexpectedly busy"
        );
        owner.phase = OwnerPhase::Active;
        tx.put(Area::Owners, &id, epoch, owner)?;
        tx.checkpoint_keep_lock()?;
        pause("v2-active", &id);
        Ok(OwnerLease {
            id,
            scope_hash: scope.hash,
            lease: published,
            operation: std::sync::Mutex::new(()),
        })
    }
    fn recover_unstarted_upload_owner(
        &self,
        tx: &mut Transaction<'_>,
        owner: &mut Owner,
    ) -> Result<OwnerLease> {
        ensure!(
            owner.data_identity.is_none()
                && owner.marker_identity.is_none()
                && owner.lease_directory_identity.is_none()
                && owner.retirement.is_none()
                && owner.manifest_retirement.is_none(),
            RetentionFailure::CompletionUnknown
        );
        match owner.phase {
            OwnerPhase::Allocating => ensure!(
                owner.manifest.is_none() && owner.lease_identity.is_none(),
                RetentionFailure::CompletionUnknown
            ),
            OwnerPhase::Publishing => {
                self.checked_owner_manifest_bytes(owner)?;
            }
            _ => anyhow::bail!(RetentionFailure::CompletionUnknown),
        }
        let request = owner
            .request
            .as_ref()
            .context("owner request binding missing")?;
        let (namespace, epoch) = retention_upload_generation_id(&request.client_request_id, "o1")
            .map_err(|_| RetentionFailure::CompletionUnknown)?;
        ensure!(
            namespace == self.namespace() && epoch == owner.epoch && owner.entries.len() == 1,
            RetentionFailure::CompletionUnknown
        );
        let entry: Entry = tx
            .read(Area::Entries, &owner.entries[0])?
            .context("upload entry missing")?;
        let progress = entry.upload.as_ref().context("upload progress missing")?;
        ensure!(
            entry.owner_id == owner.id
                && entry.scope_hash == owner.scope.hash
                && owner.bytes == entry.size
                && entry.phase == EntryPhase::Allocating
                && entry.payload_identity.is_none()
                && entry.retention_id.is_none()
                && entry.transfer.is_none()
                && progress.confirmed_bytes == 0
                && progress.pending.is_none()
                && !progress.payload_publishing,
            RetentionFailure::CompletionUnknown
        );
        let (upload_namespace, upload_epoch) =
            retention_upload_generation_id(&entry.client_upload_id, "u1")
                .map_err(|_| RetentionFailure::CompletionUnknown)?;
        let index: UploadIndex = tx
            .read(
                Area::Uploads,
                &format!("upload-generation-v1:{}", entry.client_upload_id),
            )?
            .context("upload index missing")?;
        ensure!(
            upload_namespace == self.namespace()
                && upload_epoch == entry.epoch
                && index.epoch == entry.epoch
                && index.entry_id == entry.id
                && index.owner_id == owner.id
                && index.scope_hash == owner.scope.hash
                && index.params_hash == entry.params_hash,
            RetentionFailure::CompletionUnknown
        );
        self.owner_manifest_absent(owner)?;
        let data = self.store.data()?;
        match entry.storage_layout() {
            UploadStorageLayout::DirectoryV1 => {
                ensure!(
                    entry.directory_identity.is_none(),
                    RetentionFailure::CompletionUnknown
                );
                for name in [&entry.id, &entry.quarantine] {
                    match data.open_child(OsStr::new(name), false) {
                        Err(error) if missing(&error) => (),
                        Ok(_) => anyhow::bail!(RetentionFailure::CompletionUnknown),
                        Err(error) => return Err(error),
                    }
                }
            }
            UploadStorageLayout::RootLeafV1 => {
                let (parent, name) = self.upload_location(&entry)?;
                match parent.open_regular_file(OsStr::new(&name)) {
                    Err(error) if missing(&error) => (),
                    Ok(_) => anyhow::bail!(RetentionFailure::CompletionUnknown),
                    Err(error) => return Err(error),
                }
                self.upload_quarantine_absent(&entry)?;
            }
        }
        data.sync()?;
        self.publish_upload_owner_manifest(tx, owner)
    }
    fn recover_manifest_initialization(
        &self,
        tx: &mut Transaction<'_>,
        owner: &mut Owner,
    ) -> Result<Option<OwnerLease>> {
        match owner.phase {
            OwnerPhase::Allocating if !owner.entries.is_empty() => {
                match self.recover_unstarted_upload_owner(tx, owner) {
                    Ok(lease) => return Ok(Some(lease)),
                    Err(error) => {
                        self.unknown_manifest_owner(tx, owner)?;
                        return Err(error);
                    }
                }
            }
            OwnerPhase::Allocating => self.cancel_manifest_owner(tx, owner)?,
            OwnerPhase::Publishing => {
                match self.verified_owner_manifest(owner, &manifest_name(&owner.id)) {
                    Ok(file) => {
                        // The exact quarantine locator must be absent too.
                        let parent = self.store.leases()?;
                        match parent.open_regular_file(OsStr::new(&manifest_quarantine(&owner.id)))
                        {
                            Err(error) if missing(&error) => (),
                            _ => anyhow::bail!("publishing owner quarantine is not absent"),
                        }
                        parent.sync()?;
                        if !file.try_exclusive_lease()? {
                            return Ok(None);
                        }
                        owner.phase = OwnerPhase::Active;
                        tx.put(Area::Owners, &owner.id, owner.epoch, owner)?;
                        tx.checkpoint_keep_lock()?;
                        return Ok(Some(OwnerLease {
                            id: owner.id.clone(),
                            scope_hash: owner.scope.hash.clone(),
                            lease: file,
                            operation: std::sync::Mutex::new(()),
                        }));
                    }
                    Err(error) if missing(&error) => {
                        if owner.entries.is_empty() {
                            self.cancel_manifest_owner(tx, owner)?;
                        } else {
                            match self.recover_unstarted_upload_owner(tx, owner) {
                                Ok(lease) => return Ok(Some(lease)),
                                Err(error) => {
                                    self.unknown_manifest_owner(tx, owner)?;
                                    return Err(error);
                                }
                            }
                        }
                    }
                    Err(error) => {
                        self.unknown_manifest_owner(tx, owner)?;
                        return Err(error);
                    }
                }
            }
            OwnerPhase::Active => {
                self.verified_owner_manifest(owner, &manifest_name(&owner.id))?;
                let lease = self.store.leases()?.try_existing_verified_lock(
                    OsStr::new(&manifest_name(&owner.id)),
                    owner
                        .lease_identity
                        .as_ref()
                        .context("owner inode missing")?,
                    PrivateLeaseMode::Exclusive,
                )?;
                return Ok(lease.map(|lease| OwnerLease {
                    id: owner.id.clone(),
                    scope_hash: owner.scope.hash.clone(),
                    lease,
                    operation: std::sync::Mutex::new(()),
                }));
            }
            OwnerPhase::Cancelled
            | OwnerPhase::Retired
            | OwnerPhase::Unknown
            | OwnerPhase::Retiring => (),
            _ => anyhow::bail!("owner request requires retirement reconciliation"),
        }
        Ok(None)
    }
    /// Lookup and recovery are by the original stable request. No new ID is
    /// minted for Unknown, terminal, conflicting or exhausted requests.
    pub(super) fn read_owner_request(
        &self,
        scope: &Scope,
        request: &RetentionOwnerRequestV1,
    ) -> Result<Option<OwnerCreation>> {
        let (id, params) = self.owner_request_locator(scope, request)?;
        let mut tx = self.store.transaction()?;
        let Some(mut owner) = tx.read::<Owner>(Area::Owners, &id)? else {
            tx.assert_unregistered(Area::Owners, &id)?;
            return Ok(None);
        };
        self.owner_request_match(&owner, scope, request, &id, &params)?;
        let lease = self.recover_manifest_initialization(&mut tx, &mut owner)?;
        Ok(Some(OwnerCreation {
            id,
            phase: owner.phase,
            lease,
        }))
    }
    pub(super) fn create_owner_with_request(
        &self,
        scope: &Scope,
        request: &RetentionOwnerRequestV1,
    ) -> Result<OwnerCreation> {
        self.create_owner_with_upload(scope, request, None)
    }
    pub(super) fn create_owner_with_upload(
        &self,
        scope: &Scope,
        request: &RetentionOwnerRequestV1,
        upload: Option<&RetentionUploadParamsV1>,
    ) -> Result<OwnerCreation> {
        let (id, params) = self.owner_request_locator(scope, request)?;
        let mut tx = self.store.transaction()?;
        if let Some(mut owner) = tx.read::<Owner>(Area::Owners, &id)? {
            self.owner_request_match(&owner, scope, request, &id, &params)?;
            // Reconcile the original owner before admitting a new upload. Existing
            // same-ID rows are preserved even when owner publication is unknown.
            let lease = self.recover_manifest_initialization(&mut tx, &mut owner)?;
            if let Some(upload) = upload {
                ensure!(lease.is_some(), RetentionFailure::CompletionUnknown);
                self.reserve_wire_upload(&mut tx, scope, &mut owner, upload)?;
                tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
                tx.validate_pending()?;
                tx.checkpoint_keep_lock()?;
            }
            return Ok(OwnerCreation {
                id,
                phase: owner.phase,
                lease,
            });
        }
        tx.assert_unregistered(Area::Owners, &id)?;
        let epoch = if upload.is_some() {
            let (namespace, requested) =
                retention_upload_generation_id(&request.client_owner_request_id, "o1")
                    .map_err(|_| RetentionFailure::Conflict)?;
            ensure!(namespace == self.namespace(), RetentionFailure::Conflict);
            tx.state
                .allocate_requested(requested, &self.store.header.limits)?
        } else {
            tx.state.allocate(&self.store.header.limits)?
        };
        tx.state.charges.owners += 1;
        let mut owner = Owner {
            id: id.clone(),
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
            layout_version: 2,
            request: Some(OwnerRequestBinding {
                client_request_id: request.client_owner_request_id.clone(),
                params_sha256: params,
            }),
            manifest: None,
            manifest_retirement: None,
            cleanup_capacity: RECORD_BYTES,
        };
        if let Some(upload) = upload {
            self.reserve_wire_upload(&mut tx, scope, &mut owner, upload)?;
        }
        tx.put(Area::Owners, &id, epoch, &owner)?;
        // Owner + entry + receipt slot + bytes + metadata/cleanup are checked
        // together BEFORE the first persistent owner/header publication.
        tx.validate_pending()?;
        tx.require_layout_v2()?;
        tx.checkpoint_keep_lock()?;
        pause("v2-reserved", &id);
        let lease = self.publish_upload_owner_manifest(&mut tx, &mut owner)?;
        Ok(OwnerCreation {
            id: id.clone(),
            phase: OwnerPhase::Active,
            lease: Some(lease),
        })
    }
    pub(super) fn recover_manifest_owner(
        &self,
        scope: &Scope,
        id: &str,
    ) -> Result<Option<OwnerLease>> {
        let mut tx = self.store.transaction()?;
        let mut owner = self.owner(&tx, scope, id)?;
        self.recover_manifest_initialization(&mut tx, &mut owner)
    }
}
fn pause(step: &str, id: &str) {
    #[cfg(all(test, target_os = "linux"))]
    super::tests::pause_owner_init_test_hook(step, id);
    #[cfg(not(all(test, target_os = "linux")))]
    let _ = (step, id);
}
