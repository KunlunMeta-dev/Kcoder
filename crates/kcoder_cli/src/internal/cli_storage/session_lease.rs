//! Owned session file lease and non-owning identity witnesses.
use anyhow::{Context, Result};
use fs2::FileExt;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

#[derive(Debug)]
pub struct SessionLeaseOwnedElsewhere(std::io::Error);
impl std::fmt::Display for SessionLeaseOwnedElsewhere {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("session lease is held by another owner")
    }
}
impl std::error::Error for SessionLeaseOwnedElsewhere {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

fn lease_lock_error(error: std::io::Error, target: &Path) -> anyhow::Error {
    let contended = error.kind() == std::io::ErrorKind::WouldBlock
        || fs2::lock_contended_error()
            .raw_os_error()
            .is_some_and(|code| error.raw_os_error() == Some(code));
    if contended {
        anyhow::Error::new(SessionLeaseOwnedElsewhere(error)).context(format!(
            "session is already active in another app-server: {}",
            target.display()
        ))
    } else {
        anyhow::Error::new(error).context(format!(
            "failed to lock session lease: {}",
            target.display()
        ))
    }
}

#[path = "../../app_server/workspace_registry/session_lease_witness.rs"]
mod session_lease_witness;
pub use session_lease_witness::{DeferredSessionLeaseWitness, NativeSessionLeaseWitness};

/// Installed only by the actual host. It may retain the original file while
/// already admitted work drains, never the owner's authorization liveness.
pub trait SessionLeaseRetirement: Send + Sync + std::fmt::Debug {
    fn retain_original_file(&self, owned: Box<dyn Send>);
}
struct OriginalLeaseFile(Arc<std::fs::File>);
impl Drop for OriginalLeaseFile {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&*self.0);
    }
}

#[derive(Debug)]
pub struct SessionLease {
    _file: Arc<std::fs::File>,
    observation_parent: Option<Arc<kcoder_config::PrivateDirectory>>,
    session_target: PathBuf,
    native_owner_alive: Arc<std::sync::atomic::AtomicBool>,
    scheduler_lifecycle: Option<kcoder_state::AppStateLifecycleIdentity>,
    retirement: Option<Arc<dyn SessionLeaseRetirement>>,
}

#[cfg(test)]
mod observed_history_tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn observed_owner_never_repairs_a_missing_lock_or_adopts_a_replacement() {
        let root = tempfile::tempdir().unwrap();
        let history = root.path().join("source.jsonl");
        let parent = kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap();
        let owner = SessionLease::acquire(&history).unwrap();
        let identity = owner.file_identity(&parent).unwrap();
        assert!(
            SessionLease::acquire_observed_history(&history, &identity).is_err(),
            "live owner cannot be bypassed"
        );
        drop(owner);
        let observed = SessionLease::acquire_observed_history(&history, &identity).unwrap();
        observed
            .native_witness()
            .unwrap()
            .verify_target(&history)
            .unwrap();
        drop(observed);
        std::fs::rename(
            history.with_extension("lease"),
            root.path().join("original.lease"),
        )
        .unwrap();
        assert!(SessionLease::acquire_observed_history(&history, &identity).is_err());
        assert!(!history.with_extension("lease").exists());
        let replacement = parent
            .open_read_write_file(OsStr::new("source.lease"), true)
            .unwrap();
        assert_ne!(
            parent
                .portable_regular_handle_identity(&replacement)
                .unwrap(),
            identity
        );
        assert!(SessionLease::acquire_observed_history(&history, &identity).is_err());
        assert_eq!(replacement.metadata().unwrap().len(), 0);
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.native_owner_alive
            .store(false, std::sync::atomic::Ordering::Release);
        let original = OriginalLeaseFile(self._file.clone());
        if let Some(retirement) = self.retirement.take() {
            retirement.retain_original_file(Box::new(original));
        } else {
            drop(original);
        }
    }
}

impl SessionLease {
    pub fn bind_retirement(&mut self, retirement: Arc<dyn SessionLeaseRetirement>) {
        self.retirement = Some(retirement);
    }
    pub fn acquire(session_target: &Path) -> Result<Self> {
        Self::open(session_target, true)
    }

    pub fn open(session_target: &Path, create: bool) -> Result<Self> {
        let lease_path = session_target.with_extension("lease");
        let prepared_parent = if create && let Some(parent) = lease_path.parent() {
            let directory =
                kcoder_config::PrivateDirectory::open_or_create(parent).with_context(|| {
                    format!(
                        "failed to prepare private session lease directory {}",
                        parent.display()
                    )
                })?;
            directory
                .verify_trusted_config_directory()
                .with_context(|| {
                    format!(
                        "session lease directory {} is unavailable",
                        parent.display()
                    )
                })?;
            Some(Arc::new(directory))
        } else {
            None
        };
        #[cfg(windows)]
        let (file, observation_parent) = {
            let (file, parent) =
                session_lease_witness::open_session_lease_file(&lease_path, create).with_context(
                    || format!("failed to open session lease {}", lease_path.display()),
                )?;
            (file, Some(Arc::new(parent)))
        };
        #[cfg(not(windows))]
        let file = {
            let mut options = std::fs::OpenOptions::new();
            options.create(create).read(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
            }
            options.open(&lease_path).map_err(anyhow::Error::from)
        };
        #[cfg(not(windows))]
        let file =
            file.with_context(|| format!("failed to open session lease {}", lease_path.display()))?;
        #[cfg(not(windows))]
        let observation_parent = prepared_parent;
        #[cfg(windows)]
        let _ = prepared_parent;
        if !file.metadata()?.is_file() {
            anyhow::bail!(
                "session lease is not a regular file: {}",
                lease_path.display()
            )
        }
        file.try_lock_exclusive()
            .map_err(|error| lease_lock_error(error, session_target))?;
        Ok(Self {
            _file: Arc::new(file),
            observation_parent,
            session_target: session_target.to_path_buf(),
            native_owner_alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            scheduler_lifecycle: None,
            retirement: None,
        })
    }

