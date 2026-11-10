//! Weak owner liveness and original kernel file identity, without cloning a lease FD.
use super::*;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use std::sync::{
    Weak,
    atomic::{AtomicBool, Ordering},
};

#[cfg(windows)]
pub(super) fn open_session_lease_file(
    path: &Path,
    create: bool,
) -> Result<(std::fs::File, PrivateDirectory)> {
    let parent = PrivateDirectory::open_existing(
        path.parent()
            .context("SESSION_NATIVE_LEASE_PARENT_REQUIRED")?,
    )?;
    let filename = path
        .file_name()
        .context("SESSION_NATIVE_LEASE_NAME_REQUIRED")?;
    if create {
        // Only a newly created object receives the explicit protected file ACL.
        // Inherited directory ACEs do not satisfy a private regular-file witness.
        match parent.open_read_write_file(filename, true) {
            Ok(file) => return Ok((file, parent)),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) => {}
            Err(error) => return Err(error),
        }
    }
    // Existing-only opens preserve the original ACL; the witness still verifies it.
    let file = parent.open_read_write_file(filename, false)?;
    Ok((file, parent))
}

pub struct NativeSessionLeaseWitness {
    owner: Weak<AtomicBool>,
    target: PathBuf,
    parent_path: PathBuf,
    parent: PrivateDirectory,
    filename: std::ffi::OsString,
    identity: PortableLeaseIdentity,
}

/// Cheap, non-owning handoff. Filesystem verification happens only on a worker.
pub struct DeferredSessionLeaseWitness {
    owner: Weak<AtomicBool>,
    file: Weak<std::fs::File>,
    parent: Weak<PrivateDirectory>,
    target: PathBuf,
}

impl SessionLease {
    pub fn deferred_witness(&self, target: &Path) -> Option<DeferredSessionLeaseWitness> {
        if target != self.session_target || target.as_os_str().len() > 128 * 1024 {
            return None;
        }
        Some(DeferredSessionLeaseWitness {
            owner: Arc::downgrade(&self.native_owner_alive),
            file: Arc::downgrade(&self._file),
            parent: Arc::downgrade(self.observation_parent.as_ref()?),
            target: self.session_target.clone(),
        })
    }
    pub fn native_witness(&self) -> Result<NativeSessionLeaseWitness> {
        anyhow::ensure!(
            self.native_owner_alive.load(Ordering::Acquire),
            "SESSION_NATIVE_OWNER_CLOSED"
        );
        let path = self.session_target.with_extension("lease");
        let parent_path = path
            .parent()
            .context("SESSION_NATIVE_OWNER_UNAVAILABLE")?
            .to_path_buf();
        let parent = PrivateDirectory::open_existing(&parent_path)?;
        parent.verify_private_directory()?;
        let filename = path
            .file_name()
            .context("SESSION_NATIVE_OWNER_UNAVAILABLE")?
            .to_os_string();
        let identity = parent.portable_regular_handle_identity(&self._file)?;
        let witness = NativeSessionLeaseWitness {
            owner: Arc::downgrade(&self.native_owner_alive),
            target: self.session_target.clone(),
            parent_path,
            parent,
            filename,
            identity,
        };
        witness.verify_target(&self.session_target)?;
        Ok(witness)
    }
}

