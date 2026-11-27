//! Windows image identity is held by a kernel lease denying writes and deletes.
use anyhow::{Context, Result, ensure};
use kcoder_native_image_identity::{
    HashFailure, file_information, open_share_read, sha256_bounded,
};
use std::{
    ffi::{OsString, c_void},
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::windows::ffi::OsStringExt,
    path::{Path, PathBuf},
};
use windows_sys::Win32::System::{ProcessStatus::GetMappedFileNameW, Threading::GetCurrentProcess};

#[derive(PartialEq, Eq)]
struct Identity {
    volume: u32,
    index: u64,
    size: u64,
    links: u32,
}

/// This is never reconstructed from a digest or a path observation.
pub(super) struct ImageLease {
    file: File,
    path: PathBuf,
    identity: Identity,
    system: bool,
}

impl ImageLease {
    pub(super) fn capture(path: &Path, sha256: &str, library: bool) -> Result<Self> {
        Self::capture_inner(path, sha256, library, false)
    }

    pub(super) fn capture_system_ssh(sha256: &str) -> Result<Self> {
        let path = super::process::system_ssh_path()?;
        Self::capture_inner(&path, sha256, false, true)
    }

    fn capture_inner(path: &Path, sha256: &str, library: bool, system: bool) -> Result<Self> {
        ensure!(
            path.is_absolute() && valid_sha(sha256),
            "NATIVE_IMAGE_INPUT_INVALID"
        );
        let path = path.canonicalize().context("NATIVE_IMAGE_UNAVAILABLE")?;
        let mut file = locked_file(&path)?;
        let identity = identity(&file, system)?;
        if system {
            super::system_file::verify(&file)?;
        }
        ensure!(
            (4096..=1024 * 1024 * 1024).contains(&identity.size),
            "NATIVE_IMAGE_SIZE_INVALID"
        );
        verify_pe(&mut file, library)?;
        file.seek(SeekFrom::Start(0))?;
        let digest = sha256_bounded::<{ 64 * 1024 }>(&mut file, identity.size, || false).map_err(
            |failure| match failure {
                HashFailure::Io(error) => anyhow::Error::from(error),
                HashFailure::Overflow => anyhow::anyhow!("NATIVE_IMAGE_SIZE_INVALID"),
                HashFailure::Exceeded | HashFailure::Cancelled => {
                    anyhow::anyhow!("NATIVE_IMAGE_IDENTITY_CHANGED")
                }
            },
        )?;
        ensure!(
            digest.bytes == identity.size && digest.sha256 == sha256,
            "NATIVE_IMAGE_HASH_MISMATCH"
        );
        let result = Self {
            file,
            path,
            identity,
            system,
        };
        ensure!(
            result.matches(&result.path)?,
            "NATIVE_IMAGE_IDENTITY_CHANGED"
        );
        Ok(result)
    }

    pub(super) fn matches(&self, path: &Path) -> Result<bool> {
        if !path.is_absolute() || path.canonicalize()? != self.path {
            return Ok(false);
        }
        // The original handle denies WRITE and DELETE sharing for its whole
        // lifetime. These IDs check the path still names that held image;
        // metadata alone never creates a lease or substitutes for the hash.
        if self.system {
            super::system_file::verify(&self.file)?;
        }
        Ok(identity(&self.file, self.system)? == self.identity
            && identity(&locked_file(path)?, self.system)? == self.identity)
    }

    pub(super) fn same_image(&self, other: &Self) -> bool {
        self.identity == other.identity
    }
}

pub(super) fn loaded_addon_path(address: *const c_void) -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    // SAFETY: the address belongs to this loaded module, the process pseudo
    // handle remains valid, and the mutable UTF-16 buffer has the given length.
    let length = unsafe {
        GetMappedFileNameW(
            GetCurrentProcess(),
            address,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
        )
    } as usize;
    ensure!(
        length > 0 && length < buffer.len() - 1,
        "NATIVE_ADDON_MAPPING_UNAVAILABLE"
    );
    let path = OsString::from_wide(&buffer[..length]);
    let text = path.to_str().context("NATIVE_ADDON_MAPPING_UNAVAILABLE")?;
    ensure!(
        text.starts_with("\\Device\\"),
        "NATIVE_ADDON_MAPPING_UNAVAILABLE"
    );
    Ok(PathBuf::from(format!("\\\\?\\GLOBALROOT{text}")))
}

fn locked_file(path: &Path) -> Result<File> {
    open_share_read(path).context("NATIVE_IMAGE_LOCK_UNAVAILABLE")
}

fn identity(file: &File, system: bool) -> Result<Identity> {
    let value = file_information(file).context("NATIVE_IMAGE_IDENTITY_UNAVAILABLE")?;
    ensure!(
        value.is_plain_file() && (value.links == 1 || system && value.links > 1),
        "NATIVE_IMAGE_UNSAFE"
    );
    Ok(Identity {
        volume: value.volume,
        index: value.index,
        size: value.bytes,
        links: value.links,
    })
}

fn verify_pe(file: &mut File, library: bool) -> Result<()> {
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos)?;
    let offset = u32::from_le_bytes(dos[60..64].try_into()?);
    ensure!(
        &dos[..2] == b"MZ" && (64..=1024 * 1024).contains(&offset),
        "NATIVE_IMAGE_PE_REQUIRED"
    );
    file.seek(SeekFrom::Start(u64::from(offset)))?;
    let mut pe = [0u8; 24];
    file.read_exact(&mut pe)?;
    let characteristics = u16::from_le_bytes(pe[22..24].try_into()?);
    ensure!(
        &pe[..4] == b"PE\0\0"
            && u16::from_le_bytes(pe[4..6].try_into()?) == 0x8664
            && (characteristics & 0x2000 != 0) == library,
        "NATIVE_IMAGE_PE_REQUIRED"
    );
    Ok(())
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
