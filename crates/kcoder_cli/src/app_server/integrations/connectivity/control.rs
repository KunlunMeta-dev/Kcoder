//! Native initialization writes retain the original exclusive owner lease.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::integrations::core::IntegrationOwner;
use std::{
    ffi::OsStr,
    io::{Seek, SeekFrom, Write},
};

#[path = "control/observation.rs"]
mod observation;
pub use observation::*;
pub const LOCK: &str = "channel-host-profile.lock";

pub fn initialize(
    directory: &PrivateDirectory,
    owner: IntegrationOwner,
    operation: &str,
) -> Result<()> {
    let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
    let log = directory.open_read_write_file(OsStr::new(LOG), true)?;
    lock.sync_all()?;
    log.sync_all()?;
    let data = directory.create_private_child(OsStr::new(DATA))?;
    let initial = Initialization {
        version: 1,
        owner,
        initialization_id: operation.into(),
        lock_identity: directory.portable_regular_handle_identity(&lock)?,
        log_identity: directory.portable_regular_handle_identity(&log)?,
        data_directory_identity: data.directory_identity()?,
    };
    let mut file = directory.open_read_write_file(OsStr::new(INIT), true)?;
    file.write_all(&serde_json::to_vec(&initial)?)?;
    file.sync_all()?;
    append_log(
        directory,
        &BootstrapEntry::Seed {
            initialization_identity: directory.portable_regular_handle_identity(&file)?,
        },
    )?;
    directory.sync()?;
    Ok(())
}

pub fn append_log(directory: &PrivateDirectory, entry: &BootstrapEntry) -> Result<()> {
    // The caller holds the native exclusive profile lease. No replay truncates this log.
    let mut file = directory.open_read_write_file(OsStr::new(LOG), false)?;
    ensure!(
        file.metadata()?.len() <= MAX_CONTROL,
        "CONNECTIVITY_BOOTSTRAP_LOG_INVALID"
    );
    file.seek(SeekFrom::End(0))?;
    file.write_all(&serde_json::to_vec(entry)?)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    directory.sync()?;
    Ok(())
}
