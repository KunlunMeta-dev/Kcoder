//! Uploaded files are data grants. Declared installation paths never authorize host reads.
use super::*;
use crate::source_transfer::uploads::UploadedRootBinding;
use kcoder_types::migration_source_upload::SourceUploadFile;
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

pub(crate) fn discover(
    uploaded: &UploadedRootBinding,
    cancel: &PluginCancellationToken,
) -> Result<PluginMigrationCatalog> {
    let root = uploaded.root_path()?;
    uploaded.verify(&root, uploaded.source())?;
    super::discover_inner(&root, uploaded.source(), None, Some(uploaded), cancel)
}

struct Review<'a> {
    files: BTreeMap<PathBuf, SourceUploadFile>,
    directories: BTreeSet<PathBuf>,
    observed: BTreeSet<PathBuf>,
    cancel: &'a PluginCancellationToken,
    deadline: Instant,
}
impl Review<'_> {
    fn current(&self) -> Result<()> {
        ensure!(
            !self.cancel.is_cancelled() && Instant::now() < self.deadline,
            "plugin_migration_cancelled"
        );
        Ok(())
    }
    fn walk(&mut self, directory: &PrivateDirectory, relative: &Path) -> Result<()> {
        self.current()?;
        let mut names = Vec::new();
        directory.visit_entry_names_bounded(
            self.files.len() + self.directories.len() + 1,
            |name| {
                names.push(name.to_owned());
                Ok(())
            },
        )?;
        for name in names {
            self.current()?;
            let path = relative.join(&name);
            let metadata = directory.entry_metadata(&name)?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "source_upload_product_content_changed"
            );
            if metadata.is_dir() {
                ensure!(
                    self.directories.contains(&path),
                    "source_upload_product_scope_changed"
                );
                let child = directory.open_child(&name, false)?;
                child.verify_private_directory()?;
                self.walk(&child, &path)?;
            } else {
                let expected = self
                    .files
                    .get(&path)
                    .context("source_upload_product_scope_changed")?;
                ensure!(
                    metadata.is_file() && metadata.len() == expected.bytes,
                    "source_upload_product_content_changed"
                );
                let identity = directory.portable_regular_identity(&name)?;
                let held = directory.portable_open_verified_regular(&name, &identity)?;
                let mut file = held.file();
                let mut hash = Sha256::new();
                let mut bytes = 0u64;
                let mut buffer = [0; 64 * 1024];
                loop {
                    self.current()?;
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    bytes = bytes
                        .checked_add(count as u64)
                        .context("source_upload_product_content_changed")?;
                    ensure!(
                        bytes <= expected.bytes,
                        "source_upload_product_content_changed"
                    );
                    hash.update(&buffer[..count]);
                }
                ensure!(
                    bytes == expected.bytes
                        && format!("{:x}", hash.finalize()) == expected.sha256
                        && file.metadata()?.len() == expected.bytes
                        && directory.portable_regular_identity(&name)? == identity,
                    "source_upload_product_content_changed"
                );
                self.observed.insert(path);
            }
        }
        Ok(())
    }
}

/// Bind the exact bytes copied by the formal plugin copier to the original upload manifest.
/// Pre/post source probes alone cannot establish this in a same-size in-place ABA race.
pub(super) fn verify_copy(
    source: &Source,
    frozen: &Path,
    cancel: &PluginCancellationToken,
) -> Result<()> {
    let Some(uploaded) = &source.uploaded else {
        return Ok(());
    };
    let expected = uploaded.expected_subtree_files(&source.relative)?;
    ensure!(!expected.is_empty(), "source_upload_product_scope_changed");
    let mut files = BTreeMap::new();
    let mut directories = BTreeSet::new();
    for file in expected {
        let path = PathBuf::from(&file.relative_path);
        let mut parent = path.parent();
        while let Some(path) = parent.filter(|path| !path.as_os_str().is_empty()) {
            directories.insert(path.to_owned());
            parent = path.parent();
        }
        ensure!(
            files.insert(path, file).is_none(),
            "source_upload_product_scope_changed"
        );
    }
    let directory = PrivateDirectory::open_existing(frozen)?;
    directory.verify_private_directory()?;
    let mut review = Review {
        files,
        directories,
        observed: BTreeSet::new(),
        cancel,
        deadline: Instant::now() + Duration::from_secs(120),
    };
    review.walk(&directory, Path::new(""))?;
    ensure!(
        review.files.len() == review.observed.len(),
        "source_upload_product_content_changed"
    );
    uploaded.verify(&source.root, source.kind)
}
