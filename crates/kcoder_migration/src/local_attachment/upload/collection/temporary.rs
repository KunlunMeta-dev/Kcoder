use super::*;
#[cfg(any(target_os = "linux", windows))]
pub(super) fn original_temporary_name(directory: &PrivateDirectory, file: &File) -> Result<String> {
    #[cfg(target_os = "linux")]
    let path = {
        use std::os::fd::AsRawFd;
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?
    };
    #[cfg(windows)]
    let path = {
        use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
        let mut value = vec![0u16; 32768];
        // SAFETY: the live descriptor and bounded writable UTF-16 output remain valid.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle().cast(),
                value.as_mut_ptr(),
                value.len() as u32,
                0,
            )
        };
        ensure!(
            length > 0 && (length as usize) < value.len(),
            "local_upload_collection_temporary_identity_unavailable"
        );
        PathBuf::from(std::ffi::OsString::from_wide(&value[..length as usize]))
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("local_upload_collection_temporary_identity_unavailable")?;
    ensure!(
        name.len() <= 128 && name.starts_with('.') && canonical_leaf(name).is_some(),
        "local_upload_collection_temporary_identity_unavailable"
    );
    // The OS name is a locator only. Reopen from the ORIGINAL directory capability
    // and compare the actual descriptors before recording any cleanup ownership.
    ensure!(
        directory.portable_regular_identity(OsStr::new(name))?
            == directory.portable_regular_handle_identity(file)?,
        "local_upload_collection_temporary_identity_changed"
    );
    Ok(name.into())
}

#[cfg(not(any(target_os = "linux", windows)))]
pub(super) fn original_temporary_name(
    _directory: &PrivateDirectory,
    _file: &File,
) -> Result<String> {
    anyhow::bail!("local_upload_collection_temporary_identity_unsupported")
}
