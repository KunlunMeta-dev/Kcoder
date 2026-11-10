use crate::{InstallLimits, PluginCancellationToken};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPackageRevision {
    pub sha256: String,
    pub files: usize,
    pub bytes: u64,
}
struct Walk<'a> {
    limits: InstallLimits,
    cancel: &'a PluginCancellationToken,
    deadline: Instant,
    visited: usize,
    hash: Sha256,
    files: usize,
    bytes: u64,
}
fn stamp(metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{}:{:?}:{:?}",
            metadata.len(),
            metadata.modified(),
            metadata.created()
        )
    }
}
fn executable(metadata: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}
fn walk(
    directory: &PrivateDirectory,
    relative: &Path,
    depth: usize,
    state: &mut Walk<'_>,
) -> Result<()> {
    ensure!(
        depth <= state.limits.max_depth,
        "plugin_migration_tree_budget_exceeded"
    );
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
        state.visited += 1;
        ensure!(
            state.visited <= state.limits.max_files.saturating_mul(2).saturating_add(64),
            "plugin_migration_tree_budget_exceeded"
        );
        let lower = name.to_string_lossy().to_ascii_lowercase();
        ensure!(
            !lower.starts_with(".env")
                && !matches!(
                    lower.as_str(),
                    ".git"
                        | "auth.json"
                        | "oauth.json"
                        | "credentials.json"
                        | ".credentials.json"
                        | "credentials.toml"
                        | "installed_plugins.json"
                ),
            "plugin_migration_private_state_not_copied"
        );
        let path = relative.join(&name);
        let text = path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("plugin_migration_unsafe_tree"))?;
        ensure!(
            text.len() <= state.limits.max_path_bytes && !text.chars().any(char::is_control),
            "plugin_migration_unsafe_tree"
        );
        let metadata = directory.entry_metadata(&name)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "plugin_migration_unsafe_tree"
        );

        if metadata.is_dir() {
            let child = directory.open_child(&name, false)?;
            child.verify_trusted_config_directory()?;
            let identity = child.directory_identity()?;
            super::package_hash::directory(&mut state.hash, &path)?;
            walk(&child, &path, depth + 1, state)?;
            ensure!(
                directory.open_child(&name, false)?.directory_identity()? == identity,
                "plugin_migration_source_changed"
            );
        } else {
            ensure!(
                metadata.is_file() && metadata.len() <= state.limits.max_file_bytes,
                "plugin_migration_unsafe_tree"
            );
            let mut file = directory.open_single_link_regular_file(&name)?;
            let before = stamp(&file.metadata()?);
            let size = file.metadata()?.len();
            ensure!(
                size <= state.limits.max_file_bytes,
                "plugin_migration_tree_budget_exceeded"
            );
            state.files += 1;
            state.bytes = state
                .bytes
                .checked_add(size)
                .ok_or_else(|| anyhow::anyhow!("plugin_migration_tree_budget_exceeded"))?;
            ensure!(
                state.files <= state.limits.max_files
                    && state.bytes <= state.limits.max_total_bytes,
                "plugin_migration_tree_budget_exceeded"
            );
            super::package_hash::file(&mut state.hash, &path, size, executable(&file.metadata()?))?;
            let mut buffer = [0u8; 64 * 1024];
            let mut read = 0;
            loop {
                ensure!(
                    !state.cancel.is_cancelled() && Instant::now() < state.deadline,
                    "plugin_migration_cancelled"
                );
                let n = file.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                read += n as u64;
                ensure!(read <= size, "plugin_migration_source_changed");
                state.hash.update(&buffer[..n]);
            }
            ensure!(
                read == size
                    && stamp(&file.metadata()?) == before
                    && stamp(&directory.open_single_link_regular_file(&name)?.metadata()?)
                        == before,
                "plugin_migration_source_changed"
            );
        }
    }
    Ok(())
}
pub fn package_revision(
    root: &Path,
    limits: InstallLimits,
    cancel: &PluginCancellationToken,
) -> Result<PluginPackageRevision> {
    ensure!(!cancel.is_cancelled(), "plugin_migration_cancelled");
    let directory = PrivateDirectory::open_existing(root)?;
    directory.verify_trusted_config_directory()?;
    let identity = directory.directory_identity()?;
    let mut state = Walk {
        limits,
        cancel,
        deadline: Instant::now() + Duration::from_secs(120),
        visited: 0,
        hash: super::package_hash::new_hash(),
        files: 0,
        bytes: 0,
    };
    walk(&directory, Path::new(""), 0, &mut state)?;
    ensure!(
        PrivateDirectory::open_existing(root)?.directory_identity()? == identity,
        "plugin_migration_source_changed"
    );
    Ok(PluginPackageRevision {
        sha256: format!("{:x}", state.hash.finalize()),
        files: state.files,
        bytes: state.bytes,
    })
}
/// Reuse the formal installer copier; source scripts and contributed programs never execute.
pub fn snapshot_package(
    source: &Path,
    destination: &Path,
    limits: InstallLimits,
    cancel: &PluginCancellationToken,
) -> Result<PluginPackageRevision> {
    let before = package_revision(source, limits, cancel)?;
    crate::store::copy_local_tree(
        source,
        destination,
        limits,
        Instant::now() + Duration::from_secs(120),
        cancel,
    )?;
    ensure!(
        before == package_revision(source, limits, cancel)?
            && before == package_revision(destination, limits, cancel)?,
        "plugin_migration_source_changed"
    );
    Ok(before)
}
