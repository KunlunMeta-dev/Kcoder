//! Kernel directory aliases for a native SQLite VFS, never a caller path resolver.
use super::*;

impl PrivateDirectory {
    /// The owner must retain this exact handle for every SQLite DB/WAL/SHM
    /// reference to the returned alias. Do not canonicalize the alias to a name.
    pub fn native_sqlite_entry_alias(&self, name: &OsStr) -> Result<PathBuf> {
        validate_single_name(name)?;
        self.verify_private_directory()?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;
            let prefix = if cfg!(any(target_os = "linux", target_os = "android")) {
                "/proc/self/fd"
            } else {
                "/dev/fd"
            };
            let root = PathBuf::from(format!("{prefix}/{}", self.directory.as_raw_fd()));
            // The dot also proves that this kernel alias supports traversal,
            // rather than merely describing a descriptor as a character node.
            let actual = std::fs::metadata(root.join("."))?;
            let held = self.directory_metadata()?;
            anyhow::ensure!(
                actual.is_dir() && actual.dev() == held.dev() && actual.ino() == held.ino(),
                "native SQLite directory alias unavailable"
            );
            Ok(root.join(name))
        }
        #[cfg(not(unix))]
        {
            anyhow::bail!("native SQLite directory alias unsupported on this platform")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn descriptor_alias_retains_original_directory_after_name_replacement() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("knowledge");
        let original = PrivateDirectory::open_or_create(&root)?;
        original.atomic_replace(OsStr::new("state.sqlite"), b"original descriptor")?;
        let alias = original.native_sqlite_entry_alias(OsStr::new("state.sqlite"))?;
        std::fs::rename(&root, temp.path().join("held-original"))?;
        PrivateDirectory::open_or_create(&root)?
            .atomic_replace(OsStr::new("state.sqlite"), b"replacement")?;
        assert_eq!(std::fs::read(alias)?, b"original descriptor");
        assert!(
            original
                .native_sqlite_entry_alias(OsStr::new("../outside"))
                .is_err()
        );
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn native_name_pin_keeps_original_directory_and_database_names() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let root = temp.path().join("knowledge");
        let original = PrivateDirectory::open_or_create(&root)?;
        let pin = original.pin_native_sqlite_directory(OsStr::new("state.sqlite"))?;
        assert!(std::fs::rename(&root, temp.path().join("moved")).is_err());
        assert!(std::fs::rename(root.join("state.sqlite"), root.join("different.sqlite")).is_err());
        drop(pin);
        std::fs::rename(&root, temp.path().join("moved"))?;
        Ok(())
    }
}

#[cfg(windows)]
pub struct NativeSqliteDirectoryPin {
    _directory: File,
    _database: File,
    path: PathBuf,
}
#[cfg(windows)]
impl NativeSqliteDirectoryPin {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn verify_database_handle(
        &self,
        handle: std::os::windows::io::BorrowedHandle<'_>,
    ) -> Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        anyhow::ensure!(
            unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } != 0,
            "native SQLite database handle unavailable"
        );
        let identity = (
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        );
        anyhow::ensure!(
            identity == private_file_identity(&self._database)?,
            "native SQLite database handle changed"
        );
        Ok(())
    }
}

#[cfg(windows)]
impl PrivateDirectory {
    /// Retain the actual directory name with native no-DELETE sharing before
    /// obtaining its canonical volume path for the unchanged Windows SQLite VFS.
    pub fn pin_native_sqlite_directory(
        &self,
        database: &OsStr,
    ) -> Result<NativeSqliteDirectoryPin> {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFinalPathNameByHandleW, VOLUME_NAME_GUID,
        };
        self.verify_private_directory()?;
        validate_single_name(database)?;
        let directory = windows_native::open_same_directory_no_delete_share(&self.directory)
            .context("native SQLite held directory name pin unavailable")?;
        anyhow::ensure!(
            private_file_identity(&directory)? == private_file_identity(&self.directory)?,
            "native SQLite directory changed"
        );
        let raw = directory.as_raw_handle();
        let needed =
            unsafe { GetFinalPathNameByHandleW(raw, std::ptr::null_mut(), 0, VOLUME_NAME_GUID) };
        anyhow::ensure!(
            needed > 0 && needed <= 32768,
            "native SQLite directory path unavailable"
        );
        let mut path = vec![0u16; needed as usize + 1];
        let length = unsafe {
            GetFinalPathNameByHandleW(raw, path.as_mut_ptr(), path.len() as u32, VOLUME_NAME_GUID)
        };
        anyhow::ensure!(
            length > 0 && (length as usize) < path.len(),
            "native SQLite directory path unavailable"
        );
        path.truncate(length as usize);
        let path = PathBuf::from(OsString::from_wide(&path));
        let named = windows_native::open_absolute_directory(&path)
            .context("native SQLite kernel volume path unavailable")?;
        anyhow::ensure!(
            private_file_identity(&named)? == private_file_identity(&directory)?,
            "native SQLite directory path changed"
        );
        let (database, created) = windows_native::pin_sqlite_file(&directory, database)?;
        verify_reader_links(&database, false)?;
        if created {
            secure_private_handle(&database, false)?;
            database.sync_all()?;
            self.sync()?;
        }
        Ok(NativeSqliteDirectoryPin {
            _directory: directory,
            _database: database,
            path,
        })
    }
}
