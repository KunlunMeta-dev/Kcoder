#![cfg(windows)]

//! Opt-in, task-owned second volume for Windows storage migration acceptance.
//! The caller must retain this process in its existing private Job.
//! This fixture never initializes disks, formats volumes, assigns letters, or deletes files.
//!
//! Set KCODER_E2E_OWNED_VHDX_ROOT to an existing private run directory. Its original
//! .owner.json and vhdx-request.json must agree on owner; the request also supplies
//! maximum_size_bytes (64 MiB to 2 GiB) and budget_ms (1 to 600 seconds).
//! Launch with --ignored --exact owned_vhdx_fixture --nocapture --test-threads=1.
//! After READY, atomically publish {"owner":"the-original-owner","command":"STOP"}
//! as stop.json. The original image remains for authoritative inspection and cleanup.
//! The caller must close storage-query handles before requesting normal detach.

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
};
use windows_sys::Win32::Storage::Vhd::{
    ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER, ATTACH_VIRTUAL_DISK_PARAMETERS,
    ATTACH_VIRTUAL_DISK_VERSION_1, AttachVirtualDisk, CREATE_VIRTUAL_DISK_FLAG_NONE,
    CREATE_VIRTUAL_DISK_PARAMETERS, CREATE_VIRTUAL_DISK_PARAMETERS_0,
    CREATE_VIRTUAL_DISK_PARAMETERS_0_1, CREATE_VIRTUAL_DISK_VERSION_2, CreateVirtualDisk,
    DETACH_VIRTUAL_DISK_FLAG_NONE, DetachVirtualDisk, GetVirtualDiskPhysicalPath,
    VIRTUAL_DISK_ACCESS_NONE, VIRTUAL_STORAGE_TYPE, VIRTUAL_STORAGE_TYPE_DEVICE_VHDX,
    VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT,
};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

const FRAME_LIMIT: u64 = 4096;
const IMAGE_LEAF: &str = "cross-volume.vhdx";
const ROOT_ENV: &str = "KCODER_E2E_OWNED_VHDX_ROOT";
const MIB: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    owner: String,
    maximum_size_bytes: u64,
    budget_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Stop {
    owner: String,
    command: String,
}

#[test]
#[ignore = "Requires an explicit owned root, a private Windows Job, and native VHDX authorization"]
fn owned_vhdx_fixture() {
    run().unwrap();
}

