use super::*;

#[cfg(unix)]
#[test]
fn dropped_setup_owner_unlocks_its_exact_description_even_if_a_duplicate_is_alive() -> Result<()> {
    use std::os::fd::AsRawFd;
    let root = kcoder_config::create_private_temp_dir("catalog-setup-owner-dup")?;
    let directory = PrivateDirectory::open_existing(root.path())?;
    let opened = open_database_in(
        directory.duplicate_handle()?,
        "owned-setup-description",
        true,
        MAX_FILE_BYTES,
    )?
    .unwrap();
    let original = opened._setup.as_ref().unwrap();
    let duplicate = original.try_clone()?;
    let identity = directory.portable_regular_handle_identity(&duplicate)?;
    eprintln!(
        "owned_setup_before_drop pid={} original_fd={} duplicate_fd={} identity={}",
        std::process::id(),
        original.as_raw_fd(),
        duplicate.as_raw_fd(),
        serde_json::to_string(&identity)?
    );
    let error = match open_database_in(
        directory.duplicate_handle()?,
        "owned-setup-description",
        true,
        MAX_FILE_BYTES,
    ) {
        Err(error) => error,
        Ok(_) => anyhow::bail!("a live setup owner must still exclude another writer"),
    };
    ensure!(
        error.chain().any(|cause| cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)),
        "the live original owner must report native lock contention: {error:#}"
    );
    drop(opened);
    #[cfg(target_os = "linux")]
    eprintln!(
        "owned_setup_after_owner_drop duplicate_fd={} fdinfo={}",
        duplicate.as_raw_fd(),
        std::fs::read_to_string(format!("/proc/self/fdinfo/{}", duplicate.as_raw_fd()))?
    );
    let next = open_database_in(
        directory.duplicate_handle()?,
        "owned-setup-description",
        true,
        MAX_FILE_BYTES,
    )
    .context("the original owner must release its native setup lock even while a cloned descriptor remains alive")?
    .unwrap();
    ensure!(
        directory.portable_regular_handle_identity(&duplicate)? == identity,
        "owned setup identity changed"
    );
    drop(next);
    drop(duplicate);
    Ok(())
}
