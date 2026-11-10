//! Bounded metadata-only reservation; this is not a package content digest.
use super::transfer::validate_local_transfer_components;
use crate::{InstallLimits, PluginCancellationToken};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginTransferEstimate {
    pub bytes: u64,
    pub metadata_sha256: String,
}
struct Scan<'a> {
    limits: InstallLimits,
    cancel: &'a PluginCancellationToken,
    deadline: Instant,
    entries: usize,
    files: usize,
    data: u64,
    container: u64,
    hash: Sha256,
}
fn blocks(bytes: u64) -> Result<u64> {
    bytes
        .checked_add(511)
        .map(|n| n / 512 * 512)
        .context("plugin_migration_tree_budget_exceeded")
}
fn scan(directory: &PrivateDirectory, prefix: &Path, state: &mut Scan<'_>) -> Result<()> {
    let mut names = Vec::new();
    directory.visit_entry_names_bounded(state.limits.max_files.saturating_add(1), |name| {
        names.push(name.to_os_string());
        Ok(())
    })?;
    names.sort();
    for name in names {
        ensure!(
            !state.cancel.is_cancelled() && Instant::now() < state.deadline,
            "plugin_migration_cancelled"
        );
        let path = prefix.join(&name);
        validate_local_transfer_components(&path, state.limits)?;
        state.entries += 1;
        ensure!(
            state.entries <= state.limits.max_files.saturating_mul(2).saturating_add(64),
            "plugin_migration_tree_budget_exceeded"
        );
        let text = path
            .to_str()
            .context("plugin_migration_unsafe_tree")?
            .replace('\\', "/");
        state.container = state
            .container
            .checked_add(512)
            .context("plugin_migration_tree_budget_exceeded")?;
        if text.len() > 99 {
            state.container = state
                .container
                .checked_add(512 + blocks(text.len() as u64 + 1)?)
                .context("plugin_migration_tree_budget_exceeded")?;
        }
        state.hash.update(text.as_bytes());
        state.hash.update([0]);
        let metadata = directory.entry_metadata(&name)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "plugin_migration_unsafe_tree"
        );
        if metadata.is_dir() {
            let child = directory.open_child(&name, false)?;
            child.verify_trusted_config_directory()?;
            let identity = child.directory_identity()?;
            state.hash.update(b"d\0");
            state.hash.update(identity.as_bytes());
            scan(&child, &path, state)?;
            ensure!(
                directory.open_child(&name, false)?.directory_identity()? == identity,
                "plugin_migration_source_changed"
            );
        } else {
            ensure!(metadata.is_file(), "plugin_migration_unsafe_tree");
            let file = directory.open_single_link_regular_file(&name)?;
            let metadata = file.metadata()?;
            let bytes = metadata.len();
            state.files += 1;
            state.data = state
                .data
                .checked_add(bytes)
                .context("plugin_migration_tree_budget_exceeded")?;
            ensure!(
                state.files <= state.limits.max_files
                    && bytes <= state.limits.max_file_bytes
                    && state.data <= state.limits.max_total_bytes,
                "plugin_migration_tree_budget_exceeded"
            );
            state.container = state
                .container
                .checked_add(blocks(bytes)?)
                .context("plugin_migration_tree_budget_exceeded")?;
            state.hash.update(b"f\0");
            state.hash.update(bytes.to_le_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                state.hash.update(
                    format!(
                        "{}:{}:{}:{}:{}:{}:{}:{}",
                        metadata.dev(),
                        metadata.ino(),
                        metadata.mode(),
                        metadata.mtime(),
                        metadata.mtime_nsec(),
                        metadata.ctime(),
                        metadata.ctime_nsec(),
                        metadata.nlink()
                    )
                    .as_bytes(),
                );
            }
            #[cfg(not(unix))]
            {
                state.hash.update(
                    format!(
                        "{:?}:{:?}",
                        metadata.modified().ok(),
                        metadata.created().ok()
                    )
                    .as_bytes(),
                );
            }
        }
    }
    Ok(())
}
pub fn estimate_transfer_package(
    root: &Path,
    limits: InstallLimits,
    cancel: &PluginCancellationToken,
) -> Result<PluginTransferEstimate> {
    let directory = PrivateDirectory::open_existing(root)?;
    directory.verify_trusted_config_directory()?;
    let identity = directory.directory_identity()?;
    let mut state = Scan {
        limits,
        cancel,
        deadline: Instant::now() + Duration::from_secs(120),
        entries: 0,
        files: 0,
        data: 0,
        container: 1024,
        hash: Sha256::new(),
    };
    state.hash.update(b"kcoder.plugin.transfer-metadata/1\0");
    state.hash.update(identity.as_bytes());
    scan(&directory, Path::new(""), &mut state)?;
    ensure!(
        PrivateDirectory::open_existing(root)?.directory_identity()? == identity,
        "plugin_migration_source_changed"
    );
    Ok(PluginTransferEstimate {
        bytes: state.container,
        metadata_sha256: format!("{:x}", state.hash.finalize()),
    })
}
