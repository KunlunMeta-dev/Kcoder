//! A discovery grant binds filesystem identities before a selected source is hashed.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct HistoryFileSelection {
    root: PathBuf,
    relative: PathBuf,
    root_identity: String,
    parent_identity: String,
    file_identity: String,
    pub bytes: u64,
    pub modified_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uploaded: Option<Box<crate::source_transfer::uploads::UploadedRootBinding>>,
}

impl HistoryFileSelection {
    /// Private catalog ordering only; this is never a target path or an additional read grant.
    pub(crate) fn relative_path(&self) -> &Path {
        &self.relative
    }

    pub(crate) fn from_binding(binding: &HistorySourceBinding) -> Result<Self> {
        let selected = Self::inspect(
            &binding.root,
            &binding.relative,
            &binding.root_identity,
            &binding.parent_identity,
        )?;
        ensure!(
            selected.matches_binding(binding),
            "migration_history_source_changed"
        );
        Ok(selected)
    }

    pub fn inspect(
        root: &Path,
        relative: &Path,
        root_identity: &str,
        parent_identity: &str,
    ) -> Result<Self> {
        let selected = open_selected(root, relative)?;
        ensure!(
            selected.root_identity == root_identity && selected.parent_identity == parent_identity,
            "migration_history_source_changed"
        );
        let metadata = selected.file.metadata()?;
        Ok(Self {
            root: root.into(),
            relative: relative.into(),
            root_identity: selected.root_identity,
            parent_identity: selected.parent_identity,
            file_identity: selected.file_identity,
            bytes: metadata.len(),
            modified_at_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|duration| duration.as_millis().try_into().ok()),
            uploaded: None,
        })
    }

    pub fn open(&self) -> Result<File> {
        if let Some(uploaded) = &self.uploaded {
            uploaded.verify(&self.root, uploaded.source())?;
            let expected = uploaded.expected_file(&self.root.join(&self.relative))?;
            ensure!(
                expected.bytes == self.bytes,
                "source_upload_product_content_changed"
            );
        }
        let selected = open_selected(&self.root, &self.relative)?;
        ensure!(
            selected.root_identity == self.root_identity
                && selected.parent_identity == self.parent_identity
                && selected.file_identity == self.file_identity,
            "migration_history_source_changed"
        );
        Ok(selected.file)
    }

    pub fn compressed(&self) -> bool {
        encoded::is_zstd(&self.relative)
    }

    pub fn freeze(&self) -> Result<Self> {
        let mut selected = self.clone();
        selected.bytes = self.open()?.metadata()?.len();
        ensure!(
            self.uploaded.is_none() || selected.bytes == self.bytes,
            "source_upload_product_content_changed"
        );
        ensure!(
            selected.bytes >= self.bytes,
            "migration_history_source_changed"
        );
        ensure!(
            selected.bytes <= EXTERNAL_HISTORY_MAX_BYTES,
            "migration_history_source_budget_exceeded"
        );
        Ok(selected)
    }

    pub fn selection_identity(&self) -> Result<String> {
        if let Some(uploaded) = &self.uploaded {
            return Ok(format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    "user-upload-history/1",
                    uploaded,
                    &self.relative,
                    &self.file_identity
                ))?)
            ));
        }
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &self.root,
                &self.relative,
                &self.root_identity,
                &self.parent_identity,
                &self.file_identity,
            ))?)
        ))
    }

    pub fn matches_binding(&self, binding: &HistorySourceBinding) -> bool {
        binding.root == self.root
            && binding.relative == self.relative
            && binding.root_identity == self.root_identity
            && binding.parent_identity == self.parent_identity
            && binding.file_identity == self.file_identity
            && binding.physical_bytes() == self.bytes
    }

    pub fn capture(
        &self,
        mut origin: ExternalHistoryOrigin,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<HistorySourceBinding> {
        ensure!(
            self.open()?.metadata()?.len() >= self.bytes,
            "migration_history_source_changed"
        );
        if let Some(uploaded) = &self.uploaded {
            origin.source_instance = uploaded.provenance_tag();
        }
        let mut binding = HistorySourceBinding::capture_at(
            &self.root,
            &self.relative,
            origin,
            Some(self.bytes),
            check,
        )?;
        ensure!(
            binding.root_identity == self.root_identity
                && binding.parent_identity == self.parent_identity
                && binding.file_identity == self.file_identity
                && binding.physical_bytes() == self.bytes,
            "migration_history_source_changed"
        );
        if let Some(uploaded) = &self.uploaded {
            binding = binding.with_uploaded_source(Some(uploaded.provenance()));
            let expected = uploaded.expected_file(&self.root.join(&self.relative))?;
            let snapshot = binding.snapshot();
            let (bytes, sha) = snapshot.original.as_ref().map_or(
                (snapshot.source_bytes, snapshot.source_sha256.as_str()),
                |original| (original.bytes, original.sha256.as_str()),
            );
            ensure!(
                expected.bytes == bytes && expected.sha256 == sha,
                "source_upload_product_content_changed"
            );
        }
        Ok(binding)
    }

    pub(crate) fn with_uploaded_root(
        mut self,
        binding: crate::source_transfer::uploads::UploadedRootBinding,
    ) -> Result<Self> {
        binding.verify(&self.root, binding.source())?;
        let expected = binding.expected_file(&self.root.join(&self.relative))?;
        ensure!(
            expected.bytes == self.bytes,
            "source_upload_product_content_changed"
        );
        self.modified_at_ms = None;
        self.uploaded = Some(Box::new(binding));
        Ok(self)
    }

    pub fn cost(&self) -> usize {
        self.root.as_os_str().len()
            + self.relative.as_os_str().len()
            + self.root_identity.len()
            + self.parent_identity.len()
            + self.file_identity.len()
            + 256
    }
}
