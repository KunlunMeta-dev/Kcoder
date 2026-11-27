//! Directory-local fences also cover explicit profiles that skip personal selection.
use crate::{PortableLeaseIdentity, PrivateDirectory};
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs::File,
    path::{Path, PathBuf},
};

pub(super) const WRITERS: &str = "kcoder-storage-writers.lock";
pub(super) const SECONDARY: &str = "kcoder-storage-instances.lock";
const DIRECTORY_ENTRY_BUDGET: usize = 65_536;

/// Empty ordinary coordination leaves are not business data. This observation
/// never grants writer authority; the executor must acquire their real locks.
pub(super) fn empty_except_fences(directory: &PrivateDirectory) -> Result<bool> {
    for name in directory.entry_names_bounded(3)? {
        if name != OsStr::new(WRITERS) && name != OsStr::new(SECONDARY) {
            return Ok(false);
        }
        if directory
            .open_single_link_regular_file(&name)?
            .metadata()?
            .len()
            != 0
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn permission_context(error: anyhow::Error, context: String) -> anyhow::Error {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
    }) {
        error.context(context)
    } else {
        error
    }
}

#[path = "writers_secondary.rs"]
mod secondary;
#[cfg(windows)]
#[path = "writers_windows_rename.rs"]
mod windows_rename;

pub(super) struct RootLease {
    path: PathBuf,
    directory: PrivateDirectory,
    file: File,
    secondary: Option<File>,
}

/// Lifetime admission for commands that operate on an explicit existing profile
/// without ordinary application bootstrap, cache initialization or auto migration.
pub struct StorageProfileWriter {
    _leases: Vec<RootLease>,
}

impl StorageProfileWriter {
    pub fn open(profile: &Path) -> Result<Self> {
        let profile = super::resolve::absolute(profile)?;
        let leases = RootLease::shared_with_ancestors(&profile, true)?;
        let directory = PrivateDirectory::open_existing(&profile)?;
        let identity = directory.directory_identity()?;
        ensure!(
            leases.iter().try_fold(false, |matched, lease| {
                Ok::<_, anyhow::Error>(matched || lease.matches_path_identity(&profile, &identity)?)
            })?,
            "STORAGE_ROOT_CHANGED"
        );
        super::assert_storage_root_admitted(&directory, super::StorageRootRole::Native)?;
        let home = dirs::home_dir().context("STORAGE_HOME_UNAVAILABLE")?;
        super::active_operation::assert_active_operation_outside_roots(
            &home,
            &[profile.as_path()],
            &leases,
        )?;
        for lease in &leases {
            lease.verify()?;
        }
        Ok(Self { _leases: leases })
    }
}

