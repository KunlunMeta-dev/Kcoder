//! Advisory capacity for the held directory's filesystem, without reopening a mutable pathname.
use super::*;

/// Capacity can change immediately after observation; writes still require transactional recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvailableStorage {
    pub bytes: u64,
    /// None means the filesystem does not expose a fixed free-node count.
    pub file_nodes: Option<u64>,
}

impl PrivateDirectory {
    /// Observe filesystem-reported capacity on this directory handle; never creates or repairs it.
    pub fn available_storage(&self) -> Result<AvailableStorage> {
        self.verify_trusted_config_directory()?;
        available(&self.directory)
    }
}

fn checked_bytes(units: u128, size: u128) -> Result<u64> {
    anyhow::ensure!(size > 0, "private_storage_capacity_invalid");
    u64::try_from(
        units
            .checked_mul(size)
            .ok_or_else(|| anyhow::anyhow!("private_storage_capacity_invalid"))?,
    )
    .map_err(|_| anyhow::anyhow!("private_storage_capacity_invalid"))
}

#[cfg(unix)]
fn available(file: &File) -> Result<AvailableStorage> {
    use std::os::fd::AsRawFd;
    let mut output = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: the owned descriptor remains live; successful fstatvfs initializes the full output.
    if unsafe { libc::fstatvfs(file.as_raw_fd(), output.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: success above initialized output.
    let output = unsafe { output.assume_init() };
    Ok(AvailableStorage {
        bytes: checked_bytes(u128::from(output.f_bavail), u128::from(output.f_frsize))?,
        file_nodes: if output.f_files == 0 {
            None
        } else {
            Some(
                u64::try_from(u128::from(output.f_favail))
                    .map_err(|_| anyhow::anyhow!("private_storage_capacity_invalid"))?,
            )
        },
    })
}

#[cfg(windows)]
fn available(file: &File) -> Result<AvailableStorage> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::{
        Wdk::Storage::FileSystem::{FileFsFullSizeInformation, NtQueryVolumeInformationFile},
        Win32::{Foundation::RtlNtStatusToDosError, System::IO::IO_STATUS_BLOCK},
    };
    // MS FILE_FS_FULL_SIZE_INFORMATION is three LARGE_INTEGERs and two ULONGs, aligned to 8.
    // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_fs_full_size_information
    #[repr(C, align(8))]
    #[derive(Default)]
    struct FullSize {
        _total_units: i64,
        caller_available_units: i64,
        _actual_available_units: i64,
        sectors_per_unit: u32,
        bytes_per_sector: u32,
    }
    let mut output = FullSize::default();
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: this is a held directory handle and a correctly sized/aligned native output buffer.
    let status = unsafe {
        NtQueryVolumeInformationFile(
            file.as_raw_handle().cast(),
            &mut io,
            (&mut output as *mut FullSize).cast(),
            size_of::<FullSize>() as u32,
            FileFsFullSizeInformation,
        )
    };
    if status < 0 {
        // SAFETY: NTSTATUS is the value returned by the native call above.
        return Err(std::io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32
        )
        .into());
    }
    anyhow::ensure!(
        io.Information >= size_of::<FullSize>() && output.caller_available_units >= 0,
        "private_storage_capacity_invalid"
    );
    let size = u128::from(output.sectors_per_unit) * u128::from(output.bytes_per_sector);
    Ok(AvailableStorage {
        bytes: checked_bytes(output.caller_available_units as u128, size)?,
        file_nodes: None,
    })
}

#[cfg(not(any(unix, windows)))]
fn available(_: &File) -> Result<AvailableStorage> {
    anyhow::bail!("private_storage_capacity_unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_or_overflowed_capacity_is_not_saturated_into_a_success() {
        assert!(checked_bytes(0, 0).is_err());
        assert!(checked_bytes(u128::MAX, 2).is_err());
        assert!(checked_bytes(u128::from(u64::MAX), 2).is_err());
        assert_eq!(checked_bytes(0, 4096).unwrap(), 0);
        assert_eq!(checked_bytes(7, 4096).unwrap(), 28672);
    }

    #[test]
    fn held_directory_capacity_does_not_depend_on_its_old_path() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("owned");
        std::fs::create_dir(&old).unwrap();
        crate::set_user_only_dir_permissions(&old).unwrap();
        let directory = PrivateDirectory::open_existing(&old).unwrap();
        let identity = directory.directory_identity().unwrap();
        std::fs::rename(&old, root.path().join("moved-owned")).unwrap();
        std::fs::create_dir(&old).unwrap();
        crate::set_user_only_dir_permissions(&old).unwrap();
        let _capacity = directory.available_storage().unwrap();
        assert_eq!(directory.directory_identity().unwrap(), identity);
        assert_ne!(
            PrivateDirectory::open_existing(&old)
                .unwrap()
                .directory_identity()
                .unwrap(),
            identity
        );
    }
}
