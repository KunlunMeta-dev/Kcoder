//! Opaque revisions use the actual opened handle, including sub-millisecond
//! change times and file identity. They never use access time or hash full files.
use anyhow::Result;
use sha2::{Digest, Sha256};
use std::{fs::File, time::UNIX_EPOCH};

/// Stable identity survives a rename, unlike change-time revisions.
pub(super) fn file_identity(file: &File) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::{mem::zeroed, os::windows::io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut id: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        // SAFETY: file owns the live handle and id is a correctly sized buffer.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut id) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(format!(
            "{}:{}:{}",
            id.dwVolumeSerialNumber, id.nFileIndexHigh, id.nFileIndexLow
        ))
    }
    #[cfg(not(any(unix, windows)))]
    Ok(format!("{:?}", file.metadata()?.created()?))
}

pub(super) fn revision(file: &File) -> Result<String> {
    Ok(snapshot(file)?.1)
}

pub(super) fn snapshot(file: &File) -> Result<(std::fs::Metadata, String)> {
    let metadata = file.metadata()?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    };
    #[cfg(windows)]
    let identity = {
        use std::{
            mem::{size_of, zeroed},
            os::windows::io::AsRawHandle,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle,
            GetFileInformationByHandleEx,
        };
        let mut id: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        let mut basic: FILE_BASIC_INFO = unsafe { zeroed() };
        let handle = file.as_raw_handle();
        if unsafe { GetFileInformationByHandle(handle, &mut id) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        format!(
            "{}:{}:{}:{}",
            id.dwVolumeSerialNumber, id.nFileIndexHigh, id.nFileIndexLow, basic.ChangeTime
        )
    };
    #[cfg(not(any(unix, windows)))]
    let identity = format!("{:?}", metadata.created()?);
    // Preserve existing nonnegative stamps byte-for-byte. Historical files can
    // predate the epoch; encode their complete nanosecond distance with a sign.
    let modified = match metadata.modified()?.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos().to_string(),
        Err(before_epoch) => format!("-{}", before_epoch.duration().as_nanos()),
    };
    let revision = format!(
        "file-v1:{:x}",
        Sha256::digest(format!("{identity}:{modified}:{}", metadata.len()).as_bytes())
    );
    Ok((metadata, revision))
}
