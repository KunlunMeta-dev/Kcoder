//! A versioned static package container. Packing and materialization never execute contributions.
use super::tree::{PluginPackageRevision, package_revision};
use crate::{InstallLimits, PluginCancellationToken};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    io::{Read, Write},
    path::{Component, Path},
    time::{Duration, Instant},
};

pub const PLUGIN_TRANSFER_FORMAT: &str = "kcoder-plugin-tar/1";
struct Budget<'a> {
    limits: InstallLimits,
    cancel: &'a PluginCancellationToken,
    deadline: Instant,
    entries: usize,
    files: usize,
    bytes: u64,
}
impl Budget<'_> {
    fn check(&self) -> Result<()> {
        ensure!(
            !self.cancel.is_cancelled() && Instant::now() < self.deadline,
            "plugin_migration_cancelled"
        );
        Ok(())
    }
    fn entry(&mut self, bytes: Option<u64>) -> Result<()> {
        self.check()?;
        self.entries = self
            .entries
            .checked_add(1)
            .context("plugin_migration_tree_budget_exceeded")?;
        ensure!(
            self.entries <= self.limits.max_files.saturating_mul(2).saturating_add(64),
            "plugin_migration_tree_budget_exceeded"
        );
        if let Some(bytes) = bytes {
            self.files += 1;
            self.bytes = self
                .bytes
                .checked_add(bytes)
                .context("plugin_migration_tree_budget_exceeded")?;
            ensure!(
                self.files <= self.limits.max_files
                    && bytes <= self.limits.max_file_bytes
                    && self.bytes <= self.limits.max_total_bytes,
                "plugin_migration_tree_budget_exceeded"
            );
        }
        Ok(())
    }
}
pub(super) fn validate_transfer_components(
    path: &Path,
    limits: InstallLimits,
) -> Result<Vec<&OsStr>> {
    ensure!(
        !path
            .to_str()
            .context("plugin_migration_unsafe_tree")?
            .contains('\\'),
        "plugin_migration_unsafe_tree"
    );
    validate_local_transfer_components(path, limits)
}
// Native separators are accepted only between verified local path components.
pub(super) fn validate_local_transfer_components(
    path: &Path,
    limits: InstallLimits,
) -> Result<Vec<&OsStr>> {
    let text = path.to_str().context("plugin_migration_unsafe_tree")?;
    ensure!(
        !text.is_empty()
            && text.len() <= limits.max_path_bytes
            && !text.chars().any(char::is_control)
            && !text.contains(':'),
        "plugin_migration_unsafe_tree"
    );
    let names = path
        .components()
        .map(|part| match part {
            Component::Normal(name) => Ok(name),
            _ => Err(anyhow::anyhow!("plugin_migration_unsafe_tree")),
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !names.is_empty() && names.len() <= limits.max_depth.saturating_add(1),
        "plugin_migration_tree_budget_exceeded"
    );
    for name in &names {
        ensure!(
            !name
                .to_str()
                .context("plugin_migration_unsafe_tree")?
                .contains('\\'),
            "plugin_migration_unsafe_tree"
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
    }
    Ok(names)
}
struct CheckedReader<'a> {
    source: &'a mut dyn Read,
    cancel: &'a PluginCancellationToken,
    deadline: Instant,
    remaining: u64,
    digest: Option<&'a mut Sha256>,
}
impl Read for CheckedReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() || Instant::now() >= self.deadline {
            return Err(std::io::Error::other("plugin_migration_cancelled"));
        }
        if bytes.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut probe = [0u8; 1];
            return if self.source.read(&mut probe)? == 0 {
                Ok(0)
            } else {
                Err(std::io::Error::other(
                    "plugin_migration_tree_budget_exceeded",
                ))
            };
        }
        let length = bytes
            .len()
            .min(64 * 1024)
            .min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
        let count = self.source.read(&mut bytes[..length])?;
        self.remaining -= count as u64;
        if let Some(hash) = &mut self.digest {
            hash.update(&bytes[..count]);
        }
        Ok(count)
    }
}
fn pack(
    directory: &PrivateDirectory,
    prefix: &Path,
    tar: &mut tar::Builder<&mut dyn Write>,
    budget: &mut Budget<'_>,
    emitted: &mut Sha256,
) -> Result<()> {
    let mut names = Vec::new();
    directory.visit_entry_names_bounded(budget.limits.max_files.saturating_add(1), |name| {
        names.push(name.to_os_string());
        Ok(())
    })?;
    names.sort();
    for name in names {
        let path = prefix.join(&name);
        validate_local_transfer_components(&path, budget.limits)?;
        let metadata = directory.entry_metadata(&name)?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "plugin_migration_unsafe_tree"
        );
        let mut header = tar::Header::new_gnu();
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        if metadata.is_dir() {
            budget.entry(None)?;
            let child = directory.open_child(&name, false)?;
            child.verify_trusted_config_directory()?;
            let identity = child.directory_identity()?;
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o700);
            header.set_size(0);
            header.set_cksum();
            super::package_hash::directory(emitted, &path)?;
            tar.append_data(&mut header, &path, std::io::empty())?;
            pack(&child, &path, tar, budget, emitted)?;
            ensure!(
                directory.open_child(&name, false)?.directory_identity()? == identity,
                "plugin_migration_source_changed"
            );
        } else {
            ensure!(metadata.is_file(), "plugin_migration_unsafe_tree");
            let mut file = directory.open_single_link_regular_file(&name)?;
            let bytes = file.metadata()?.len();
            budget.entry(Some(bytes))?;
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::MetadataExt;
                if file.metadata()?.mode() & 0o111 == 0 {
                    0o600
                } else {
                    0o700
                }
            };
            #[cfg(not(unix))]
            let mode = 0o600;
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(mode);
            header.set_size(bytes);
            header.set_cksum();
            super::package_hash::file(emitted, &path, bytes, mode & 0o111 != 0)?;
            let reader = CheckedReader {
                source: &mut file,
                cancel: budget.cancel,
                deadline: budget.deadline,
                remaining: bytes.saturating_add(1),
                digest: Some(emitted),
            };
            tar.append_data(&mut header, &path, reader)?;
        }
    }
    Ok(())
}
/// The caller owns/publishes the writer. Only a fully completed result is a package receipt.
pub fn write_transfer_package(
    source: &Path,
    output: &mut dyn Write,
    limits: InstallLimits,
    cancel: &PluginCancellationToken,
) -> Result<PluginPackageRevision> {
    let before = package_revision(source, limits, cancel)?;
    let directory = PrivateDirectory::open_existing(source)?;
    directory.verify_trusted_config_directory()?;
    let identity = directory.directory_identity()?;
    let mut budget = Budget {
        limits,
        cancel,
        deadline: Instant::now() + Duration::from_secs(120),
        entries: 0,
        files: 0,
        bytes: 0,
    };
    let mut tar = tar::Builder::new(output);
    let mut emitted = super::package_hash::new_hash();
    pack(
        &directory,
        Path::new(""),
        &mut tar,
        &mut budget,
        &mut emitted,
    )?;
    tar.finish()?;
    ensure!(
        PrivateDirectory::open_existing(source)?.directory_identity()? == identity
            && format!("{:x}", emitted.finalize()) == before.sha256
            && budget.files == before.files
            && budget.bytes == before.bytes
            && package_revision(source, limits, cancel)? == before,
        "plugin_migration_source_changed"
    );
    Ok(before)
}
/// Materialize only into the caller's new owned empty directory. Partial output is
/// not adopted or deleted here; its owner must reconcile or allocate another attempt.
pub fn materialize_transfer_package(
    input: &mut dyn Read,
    destination: &Path,
    limits: InstallLimits,
    cancel: &PluginCancellationToken,
) -> Result<PluginPackageRevision> {
    let directory = PrivateDirectory::open_existing(destination)?;
    directory.verify_private_directory()?;
    let identity = directory.directory_identity()?;
    let mut existing = 0;
    directory.visit_entry_names_bounded(1, |_| {
        existing += 1;
        Ok(())
    })?;
    ensure!(existing == 0, "plugin_migration_target_conflict");
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut budget = Budget {
        limits,
        cancel,
        deadline,
        entries: 0,
        files: 0,
        bytes: 0,
    };
    let max_container = limits
        .max_total_bytes
        .checked_add(
            (limits.max_files.saturating_mul(2).saturating_add(64) as u64)
                .checked_mul((limits.max_path_bytes as u64).saturating_add(2048))
                .context("plugin_migration_tree_budget_exceeded")?,
        )
        .context("plugin_migration_tree_budget_exceeded")?;
    let mut archive = tar::Archive::new(CheckedReader {
        source: input,
        cancel,
        deadline,
        remaining: max_container,
        digest: None,
    });
    let mut paths = BTreeSet::new();
    let mut long_name = None;
    // Raw iteration prevents tar from allocating unbounded GNU/PAX metadata before our limits.
    for result in archive.entries()?.raw(true) {
        let mut entry = result?;
        budget.check()?;
        let kind = entry.header().entry_type();
        if kind.is_gnu_longname() {
            ensure!(
                long_name.is_none()
                    && entry.size() > 0
                    && entry.size() <= limits.max_path_bytes as u64 + 1,
                "plugin_migration_tree_budget_exceeded"
            );
            let expected = entry.size();
            let mut bytes = Vec::new();
            (&mut entry).take(expected + 1).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() as u64 == expected && bytes.last() == Some(&0),
                "plugin_migration_unsafe_tree"
            );
            bytes.pop();
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| anyhow::anyhow!("plugin_migration_unsafe_tree"))?;
            let path = std::path::PathBuf::from(text);
            validate_transfer_components(&path, limits)?;
            long_name = Some(path);
            continue;
        }
        ensure!(
            kind.is_file() || kind.is_dir(),
            "plugin_migration_unsafe_tree"
        );
        let path = long_name.take().unwrap_or(entry.path()?.into_owned());
        let names = validate_transfer_components(&path, limits)?;
        let normalized = path.to_str().unwrap().to_lowercase();
        ensure!(paths.insert(normalized), "plugin_migration_unsafe_tree");
        if kind.is_dir() {
            ensure!(
                names.len() <= limits.max_depth,
                "plugin_migration_tree_budget_exceeded"
            );
        }
        let bytes = entry.size();
        ensure!(!kind.is_dir() || bytes == 0, "plugin_migration_unsafe_tree");
        budget.entry(kind.is_file().then_some(bytes))?;
        let mut opened: Option<PrivateDirectory> = None;
        for component in &names[..names.len() - 1] {
            let next = opened
                .as_ref()
                .unwrap_or(&directory)
                .open_child(component, false)?;
            next.verify_private_directory()?;
            opened = Some(next);
        }
        let parent = opened.as_ref().unwrap_or(&directory);
        let leaf = names[names.len() - 1];
        if kind.is_dir() {
            parent
                .create_private_child(leaf)?
                .verify_private_directory()?;
        } else {
            #[cfg(unix)]
            let mode = entry.header().mode()?;
            let count = std::cell::Cell::new(0u64);
            let mut limited = (&mut entry).take(bytes);
            struct Count<'a, R> {
                source: R,
                count: &'a std::cell::Cell<u64>,
            }
            impl<R: Read> Read for Count<'_, R> {
                fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                    let n = self.source.read(bytes)?;
                    self.count.set(self.count.get() + n as u64);
                    Ok(n)
                }
            }
            let parent_identity = parent.directory_identity()?;
            parent.atomic_publish_from_reader(
                leaf,
                &mut Count {
                    source: &mut limited,
                    count: &count,
                },
                false,
                || {
                    budget.check()?;
                    ensure!(
                        count.get() == bytes
                            && parent.directory_identity()? == parent_identity
                            && PrivateDirectory::open_existing(destination)?
                                .directory_identity()?
                                == identity,
                        "plugin_migration_source_changed"
                    );
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if mode & 0o111 != 0 {
                            return Ok(Some(std::fs::Permissions::from_mode(0o700)));
                        }
                    }
                    Ok(None)
                },
            )?;
        }
    }
    ensure!(long_name.is_none(), "plugin_migration_unsafe_tree");
    let mut remainder = archive.into_inner();
    let mut padding = [0u8; 64 * 1024];
    loop {
        let count = remainder.read(&mut padding)?;
        if count == 0 {
            break;
        }
        ensure!(
            padding[..count].iter().all(|byte| *byte == 0),
            "plugin_migration_invalid_package"
        );
    }
    budget.check()?;
    ensure!(
        PrivateDirectory::open_existing(destination)?.directory_identity()? == identity,
        "plugin_migration_target_changed"
    );
    package_revision(destination, limits, cancel)
}
