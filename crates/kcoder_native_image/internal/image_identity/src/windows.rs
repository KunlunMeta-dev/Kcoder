//! Held Windows file and process-image observations.
use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    io,
    mem::zeroed,
    os::windows::{
        ffi::OsStringExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, RawHandle},
    },
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, GetFileInformationByHandle,
    },
    System::Threading::QueryFullProcessImageNameW,
};

/// Open `path` for reading with only read sharing, so no writer, deleter or
/// renamer can coexist with the returned handle for its whole lifetime. A
/// final reparse point is opened as itself, never followed.
pub fn open_share_read(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

/// Kernel file identity read from a held handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileInformation {
    pub attributes: u32,
    pub volume: u32,
    pub index: u64,
    pub bytes: u64,
    pub links: u32,
}

impl FileInformation {
    /// Neither a directory nor a reparse point. Link-count policy stays with
    /// the caller (ordinary images require one link; only the fixed system
    /// OpenSSH image may have servicing hard links).
    pub fn is_plain_file(&self) -> bool {
        self.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) == 0
    }
}

/// `GetFileInformationByHandle` on the held file; `None` when the query fails.
pub fn file_information(file: &File) -> Option<FileInformation> {
    // SAFETY: an all-zero value is valid for this plain-data output struct.
    let mut value: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    // SAFETY: File owns this valid handle and the output has the exact API size.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut value) } == 0 {
        return None;
    }
    Some(FileInformation {
        attributes: value.dwFileAttributes,
        volume: value.dwVolumeSerialNumber,
        index: (u64::from(value.nFileIndexHigh) << 32) | u64::from(value.nFileIndexLow),
        bytes: (u64::from(value.nFileSizeHigh) << 32) | u64::from(value.nFileSizeLow),
        links: value.nNumberOfLinks,
    })
}

/// The Win32 image path of a held (or pseudo) process handle, exactly as the
/// kernel reports it. This never opens a process by PID and never
/// canonicalizes; `None` when the query fails or the path does not fit.
pub fn process_image_path(process: RawHandle) -> Option<PathBuf> {
    let mut path = vec![0u16; 32768];
    let mut count = path.len() as u32;
    // SAFETY: query-only use of the caller's process handle; the UTF-16
    // buffer has `count` slots and the API writes at most that many.
    let queried =
        unsafe { QueryFullProcessImageNameW(process.cast(), 0, path.as_mut_ptr(), &mut count) };
    if queried == 0 || count == 0 || count as usize >= path.len() {
        return None;
    }
    Some(PathBuf::from(OsString::from_wide(&path[..count as usize])))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    #[test]
    fn share_read_handle_denies_writers_and_reports_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.bin");
        std::fs::write(&path, vec![3u8; 5000]).unwrap();
        let held = open_share_read(&path).unwrap();
        let info = file_information(&held).unwrap();
        assert!(info.is_plain_file());
        assert_eq!((info.bytes, info.links), (5000, 1));
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(std::fs::remove_file(&path).is_err());
        let again = file_information(&open_share_read(&path).unwrap()).unwrap();
        assert_eq!((again.volume, again.index), (info.volume, info.index));
        let directory_handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(directory.path())
            .unwrap();
        assert!(!file_information(&directory_handle).unwrap().is_plain_file());
    }

    #[test]
    fn current_process_image_is_reported_without_a_pid_lookup() {
        let path = process_image_path(unsafe { GetCurrentProcess() }).unwrap();
        assert_eq!(
            path.canonicalize().unwrap(),
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
        assert!(process_image_path(std::ptr::null_mut()).is_none());
    }
}