    /// Carry the original private-State observation to the resident scheduler.
    /// The scheduler rechecks this owner and the actual lease target before use.
    pub fn bind_scheduler_lifecycle(&mut self, lifecycle: kcoder_state::AppStateLifecycleIdentity) {
        self.scheduler_lifecycle = Some(lifecycle);
    }

    pub fn target(&self) -> &Path {
        &self.session_target
    }

    pub fn matches_target(&self, target: &Path) -> bool {
        self.session_target == target
    }

    pub fn scheduler_lifecycle(&self) -> Option<kcoder_state::AppStateLifecycleIdentity> {
        self.scheduler_lifecycle.clone()
    }

    pub fn owner_liveness(&self) -> std::sync::Weak<AtomicBool> {
        Arc::downgrade(&self.native_owner_alive)
    }

    pub fn file_identity(
        &self,
        parent: &kcoder_config::PrivateDirectory,
    ) -> Result<kcoder_config::PortableLeaseIdentity> {
        parent.portable_regular_handle_identity(&self._file)
    }

    pub fn acquire_existing_history(history_path: &Path) -> Result<Self> {
        let lease_path = history_path.with_extension("lease");
        match std::fs::symlink_metadata(&lease_path) {
            Ok(_) => return Self::open(history_path, false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect session lease {}", lease_path.display())
                });
            }
        }
        let metadata = std::fs::symlink_metadata(history_path)
            .with_context(|| format!("persisted thread not found: {}", history_path.display()))?;
        if !metadata.file_type().is_file() {
            anyhow::bail!(
                "persisted thread is not a regular file: {}",
                history_path.display()
            )
        }
        Self::acquire(history_path)
    }

    /// Permission observations may acquire only the exact original native
    /// lease. They must never create a missing leaf or adopt a replacement.
    pub fn acquire_observed_history(
        history_path: &Path,
        expected: &kcoder_config::PortableLeaseIdentity,
    ) -> Result<Self> {
        let lease_path = history_path.with_extension("lease");
        let parent_path = lease_path
            .parent()
            .context("observed session lease parent unavailable")?;
        let parent = Arc::new(kcoder_config::PrivateDirectory::open_existing(parent_path)?);
        parent.verify_private_directory()?;
        let name = lease_path
            .file_name()
            .context("observed session lease name unavailable")?;
        let file = parent.open_read_write_file(name, false)?;
        anyhow::ensure!(
            &parent.portable_regular_handle_identity(&file)? == expected,
            "observed session lease identity changed"
        );
        FileExt::try_lock_exclusive(&file)
            .context("observed session still has its original owner")?;
        anyhow::ensure!(
            &parent.portable_regular_identity(name)? == expected,
            "observed session lease was replaced during acquisition"
        );
        let lease = Self {
            _file: Arc::new(file),
            observation_parent: Some(parent),
            session_target: history_path.to_owned(),
            native_owner_alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            scheduler_lifecycle: None,
            retirement: None,
        };
        lease.native_witness()?.verify_target(history_path)?;
        Ok(lease)
    }
}

#[cfg(test)]
mod ownership_error_tests {
    use super::*;

    #[test]
    fn only_actual_lock_contention_has_an_owned_elsewhere_marker() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("original.jsonl");
        let original = SessionLease::acquire(&target).unwrap();
        let busy = SessionLease::acquire(&target).unwrap_err();
        assert!(busy.downcast_ref::<SessionLeaseOwnedElsewhere>().is_some());
        assert!(original.native_witness().is_ok());
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::InvalidInput,
            std::io::ErrorKind::Other,
        ] {
            let error = lease_lock_error(std::io::Error::from(kind), &target);
            assert!(error.downcast_ref::<SessionLeaseOwnedElsewhere>().is_none());
            assert!(!error.to_string().starts_with("session is already active"));
        }
        drop(original);
        assert!(SessionLease::acquire(&target).is_ok());
    }

    #[test]
    fn unsafe_lease_objects_are_not_classified_as_another_owner() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("original.jsonl");
        std::fs::create_dir(target.with_extension("lease")).unwrap();
        let error = SessionLease::open(&target, false).unwrap_err();
        assert!(error.downcast_ref::<SessionLeaseOwnedElsewhere>().is_none());
    }
}
