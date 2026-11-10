use super::*;

pub(super) const ROLE: &str = "browser-products";
pub(super) const INTENT: &str = "product-intent.json";
pub(super) const PROGRESS: &str = "product-progress.json";
pub(super) const RECEIPT: &str = "product-receipt.json";
pub(super) const PRODUCT: &str = "product";
pub(super) const START: &str = "product-started.json";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProductStart {
    pub version: u32,
    pub intent_sha256: String,
    pub role_directory: Option<String>,
    pub operation_directory: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Intent {
    pub version: u32,
    pub upload_directory: String,
    pub manifest: String,
    pub upload_receipt: super::super::Receipt,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Progress {
    pub stage: SourceUploadStage,
    pub copied: u64,
    pub files: u32,
    pub error: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum NodeIdentity {
    Directory(String),
    File(PortableLeaseIdentity),
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NodeBirth {
    pub relative: String,
    pub staging: String,
    pub identity: Option<NodeIdentity>,
    pub published: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProductReceipt {
    pub version: u32,
    pub intent_sha256: String,
    pub nodes_sha256: String,
    pub root_identity: String,
}

pub(super) fn node_name(relative: &str) -> String {
    format!(
        "product-node-{:x}.json",
        Sha256::digest(relative.as_bytes())
    )
}

pub(super) fn paths(manifest: &ValidatedManifest) -> BTreeMap<String, bool> {
    let mut paths = BTreeMap::from([(String::new(), true)]);
    for file in &manifest.manifest().files {
        let parts = file.relative_path.split('/').collect::<Vec<_>>();
        for count in 1..parts.len() {
            paths.insert(parts[..count].join("/"), true);
        }
        paths.insert(file.relative_path.clone(), false);
    }
    paths
}

/// Conservative metadata accounting is separate from the original two payload
/// copies. It is a quota/preflight estimate, not filesystem preallocation.
pub(super) fn metadata_budget(manifest: &ValidatedManifest) -> Result<u64> {
    let nodes = paths(manifest).len() as u64;
    ensure!(
        nodes <= 1 + 16 * 1024,
        "source_upload_product_metadata_budget"
    );
    nodes
        .checked_mul(32 * 1024)
        .and_then(|bytes| bytes.checked_add(4 * 1024 * 1024))
        .filter(|bytes| *bytes <= 2 * 1024 * 1024 * 1024)
        .context("source_upload_product_metadata_budget")
}

pub(super) fn open_parent(
    root: &PrivateDirectory,
    relative: &str,
) -> Result<(PrivateDirectory, String)> {
    let mut parent = root.duplicate_handle()?;
    let mut parts = relative.split('/').collect::<Vec<_>>();
    let leaf = parts.pop().context("source_upload_product_path_changed")?;
    for part in parts {
        parent = parent.open_child(OsStr::new(part), false)?;
        parent.verify_private_directory()?;
    }
    Ok((parent, leaf.into()))
}

pub(super) fn load_progress(
    directory: &PrivateDirectory,
    manifest: &ValidatedManifest,
) -> Result<Progress> {
    let progress: Progress =
        load(directory, PROGRESS)?.context("source_upload_product_recovery_required")?;
    ensure!(
        progress.copied <= manifest.total_bytes()
            && progress.files as usize <= manifest.manifest().files.len()
            && progress
                .error
                .as_deref()
                .is_none_or(super::super::safe_error),
        "source_upload_product_progress_changed"
    );
    Ok(progress)
}

pub(super) fn proof(directory: &PrivateDirectory, relative: &str) -> Result<NodeBirth> {
    let proof: NodeBirth =
        load(directory, &node_name(relative))?.context("source_upload_product_birth_unknown")?;
    ensure!(
        proof.relative == relative && proof.identity.is_some() && proof.published,
        "source_upload_product_birth_unknown"
    );
    Ok(proof)
}

/// A seal is computed only from originally published identities. No pathname or
/// caller-supplied identity can turn an untracked entry into a managed product.
pub(super) fn verify_tree(
    directory: &PrivateDirectory,
    manifest: &ValidatedManifest,
    expected: Option<&ProductReceipt>,
    mut check: impl FnMut() -> Result<()>,
) -> Result<ProductReceipt> {
    let intent: Intent =
        load(directory, INTENT)?.context("source_upload_product_recovery_required")?;
    ensure!(
        intent.version == 1 && intent.manifest == manifest.sha256(),
        "source_upload_product_binding_changed"
    );
    let root = directory.open_child(OsStr::new(PRODUCT), false)?;
    root.verify_private_directory()?;
    let mut hash = Sha256::new();
    let paths = paths(manifest);
    let mut children: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for path in paths.keys().filter(|path| !path.is_empty()) {
        let (parent, leaf) = path.rsplit_once('/').unwrap_or(("", path));
        children.entry(parent).or_default().insert(leaf);
    }
    for (relative, is_directory) in &paths {
        check()?;
        let birth = proof(directory, relative)?;
        let (parent, leaf) = if relative.is_empty() {
            (directory.duplicate_handle()?, PRODUCT.into())
        } else {
            open_parent(&root, relative)?
        };
        match (&birth.identity, *is_directory) {
            (Some(NodeIdentity::Directory(identity)), true) => {
                let child = parent.open_child(OsStr::new(&leaf), false)?;
                child.verify_private_directory()?;
                ensure!(
                    child.directory_identity()? == *identity,
                    "source_upload_product_changed"
                );
                // Only the original manifest may contribute discovered files. Unknown
                // additions, temporary names, links and siblings are not adopted.
                let empty = BTreeSet::new();
                let expected_children = children.get(relative.as_str()).unwrap_or(&empty);
                let mut observed = BTreeSet::new();
                child.visit_entry_names_bounded(expected_children.len() + 1, |name| {
                    let name = name.to_str().context("source_upload_product_changed")?;
                    ensure!(
                        expected_children.contains(name),
                        "source_upload_product_changed"
                    );
                    observed.insert(name.to_owned());
                    Ok(())
                })?;
                ensure!(
                    observed.len() == expected_children.len(),
                    "source_upload_product_changed"
                );
            }
            (Some(NodeIdentity::File(identity)), false) => {
                let held = parent.portable_open_verified_regular(OsStr::new(&leaf), identity)?;
                let file = manifest
                    .manifest()
                    .files
                    .iter()
                    .find(|file| &file.relative_path == relative)
                    .context("source_upload_product_changed")?;
                ensure!(
                    held.file().metadata()?.len() == file.bytes,
                    "source_upload_product_changed"
                );
            }
            _ => anyhow::bail!("source_upload_product_changed"),
        }
        hash.update(serde_json::to_vec(&birth)?);
    }
    let receipt = ProductReceipt {
        version: 1,
        intent_sha256: digest(&intent)?,
        nodes_sha256: format!("{:x}", hash.finalize()),
        root_identity: root.directory_identity()?,
    };
    ensure!(
        expected.is_none_or(|expected| *expected == receipt),
        "source_upload_product_receipt_changed"
    );
    Ok(receipt)
}
