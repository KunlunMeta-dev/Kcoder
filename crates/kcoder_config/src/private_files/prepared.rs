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
    /// Compare persisted publication identities without treating NTFS creation
    /// time tunneling as replacement. Keep the existing wire format: volume,
    /// file ID, last-write time and size must still match, including old receipts.
    #[doc(hidden)]
    pub fn same_file_identity(left: &str, right: &str) -> bool {
        if left == right {
            return true;
        }
        #[cfg(windows)]
        {
            let parse = |value: &str| -> Option<[u32; 9]> {
                let mut parts = value.strip_prefix("windows:")?.split(':');
                let mut fields = [0; 9];
                for field in &mut fields {
                    *field = parts.next()?.parse().ok()?;
                }
                parts.next().is_none().then_some(fields)
            };
            if let (Some(left), Some(right)) = (parse(left), parse(right)) {
                return left[..3] == right[..3] && left[5..] == right[5..];
            }
        }
        false
    }
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
            Self::same_file_identity(&identity(&file)?, expected),
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
                Self::same_file_identity(&identity(&for_rename)?, expected),
                "private_file_prepared_changed"
            );
            windows_native::rename_handle_relative(&for_rename, &self.directory, target)?;
        }
        anyhow::ensure!(
            Self::same_file_identity(&self.regular_file_identity(target)?, expected),
            "private_file_publication_identity_mismatch"
        );
        self.sync()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn prepared_replacement_retains_its_identity_after_overwriting_an_existing_name() -> Result<()>
    {
        let root = tempfile::tempdir()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        for (index, bytes) in [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .enumerate()
        {
            let source = format!("prepared-{index}");
            let mut file = directory.open_read_write_file(OsStr::new(&source), true)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            let expected = directory.regular_file_identity(OsStr::new(&source))?;
            if index > 0 {
                let previous = directory.regular_file_identity(OsStr::new("published"))?;
                directory.publish_prepared(
                    OsStr::new("published"),
                    OsStr::new("previous"),
                    &previous,
                )?;
            }
            directory.publish_prepared(OsStr::new(&source), OsStr::new("published"), &expected)?;
            assert!(PrivateDirectory::same_file_identity(
                &expected,
                &directory.regular_file_identity(OsStr::new("published"))?
            ));
            assert_eq!(std::fs::read(root.path().join("published"))?, bytes);
        }
        Ok(())
    }

    #[test]
    fn prepared_publication_rejects_a_replaced_source_with_identical_bytes() -> Result<()> {
        let root = tempfile::tempdir()?;
        let directory = PrivateDirectory::open_or_create(root.path())?;
        directory.atomic_replace(OsStr::new("prepared"), b"same bytes")?;
        let held = directory.open_regular_file(OsStr::new("prepared"))?;
        let original = identity(&held)?;
        directory.atomic_replace(OsStr::new("prepared"), b"same bytes")?;
        assert!(
            directory
                .publish_prepared(OsStr::new("prepared"), OsStr::new("published"), &original)
                .is_err()
        );
        assert!(!root.path().join("published").exists());
        assert_eq!(std::fs::read(root.path().join("prepared"))?, b"same bytes");
        Ok(())
    }

    #[cfg(windows)]
    #[test]
    fn legacy_windows_publication_identity_ignores_only_creation_time() {
        let old = "windows:10:20:30:40:50:60:70:80:90";
        let tunneled = "windows:10:20:30:41:51:60:70:80:90";
        assert!(PrivateDirectory::same_file_identity(old, tunneled));
        for index in [1, 2, 3, 6, 7, 8, 9] {
            let mut fields = old.split(':').collect::<Vec<_>>();
            fields[index] = "99";
            assert!(!PrivateDirectory::same_file_identity(
                old,
                &fields.join(":")
            ));
        }
        for malformed in [
            "windows:10:20:30:x:50:60:70:80:90",
            "windows:10:20:30:40:50:60:70:80",
            "windows:10:20:30:40:50:60:70:80:90:0",
        ] {
            assert!(!PrivateDirectory::same_file_identity(old, malformed));
        }
    }
}
