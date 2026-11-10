//! Prepared replacements bind the publication receipt to the actual renamed file identity.
use super::*;

pub(crate) fn identity(file: &File) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(format!(
            "unix:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.len()
        ))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: file owns a live handle and info is valid output storage.
        anyhow::ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } != 0,
            "private_file_identity_unavailable"
        );
        Ok(format!(
            "windows:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime,
            info.ftLastWriteTime.dwHighDateTime,
            info.ftLastWriteTime.dwLowDateTime,
            info.nFileSizeHigh,
            info.nFileSizeLow
        ))
    }
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("private_file_identity_unavailable")
}

impl PrivateDirectory {
    /// Bind a snapshot to the opened descriptor rather than a second path lookup.
    #[doc(hidden)]
    pub fn identity_of_file(file: &File) -> Result<String> {
        identity(file)
    }
    #[doc(hidden)]
    pub fn regular_file_identity(&self, name: &OsStr) -> Result<String> {
        identity(&self.open_single_link_regular_file(name)?)
    }

    /// The caller owns and serializes both leaves; a replaced source is never adopted.
    #[doc(hidden)]
    pub fn publish_prepared(&self, source: &OsStr, target: &OsStr, expected: &str) -> Result<()> {
        validate_single_name(source)?;
        validate_single_name(target)?;
        anyhow::ensure!(
            source != target,
            "private_file_invalid_prepared_destination"
        );
        let file = self.open_single_link_regular_file(source)?;
        anyhow::ensure!(
            identity(&file)? == expected,
            "private_file_prepared_changed"
        );
        #[cfg(unix)]
        rename(
            &self.directory,
            Path::new(source),
            &self.directory,
            Path::new(target),
        )?;
        #[cfg(windows)]
        {
            let for_rename = windows_native::open_entry(&self.directory, source, true)?;
            anyhow::ensure!(
                identity(&for_rename)? == expected,
                "private_file_prepared_changed"
            );
            windows_native::rename_handle_relative(&for_rename, &self.directory, target)?;
        }
        anyhow::ensure!(
            self.regular_file_identity(target)? == expected,
            "private_file_publication_identity_mismatch"
        );
        self.sync()
    }
}