fn run() -> Result<()> {
    let root = std::env::var(ROOT_ENV).context("Explicit owned VHDX root is required")?;
    validate_root(&root)?;
    let mut in_job = 0;
    // SAFETY: The current process pseudo-handle and the output pointer are valid.
    ensure!(
        unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) } != 0 && in_job != 0,
        "VHDX fixture requires the caller's existing owned Job"
    );

    let root = Path::new(&root);
    let _directories = pin_directories(root)?;
    let (_owner_file, owner_info, marker) = read_json(&root.join(".owner.json"))?;
    let (_request_file, _, request) = read_json(&root.join("vhdx-request.json"))?;
    let request: Request = serde_json::from_value(request).context("Invalid owned VHDX request")?;
    validate_request(&request)?;
    ensure!(
        marker["owner"] == request.owner,
        "Original VHDX owner changed"
    );
    let started = Instant::now();
    let budget = Duration::from_millis(request.budget_ms);

    let image_path = root.join(IMAGE_LEAF);
    let stop_path = root.join("stop.json");
    require_absent(&image_path)?;
    require_absent(&stop_path)?;
    let disk = create_disk(&image_path, request.maximum_size_bytes)?;
    let image = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&image_path)
        .context("Cannot retain newly created image identity")?;
    let image_info = file_info(&image)?;
    ensure_regular_single_link(&image_info)?;
    // Do not attach after an explicit stop published during image creation.
    require_absent(&stop_path)?;
    ensure!(
        started.elapsed() < budget,
        "Owned VHDX creation exceeded budget"
    );

    let parameters = ATTACH_VIRTUAL_DISK_PARAMETERS {
        Version: ATTACH_VIRTUAL_DISK_VERSION_1,
        ..Default::default()
    };
    // SAFETY: Keep the original disk handle alive until explicit detach or process exit.
    // Omitting PERMANENT_LIFETIME makes OS handle close detach even after Job termination.
    win32(
        unsafe {
            AttachVirtualDisk(
                disk.as_raw_handle(),
                null_mut(),
                ATTACH_VIRTUAL_DISK_FLAG_NO_DRIVE_LETTER,
                0,
                &parameters,
                null(),
            )
        },
        "Attach original owned VHDX",
    )?;
    let physical_disk = physical_path(&disk)?;
    let image_identity = identity(&image_info);
    emit(json!({
        "event": "READY", "owner": request.owner, "image_path": image_path,
        "image_identity": image_identity, "owner_identity": identity(&owner_info),
        "physical_disk": physical_disk, "maximum_size_bytes": request.maximum_size_bytes,
        "dynamic": true, "permanent_lifetime": false, "automatic_drive_letter": false,
        "budget_ms": request.budget_ms
    }))?;

    let stop: Result<&str> = (|| {
        loop {
            ensure!(started.elapsed() < budget, "Owned VHDX deadline elapsed");
            match read_json(&stop_path) {
                Ok((_file, _, stop)) => {
                    let stop: Stop = serde_json::from_value(stop).context("Invalid VHDX stop")?;
                    ensure!(
                        stop.owner == request.owner && stop.command == "STOP",
                        "VHDX stop owner mismatch"
                    );
                    return Ok("owner_stop");
                }
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
                Err(error) => return Err(error),
            }
            std::thread::sleep(
                Duration::from_millis(100).min(budget.saturating_sub(started.elapsed())),
            );
        }
    })();
    ensure!(
        identity(&file_info(&image)?) == image_identity,
        "Original VHDX image identity changed"
    );
    // SAFETY: This is the same handle used by AttachVirtualDisk, never a disk number.
    let detach_code =
        unsafe { DetachVirtualDisk(disk.as_raw_handle(), DETACH_VIRTUAL_DISK_FLAG_NONE, 0) };
    let (physical_path_code, _) = physical_path_result(&disk);
    emit(json!({
        "event": "STOPPED", "owner": request.owner, "image_path": image_path,
        "image_identity": image_identity, "physical_disk": physical_disk,
        "reason": stop.as_ref().copied().unwrap_or("owner_input_or_deadline_failure"),
        "detach_code": detach_code, "physical_path_code_after_detach": physical_path_code
    }))?;
    win32(detach_code, "Detach original owned VHDX")?;
    ensure!(
        physical_path_code != 0,
        "Original VHDX still exposes a physical disk after detach"
    );
    stop?;
    // Image and owner files remain for the original RunContext's evidence and cleanup.
    Ok(())
}

fn require_absent(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => bail!("Owned VHDX image and stop paths must not already exist"),
    }
}

fn read_json(path: &Path) -> Result<(File, BY_HANDLE_FILE_INFORMATION, Value)> {
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let info = file_info(&file)?;
    ensure_regular_single_link(&info)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(FRAME_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= FRAME_LIMIT,
        "Owned VHDX JSON exceeds budget"
    );
    let value = serde_json::from_slice(&bytes).context("Invalid owned VHDX JSON file")?;
    Ok((file, info, value))
}

fn validate_request(request: &Request) -> Result<()> {
    ensure!(
        (16..=128).contains(&request.owner.len())
            && request
                .owner
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)),
        "Invalid owned VHDX nonce"
    );
    ensure!(
        (64 * MIB..=2048 * MIB).contains(&request.maximum_size_bytes)
            && request.maximum_size_bytes.is_multiple_of(MIB),
        "VHDX size must be 64 MiB to 2 GiB in whole MiB"
    );
    ensure!(
        (1000..=600_000).contains(&request.budget_ms),
        "VHDX budget must be 1 to 600 seconds"
    );
    Ok(())
}

fn validate_root(root: &str) -> Result<()> {
    let bytes = root.as_bytes();
    ensure!(
        bytes.len() > 3
            && bytes[0].is_ascii_alphabetic()
            && &bytes[1..3] == b":\\"
            && root.encode_utf16().count() <= 220,
        "VHDX root must be a bounded absolute local drive path"
    );
    for part in root[3..].split('\\') {
        ensure!(
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|character| character.is_control() || "<>:\"/|?*".contains(character)),
            "Unsafe VHDX root component"
        );
    }
    Ok(())
}

