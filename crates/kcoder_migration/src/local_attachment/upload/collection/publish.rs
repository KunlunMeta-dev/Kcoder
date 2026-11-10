use super::*;
use std::io::{Seek, SeekFrom};

impl Operation<'_> {
    pub(in crate::local_attachment::upload) fn collection_binding(&self) -> Result<String> {
        hash(&("local-upload-collection/1", &self.grant))
    }
    pub(in crate::local_attachment::upload) fn collection_id(&self) -> Result<String> {
        hash(&(
            "local-upload-storage-retirement/1",
            self.collection_binding()?,
        ))
    }
    pub(in crate::local_attachment::upload) fn collection_birth(&self) -> Result<&Birth> {
        ensure!(
            self.grant.version == 3,
            "local_upload_collection_legacy_retained"
        );
        let birth = self
            .grant
            .collection_birth
            .as_ref()
            .context("local_upload_collection_missing_birth")?;
        self.directory
            .portable_verify_retention_identity(&birth.directory)?;
        self.store.verify()?;
        self.store
            .directory
            .portable_open_verified_child(OsStr::new(&self.grant.operation_id), &birth.directory)?;
        for (name, expected) in [
            ("writer.lock", &birth.writer),
            ("control.lock", &birth.control),
            ("collection-control.lock", &birth.collection_control),
            ("collection-writer.lock", &birth.collection_writer),
        ] {
            ensure!(
                self.directory.portable_regular_identity(OsStr::new(name))? == *expected,
                "local_upload_collection_birth_changed"
            );
        }
        ensure!(
            self.store
                .directory
                .portable_regular_identity(OsStr::new("catalog.lock"))?
                == birth.catalog,
            "local_upload_collection_birth_changed"
        );
        self.directory
            .portable_open_verified_child(OsStr::new("parts"), &birth.parts)?;
        Ok(birth)
    }
    pub(super) fn collection_record(&self) -> Result<Option<Record>> {
        let value: Option<Record> = read_json(&self.directory, "collection.json", BUDGET)?;
        if let Some(record) = &value {
            ensure!(
                record.version == 1
                    && record.binding == self.collection_binding()?
                    && record.collection_id == self.collection_id()?
                    && record.acknowledged <= record.cancel_revision
                    && record.removed.len() <= MAX_FILES
                    && record.prior_plans.len() <= 16
                    && record.prior_plans.iter().all(|digest| valid_sha(digest))
                    && record.deleted_bytes <= HISTORICAL_LOCAL_UPLOAD_MAX_BYTES * 2,
                "local_upload_collection_changed"
            );
            let mut unique = std::collections::BTreeSet::new();
            for name in &record.removed {
                slot(name)?;
                ensure!(unique.insert(name), "local_upload_collection_changed");
            }
            if let Some(name) = &record.pending {
                slot(name)?;
            }
            if let Some(plan) = &record.plan {
                ensure!(valid_sha(plan), "local_upload_collection_changed");
            }
        }
        Ok(value)
    }
    pub(in crate::local_attachment::upload) fn registered_plan_file(
        &self,
        name: &str,
    ) -> Result<bool> {
        let Some(digest) = name
            .strip_prefix("collection-plan-")
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|digest| valid_sha(digest))
        else {
            return Ok(false);
        };
        Ok(self.collection_record()?.is_some_and(|record| {
            record.plan.as_deref() == Some(digest)
                || record.prior_plans.iter().any(|known| known == digest)
        }))
    }
    pub(in crate::local_attachment::upload) fn storage_retired(&self) -> Result<bool> {
        Ok(self
            .collection_record()?
            .is_some_and(|record| record.tombstone))
    }
    pub(in crate::local_attachment::upload) fn ensure_storage_live(&self) -> Result<()> {
        ensure!(
            !self
                .collection_record()?
                .is_some_and(|record| record.tombstone),
            "local_upload_storage_retired"
        );
        Ok(())
    }
    pub(in crate::local_attachment::upload) fn target_directory(
        &self,
        name: &str,
    ) -> Result<(PrivateDirectory, String)> {
        let (parent, leaf) = slot(name)?;
        let birth = self.collection_birth()?;
        let directory = if parent.is_empty() {
            self.directory.duplicate_handle()?
        } else {
            self.directory
                .portable_open_verified_child(OsStr::new("parts"), &birth.parts)?
        };
        Ok((directory, leaf.into()))
    }
    pub(in crate::local_attachment::upload) fn proof_file(
        &self,
        name: &str,
    ) -> Result<(PrivateDirectory, String)> {
        let (directory, leaf) = self.target_directory(name)?;
        let canonical = canonical_leaf(&leaf).context("local_upload_collection_invalid_path")?;
        Ok((directory, format!("{canonical}.proof.json")))
    }
    pub(super) fn file_proofs(&self, name: &str) -> Result<Option<Versions>> {
        let (directory, leaf) = self.proof_file(name)?;
        let value: Option<Versions> = read_json(&directory, &leaf, PROOF_BYTES)?;
        if let Some(proofs) = &value {
            ensure!(
                proofs.version == 1
                    && proofs.binding == self.collection_binding()?
                    && proofs.name == logical_name(name)?
                    && proofs.manifest
                        == hash(&self.manifest()?.context("local_upload_not_begun")?)?
                    && !proofs.values.is_empty()
                    && proofs.values.len() <= 16,
                "local_upload_collection_proof_changed"
            );
            for proof in &proofs.values {
                ensure!(
                    proof.bytes <= HISTORICAL_LOCAL_UPLOAD_MAX_BYTES && valid_sha(&proof.sha256),
                    "local_upload_collection_proof_changed"
                );
            }
        }
        Ok(value)
    }
    pub(in crate::local_attachment::upload) fn append_file_proof(
        &self,
        name: &str,
        file: &File,
    ) -> Result<()> {
        ensure!(self._writer.is_some(), "local_upload_busy");
        self.ensure_storage_live()?;
        let (directory, _) = self.target_directory(name)?;
        let identity = directory.portable_regular_handle_identity(file)?;
        let bytes = file.metadata()?.len();
        ensure!(
            bytes <= HISTORICAL_LOCAL_UPLOAD_MAX_BYTES,
            "local_upload_invalid_part"
        );
        let mut input = file.try_clone()?;
        input.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        let mut read = 0;
        let mut buffer = [0; 64 * 1024];
        while read < bytes {
            self.allow()?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            read += count as u64;
            ensure!(read <= bytes, "local_upload_content_changed");
            digest.update(&buffer[..count]);
        }
        ensure!(
            read == bytes
                && file.metadata()?.len() == bytes
                && directory.portable_regular_handle_identity(file)? == identity,
            "local_upload_content_changed"
        );
        let proof = FileProof {
            temporary_name: temporary::original_temporary_name(&directory, file)?,
            identity,
            bytes,
            sha256: format!("{:x}", digest.finalize()),
        };
        let mut versions = self.file_proofs(name)?.unwrap_or(Versions {
            version: 1,
            binding: self.collection_binding()?,
            name: name.into(),
            manifest: hash(&self.manifest()?.context("local_upload_not_begun")?)?,
            values: Vec::new(),
        });
        if !versions.values.contains(&proof) {
            ensure!(
                versions.values.len() < 16,
                "local_upload_collection_proof_budget"
            );
            versions.values.push(proof);
        }
        let (directory, leaf) = self.proof_file(name)?;
        write_json(&directory, &leaf, &versions, PROOF_BYTES)
    }
    pub(super) fn verify_owned_file(
        &self,
        name: &str,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<FileProof> {
        let (directory, leaf) = self.target_directory(name)?;
        let proofs = self
            .file_proofs(name)?
            .context("local_upload_collection_missing_proof")?;
        let file = directory.open_single_link_regular_file(OsStr::new(&leaf))?;
        let identity = directory.portable_regular_handle_identity(&file)?;
        let expected = proofs
            .values
            .into_iter()
            .find(|proof| {
                proof.identity == identity
                    && (!leaf.starts_with('.') || proof.temporary_name == leaf)
            })
            .context("local_upload_collection_content_changed")?;
        parts::verify_file(&directory, &leaf, expected.bytes, &expected.sha256, check)?;
        Ok(expected)
    }
}
