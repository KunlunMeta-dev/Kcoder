//! Serialize brief source-record transactions without treating contention as revoked authority.
use super::*;
use kcoder_config::VerifiedPrivateLease;
use std::time::{Duration, Instant};

pub(super) fn binding_lease(
    directory: &PrivateDirectory,
    identity: &PortableLeaseIdentity,
    mode: PrivateLeaseMode,
) -> Result<VerifiedPrivateLease> {
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        // Only contention is retried. Replacement/corruption still fails immediately.
        if let Some(lease) =
            directory.try_existing_portable_lock(OsStr::new(LOCK), identity, mode)?
        {
            return Ok(lease);
        }
        ensure!(
            Instant::now() < deadline,
            "TASK_CAPABILITY_SCOPE_BINDING_BUSY"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brief_reader_contention_does_not_reject_child_acceptance() -> Result<()> {
        let root = tempfile::tempdir()?;
        let directory = PrivateDirectory::open_existing(root.path())?
            .create_private_child(OsStr::new("store"))?;
        let file = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let identity = directory.portable_regular_handle_identity(&file)?;
        let reader = binding_lease(&directory, &identity, PrivateLeaseMode::Shared)?;
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            drop(reader);
        });
        let writer = binding_lease(&directory, &identity, PrivateLeaseMode::Exclusive)?;
        release.join().unwrap();
        drop(writer);
        Ok(())
    }

    #[test]
    fn persistent_contention_is_bounded_and_replaced_lock_is_never_accepted() -> Result<()> {
        let root = tempfile::tempdir()?;
        let directory = PrivateDirectory::open_existing(root.path())?
            .create_private_child(OsStr::new("store"))?;
        let file = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let identity = directory.portable_regular_handle_identity(&file)?;
        let writer = binding_lease(&directory, &identity, PrivateLeaseMode::Exclusive)?;
        let started = Instant::now();
        let error = binding_lease(&directory, &identity, PrivateLeaseMode::Shared)
            .err()
            .unwrap();
        assert!(
            error
                .to_string()
                .contains("TASK_CAPABILITY_SCOPE_BINDING_BUSY")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(writer);
        directory.atomic_replace(OsStr::new(LOCK), b"replacement")?;
        assert!(binding_lease(&directory, &identity, PrivateLeaseMode::Shared).is_err());
        Ok(())
    }
}
