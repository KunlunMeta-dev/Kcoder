//! Owned session file lease and non-owning identity witnesses.
use anyhow::{Context, Result};
use fs2::FileExt;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

#[path = "../../app_server/workspace_registry/session_lease_witness.rs"]
mod session_lease_witness;
pub use session_lease_witness::{DeferredSessionLeaseWitness, NativeSessionLeaseWitness};

#[derive(Debug)]
pub struct SessionLease {
    _file: Arc<std::fs::File>,
    observation_parent: Option<Arc<kcoder_config::PrivateDirectory>>,
    session_target: PathBuf,
    native_owner_alive: Arc<std::sync::atomic::AtomicBool>,
    scheduler_lifecycle: Option<kcoder_state::AppStateLifecycleIdentity>,
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        self.native_owner_alive
            .store(false, std::sync::atomic::Ordering::Release);
        let _ = fs2::FileExt::unlock(&*self._file);
    }
}

impl SessionLease {
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
            directory.verify_private_directory()?;
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
                options.mode(0o600);
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
        file.try_lock_exclusive().with_context(|| {
            format!(
                "session is already active in another app-server: {}",
                session_target.display()
            )
        })?;
        Ok(Self {
            _file: Arc::new(file),
            observation_parent,
            session_target: session_target.to_path_buf(),
            native_owner_alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            scheduler_lifecycle: None,
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
}
