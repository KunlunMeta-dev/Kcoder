//! Workflow run artifact I/O and original resume lease acquisition.
use kcoder_tool_error::ToolError;
#[cfg(any(target_os = "linux", windows))]
use std::time::Duration;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_ARTIFACT_WRITE_ID: AtomicU64 = AtomicU64::new(1);

pub struct ResumeLease {
    _file: fs::File,
}

pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

#[cfg(target_os = "linux")]
pub fn try_acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::Mode;
    use std::os::fd::AsRawFd;

    let parent = secure_open_dir(run_dir).map_err(|error| {
        ToolError::Execution(format!(
            "failed to open workflow run directory `{}`: {error}",
            run_dir.display()
        ))
    })?;
    let fd = openat(
        &parent,
        ".resume.lock",
        OFlag::O_RDWR | OFlag::O_CREAT | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(nix_io_error)
    .map_err(|error| ToolError::Execution(format!("failed to open resume lease: {error}")))?;
    let file = fs::File::from(fd);
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        return Err(ToolError::InvalidInput(format!(
            "workflow resume is already being prepared or is running: {error}"
        )));
    }
    Ok(ResumeLease { _file: file })
}

#[cfg(windows)]
pub fn try_acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    use std::os::windows::fs::OpenOptionsExt;

    let path = run_dir.join(".resume.lock");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        // A zero share mode gives this handle an exclusive Windows lease. The
        // lease is released automatically when ResumeLease drops the file.
        .share_mode(0)
        .open(&path)
        .map_err(|error| {
            ToolError::InvalidInput(format!(
                "workflow resume is already being prepared or is running: {error}"
            ))
        })?;
    Ok(ResumeLease { _file: file })
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
pub fn try_acquire_resume_lease(_run_dir: &Path) -> Result<ResumeLease, ToolError> {
    Err(ToolError::Execution(
        "workflow resume locking is not supported on this platform".to_string(),
    ))
}

