//! Held executable identity and content pin for a configured Native remote.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

pub fn file_identity(file: &File) -> Result<String> {
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "REMOTE_NATIVE_INSTALLATION_INVALID");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        ensure!(
            metadata.nlink() == 1 && metadata.permissions().mode() & 0o022 == 0,
            "REMOTE_NATIVE_INSTALLATION_UNSAFE"
        );
        Ok(format!(
            "unix:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.uid(),
            metadata.mode(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec()
        ))
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_INFO, FILE_STANDARD_INFO, FileIdInfo,
            FileStandardInfo, GetFileInformationByHandleEx,
        };
        let mut id: FILE_ID_INFO = unsafe { std::mem::zeroed() };
        let mut standard: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: the File owns a live process-local handle and both output
        // structures have the exact Windows SDK layout/size for their classes.
        ensure!(
            unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle().cast(),
                    FileIdInfo,
                    (&mut id as *mut FILE_ID_INFO).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            } != 0
                && unsafe {
                    GetFileInformationByHandleEx(
                        file.as_raw_handle().cast(),
                        FileStandardInfo,
                        (&mut standard as *mut FILE_STANDARD_INFO).cast(),
                        std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
                    )
                } != 0,
            "REMOTE_NATIVE_INSTALLATION_IDENTITY_UNAVAILABLE"
        );
        ensure!(
            standard.NumberOfLinks == 1
                && !standard.Directory
                && !standard.DeletePending
                && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "REMOTE_NATIVE_INSTALLATION_UNSAFE"
        );
        Ok(format!(
            "windows:{:016x}:{:02x?}:{}:{}:{}",
            id.VolumeSerialNumber,
            id.FileId.Identifier,
            metadata.file_size(),
            metadata.last_write_time(),
            metadata.file_attributes()
        ))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        anyhow::bail!("REMOTE_NATIVE_INSTALLATION_IDENTITY_PROVIDER_UNAVAILABLE")
    }
}
pub fn program_pin(file: &File) -> Result<(String, String)> {
    let before = file_identity(file)?;
    let mut reader = file.try_clone()?;
    reader.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    ensure!(
        file_identity(file)? == before,
        "REMOTE_NATIVE_INSTALLATION_CHANGED"
    );
    Ok((before, format!("{:x}", hash.finalize())))
}
