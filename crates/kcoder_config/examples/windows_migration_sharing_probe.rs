//! Isolated diagnostic for migration directory bootstrap and lease sharing.
#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    use kcoder_config::{PrivateDirectory, PrivateLeaseMode};
    use std::{ffi::OsStr, path::PathBuf};

    let root = PathBuf::from(std::env::args_os().nth(1).expect("owned probe directory"));
    let base = PrivateDirectory::open_or_create(&root)?;
    base.verify_private_directory()?;
    println!("STEP base_ready");
    let name = OsStr::new("mutation.lock");
    drop(base.try_exclusive_lock(name)?.expect("isolated lock"));
    println!("STEP bootstrap_lock_ready");
    let identity = base.portable_regular_identity(name)?;
    println!("STEP initial_identity_ready");
    let lease = base
        .try_existing_portable_lock(name, &identity, PrivateLeaseMode::Exclusive)?
        .expect("isolated lease");
    println!("STEP exclusive_lease_ready");
    let staging = base.create_private_child(OsStr::new(".managed-v2-probe"))?;
    println!("STEP staging_created");
    let _ = staging.directory_identity()?;
    println!("STEP staging_identity_ready");
    let _ = base.directory_identity()?;
    println!("STEP base_identity_ready");
    match base.portable_regular_identity(name) {
        Ok(observed) => {
            anyhow::ensure!(observed == identity, "probe identity changed");
            println!("STEP locked_file_identity_ready");
        }
        Err(error) => {
            println!("FAIL locked_file_identity: {error:#}");
            drop(lease);
            let _ = base.portable_regular_identity(name)?;
            println!("STEP identity_after_release_ready");
            return Err(error);
        }
    }
    let staging = if std::env::args().nth(2).as_deref() == Some("reopen-staging") {
        drop(staging);
        println!("STEP staging_original_handle_closed");
        base.open_child(OsStr::new(".managed-v2-probe"), false)?
    } else {
        staging
    };
    staging.atomic_replace(OsStr::new("lifecycle.json"), b"{\"probe\":true}")?;
    println!("STEP lifecycle_document_ready");
    drop(staging);
    base.rename_no_replace(OsStr::new(".managed-v2-probe"), OsStr::new("managed-v2"))?;
    println!("STEP lifecycle_directory_published");
    drop(lease);
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This diagnostic requires an isolated directory on Windows.");
    std::process::exit(2);
}
