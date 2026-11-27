//! Explicit directory-link primitives. Ordinary child opens still reject links.
use super::{PrivateDirectory, PrivateEntryHandle, private_file_identity, validate_single_name};
#[cfg(windows)]
use anyhow::Context;
use anyhow::{Result, ensure};
use std::{ffi::OsStr, path::Path, path::PathBuf};

impl PrivateDirectory {
    /// Create one new directory link under the held parent, never replacing a name.
    /// The caller owns the exact namespace and must journal the returned identity
    /// before any source mutation. An error may leave an unrecorded preparation;
    /// its name alone cannot establish ownership or permission to remove/replay it.
    pub fn create_directory_link(
        &self,
        name: &OsStr,
        target: &Path,
    ) -> Result<PrivateEntryHandle<'_>> {
        validate_single_name(name)?;
        ensure!(
            target.is_absolute()
                && !target
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir)),
            "directory link target must be absolute without parent traversal"
        );
        #[cfg(any(unix, windows))]
        let file = platform::create(&self.directory, name, target)?;
        #[cfg(not(any(unix, windows)))]
        anyhow::bail!("directory links are unsupported on this platform");
        let metadata = file.metadata()?;
        let entry = PrivateEntryHandle {
            parent: self,
            name: name.to_owned(),
            file,
            metadata,
        };
        self.sync()?;
        ensure!(
            private_file_identity(&self.open_entry_handle(name)?.file)?
                == private_file_identity(&entry.file)?,
            "directory link identity is unconfirmed after creation"
        );
        entry.directory_link_target()?;
        Ok(entry)
    }
}