#[cfg(any(target_os = "linux", windows))]
pub async fn acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    const RETRY_COUNT: usize = 25;
    const RETRY_DELAY: Duration = Duration::from_millis(10);

    for attempt in 0..=RETRY_COUNT {
        match try_acquire_resume_lease(run_dir) {
            Ok(lease) => return Ok(lease),
            Err(ToolError::InvalidInput(_)) if attempt < RETRY_COUNT => {
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("bounded resume lease loop always returns")
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
pub async fn acquire_resume_lease(run_dir: &Path) -> Result<ResumeLease, ToolError> {
    try_acquire_resume_lease(run_dir)
}

#[cfg(any(target_os = "linux", windows))]
pub async fn acquire_initial_resume_lease(
    run_dir: &Path,
) -> Result<Option<ResumeLease>, ToolError> {
    acquire_resume_lease(run_dir).await.map(Some)
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
pub async fn acquire_initial_resume_lease(
    _run_dir: &Path,
) -> Result<Option<ResumeLease>, ToolError> {
    // Initial execution remains available on platforms where crash-resume
    // locking itself is unsupported.
    Ok(None)
}

#[cfg(not(target_os = "linux"))]
fn secure_reject_symlink_components(path: &Path) -> std::io::Result<()> {
    let absolute = absolute_lexical_path(path)?;
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!(
                        "workflow artifact path contains a symbolic link: {}",
                        current.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn atomic_write_file(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    secure_reject_symlink_components(path.parent().unwrap_or_else(|| Path::new(".")))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("artifact");
    let temporary = path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        NEXT_ARTIFACT_WRITE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes.as_ref())?;
        file.sync_all()?;
        if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            fs::remove_file(path)?;
        }
        fs::rename(&temporary, path)?;
        sync_parent_directory(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn sync_parent_directory(_path: &Path) -> std::io::Result<()> {
    // Windows does not allow directories to be opened with std::fs::File, and
    // the preceding rename is already the atomic publication point.
    Ok(())
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
fn sync_parent_directory(path: &Path) -> std::io::Result<()> {
    fs::File::open(path.parent().unwrap_or_else(|| Path::new(".")))?.sync_all()
}

#[cfg(target_os = "linux")]
pub fn atomic_write_file(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    use nix::fcntl::{OFlag, openat, renameat};
    use nix::sys::stat::Mode;

    let (parent, file_name) = secure_open_parent(path)?;
    let temporary = format!(
        ".{}.tmp-{}-{}",
        file_name.to_string_lossy(),
        std::process::id(),
        NEXT_ARTIFACT_WRITE_ID.fetch_add(1, Ordering::Relaxed)
    );
    let fd = openat(
        &parent,
        temporary.as_str(),
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(nix_io_error)?;
    let mut file = fs::File::from(fd);
    let result = (|| {
        file.write_all(bytes.as_ref())?;
        file.sync_all()?;
        renameat(&parent, temporary.as_str(), &parent, file_name.as_os_str())
            .map_err(nix_io_error)?;
        parent.sync_all()
    })();
    if result.is_err() {
        use nix::unistd::{UnlinkatFlags, unlinkat};
        let _ = unlinkat(&parent, temporary.as_str(), UnlinkatFlags::NoRemoveDir);
    }
    result
}

#[cfg(target_os = "linux")]
fn secure_open_dir(path: &Path) -> std::io::Result<fs::File> {
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};

    let absolute = absolute_lexical_path(path)?;
    let relative = absolute
        .strip_prefix("/")
        .map_err(|_| std::io::Error::other("path is not absolute"))?;
    let root = fs::File::open("/")?;
    let fd = openat2(
        &root,
        relative,
        OpenHow::new()
            .flags(OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
            .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_SYMLINKS),
    )
    .map_err(nix_io_error)?;
    Ok(fs::File::from(fd))
}

#[cfg(target_os = "linux")]
fn secure_open_parent(path: &Path) -> std::io::Result<(fs::File, std::ffi::OsString)> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("path has no parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("path has no file name"))?
        .to_os_string();
    Ok((secure_open_dir(parent)?, file_name))
}

#[cfg(target_os = "linux")]
pub fn secure_create_dir(path: &Path) -> std::io::Result<()> {
    use nix::errno::Errno;
    use nix::sys::stat::{Mode, mkdirat};

    if secure_open_dir(path).is_ok() {
        return Ok(());
    }
    let parent_path = path
        .parent()
        .ok_or_else(|| std::io::Error::other("directory has no parent"))?;
    secure_create_dir(parent_path)?;
    let parent = secure_open_dir(parent_path)?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("directory has no name"))?;
    match mkdirat(&parent, name, Mode::S_IRWXU) {
        Ok(()) | Err(Errno::EEXIST) => {
            secure_open_dir(path)?;
            parent.sync_all()?;
            Ok(())
        }
        Err(error) => Err(nix_io_error(error)),
    }
}

#[cfg(target_os = "linux")]
pub fn secure_create_new_dir(path: &Path) -> std::io::Result<()> {
    use nix::sys::stat::{Mode, mkdirat};

    let (parent, name) = secure_open_parent(path)?;
    mkdirat(&parent, name.as_os_str(), Mode::S_IRWXU).map_err(nix_io_error)?;
    secure_open_dir(path)?;
    parent.sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn secure_create_new_dir(path: &Path) -> std::io::Result<()> {
    secure_reject_symlink_components(path.parent().unwrap_or_else(|| Path::new(".")))?;
    fs::create_dir(path)?;
    secure_reject_symlink_components(path)
}

#[cfg(not(target_os = "linux"))]
pub fn secure_create_dir(path: &Path) -> std::io::Result<()> {
    secure_reject_symlink_components(path)?;
    fs::create_dir_all(path)?;
    secure_reject_symlink_components(path)
}

#[cfg(target_os = "linux")]
pub fn secure_remove_file(path: &Path) -> std::io::Result<()> {
    use nix::errno::Errno;
    use nix::unistd::{UnlinkatFlags, unlinkat};

    let (parent, name) = secure_open_parent(path)?;
    match unlinkat(&parent, name.as_os_str(), UnlinkatFlags::NoRemoveDir) {
        Ok(()) => parent.sync_all(),
        Err(Errno::ENOENT) => Ok(()),
        Err(error) => Err(nix_io_error(error)),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn secure_remove_file(path: &Path) -> std::io::Result<()> {
    secure_reject_symlink_components(path.parent().unwrap_or_else(|| Path::new(".")))?;
    match fs::remove_file(path) {
        Ok(()) => sync_parent_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
pub fn secure_read_file(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};

    let (parent, name) = secure_open_parent(path)?;
    let fd = openat2(
        &parent,
        name.as_os_str(),
        OpenHow::new()
            .flags(OFlag::O_RDONLY | OFlag::O_CLOEXEC)
            .resolve(ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_SYMLINKS),
    )
    .map_err(nix_io_error)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut fs::File::from(fd))
        .take((maximum + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(std::io::Error::other("file exceeds size limit"));
    }
    Ok(bytes)
}

#[cfg(not(target_os = "linux"))]
pub fn secure_read_file(path: &Path, maximum: usize) -> std::io::Result<Vec<u8>> {
    secure_reject_symlink_components(path)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut fs::File::open(path)?)
        .take((maximum + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        return Err(std::io::Error::other("file exceeds size limit"));
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
pub fn secure_append_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::Mode;

    let (parent, name) = secure_open_parent(path)?;
    let fd = openat(
        &parent,
        name.as_os_str(),
        OFlag::O_WRONLY | OFlag::O_APPEND | OFlag::O_CREAT | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::S_IRUSR | Mode::S_IWUSR,
    )
    .map_err(nix_io_error)?;
    let mut file = fs::File::from(fd);
    file.write_all(bytes)?;
    file.sync_data()?;
    parent.sync_all()
}

#[cfg(not(target_os = "linux"))]
pub fn secure_append_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    secure_reject_symlink_components(path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_data()?;
    sync_parent_directory(path)
}

fn absolute_lexical_path(path: &Path) -> std::io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(lexical_normalize(path))
    } else {
        Ok(lexical_normalize(&std::env::current_dir()?.join(path)))
    }
}

#[cfg(target_os = "linux")]
fn nix_io_error(error: nix::errno::Errno) -> std::io::Error {
    std::io::Error::from_raw_os_error(error as i32)
}