impl DeferredSessionLeaseWitness {
    pub fn verify_target(&self, target: &Path) -> Result<()> {
        let owner = self
            .owner
            .upgrade()
            .context("SESSION_NATIVE_OWNER_CLOSED")?;
        let file = self.file.upgrade().context("SESSION_NATIVE_OWNER_CLOSED")?;
        let parent = self
            .parent
            .upgrade()
            .context("SESSION_NATIVE_OWNER_CLOSED")?;
        anyhow::ensure!(
            owner.load(Ordering::Acquire) && self.target == target,
            "SESSION_NATIVE_OWNER_CHANGED"
        );
        let lease_path = self.target.with_extension("lease");
        parent.verify_private_directory()?;
        let current_parent = PrivateDirectory::open_existing(
            lease_path
                .parent()
                .context("SESSION_NATIVE_OWNER_UNAVAILABLE")?,
        )?;
        anyhow::ensure!(
            current_parent.directory_identity()? == parent.directory_identity()?,
            "SESSION_NATIVE_OWNER_CHANGED"
        );
        let name = lease_path
            .file_name()
            .context("SESSION_NATIVE_OWNER_UNAVAILABLE")?;
        anyhow::ensure!(
            parent.portable_regular_handle_identity(&file)?
                == current_parent.portable_regular_identity(name)?
                && owner.load(Ordering::Acquire),
            "SESSION_NATIVE_OWNER_CHANGED"
        );
        Ok(())
    }
}
impl NativeSessionLeaseWitness {
    pub fn verify_target(&self, native_target: &Path) -> Result<()> {
        let owner = self
            .owner
            .upgrade()
            .context("SESSION_NATIVE_OWNER_CLOSED")?;
        anyhow::ensure!(
            owner.load(Ordering::Acquire) && self.target == native_target,
            "SESSION_NATIVE_OWNER_CHANGED"
        );
        self.parent.verify_private_directory()?;
        let current = PrivateDirectory::open_existing(&self.parent_path)?;
        anyhow::ensure!(
            current.directory_identity()? == self.parent.directory_identity()?
                && current.portable_regular_identity(&self.filename)? == self.identity
                && owner.load(Ordering::Acquire),
            "SESSION_NATIVE_OWNER_CHANGED"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deferred_observer_does_not_extend_original_session_lease() {
        #[cfg(unix)]
        let temp = {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()
                .unwrap()
        };
        #[cfg(not(unix))]
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("session.jsonl");
        let lease = SessionLease::acquire(&target).unwrap();
        assert!(
            lease
                .deferred_witness(&temp.path().join("other.jsonl"))
                .is_none()
        );
        let witness = lease.deferred_witness(&target).unwrap();
        witness.verify_target(&target).unwrap();
        let inflight = witness.file.upgrade().unwrap();
        drop(lease);
        assert!(witness.verify_target(&target).is_err());
        let replacement = SessionLease::open(&target, false).unwrap();
        assert!(witness.verify_target(&target).is_err());
        drop(replacement);
        drop(inflight);
    }

    #[cfg(unix)]
    #[test]
    fn deferred_observer_does_not_reopen_parent_for_existing_legacy_lease() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let target = temp.path().join("session.jsonl");
        drop(SessionLease::acquire(&target).unwrap());
        let existing = SessionLease::open(&target, false).unwrap();
        assert!(existing.deferred_witness(&target).is_none());
        drop(existing);
        assert!(SessionLease::open(&target, false).is_ok());
    }

    #[test]
    fn native_witness_never_extends_the_original_session_lock_or_revives_with_replacement_owner() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("sessions").join("original.jsonl");
        let lease = SessionLease::acquire(&target).unwrap();
        let witness = lease.native_witness().unwrap();
        witness.verify_target(&target).unwrap();
        assert!(
            witness
                .verify_target(&temp.path().join("another.jsonl"))
                .is_err()
        );
        assert!(SessionLease::open(&target, false).is_err());
        drop(lease);
        assert!(witness.verify_target(&target).is_err());
        let next = SessionLease::open(&target, false).unwrap();
        next.native_witness()
            .unwrap()
            .verify_target(&target)
            .unwrap();
        assert!(witness.verify_target(&target).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn explicit_session_creation_privates_only_the_native_parent() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let workspace_mode = std::fs::metadata(&workspace).unwrap().permissions().mode();
        let parent = workspace.join("sessions");
        let target = parent.join("original.jsonl");
        let lease = SessionLease::acquire(&target).unwrap();

        lease
            .native_witness()
            .unwrap()
            .verify_target(&target)
            .unwrap();
        assert_eq!(
            std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&workspace).unwrap().permissions().mode(),
            workspace_mode
        );
    }

    #[test]
    fn existing_only_open_never_creates_a_missing_native_parent() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("missing");
        assert!(SessionLease::open(&parent.join("original.jsonl"), false).is_err());
        assert!(!parent.exists());
    }

    #[test]
    #[cfg(unix)]
    fn existing_only_open_preserves_unsafe_parent_permissions_and_witness_denies() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("legacy");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        let target = parent.join("original.jsonl");
        let path = target.with_extension("lease");
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let lease = SessionLease::open(&target, false).unwrap();
        assert!(lease.native_witness().is_err());
        assert_eq!(
            std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    #[cfg(unix)]
    fn replaced_lease_path_cannot_borrow_the_original_live_file_identity() {
        let temp = tempfile::tempdir().unwrap();
        PrivateDirectory::open_or_create(temp.path()).unwrap();
        let target = temp.path().join("original.jsonl");
        let lease = SessionLease::acquire(&target).unwrap();
        let witness = lease.native_witness().unwrap();
        std::fs::rename(
            target.with_extension("lease"),
            temp.path().join("old.lease"),
        )
        .unwrap();
        let next = SessionLease::acquire(&target).unwrap();
        assert!(witness.verify_target(&target).is_err());
        next.native_witness()
            .unwrap()
            .verify_target(&target)
            .unwrap();
    }
}
