use super::validate_storage_location_record;
use anyhow::{Context, Result, ensure};
use kcoder_types::{STORAGE_LOCATION_MAX_BYTES, StorageLocationRecord};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;

/// Missing is distinct from malformed, unreadable, linked or future records.
pub fn read_storage_location_record(path: &Path) -> Result<Option<StorageLocationRecord>> {
    let named = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("STORAGE_RECORD_UNAVAILABLE"),
    };
    ensure!(
        named.is_file() && !named.is_symlink(),
        "STORAGE_RECORD_INVALID"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).context("STORAGE_RECORD_UNAVAILABLE")?;
    let held = file.metadata().context("STORAGE_RECORD_UNAVAILABLE")?;
    ensure!(
        held.is_file() && held.len() <= STORAGE_LOCATION_MAX_BYTES,
        "STORAGE_RECORD_INVALID"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            named.dev() == held.dev() && named.ino() == held.ino(),
            "STORAGE_RECORD_INVALID"
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            held.file_attributes() & 0x400 == 0,
            "STORAGE_RECORD_INVALID"
        );
    }
    let mut bytes = Vec::new();
    file.take(STORAGE_LOCATION_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("STORAGE_RECORD_UNAVAILABLE")?;
    ensure!(
        bytes.len() as u64 <= STORAGE_LOCATION_MAX_BYTES,
        "STORAGE_RECORD_INVALID"
    );
    let record: StorageLocationRecord =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("STORAGE_RECORD_INVALID"))?;
    validate_storage_location_record(&record)?;
    Ok(Some(record))
}
