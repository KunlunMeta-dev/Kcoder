use super::*;
use kcoder_types::migration::MigrationSourceKind;

/// Private Native provenance. Deserialization is only for owned migration journals,
/// never an RPC grant or a claim about the browser's original machine/account.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadedRootBinding {
    profile: PathBuf,
    profile_identity: String,
    authority: TransferAuthority,
    operation_id: String,
    manifest_sha256: String,
    receipt_sha256: String,
    source: MigrationSourceKind,
}

impl UploadedRootBinding {
    pub(super) fn capture(
        store: &SourceUploads,
        material: &Store,
        operation_id: &str,
        manifest_sha256: String,
        receipt: ProductReceipt,
    ) -> Result<Self> {
        let binding = Self {
            profile: store.store.profile.clone(),
            profile_identity: store.store.identity.clone(),
            authority: store.store.authority.clone(),
            operation_id: operation_id.into(),
            manifest_sha256,
            receipt_sha256: digest(&receipt)?,
            source: store.manifest(operation_id)?.source,
        };
        material.verify_authority()?;
        binding.verify(&binding.root_path()?, binding.source)?;
        Ok(binding)
    }

    pub(crate) fn source(&self) -> MigrationSourceKind {
        self.source
    }

    pub(crate) fn root_path(&self) -> Result<PathBuf> {
        valid_uuid(&self.operation_id)?;
        ensure!(
            valid_sha(&self.manifest_sha256) && valid_sha(&self.receipt_sha256),
            "source_upload_product_binding_changed"
        );
        let root = self
            .profile
            .join("migrations/source-transfer")
            .join(ROLE)
            .join(&self.operation_id)
            .join(PRODUCT);
        PrivateDirectory::open_existing(&root)?.verify_private_directory()?;
        root.canonicalize()
            .map_err(|_| anyhow::anyhow!("source_upload_product_changed"))
    }

    pub(crate) fn logical_identity(&self) -> String {
        format!(
            "{:x}",
            Sha256::digest(format!(
                "user-upload-product/1\0{}\0{}\0{}\0{}\0{}\0{}",
                self.profile_identity,
                self.authority.instance_id,
                self.authority.account_id,
                self.operation_id,
                self.manifest_sha256,
                self.receipt_sha256
            ))
        )
    }

    pub(crate) fn provenance_tag(&self) -> String {
        format!("user-upload:{}:{}", self.operation_id, self.manifest_sha256)
    }
    pub(crate) fn provenance(
        &self,
    ) -> kcoder_types::migration_source_upload::SourceUploadProvenance {
        kcoder_types::migration_source_upload::SourceUploadProvenance {
            operation_id: self.operation_id.clone(),
            manifest_sha256: self.manifest_sha256.clone(),
        }
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }

    fn scope(&self) -> Result<(PrivateDirectory, ValidatedManifest)> {
        let uploads = SourceUploads {
            store: Store::reopen_existing(
                &self.profile,
                &self.profile_identity,
                &self.authority,
                "browser-uploads",
            )?,
        };
        let (_, directory, manifest) =
            uploads.selected_product(&self.operation_id, &self.manifest_sha256)?;
        ensure!(
            manifest.manifest().source == self.source,
            "source_upload_product_binding_changed"
        );
        let receipt: ProductReceipt =
            load(&directory, RECEIPT)?.context("source_upload_product_not_ready")?;
        ensure!(
            digest(&receipt)? == self.receipt_sha256,
            "source_upload_product_receipt_changed"
        );
        verify_tree(&directory, &manifest, Some(&receipt), || Ok(()))?;
        Ok((directory, manifest))
    }

    pub(crate) fn verify(&self, root: &Path, source: MigrationSourceKind) -> Result<()> {
        ensure!(
            source == self.source && root == self.root_path()?,
            "source_upload_product_binding_changed"
        );
        self.scope()?;
        Ok(())
    }

    /// The caller provides the exact bytes returned by the existing adapter reader.
    /// Do not replace this with a hash of a different read or metadata-only success.
    pub(crate) fn verify_bytes(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let expected = self.expected_file(path)?;
        ensure!(
            bytes.len() as u64 == expected.bytes
                && format!("{:x}", Sha256::digest(bytes)) == expected.sha256,
            "source_upload_product_content_changed"
        );
        Ok(())
    }

    pub(crate) fn verify_file_set<'a>(
        &self,
        files: impl IntoIterator<Item = (PathBuf, &'a [u8])>,
    ) -> Result<()> {
        let root = self.root_path()?;
        let (_, manifest) = self.scope()?;
        for (path, bytes) in files {
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| anyhow::anyhow!("source_upload_product_scope_changed"))?;
            let relative = relative
                .components()
                .map(|part| {
                    ensure!(
                        matches!(part, std::path::Component::Normal(_)),
                        "source_upload_product_scope_changed"
                    );
                    part.as_os_str()
                        .to_str()
                        .context("source_upload_product_scope_changed")
                })
                .collect::<Result<Vec<_>>>()?
                .join("/");
            let expected = manifest
                .manifest()
                .files
                .iter()
                .find(|file| file.relative_path == relative)
                .context("source_upload_product_scope_changed")?;
            ensure!(
                bytes.len() as u64 == expected.bytes
                    && format!("{:x}", Sha256::digest(bytes)) == expected.sha256,
                "source_upload_product_content_changed"
            );
        }
        Ok(())
    }

    pub(crate) fn expected_file(&self, path: &Path) -> Result<SourceUploadFile> {
        let root = self.root_path()?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| anyhow::anyhow!("source_upload_product_scope_changed"))?;
        ensure!(
            relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
            "source_upload_product_scope_changed"
        );
        let relative = relative
            .components()
            .map(|part| {
                part.as_os_str()
                    .to_str()
                    .context("source_upload_product_scope_changed")
            })
            .collect::<Result<Vec<_>>>()?
            .join("/");
        let (_, manifest) = self.scope()?;
        manifest
            .manifest()
            .files
            .iter()
            .find(|file| file.relative_path == relative)
            .cloned()
            .context("source_upload_product_scope_changed")
    }

    /// Return one verified metadata snapshot for a copied subtree, without repeated tree probes.
    pub(crate) fn expected_subtree_files(&self, relative: &Path) -> Result<Vec<SourceUploadFile>> {
        ensure!(
            !relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_))),
            "source_upload_product_scope_changed"
        );
        let (_, manifest) = self.scope()?;
        let mut files = Vec::new();
        for file in &manifest.manifest().files {
            if let Ok(path) = Path::new(&file.relative_path).strip_prefix(relative) {
                ensure!(
                    !path.as_os_str().is_empty(),
                    "source_upload_product_scope_changed"
                );
                let path = path
                    .components()
                    .map(|part| {
                        part.as_os_str()
                            .to_str()
                            .context("source_upload_product_scope_changed")
                    })
                    .collect::<Result<Vec<_>>>()?
                    .join("/");
                files.push(SourceUploadFile {
                    relative_path: path,
                    bytes: file.bytes,
                    sha256: file.sha256.clone(),
                });
            }
        }
        ensure!(!files.is_empty(), "source_upload_product_scope_changed");
        Ok(files)
    }
}
