use super::*;

impl OfficeStore {
    pub fn publish_artifact(
        &self,
        operation: &str,
        manifest: OfficeArtifactManifest,
        bytes: &[u8],
    ) -> Result<OfficeArtifactManifest> {
        manifest.validate()?;
        ensure!(manifest.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        ensure!(
            manifest.bytes == bytes.len() as u64 && manifest.sha256 == digest(bytes),
            "OFFICE_CONTENT_IDENTITY_MISMATCH"
        );
        let key = reference_key(&OfficeArtifactRef {
            id: manifest.id.clone(),
            revision: manifest.revision,
        });
        let blob = format!("content-{}.blob", manifest.sha256);
        self.mutate(operation, "artifact.publish", &manifest, |state| {
            if let Some(previous) = state.artifacts.get(&key) {
                ensure!(previous.manifest == manifest, "OFFICE_ARTIFACT_IMMUTABLE");
                return Ok(previous.manifest.clone());
            }
            ensure!(
                state.artifacts.len() < MAX_ARTIFACTS,
                "OFFICE_ARTIFACT_CAPACITY"
            );
            self.write_immutable_blob(&blob, bytes)?;
            state.artifacts.insert(
                key,
                StoredArtifact {
                    manifest: manifest.clone(),
                    blob,
                },
            );
            Ok(manifest.clone())
        })
    }
    pub(super) fn write_immutable_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        match self.read_optional(name, OFFICE_MAX_ARTIFACT_BYTES as usize)? {
            Some(previous) => ensure!(previous == bytes, "OFFICE_CONTENT_IMMUTABLE"),
            None => self.directory.atomic_replace(OsStr::new(name), bytes)?,
        }
        Ok(())
    }
    pub fn read_artifact(
        &self,
        reference: &OfficeArtifactRef,
    ) -> Result<Option<OfficeArtifactManifest>> {
        valid_id(&reference.id)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .artifacts
            .get(&reference_key(reference))
            .map(|record| record.manifest.clone()))
    }
    pub fn list_artifacts(&self, thread: &str) -> Result<Vec<OfficeArtifactManifest>> {
        valid_id(thread)?;
        let _lock = self.lock(false)?;
        Ok(self
            .load()?
            .artifacts
            .into_values()
            .filter_map(|record| {
                (record.manifest.task.thread_id == thread).then_some(record.manifest)
            })
            .collect())
    }
    pub fn read_artifact_chunk(
        &self,
        reference: &OfficeArtifactRef,
        offset: u64,
        limit: usize,
    ) -> Result<(Vec<u8>, u64)> {
        ensure!(
            limit > 0 && limit <= 512 * 1024,
            "OFFICE_INVALID_PAGE_LIMIT"
        );
        valid_id(&reference.id)?;
        let _lock = self.lock(false)?;
        let record = self
            .load()?
            .artifacts
            .get(&reference_key(reference))
            .cloned()
            .context("OFFICE_ARTIFACT_NOT_FOUND")?;
        ensure!(record.manifest.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        let bytes = self
            .read_optional(&record.blob, OFFICE_MAX_ARTIFACT_BYTES as usize)?
            .context("OFFICE_CONTENT_MISSING")?;
        ensure!(
            bytes.len() as u64 == record.manifest.bytes && digest(&bytes) == record.manifest.sha256,
            "OFFICE_CONTENT_CORRUPT"
        );
        ensure!(offset <= bytes.len() as u64, "OFFICE_INVALID_OFFSET");
        let start = usize::try_from(offset).context("OFFICE_INVALID_OFFSET")?;
        let end = start.saturating_add(limit).min(bytes.len());
        Ok((bytes[start..end].to_vec(), bytes.len() as u64))
    }
    pub fn create_dataset(
        &self,
        operation: &str,
        dataset: OfficeDataset,
    ) -> Result<OfficeArtifactRef> {
        dataset.validate()?;
        ensure!(dataset.owner == self.owner, "OFFICE_OWNER_MISMATCH");
        let reference = OfficeArtifactRef {
            id: dataset.id.clone(),
            revision: dataset.revision,
        };
        let key = reference_key(&reference);
        let blob = format!("dataset-{key}.json");
        let bytes = serde_json::to_vec(&dataset)?;
        let sha256 = digest(&bytes);
        self.mutate(operation, "dataset.create", &dataset, |state| {
            if let Some(previous) = state.datasets.get(&key) {
                ensure!(previous.sha256 == sha256, "OFFICE_DATASET_IMMUTABLE");
                return Ok(previous.reference.clone());
            }
            ensure!(
                state.datasets.len() < MAX_DATASETS,
                "OFFICE_DATASET_CAPACITY"
            );
            self.write_immutable_blob(&blob, &bytes)?;
            state.datasets.insert(
                key,
                StoredDataset {
                    reference: reference.clone(),
                    blob,
                    sha256,
                },
            );
            Ok(reference)
        })
    }
    pub fn read_dataset(&self, reference: &OfficeArtifactRef) -> Result<Option<OfficeDataset>> {
        valid_id(&reference.id)?;
        let _lock = self.lock(false)?;
        let Some(record) = self
            .load()?
            .datasets
            .get(&reference_key(reference))
            .cloned()
        else {
            return Ok(None);
        };
        let bytes = self
            .read_optional(&record.blob, OFFICE_MAX_DATASET_BYTES)?
            .context("OFFICE_DATASET_MISSING")?;
        ensure!(digest(&bytes) == record.sha256, "OFFICE_DATASET_CORRUPT");
        let dataset: OfficeDataset =
            serde_json::from_slice(&bytes).context("OFFICE_DATASET_CORRUPT")?;
        ensure!(
            dataset.owner == self.owner
                && dataset.id == reference.id
                && dataset.revision == reference.revision,
            "OFFICE_OWNER_MISMATCH"
        );
        dataset.validate()?;
        Ok(Some(dataset))
    }
}