impl RootLease {
    /// Optional identity observation only. Contended or absent registrations
    /// supply no additional alias fact and never admit a business writer.
    pub(super) fn existing_identity_probe(path: &Path) -> Result<Option<Self>> {
        let directory = match PrivateDirectory::open_existing(path) {
            Ok(directory) => directory,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let file = match directory.try_existing_shared_lock(OsStr::new(WRITERS)) {
            Ok(Some(file)) => file,
            Ok(None) => return Ok(None),
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let lease = Self {
            path: path.into(),
            directory,
            file,
            secondary: None,
        };
        lease.verify()?;
        Ok(Some(lease))
    }

    /// Bounded facts from this actual held root and its existing ancestors.
    /// No leaf is created, no directory entries are enumerated, and no allow
    /// verdict survives this observation.
    pub(super) fn scope_identities(&self) -> Result<(String, BTreeSet<String>)> {
        self.verify()?;
        let identity = self.directory.directory_identity()?;
        let ancestors = self
            .path
            .ancestors()
            .map(|path| PrivateDirectory::open_existing(path)?.directory_identity())
            .collect::<Result<BTreeSet<_>>>()?;
        ensure!(ancestors.contains(&identity), "STORAGE_ROOT_CHANGED");
        self.verify()?;
        Ok((identity, ancestors))
    }

    pub(super) fn matches_directory(&self, identity: &str) -> Result<bool> {
        self.verify()?;
        Ok(self.directory.directory_identity()? == identity)
    }

    pub(super) fn matches_path_identity(&self, path: &Path, identity: &str) -> Result<bool> {
        self.verify()?;
        Ok(self.path == path && self.directory.directory_identity()? == identity)
    }

    pub fn fence_identity(&self) -> Result<String> {
        self.verify()?;
        Ok(serde_json::to_string(
            &PortableLeaseIdentity::from_storage_lock_handle(&self.file)?,
        )?)
    }

    pub fn shared_with_ancestors(path: &Path, existing_only: bool) -> Result<Vec<Self>> {
        // Refuse an already pending parent before creating a missing profile.
        // Admission is checked again after our own registration to close races.
        for ancestor in path.ancestors().skip(1) {
            drop(Self::shared_ancestor(ancestor)?);
        }
        Self::with_shared_ancestors(Self::shared(path, existing_only)?)
    }

    pub fn shared(path: &Path, existing_only: bool) -> Result<Self> {
        let directory = if existing_only {
            PrivateDirectory::open_existing(path).context("STORAGE_DATA_ROOT_UNAVAILABLE")?
        } else {
            PrivateDirectory::open_config_root(path)?
        };
        let file = directory
            .try_shared_lock(OsStr::new(WRITERS))
            .map_err(|error| {
                permission_context(
                    error,
                    format!(
                        "storage selected-root writer lock access: {}",
                        path.display()
                    ),
                )
            })?
            .context("STORAGE_MIGRATION_BUSY")?;
        let lease = Self {
            path: path.to_owned(),
            directory,
            file,
            secondary: None,
        };
        lease.verify()?;
        lease.probe_secondary("STORAGE_MIGRATION_BUSY")?;
        Ok(lease)
    }

    fn with_shared_ancestors(own: Self) -> Result<Vec<Self>> {
        let path = own.path.clone();
        let mut leases = vec![own];
        // Register our own fence first. A parent migration that creates its fence
        // after this ancestor read must discover us in its stopped-tree scan.
        for ancestor in path.ancestors().skip(1) {
            if let Some(lease) = Self::shared_ancestor(ancestor)? {
                leases.push(lease);
            }
        }
        for lease in &leases {
            lease.verify()?;
        }
        Ok(leases)
    }

    fn shared_ancestor(path: &Path) -> Result<Option<Self>> {
        let directory = match PrivateDirectory::open_existing(path) {
            Ok(directory) => directory,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let file = match directory.try_existing_shared_lock(OsStr::new(WRITERS)) {
            Ok(file) => file.context("STORAGE_MIGRATION_BUSY")?,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let lease = Self {
            path: path.into(),
            directory,
            file,
            secondary: None,
        };
        lease.verify()?;
        lease.probe_secondary("STORAGE_MIGRATION_BUSY")?;
        super::component_publication::assert_target_admitted(&lease.directory)?;
        Ok(Some(lease))
    }

    /// Lock the parent before checking existing nested registrations. Later
    /// startups can register themselves, but cannot pass their ancestor check.
    pub fn exclusive_tree_existing(path: &Path, held: &mut Vec<Self>) -> Result<()> {
        let Some(root) = Self::exclusive_existing(path, held)? else {
            return Ok(());
        };
        let mut pending = vec![(path.to_owned(), root.directory.duplicate_handle()?)];
        // Publish only complete scans: a busy nested writer must not make a retry
        // mistake this root's partial scan for an already established fence.
        let mut acquired = vec![root];
        let mut visited = BTreeSet::new();
        while let Some((path, directory)) = pending.pop() {
            let identity = directory.directory_identity()?;
            if !visited.insert(identity.clone()) {
                continue;
            }
            ensure!(
                PrivateDirectory::open_existing(&path)?.directory_identity()? == identity,
                "STORAGE_ROOT_CHANGED"
            );
            directory.visit_entry_names_bounded(DIRECTORY_ENTRY_BUDGET, |name| {
                let entry = directory.open_entry_handle(name)?;
                let metadata = entry.metadata();
                if name == OsStr::new(WRITERS) {
                    ensure!(
                        metadata.is_file() && !metadata.file_type().is_symlink(),
                        "STORAGE_ROOT_CHANGED"
                    );
                    let already_held = held.iter().chain(&acquired).try_fold(
                        false,
                        |found, previous| -> Result<bool> {
                            Ok(found || previous.directory.directory_identity()? == identity)
                        },
                    )?;
                    if !already_held {
                        acquired.push(Self::exclusive_fence(
                            &path,
                            &directory,
                            &entry.identity()?,
                        )?);
                    }
                } else if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    pending.push((path.join(name), entry.open_child_directory()?));
                }
                // Business payloads and arbitrary links are never read or followed.
                Ok(())
            })?;
            ensure!(
                PrivateDirectory::open_existing(&path)?.directory_identity()? == identity,
                "STORAGE_ROOT_CHANGED"
            );
        }
        for lease in &acquired {
            lease.verify()?;
        }
        held.extend(acquired);
        Ok(())
    }

    fn exclusive_fence(path: &Path, directory: &PrivateDirectory, expected: &str) -> Result<Self> {
        let file = directory
            .try_existing_exclusive_lock(OsStr::new(WRITERS))
            .context("STORAGE_ROOT_CHANGED")?
            .context("STORAGE_WRITERS_ACTIVE")?;
        ensure!(
            serde_json::to_string(&PortableLeaseIdentity::from_storage_lock_handle(&file)?)?
                == expected,
            "STORAGE_ROOT_CHANGED"
        );
        let lease = Self {
            path: path.to_owned(),
            directory: directory.duplicate_handle()?,
            file,
            secondary: None,
        };
        lease.verify()?;
        lease.probe_secondary("STORAGE_WRITERS_ACTIVE")?;
        Ok(lease)
    }

    pub fn exclusive_existing(path: &Path, held: &[Self]) -> Result<Option<Self>> {
        let directory = match PrivateDirectory::open_existing(path) {
            Ok(directory) => directory,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        // A directory alias must not make this process try to lock its own inode twice.
        let identity = directory.directory_identity()?;
        let mut already_held = false;
        for previous in held {
            previous.verify()?;
            already_held |= previous.directory.directory_identity()? == identity;
        }
        if already_held {
            return Ok(None);
        }
        let file = directory
            .try_exclusive_lock(OsStr::new(WRITERS))
            .map_err(|error| {
                permission_context(
                    error,
                    format!("storage stopped writer fence access: {}", path.display()),
                )
            })?
            .context("STORAGE_WRITERS_ACTIVE")?;
        let lease = Self {
            path: path.to_owned(),
            directory,
            file,
            secondary: None,
        };
        lease.verify()?;
        lease.probe_secondary("STORAGE_WRITERS_ACTIVE")?;
        Ok(Some(lease))
    }

    /// Follow only the same held directory through the component publisher's
    /// no-replace rename. This changes no persistent identity or authority.
    #[cfg(not(windows))]
    pub(super) fn follow_owned_rename(
        &mut self,
        identity: &str,
        previous: &Path,
        path: &Path,
    ) -> Result<bool> {
        let is_root = self.directory.directory_identity()? == identity;
        let Ok(relative) = self.path.strip_prefix(previous) else {
            ensure!(!is_root, "STORAGE_COMPONENT_BINDING_CHANGED");
            return Ok(false);
        };
        ensure!(
            !is_root || relative.as_os_str().is_empty(),
            "STORAGE_COMPONENT_BINDING_CHANGED"
        );
        let destination = if relative.as_os_str().is_empty() {
            path.to_owned()
        } else {
            path.join(relative)
        };
        let previous = std::mem::replace(&mut self.path, destination);
        if let Err(error) = self.verify() {
            self.path = previous;
            return Err(error);
        }
        Ok(is_root)
    }

    pub fn verify(&self) -> Result<()> {
        let named = self
            .directory
            .open_single_link_regular_file(OsStr::new(WRITERS))
            .context("STORAGE_ROOT_CHANGED")?;
        ensure!(
            self.file.metadata()?.len() == 0
                && named.metadata()?.len() == 0
                && PrivateDirectory::open_existing(&self.path)
                    .context("STORAGE_ROOT_CHANGED")?
                    .directory_identity()?
                    == self.directory.directory_identity()?
                && PortableLeaseIdentity::from_storage_lock_handle(&named)
                    .context("STORAGE_ROOT_CHANGED")?
                    == PortableLeaseIdentity::from_storage_lock_handle(&self.file)
                        .context("STORAGE_ROOT_CHANGED")?,
            "STORAGE_ROOT_CHANGED"
        );
        self.verify_secondary_snapshot()
    }

    /// Confirm the stopped root still names the original held directory.
    pub(super) fn verify_stopped_access(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.path)
                .context("STORAGE_ROOT_CHANGED")?
                .directory_identity()?
                == self.directory.directory_identity()?,
            "STORAGE_ROOT_CHANGED"
        );
        self.verify()
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

#[cfg(test)]
#[path = "writers_tests.rs"]
mod tests;
