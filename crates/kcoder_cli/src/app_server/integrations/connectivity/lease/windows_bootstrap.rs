//! Protect only pinned files of the original in-flight namespace creation.
use super::*;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE},
    Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, ReOpenFile},
};

pub fn seal_created_files(
    directory: &PrivateDirectory,
    data: &PrivateDirectory,
    files: &BTreeMap<String, (File, PortableLeaseIdentity)>,
) -> Result<()> {
    ensure!(
        [
            "binding",
            "connectivity.sqlite3",
            "connectivity.lock",
            "connectivity.ready.json"
        ]
        .iter()
        .all(|name| files.contains_key(*name)),
        "CONNECTIVITY_CREATED_FILE_WITNESS_REQUIRED"
    );
    for (name, (file, original)) in files {
        let (parent, name) = if name == "binding" {
            (directory, OsStr::new("data.binding.json"))
        } else {
            (data, OsStr::new(name))
        };
        ensure!(
            PortableLeaseIdentity::from_regular_handle(file)? == *original
                && PortableLeaseIdentity::from_regular_handle(
                    &parent.open_single_link_regular_file(name)?
                )? == *original,
            "CONNECTIVITY_CREATED_FILE_CHANGED"
        );
        ensure!(
            parent.portable_regular_handle_identity(file)? == *original
                && parent.portable_regular_identity(name)? == *original,
            "CONNECTIVITY_CREATED_FILE_CHANGED"
        );
    }
    Ok(())
}

/// Owned Main startup may prepare volatile SQLite coordination files after the
/// original database/namespace receipt and exclusive kernel lease were verified.
/// Existing files are observed by identity; their inherited access is unchanged.
pub fn prepare_sidecars(
    data: &PrivateDirectory,
) -> Result<BTreeMap<String, (File, PortableLeaseIdentity)>> {
    let mut files = BTreeMap::new();
    for name in ["connectivity.sqlite3-wal", "connectivity.sqlite3-shm"] {
        let leaf = OsStr::new(name);
        let file = match data.open_single_link_regular_file(leaf) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                let created = data.open_read_write_file(leaf, true)?;
                created.sync_all()?;
                let original = PortableLeaseIdentity::from_regular_handle(&created)?;
                // The generic creator also owns DELETE. SQLite's Windows VFS
                // does not share delete access, so retain only this same file's
                // read/query rights after its original creation has been synced.
                // SAFETY: ReOpenFile uses the held original object, not a path.
                let raw = unsafe {
                    ReOpenFile(
                        created.as_raw_handle().cast(),
                        GENERIC_READ,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        0,
                    )
                };
                ensure!(
                    raw != INVALID_HANDLE_VALUE && !raw.is_null(),
                    "CONNECTIVITY_SQLITE_SIDECAR_REOPEN_UNAVAILABLE"
                );
                // SAFETY: ReOpenFile returned a new non-inherited owned handle.
                let file: File = unsafe { OwnedHandle::from_raw_handle(raw.cast()) }.into();
                ensure!(
                    PortableLeaseIdentity::from_regular_handle(&file)? == original,
                    "CONNECTIVITY_PRIVATE_FILE_CHANGED"
                );
                drop(created);
                file
            }
            Err(error) => return Err(error),
        };
        let identity = data.portable_regular_handle_identity(&file)?;
        ensure!(
            data.portable_regular_identity(leaf)? == identity,
            "CONNECTIVITY_PRIVATE_FILE_CHANGED"
        );
        files.insert(name.to_owned(), (file, identity));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn coordination_preparation_creates_only_missing_private_leaves_and_preserves_existing_bytes()
    -> Result<()> {
        let owned = tempfile::tempdir()?;
        let root = PrivateDirectory::open_existing(owned.path())?;
        let data = root.create_private_child(OsStr::new("data"))?;
        let first = prepare_sidecars(&data)?;
        assert_eq!(first.len(), 2);
        for (name, (file, identity)) in &first {
            assert_eq!(file.metadata()?.len(), 0);
            assert_eq!(&data.portable_regular_identity(OsStr::new(name))?, identity);
        }
        let expected = b"original WAL coordination bytes";
        let mut wal = data.open_read_write_file(OsStr::new("connectivity.sqlite3-wal"), false)?;
        wal.write_all(expected)?;
        wal.sync_all()?;
        drop(wal);
        let second = prepare_sidecars(&data)?;
        for (name, (_, identity)) in &second {
            assert_eq!(identity, &first[name].1);
        }
        assert_eq!(
            control::read_bytes(&second["connectivity.sqlite3-wal"].0)?,
            expected
        );
        assert_eq!(std::fs::read_dir(owned.path().join("data"))?.count(), 2);
        Ok(())
    }
}
