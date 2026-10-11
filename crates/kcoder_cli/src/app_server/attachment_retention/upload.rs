//! Exact-ID upload producer. Metadata transactions never hold byte IO/fsync.
use super::*;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};

fn generation(id: &str, prefix: &str, namespace: &str) -> Result<u64> {
    let (actual, epoch) =
        retention_upload_generation_id(id, prefix).map_err(|_| RetentionFailure::Conflict)?;
    ensure!(actual == namespace, RetentionFailure::Conflict);
    Ok(epoch)
}
fn key(id: &str) -> String {
    format!("upload-generation-v1:{id}")
}
fn range_hash(file: &mut File, offset: u64, length: u64) -> Result<String> {
    file.seek(SeekFrom::Start(offset))?;
    let mut remaining = length;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    while remaining != 0 {
        let count = file.read(&mut buffer[..remaining.min(64 * 1024) as usize])?;
        ensure!(count != 0, RetentionFailure::CompletionUnknown);
        hash.update(&buffer[..count]);
        remaining -= count as u64;
    }
    Ok(format!("{:x}", hash.finalize()))
}
impl RetentionService {
    pub fn upload_admission(&self) -> Result<RetentionUploadAdmissionV1> {
        let tx = self.store.transaction()?;
        Ok(RetentionUploadAdmissionV1 {
            version: 1,
            root_namespace: self.namespace().into(),
            admission_epoch: tx.state.upload_admission_epoch(&self.store.header.limits)?,
        })
    }
    /// Invoked inside the SAME first owner transaction, before any checkpoint.
    pub(super) fn reserve_wire_upload(
        &self,
        tx: &mut Transaction<'_>,
        scope: &Scope,
        owner: &mut Owner,
        params: &RetentionUploadParamsV1,
    ) -> Result<Entry> {
        let epoch = generation(&params.client_upload_id, "u1", self.namespace())?;
        let size = params.size.context("upload size missing")?;
        let sha = params
            .content_sha256
            .as_ref()
            .context("upload digest missing")?;
        let filename = params
            .filename
            .as_ref()
            .context("upload filename missing")?;
        let params_hash = digest(&serde_json::to_vec(&(
            filename,
            size,
            sha,
            &params.owner_request,
        ))?);
        let locator = key(&params.client_upload_id);
        if let Some(index) = tx.read::<UploadIndex>(Area::Uploads, &locator)? {
            ensure!(
                index.scope_hash == scope.hash
                    && index.owner_id == owner.id
                    && index.params_hash == params_hash
                    && index.epoch == epoch,
                RetentionFailure::Conflict
            );
            let entry: Entry = tx
                .read(Area::Entries, &index.entry_id)?
                .context("upload entry missing")?;
            ensure!(
                entry.client_upload_id == params.client_upload_id
                    && entry.params_hash == params_hash
                    && entry.scope_hash == scope.hash
                    && entry.owner_id == owner.id
                    && entry
                        .upload
                        .as_ref()
                        .is_some_and(|u| u.filename == *filename),
                RetentionFailure::Conflict
            );
            return Ok(entry);
        }
        tx.assert_unregistered(Area::Uploads, &locator)?;
        ensure!(epoch > tx.state.retired_through, RetentionFailure::Conflict);
        ensure!(
            size <= self.store.header.limits.entry_bytes && owner.phase != OwnerPhase::Unknown,
            RetentionFailure::Conflict
        );
        ensure!(
            owner.entries.len() < self.store.header.limits.entries_per_owner,
            RetentionFailure::Capacity
        );
        let mut pending = 0;
        for id in &owner.entries {
            let entry: Entry = tx.read(Area::Entries, id)?.context("owner entry missing")?;
            if matches!(entry.phase, EntryPhase::Allocating | EntryPhase::Sealing) {
                pending += 1;
            }
        }
        ensure!(
            pending < self.store.header.limits.pending_uploads_per_owner
                && owner
                    .bytes
                    .checked_add(size)
                    .is_some_and(|n| n <= self.store.header.limits.owner_bytes),
            RetentionFailure::Capacity
        );
        tx.state
            .allocate_requested(epoch, &self.store.header.limits)?;
        let id = digest(&serde_json::to_vec(&(
            "upload-entry-v1",
            self.namespace(),
            &params.client_upload_id,
        ))?);
        let entry = Entry {
            id: id.clone(),
            owner_id: owner.id.clone(),
            epoch,
            scope_hash: scope.hash.clone(),
            client_upload_id: params.client_upload_id.clone(),
            params_hash: params_hash.clone(),
            size,
            content_sha256: sha.clone(),
            phase: EntryPhase::Allocating,
            revision: 1,
            directory_identity: Some(self.store.data()?.retention_identity()?),
            payload_identity: None,
            retention_id: None,
            quarantine: format!("q-u-entry-{id}"),
            transfer: None,
            cleanup_capacity: RECORD_BYTES,
            upload: Some(UploadProgress {
                storage_layout: UploadStorageLayout::RootLeafV1,
                filename: filename.clone(),
                confirmed_bytes: 0,
                pending: None,
                payload_publishing: false,
            }),
        };
        owner.entries.push(id.clone());
        owner.bytes += size;
        tx.state.charges.entries += 1;
        tx.state.charges.receipt_slots += 1;
        tx.state.charges.staged_bytes += size;
        tx.put(Area::Entries, &id, epoch, &entry)?;
        tx.put(
            Area::Uploads,
            &locator,
            epoch,
            &UploadIndex {
                scope_hash: scope.hash.clone(),
                owner_id: owner.id.clone(),
                entry_id: id,
                params_hash,
                epoch,
            },
        )?;
        Ok(entry)
    }
    fn wire_upload_entry(
        &self,
        tx: &Transaction<'_>,
        scope: &Scope,
        params: &RetentionUploadParamsV1,
    ) -> Result<Option<Entry>> {
        let epoch = generation(&params.client_upload_id, "u1", self.namespace())?;
        let (owner_id, owner_hash) = self.owner_request_locator(scope, &params.owner_request)?;
        let owner = tx.read::<Owner>(Area::Owners, &owner_id)?;
        if let Some(owner) = &owner {
            self.owner_request_match(owner, scope, &params.owner_request, &owner_id, &owner_hash)?;
        } else {
            tx.assert_unregistered(Area::Owners, &owner_id)?;
        }
        let locator = key(&params.client_upload_id);
        let Some(index) = tx.read::<UploadIndex>(Area::Uploads, &locator)? else {
            tx.assert_unregistered(Area::Uploads, &locator)?;
            return Ok(None);
        };
        ensure!(
            index.scope_hash == scope.hash && index.owner_id == owner_id && index.epoch == epoch,
            RetentionFailure::Conflict
        );
        ensure!(owner.is_some(), RetentionFailure::CompletionUnknown);
        let entry: Entry = tx
            .read(Area::Entries, &index.entry_id)?
            .context("upload index entry missing")?;
        ensure!(
            entry.scope_hash == scope.hash
                && entry.owner_id == owner_id
                && entry.epoch == epoch
                && entry.client_upload_id == params.client_upload_id
                && entry.params_hash == index.params_hash
                && entry.upload.is_some(),
            RetentionFailure::Conflict
        );
        ensure!(
            entry.phase != EntryPhase::Allocating || entry.transfer.is_none(),
            RetentionFailure::CompletionUnknown
        );
        Ok(Some(entry))
    }
    fn upload_result(
        &self,
        scope: &Scope,
        params: &RetentionUploadParamsV1,
        entry: &Entry,
    ) -> Result<RetentionUploadResultV1> {
        let progress = entry.upload.as_ref().context("upload progress missing")?;
        let state = match entry.phase {
            EntryPhase::Allocating if progress.confirmed_bytes == 0 => {
                RetentionUploadStateV1::Allocating
            }
            EntryPhase::Allocating | EntryPhase::Sealing => RetentionUploadStateV1::Uploading,
            EntryPhase::Sealed | EntryPhase::Ready => RetentionUploadStateV1::Sealed,
            EntryPhase::Cancelled | EntryPhase::Released => RetentionUploadStateV1::Cancelled,
            _ => RetentionUploadStateV1::Unknown,
        };
        Ok(RetentionUploadResultV1 {
            client_owner_request_id: params.owner_request.client_owner_request_id.clone(),
            client_upload_id: params.client_upload_id.clone(),
            scope_id: scope.hash.clone(),
            lookup: RetentionUploadLookupV1::Present {
                filename: progress.filename.clone(),
                size: entry.size,
                content_sha256: entry.content_sha256.clone(),
                recovery: RetentionUploadRecoveryV1 {
                    root_namespace: self.namespace().into(),
                    epoch: entry.epoch,
                    state,
                    confirmed_bytes: progress.confirmed_bytes,
                    stage_ref: matches!(entry.phase, EntryPhase::Sealed | EntryPhase::Ready)
                        .then(|| stage(self.namespace(), entry)),
                },
            },
        })
    }
    fn read_entry_with_lease(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        params: &RetentionUploadParamsV1,
    ) -> Result<Entry> {
        let tx = self.store.transaction()?;
        self.leased_owner(&tx, scope, lease)?;
        self.wire_upload_entry(&tx, scope, params)?
            .context("upload missing")
    }
    /// CAS the entire persisted upload authority, not merely a revision counter.
    fn upload_commit(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        old: &Entry,
        next: &Entry,
    ) -> Result<()> {
        let mut tx = self.store.transaction()?;
        self.leased_owner(&tx, scope, lease)?;
        let fresh: Entry = tx
            .read(Area::Entries, &old.id)?
            .context("upload journal missing")?;
        ensure!(
            serde_json::to_value(&fresh)? == serde_json::to_value(old)?,
            RetentionFailure::CompletionUnknown
        );
        tx.put(Area::Entries, &next.id, next.epoch, next)?;
        tx.commit()
    }
    pub(super) fn upload_location(&self, entry: &Entry) -> Result<(PrivateDirectory, String)> {
        let data = self.store.data()?;
        let identity = entry
            .directory_identity
            .as_ref()
            .context("upload parent unproven")?;
        match entry.storage_layout() {
            UploadStorageLayout::DirectoryV1 => Ok((
                data.open_verified_child(OsStr::new(&entry.id), identity)?,
                "payload".into(),
            )),
            UploadStorageLayout::RootLeafV1 => {
                ensure!(
                    entry.id.len() == 64
                        && entry.id.bytes().all(|byte| byte.is_ascii_hexdigit())
                        && entry.quarantine == format!("q-u-entry-{}", entry.id),
                    RetentionFailure::CompletionUnknown
                );
                data.verify_retention_identity(identity)?;
                Ok((data, entry.upload_leaf()))
            }
        }
    }
    fn upload_file(&self, entry: &Entry) -> Result<(PrivateDirectory, File)> {
        let (directory, name) = self.upload_location(entry)?;
        let expected = entry
            .payload_identity
            .as_ref()
            .context("upload payload unproven")?;
        let file = directory.open_verified_read_write_regular(OsStr::new(&name), expected)?;
        Ok((directory, file))
    }
    pub(super) fn upload_quarantine_absent(&self, entry: &Entry) -> Result<()> {
        let data = self.store.data()?;
        match entry.storage_layout() {
            UploadStorageLayout::RootLeafV1 => {
                match data.open_regular_file(OsStr::new(&entry.quarantine)) {
                    Err(error) if missing(&error) => Ok(()),
                    Ok(_) => anyhow::bail!(RetentionFailure::CompletionUnknown),
                    Err(error) => Err(error),
                }
            }
            UploadStorageLayout::DirectoryV1 => {
                match data.open_child(OsStr::new(&entry.quarantine), false) {
                    Err(error) if missing(&error) => Ok(()),
                    Ok(_) => anyhow::bail!(RetentionFailure::CompletionUnknown),
                    Err(error) => Err(error),
                }
            }
        }
    }
    fn ensure_upload_file(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        entry: &mut Entry,
    ) -> Result<()> {
        if entry.directory_identity.is_none() {
            ensure!(
                entry.storage_layout() == UploadStorageLayout::DirectoryV1,
                RetentionFailure::CompletionUnknown
            );
            let data = self.store.data()?;
            // A preexisting object without a recorded identity is never adopted.
            match data.open_child(OsStr::new(&entry.id), false) {
                Err(error) if missing(&error) => (),
                Ok(_) => anyhow::bail!(RetentionFailure::CompletionUnknown),
                Err(error) => return Err(error),
            }
            let directory = data.open_child(OsStr::new(&entry.id), true)?;
            upload_pause("directory-created", &entry.id);
            let mut next = entry.clone();
            next.directory_identity = Some(directory.retention_identity()?);
            data.sync()?;
            self.upload_commit(scope, lease, entry, &next)?;
            *entry = next;
        }
        ensure!(
            !entry.upload.as_ref().unwrap().payload_publishing || entry.payload_identity.is_some(),
            RetentionFailure::CompletionUnknown
        );
        let (directory, payload_name) = self.upload_location(entry)?;
        let unpublished = if entry.upload.as_ref().unwrap().payload_publishing {
            match directory.open_regular_file(OsStr::new(&payload_name)) {
                Err(error) if missing(&error) => true,
                Ok(_) => false,
                Err(error) => return Err(error),
            }
        } else {
            false
        };
        if entry.payload_identity.is_none() || unpublished {
            let progress = entry.upload.as_ref().unwrap();
            // A lost anonymous inode can be replaced only before any byte was
            // admitted. Never adopt an existing payload or quarantine object.
            ensure!(
                entry.phase == EntryPhase::Allocating
                    && entry.retention_id.is_none()
                    && entry.transfer.is_none()
                    && progress.confirmed_bytes == 0
                    && progress.pending.is_none(),
                RetentionFailure::CompletionUnknown
            );
            match directory.open_regular_file(OsStr::new(&payload_name)) {
                Err(error) if missing(&error) => (),
                Ok(_) => anyhow::bail!(RetentionFailure::CompletionUnknown),
                Err(error) => return Err(error),
            }
            let data = self.store.data()?;
            self.upload_quarantine_absent(entry)?;
            directory.sync()?;
            data.sync()?;
            let mut anonymous = directory.create_anonymous_private_entry()?;
            anonymous.seal(&[])?;
            upload_pause("payload-anonymous-sealed", &entry.id);
            let mut next = entry.clone();
            next.payload_identity = Some(anonymous.identity().clone());
            next.upload.as_mut().unwrap().payload_publishing = true;
            self.upload_commit(scope, lease, entry, &next)?;
            *entry = next;
            upload_pause("payload-publishing", &entry.id);
            directory.publish_anonymous_private_entry(&anonymous, OsStr::new(&payload_name))?;
            upload_pause("payload-linked", &entry.id);
            directory.sync()?;
            upload_pause("payload-parent-synced", &entry.id);
        }
        if entry.upload.as_ref().unwrap().payload_publishing {
            // After a crash only this exact published inode can be recovered.
            let (directory, file) = self.upload_file(entry)?;
            ensure!(
                file.metadata()?.len() == 0,
                RetentionFailure::CompletionUnknown
            );
            file.sync_all()?;
            directory.sync()?;
            let mut next = entry.clone();
            next.upload.as_mut().unwrap().payload_publishing = false;
            self.upload_commit(scope, lease, entry, &next)?;
            *entry = next;
        }
        Ok(())
    }
    fn settle_upload_chunk(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        entry: &mut Entry,
    ) -> Result<()> {
        let Some(pending) = entry.upload.as_ref().unwrap().pending.clone() else {
            return Ok(());
        };
        let (directory, mut file) = self.upload_file(entry)?;
        let end = pending
            .offset
            .checked_add(pending.length)
            .context("upload range overflow")?;
        let actual = file.metadata()?.len();
        ensure!(
            pending.offset == entry.upload.as_ref().unwrap().confirmed_bytes
                && actual >= pending.offset
                && actual <= end
                && end <= entry.size,
            RetentionFailure::CompletionUnknown
        );
        if actual != end {
            return Ok(());
        }
        ensure!(
            range_hash(&mut file, pending.offset, pending.length)? == pending.sha256,
            RetentionFailure::CompletionUnknown
        );
        file.sync_all()?;
        directory.sync()?;
        let mut next = entry.clone();
        let progress = next.upload.as_mut().unwrap();
        progress.confirmed_bytes = end;
        progress.pending = None;
        self.upload_commit(scope, lease, entry, &next)?;
        *entry = next;
        Ok(())
    }
    pub fn start_wire_upload(
        &self,
        scope: &Scope,
        params: &RetentionUploadParamsV1,
    ) -> Result<RetentionUploadResultV1> {
        // Preflight foreign/global IDs before even initializing an owner.
        {
            let tx = self.store.transaction()?;
            self.wire_upload_entry(&tx, scope, params)?;
        }
        let created = self.create_owner_with_upload(scope, &params.owner_request, Some(params))?;
        let lease = created
            .lease
            .context("upload owner initialization unknown or busy")?;
        let mut entry = self.read_entry_with_lease(scope, &lease, params)?;
        if !entry.phase.physical_terminal() && !matches!(entry.phase, EntryPhase::Unknown) {
            self.ensure_upload_file(scope, &lease, &mut entry)?;
            self.settle_upload_chunk(scope, &lease, &mut entry)?;
        }
        self.upload_result(scope, params, &entry)
    }
    pub fn read_wire_upload(
        &self,
        scope: &Scope,
        params: &RetentionUploadParamsV1,
    ) -> Result<RetentionUploadResultV1> {
        let epoch = generation(&params.client_upload_id, "u1", self.namespace())?;
        let entry = {
            let tx = self.store.transaction()?;
            let entry = self.wire_upload_entry(&tx, scope, params)?;
            if entry.is_none() {
                let lookup = match retired(&tx, self.namespace(), epoch)? {
                    Some(proof) => RetentionUploadLookupV1::EpochRetired { proof },
                    None => RetentionUploadLookupV1::Absent,
                };
                return Ok(RetentionUploadResultV1 {
                    client_owner_request_id: params.owner_request.client_owner_request_id.clone(),
                    client_upload_id: params.client_upload_id.clone(),
                    scope_id: scope.hash.clone(),
                    lookup,
                });
            }
            entry.unwrap()
        };
        if entry.phase.physical_terminal() {
            return self.upload_result(scope, params, &entry);
        }
        let owner = self
            .read_owner_request(scope, &params.owner_request)?
            .context("upload owner missing")?;
        let lease = owner.lease.context("upload owner unknown or busy")?;
        let mut entry = self.read_entry_with_lease(scope, &lease, params)?;
        // Existing publication recovery may replace only a proven lost EMPTY
        // anonymous inode. An absent ID read above never initializes an owner.
        if entry.upload.as_ref().unwrap().payload_publishing {
            self.ensure_upload_file(scope, &lease, &mut entry)?;
        }
        self.settle_upload_chunk(scope, &lease, &mut entry)?;
        self.upload_result(scope, params, &entry)
    }
    pub fn chunk_wire_upload(
        &self,
        scope: &Scope,
        params: &RetentionUploadParamsV1,
        bytes: &[u8],
    ) -> Result<RetentionUploadResultV1> {
        let length = params.length.context("upload length missing")?;
        let offset = params.offset.context("upload offset missing")?;
        let sha = params
            .chunk_sha256
            .as_ref()
            .context("chunk digest missing")?;
        ensure!(
            length > 0
                && length <= RETENTION_UPLOAD_CHUNK_BYTES
                && bytes.len() as u64 == length
                && digest(bytes) == *sha,
            RetentionFailure::Conflict
        );
        let owner = self
            .read_owner_request(scope, &params.owner_request)?
            .context("upload owner missing")?;
        let lease = owner.lease.context("upload owner unknown or busy")?;
        let _operation = lease
            .operation
            .lock()
            .map_err(|_| anyhow::anyhow!("upload operation lock poisoned"))?;
        let mut entry = self.read_entry_with_lease(scope, &lease, params)?;
        ensure!(
            matches!(
                entry.phase,
                EntryPhase::Allocating
                    | EntryPhase::Sealing
                    | EntryPhase::Sealed
                    | EntryPhase::Ready
            ),
            RetentionFailure::Conflict
        );
        let end = offset
            .checked_add(length)
            .context("upload range overflow")?;
        ensure!(end <= entry.size, RetentionFailure::Conflict);
        self.ensure_upload_file(scope, &lease, &mut entry)?;
        self.settle_upload_chunk(scope, &lease, &mut entry)?;
        let progress = entry.upload.as_ref().unwrap();
        if end <= progress.confirmed_bytes {
            let (_, mut file) = self.upload_file(&entry)?;
            file.seek(SeekFrom::Start(offset))?;
            let mut actual = vec![0; bytes.len()];
            file.read_exact(&mut actual)?;
            ensure!(actual == bytes, RetentionFailure::Conflict);
            return self.upload_result(scope, params, &entry);
        }
        ensure!(
            offset == progress.confirmed_bytes && entry.phase == EntryPhase::Allocating,
            RetentionFailure::Conflict
        );
        let pending = PendingUploadChunk {
            offset,
            length,
            sha256: sha.clone(),
        };
        ensure!(
            progress.pending.as_ref().is_none_or(|p| p == &pending),
            RetentionFailure::Conflict
        );
        // Payload identity is already durable. No bytes execute under this tx.
        let mut next = entry.clone();
        next.upload.as_mut().unwrap().pending = Some(pending);
        self.upload_commit(scope, &lease, &entry, &next)?;
        entry = next;
        upload_pause("pending", &entry.id);
        let (directory, mut file) = self.upload_file(&entry)?;
        ensure!(
            file.metadata()?.len() >= offset && file.metadata()?.len() <= end,
            RetentionFailure::CompletionUnknown
        );
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(bytes)?;
        upload_pause("written", &entry.id);
        file.sync_all()?;
        directory.sync()?;
        upload_pause("synced", &entry.id);
        self.settle_upload_chunk(scope, &lease, &mut entry)?;
        self.upload_result(scope, params, &entry)
    }
    pub fn finish_wire_upload(
        &self,
        scope: &Scope,
        params: &RetentionUploadParamsV1,
    ) -> Result<RetentionUploadResultV1> {
        let owner = self
            .read_owner_request(scope, &params.owner_request)?
            .context("upload owner missing")?;
        let lease = owner.lease.context("upload owner unknown or busy")?;
        let mut entry = self.read_entry_with_lease(scope, &lease, params)?;
        if matches!(entry.phase, EntryPhase::Sealed | EntryPhase::Ready) {
            return self.upload_result(scope, params, &entry);
        }
        ensure!(
            matches!(entry.phase, EntryPhase::Allocating | EntryPhase::Sealing),
            RetentionFailure::Conflict
        );
        self.ensure_upload_file(scope, &lease, &mut entry)?;
        self.settle_upload_chunk(scope, &lease, &mut entry)?;
        ensure!(
            entry.upload.as_ref().unwrap().confirmed_bytes == entry.size
                && entry.upload.as_ref().unwrap().pending.is_none(),
            RetentionFailure::Conflict
        );
        let mut next = entry.clone();
        next.phase = EntryPhase::Sealing;
        self.upload_commit(scope, &lease, &entry, &next)?;
        entry = next;
        let (directory, mut file) = self.upload_file(&entry)?;
        ensure!(
            file.metadata()?.len() == entry.size
                && range_hash(&mut file, 0, entry.size)? == entry.content_sha256,
            RetentionFailure::CompletionUnknown
        );
        file.sync_all()?;
        directory.sync()?;
        upload_pause("sealed", &entry.id);
        let mut next = entry.clone();
        next.phase = EntryPhase::Sealed;
        self.upload_commit(scope, &lease, &entry, &next)?;
        entry = next;
        self.upload_result(scope, params, &entry)
    }
    fn root_upload_absent(parent: &PrivateDirectory, name: &str) -> Result<()> {
        match parent.open_regular_file(OsStr::new(name)) {
            Err(error) if missing(&error) => Ok(()),
            Ok(_) => anyhow::bail!(RetentionFailure::CompletionUnknown),
            Err(error) => Err(error),
        }
    }
    pub(super) fn release_root_upload_entry(
        &self,
        scope: &Scope,
        lease: &OwnerLease,
        mut entry: Entry,
    ) -> Result<()> {
        ensure!(
            entry.storage_layout() == UploadStorageLayout::RootLeafV1,
            RetentionFailure::CompletionUnknown
        );
        if entry.phase.physical_terminal() {
            return Ok(());
        }
        let (parent, source) = self.upload_location(&entry)?;
        if entry.phase == EntryPhase::ReleasePending {
            let mut next = entry.clone();
            if let Some(identity) = &entry.payload_identity {
                parent.open_verified_regular(OsStr::new(&source), identity)?;
                next.phase = EntryPhase::RenamePending;
            } else {
                let progress = entry.upload.as_ref().context("upload progress missing")?;
                ensure!(
                    entry.retention_id.is_none()
                        && entry.transfer.is_none()
                        && progress.confirmed_bytes == 0
                        && progress.pending.is_none()
                        && !progress.payload_publishing,
                    RetentionFailure::CompletionUnknown
                );
                Self::root_upload_absent(&parent, &source)?;
                Self::root_upload_absent(&parent, &entry.quarantine)?;
                parent.sync()?;
                next.phase = EntryPhase::PayloadGone;
            }
            self.upload_commit(scope, lease, &entry, &next)?;
            entry = next;
        }
        if entry.phase == EntryPhase::RenamePending {
            let identity = entry
                .payload_identity
                .as_ref()
                .context("upload inode missing")?;
            match parent.open_verified_regular(OsStr::new(&entry.quarantine), identity) {
                Ok(_) => {
                    Self::root_upload_absent(&parent, &source)?;
                    parent.sync()?;
                }
                Err(error) if missing(&error) => {
                    parent.open_verified_regular(OsStr::new(&source), identity)?;
                    parent.quarantine_verified_entry_unflushed(
                        OsStr::new(&source),
                        identity,
                        OsStr::new(&entry.quarantine),
                    )?;
                    parent.sync()?;
                }
                Err(error) => return Err(error),
            }
            upload_pause("release-renamed", &entry.id);
            let mut next = entry.clone();
            next.phase = EntryPhase::Quarantined;
            self.upload_commit(scope, lease, &entry, &next)?;
            entry = next;
            upload_pause("release-quarantined", &entry.id);
        }
        if entry.phase == EntryPhase::Quarantined {
            Self::root_upload_absent(&parent, &source)?;
            let identity = entry
                .payload_identity
                .as_ref()
                .context("upload inode missing")?;
            match parent.open_verified_regular(OsStr::new(&entry.quarantine), identity) {
                Ok(_) => {
                    parent.unlink_verified_regular_leaf_unflushed(
                        OsStr::new(&entry.quarantine),
                        identity,
                    )?;
                    parent.sync()?;
                }
                Err(error) if missing(&error) => parent.sync()?,
                Err(error) => return Err(error),
            }
            upload_pause("release-unlinked", &entry.id);
            let mut next = entry.clone();
            next.phase = EntryPhase::PayloadGone;
            self.upload_commit(scope, lease, &entry, &next)?;
            entry = next;
        }
        ensure!(
            entry.phase == EntryPhase::PayloadGone,
            RetentionFailure::CompletionUnknown
        );
        Self::root_upload_absent(&parent, &source)?;
        Self::root_upload_absent(&parent, &entry.quarantine)?;
        parent.sync()?;
        let mut tx = self.store.transaction()?;
        let mut owner = self.leased_owner(&tx, scope, lease)?;
        let mut current: Entry = tx
            .read(Area::Entries, &entry.id)?
            .context("upload completion missing")?;
        ensure!(
            serde_json::to_value(&current)? == serde_json::to_value(&entry)?,
            RetentionFailure::CompletionUnknown
        );
        current.phase = if current.retention_id.is_none() {
            EntryPhase::Cancelled
        } else {
            EntryPhase::Released
        };
        if current.retention_id.is_none() {
            decrement(&mut tx.state.charges.entries, 1)?;
            decrement(&mut tx.state.charges.receipt_slots, 1)?;
        }
        decrement(&mut tx.state.charges.staged_bytes, current.size)?;
        decrement(&mut owner.bytes, current.size)?;
        decrement(
            &mut tx
                .state
                .epochs
                .get_mut(&entry.epoch)
                .context("upload epoch missing")?
                .nonterminal_allocations,
            1,
        )?;
        tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
        tx.put(Area::Entries, &current.id, current.epoch, &current)?;
        tx.commit()
    }
    pub fn cancel_wire_upload(
        &self,
        scope: &Scope,
        params: &RetentionUploadParamsV1,
    ) -> Result<RetentionUploadResultV1> {
        {
            let tx = self.store.transaction()?;
            self.wire_upload_entry(&tx, scope, params)?;
        }
        let owner = self
            .read_owner_request(scope, &params.owner_request)?
            .context("upload owner missing")?;
        let lease = owner.lease.context("upload owner unknown or busy")?;
        let mut entry = self.read_entry_with_lease(scope, &lease, params)?;
        if entry.phase.physical_terminal() {
            return self.upload_result(scope, params, &entry);
        }
        ensure!(
            entry.retention_id.is_none()
                && matches!(
                    entry.phase,
                    EntryPhase::Allocating
                        | EntryPhase::Sealing
                        | EntryPhase::Sealed
                        | EntryPhase::ReleasePending
                        | EntryPhase::RenamePending
                        | EntryPhase::Quarantined
                        | EntryPhase::PayloadGone
                ),
            RetentionFailure::Conflict
        );
        // A valid start returns only after creating the pinned empty payload.
        // Unknown pre-publication objects are preserved rather than guessed away.
        if matches!(
            entry.phase,
            EntryPhase::Allocating | EntryPhase::Sealing | EntryPhase::Sealed
        ) {
            if entry.storage_layout() != UploadStorageLayout::RootLeafV1
                || entry.payload_identity.is_some()
            {
                self.ensure_upload_file(scope, &lease, &mut entry)?;
            }
            let mut next = entry.clone();
            next.phase = EntryPhase::ReleasePending;
            self.upload_commit(scope, &lease, &entry, &next)?;
            entry = next;
        }
        self.release_entry(scope, &lease, &entry.id)?;
        entry = self.read_entry_with_lease(scope, &lease, params)?;
        self.upload_result(scope, params, &entry)
    }
}
fn upload_pause(phase: &str, id: &str) {
    #[cfg(all(test, target_os = "linux"))]
    if std::env::var("KCODER_TEST_UPLOAD_CRASH_PHASE")
        .ok()
        .as_deref()
        == Some(phase)
        && std::env::var("KCODER_TEST_UPLOAD_CRASH_ID").ok().as_deref() == Some(id)
    {
        super::tests::pause_owner_init_test_hook(&format!("v2-upload-{phase}"), id);
    }
    #[cfg(not(all(test, target_os = "linux")))]
    let _ = (phase, id);
}