impl PrivateEntryHandle<'_> {
    /// Read a directory link through its no-follow handle; never open its target.
    /// Only Windows mount-point junctions are supported, not arbitrary reparse tags.
    pub fn directory_link_target(&self) -> Result<PathBuf> {
        ensure!(
            self.metadata.file_type().is_symlink(),
            "entry is not a supported directory link"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            ensure!(
                self.metadata.nlink() == 1,
                "directory link has multiple hard links"
            );
            platform::read(self)
        }
        #[cfg(windows)]
        {
            platform::read(self)
        }
        #[cfg(not(any(unix, windows)))]
        anyhow::bail!("directory links are unsupported on this platform")
    }

    /// Retain/publish this directory or link without replacing any destination.
    /// Windows renames the verified object handle. POSIX rename has no compare-ID
    /// condition: a concurrently substituted source is preserved at destination
    /// and reported as unconfirmed after checking the actual moved identity.
    pub fn rename_directory_entry_no_replace(&self, destination: &OsStr) -> Result<()> {
        validate_single_name(destination)?;
        ensure!(
            self.metadata.is_dir() || self.metadata.file_type().is_symlink(),
            "directory publication requires a directory or link"
        );
        let expected = private_file_identity(&self.file)?;
        let current = self.parent.open_entry_handle(&self.name)?;
        ensure!(
            private_file_identity(&current.file)? == expected,
            "directory publication source identity changed"
        );
        #[cfg(unix)]
        super::unix::rename_no_replace(&self.parent.directory, &self.name, destination)?;
        #[cfg(windows)]
        {
            let file = super::windows_native::open_entry(&self.parent.directory, &self.name, true)
                .context("failed to reopen the verified directory entry for publication")?;
            ensure!(
                private_file_identity(&file)? == expected,
                "directory publication source identity changed"
            );
            super::windows_native::rename_handle_relative_with_replace(
                &file,
                &self.parent.directory,
                destination,
                false,
            )
            .context("failed to rename the verified directory entry for publication")?;
        }
        self.parent.sync()?;
        let published = self.parent.open_entry_handle(destination)?;
        ensure!(
            private_file_identity(&published.file)? == expected,
            "directory publication identity is unconfirmed"
        );
        Ok(())
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::{
        ffi::CString,
        fs::File,
        os::fd::AsRawFd,
        os::unix::ffi::{OsStrExt, OsStringExt},
    };

    pub(super) fn create(parent: &File, name: &OsStr, target: &Path) -> Result<File> {
        let child = name;
        let name = CString::new(name.as_bytes())?;
        let target = CString::new(target.as_os_str().as_bytes())?;
        // SAFETY: the parent FD is held and both paths are live C strings. The
        // single name is validated by the caller; symlinkat cannot replace it.
        if unsafe { libc::symlinkat(target.as_ptr(), parent.as_raw_fd(), name.as_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        super::super::unix::open_entry(parent, child)
    }

    pub(super) fn read(entry: &PrivateEntryHandle<'_>) -> Result<PathBuf> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let (descriptor, name) = (entry.file.as_raw_fd(), CString::new("")?);
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let (descriptor, name) = {
            ensure!(
                private_file_identity(&entry.parent.open_entry_handle(&entry.name)?.file)?
                    == private_file_identity(&entry.file)?,
                "directory link identity changed before reading"
            );
            (
                entry.parent.directory.as_raw_fd(),
                CString::new(entry.name.as_bytes())?,
            )
        };
        let mut bytes = vec![0u8; 32768];
        // SAFETY: descriptor is held, the name is live, and bytes is valid output
        // storage. Linux reads the held O_PATH symlink itself via the empty name.
        let length = unsafe {
            libc::readlinkat(
                descriptor,
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
            )
        };
        if length < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        ensure!(
            (length as usize) < bytes.len(),
            "directory link target exceeds limit"
        );
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        ensure!(
            private_file_identity(&entry.parent.open_entry_handle(&entry.name)?.file)?
                == private_file_identity(&entry.file)?,
            "directory link identity changed while reading"
        );
        bytes.truncate(length as usize);
        Ok(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use anyhow::Context;
    use std::{
        fs::File,
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            io::AsRawHandle,
        },
    };
    use windows_sys::{
        Wdk::Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        },
        Win32::{
            Foundation::{GENERIC_READ, GENERIC_WRITE},
            Storage::FileSystem::{DELETE, SYNCHRONIZE},
            System::{IO::DeviceIoControl, SystemServices::IO_REPARSE_TAG_MOUNT_POINT},
        },
    };

    // winioctl.h CTL_CODE(FILE_DEVICE_FILE_SYSTEM, 41/42, METHOD_BUFFERED, FILE_ANY_ACCESS).
    // Their values match windows-sys' Win32_System_Ioctl constants; no extra feature is needed.
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00a4;
    const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00a8;
    const REPARSE_LIMIT: usize = 16 * 1024;

    pub(super) fn create(parent: &File, name: &OsStr, target: &Path) -> Result<File> {
        let mut dos: Vec<u16> = target.as_os_str().encode_wide().collect();
        let extended: Vec<u16> = r"\\?\".encode_utf16().collect();
        if dos.starts_with(&extended) {
            dos.drain(..extended.len());
        }
        ensure!(
            dos.len() >= 3 && dos[1] == b':' as u16 && dos[2] == b'\\' as u16,
            "junction requires an absolute local DOS target"
        );
        ensure!(!dos.contains(&0), "junction target contains NUL");
        let mut substitute: Vec<u16> = r"\??\".encode_utf16().collect();
        substitute.extend_from_slice(&dos);
        let substitute_bytes = substitute
            .len()
            .checked_mul(2)
            .context("junction target overflow")?;
        let print_bytes = dos
            .len()
            .checked_mul(2)
            .context("junction target overflow")?;
        let data_length = 8usize
            .checked_add(substitute_bytes + 2)
            .and_then(|size| size.checked_add(print_bytes + 2))
            .context("junction target overflow")?;
        ensure!(
            data_length + 8 <= REPARSE_LIMIT,
            "junction target exceeds reparse limit"
        );
        let mut buffer = Vec::with_capacity(data_length + 8);
        buffer.extend_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
        for value in [
            data_length as u16,
            0,
            0,
            substitute_bytes as u16,
            (substitute_bytes + 2) as u16,
            print_bytes as u16,
        ] {
            buffer.extend_from_slice(&value.to_le_bytes());
        }
        for unit in substitute
            .iter()
            .chain(std::iter::once(&0))
            .chain(dos.iter())
            .chain(std::iter::once(&0))
        {
            buffer.extend_from_slice(&unit.to_le_bytes());
        }
        let file = super::super::windows_native::nt_create_relative(
            parent,
            name,
            GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE,
            FILE_CREATE,
            FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
        )?;
        let mut returned = 0u32;
        // SAFETY: the new ordinary directory is exclusively created under the
        // held parent. The complete mount-point buffer stays live during the call.
        if unsafe {
            DeviceIoControl(
                file.as_raw_handle().cast(),
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(file)
    }

    pub(super) fn read(entry: &PrivateEntryHandle<'_>) -> Result<PathBuf> {
        let mut buffer = vec![0u8; REPARSE_LIMIT];
        let mut returned = 0u32;
        // SAFETY: the no-follow entry handle is held, the writable buffer and
        // returned-size pointer remain valid for this synchronous control call.
        if unsafe {
            DeviceIoControl(
                entry.file.as_raw_handle().cast(),
                FSCTL_GET_REPARSE_POINT,
                std::ptr::null(),
                0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        let length = returned as usize;
        ensure!(
            length >= 16 && length <= buffer.len(),
            "junction buffer is truncated"
        );
        buffer.truncate(length);
        let word =
            |offset: usize| u16::from_le_bytes([buffer[offset], buffer[offset + 1]]) as usize;
        ensure!(
            u32::from_le_bytes(buffer[..4].try_into()?) == IO_REPARSE_TAG_MOUNT_POINT,
            "entry is not a mount-point junction"
        );
        ensure!(
            word(4) + 8 == buffer.len(),
            "junction data length is invalid"
        );
        let offset = word(8);
        let length = word(10);
        ensure!(
            offset % 2 == 0
                && length > 0
                && length % 2 == 0
                && offset
                    .checked_add(length)
                    .is_some_and(|end| end <= buffer.len() - 16),
            "junction substitute name is invalid"
        );
        let units = buffer[16 + offset..16 + offset + length]
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>();
        ensure!(!units.contains(&0), "junction substitute name contains NUL");
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&units)))
    }
}

#[cfg(test)]
#[path = "cache_links_tests.rs"]
mod tests;