fn pin_directories(root: &Path) -> Result<Vec<File>> {
    let mut current = PathBuf::new();
    let mut held = Vec::new();
    for component in root.components() {
        current.push(component);
        if !current.has_root() {
            continue;
        }
        let file = OpenOptions::new()
            .read(true)
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&current)
            .context("Cannot pin owned VHDX directory chain")?;
        let info = file_info(&file)?;
        ensure!(
            info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
                && info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "VHDX directory chain contains a non-directory or reparse point"
        );
        // No DELETE sharing: retained ancestors cannot be renamed under this path.
        held.push(file);
    }
    Ok(held)
}

fn create_disk(path: &Path, maximum_size: u64) -> Result<OwnedHandle> {
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let storage = VIRTUAL_STORAGE_TYPE {
        DeviceId: VIRTUAL_STORAGE_TYPE_DEVICE_VHDX,
        VendorId: VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT,
    };
    let parameters = CREATE_VIRTUAL_DISK_PARAMETERS {
        Version: CREATE_VIRTUAL_DISK_VERSION_2,
        Anonymous: CREATE_VIRTUAL_DISK_PARAMETERS_0 {
            Version2: CREATE_VIRTUAL_DISK_PARAMETERS_0_1 {
                MaximumSize: maximum_size,
                BlockSizeInBytes: 2 * MIB as u32,
                SectorSizeInBytes: 512,
                PhysicalSectorSizeInBytes: 4096,
                ..Default::default()
            },
        },
    };
    let mut handle = null_mut();
    // SAFETY: All input buffers live across this synchronous call; no parent/source
    // image is provided, and NONE creates a dynamic image without full allocation.
    win32(
        unsafe {
            CreateVirtualDisk(
                &storage,
                path.as_ptr(),
                VIRTUAL_DISK_ACCESS_NONE,
                null_mut(),
                CREATE_VIRTUAL_DISK_FLAG_NONE,
                0,
                &parameters,
                null(),
                &mut handle,
            )
        },
        "Create new owned dynamic VHDX",
    )?;
    // SAFETY: Successful CreateVirtualDisk returned this new owned kernel handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn physical_path_result(disk: &OwnedHandle) -> (u32, Vec<u16>) {
    let mut path = vec![0u16; 260];
    let mut bytes = (path.len() * 2) as u32;
    // SAFETY: The original handle and the writable buffer are valid for this call.
    let code =
        unsafe { GetVirtualDiskPhysicalPath(disk.as_raw_handle(), &mut bytes, path.as_mut_ptr()) };
    (code, path)
}

fn physical_path(disk: &OwnedHandle) -> Result<String> {
    let (code, path) = physical_path_result(disk);
    win32(code, "Query original owned VHDX physical path")?;
    let end = path
        .iter()
        .position(|unit| *unit == 0)
        .context("Unterminated physical disk path")?;
    let path = String::from_utf16(&path[..end])?;
    let number = path
        .strip_prefix(r"\\.\PhysicalDrive")
        .context("Unexpected owned physical disk path")?;
    ensure!(
        !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()),
        "Invalid owned physical disk path"
    );
    Ok(path)
}

fn file_info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: The retained file handle and the output pointer are valid.
    ensure!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } != 0,
        "Cannot observe original VHDX file identity: {}",
        std::io::Error::last_os_error()
    );
    Ok(info)
}

fn ensure_regular_single_link(info: &BY_HANDLE_FILE_INFORMATION) -> Result<()> {
    ensure!(
        info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) == 0
            && info.nNumberOfLinks == 1,
        "Owned VHDX file must be regular, single-link and non-reparse"
    );
    Ok(())
}

fn identity(info: &BY_HANDLE_FILE_INFORMATION) -> Value {
    json!({ "volume_serial": info.dwVolumeSerialNumber, "file_index_high": info.nFileIndexHigh, "file_index_low": info.nFileIndexLow })
}

fn win32(code: u32, operation: &str) -> Result<()> {
    ensure!(
        code == 0,
        "{operation}: {}",
        std::io::Error::from_raw_os_error(code as i32)
    );
    Ok(())
}

fn emit(value: Value) -> Result<()> {
    let mut output = std::io::stdout().lock();
    // Start a new line because libtest may have printed its test label without one.
    output.write_all(b"\n")?;
    serde_json::to_writer(&mut output, &value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
