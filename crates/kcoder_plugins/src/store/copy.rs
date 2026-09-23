use crate::PluginCancellationToken;
use anyhow::{Context, Result, bail};
use std::path::Path;
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InstallLimits {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_depth: usize,
    pub max_path_bytes: usize,
}

impl Default for InstallLimits {
    fn default() -> Self {
        Self {
            max_files: 10_000,
            max_total_bytes: 256 * 1024 * 1024,
            max_file_bytes: 32 * 1024 * 1024,
            max_depth: 64,
            max_path_bytes: 4096,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CopyStats {
    pub files: usize,
    pub total_bytes: u64,
}

struct CopyContext<'a> {
    limits: InstallLimits,
    deadline: Instant,
    cancellation: &'a PluginCancellationToken,
}

pub(super) fn copy_local_tree(
    source: &Path,
    destination: &Path,
    limits: InstallLimits,
    deadline: Instant,
    cancellation: &PluginCancellationToken,
) -> Result<CopyStats> {
    cancellation.check()?;
    #[cfg(windows)]
    reject_windows_reparse_components(source)?;
    let canonical_source = dunce::canonicalize(source)
        .with_context(|| format!("failed to resolve local plugin source {}", source.display()))?;
    if !canonical_source.is_dir() {
        bail!(
            "local plugin source is not a directory: {}",
            canonical_source.display()
        );
    }
    copy_local_tree_platform(
        &canonical_source,
        destination,
        limits,
        deadline,
        cancellation,
    )
}

#[cfg(windows)]
fn reject_windows_reparse_components(path: &Path) -> Result<()> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut current = std::path::PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        let metadata = std::fs::symlink_metadata(&current).with_context(|| {
            format!(
                "failed to inspect Windows plugin source component {}",
                current.display()
            )
        })?;
        reject_windows_reparse_point(&metadata, &current)?;
    }
    Ok(())
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        bail!("plugin installation timed out");
    }
    Ok(())
}

fn validate_relative_path(path: &Path, limits: InstallLimits, depth: usize) -> Result<()> {
    if depth > limits.max_depth {
        bail!(
            "plugin package exceeds maximum directory depth {}",
            limits.max_depth
        );
    }
    if path.as_os_str().as_encoded_bytes().len() > limits.max_path_bytes {
        bail!(
            "plugin package path exceeds {} bytes",
            limits.max_path_bytes
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_local_tree_platform(
    source: &Path,
    destination: &Path,
    limits: InstallLimits,
    deadline: Instant,
    cancellation: &PluginCancellationToken,
) -> Result<CopyStats> {
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2};
    use std::fs::File;

    fn open_absolute_directory(path: &Path) -> Result<std::os::fd::OwnedFd> {
        let relative = path
            .strip_prefix("/")
            .context("secure plugin copy requires an absolute path")?;
        let root = File::open("/").context("failed to open filesystem root")?;
        openat2(
            &root,
            relative,
            OpenHow::new()
                .flags(OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
                .resolve(
                    ResolveFlag::RESOLVE_BENEATH
                        | ResolveFlag::RESOLVE_NO_SYMLINKS
                        | ResolveFlag::RESOLVE_NO_MAGICLINKS,
                ),
        )
        .map_err(std::io::Error::from)
        .with_context(|| format!("failed to securely open directory {}", path.display()))
    }

    let source = open_absolute_directory(source)?;
    let destination = open_absolute_directory(destination)?;
    let mut stats = CopyStats::default();
    let context = CopyContext {
        limits,
        deadline,
        cancellation,
    };
    copy_open_directory_linux(source, destination, Path::new(""), 0, &context, &mut stats)?;
    Ok(stats)
}

#[cfg(target_os = "linux")]
fn copy_open_directory_linux(
    source: std::os::fd::OwnedFd,
    destination: std::os::fd::OwnedFd,
    relative: &Path,
    depth: usize,
    context: &CopyContext<'_>,
    stats: &mut CopyStats,
) -> Result<()> {
    use nix::dir::Dir;
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat, openat2};
    use nix::sys::stat::{Mode, SFlag, fstat, mkdirat};
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::unix::ffi::OsStrExt;

    check_deadline(context.deadline)?;
    context.cancellation.check()?;
    validate_relative_path(relative, context.limits, depth)?;
    let mut source = Dir::from_fd(source).context("failed to enumerate plugin source directory")?;
    let entries = source
        .iter()
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_bytes().to_vec())
                .map_err(anyhow::Error::from)
        })
        .collect::<Result<Vec<_>>>()?;
    for name in entries {
        check_deadline(context.deadline)?;
        context.cancellation.check()?;
        if name == b"." || name == b".." {
            continue;
        }
        if name.is_empty() || name.contains(&0) || name.contains(&b'/') {
            bail!("plugin package contains an invalid file name");
        }
        let name = OsStr::from_bytes(&name);
        let child_relative = relative.join(name);
        validate_relative_path(&child_relative, context.limits, depth + 1)?;
        let child = openat2(
            &source,
            name,
            OpenHow::new()
                .flags(OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK)
                .resolve(
                    ResolveFlag::RESOLVE_BENEATH
                        | ResolveFlag::RESOLVE_NO_SYMLINKS
                        | ResolveFlag::RESOLVE_NO_MAGICLINKS,
                ),
        )
        .map_err(std::io::Error::from)
        .with_context(|| {
            format!(
                "plugin package entry is unsafe: {}",
                child_relative.display()
            )
        })?;
        let metadata = fstat(&child).context("failed to inspect plugin package entry")?;
        let kind = SFlag::from_bits_truncate(metadata.st_mode);
        if kind.contains(SFlag::S_IFDIR) {
            mkdirat(&destination, name, Mode::S_IRWXU)
                .map_err(std::io::Error::from)
                .with_context(|| {
                    format!(
                        "failed to create staged plugin directory {}",
                        child_relative.display()
                    )
                })?;
            let target_child = openat(
                &destination,
                name,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
                Mode::empty(),
            )
            .map_err(std::io::Error::from)?;
            copy_open_directory_linux(
                child,
                target_child,
                &child_relative,
                depth + 1,
                context,
                stats,
            )?;
            File::from(target_child_for_sync(&destination, name)?)
                .sync_all()
                .context("failed to sync staged plugin directory")?;
            continue;
        }
        if !kind.contains(SFlag::S_IFREG) {
            bail!(
                "plugin package contains unsupported file type at {}",
                child_relative.display()
            );
        }
        if metadata.st_nlink != 1 {
            bail!(
                "plugin package contains a hard-linked file at {}",
                child_relative.display()
            );
        }
        if metadata.st_size < 0 || metadata.st_size as u64 > context.limits.max_file_bytes {
            bail!(
                "plugin file {} exceeds {} bytes",
                child_relative.display(),
                context.limits.max_file_bytes
            );
        }
        if stats.files >= context.limits.max_files {
            bail!("plugin package exceeds {} files", context.limits.max_files);
        }
        let declared_size = metadata.st_size as u64;
        if stats
            .total_bytes
            .checked_add(declared_size)
            .is_none_or(|total| total > context.limits.max_total_bytes)
        {
            bail!(
                "plugin package exceeds {} total bytes",
                context.limits.max_total_bytes
            );
        }
        let executable = metadata.st_mode & 0o111 != 0;
        let mode = if executable {
            Mode::S_IRUSR | Mode::S_IWUSR | Mode::S_IXUSR
        } else {
            Mode::S_IRUSR | Mode::S_IWUSR
        };
        let target = openat(
            &destination,
            name,
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
            mode,
        )
        .map_err(std::io::Error::from)
        .with_context(|| {
            format!(
                "failed to create staged plugin file {}",
                child_relative.display()
            )
        })?;
        let mut source_file = File::from(child);
        let mut target_file = File::from(target);
        let remaining_total = context.limits.max_total_bytes - stats.total_bytes;
        let allowed = context.limits.max_file_bytes.min(remaining_total);
        let copied = std::io::copy(
            &mut Read::by_ref(&mut source_file).take(allowed + 1),
            &mut target_file,
        )
        .with_context(|| format!("failed to copy plugin file {}", child_relative.display()))?;
        if copied > allowed {
            bail!("plugin package grew beyond configured limits while being copied");
        }
        target_file
            .flush()
            .context("failed to flush staged plugin file")?;
        target_file
            .sync_all()
            .context("failed to sync staged plugin file")?;
        stats.files += 1;
        stats.total_bytes += copied;
    }
    File::from(destination)
        .sync_all()
        .context("failed to sync staged plugin directory")?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn target_child_for_sync(
    destination: &std::os::fd::OwnedFd,
    name: &std::ffi::OsStr,
) -> Result<std::os::fd::OwnedFd> {
    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::Mode;

    openat(
        destination,
        name,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(std::io::Error::from)
    .context("failed to reopen staged plugin directory")
}

#[cfg(not(target_os = "linux"))]
fn copy_local_tree_platform(
    source: &Path,
    destination: &Path,
    limits: InstallLimits,
    deadline: Instant,
    cancellation: &PluginCancellationToken,
) -> Result<CopyStats> {
    let mut stats = CopyStats::default();
    let context = CopyContext {
        limits,
        deadline,
        cancellation,
    };
    copy_directory_portable(source, destination, Path::new(""), 0, &context, &mut stats)?;
    Ok(stats)
}

#[cfg(not(target_os = "linux"))]
fn copy_directory_portable(
    source: &Path,
    destination: &Path,
    relative: &Path,
    depth: usize,
    context: &CopyContext<'_>,
    stats: &mut CopyStats,
) -> Result<()> {
    use std::fs;
    use std::io::{Read, Write};

    check_deadline(context.deadline)?;
    context.cancellation.check()?;
    validate_relative_path(relative, context.limits, depth)?;
    let mut entries = fs::read_dir(source)
        .with_context(|| format!("failed to enumerate plugin source {}", source.display()))?
        .collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        check_deadline(context.deadline)?;
        context.cancellation.check()?;
        let source_path = entry.path();
        let child_relative = relative.join(entry.file_name());
        validate_relative_path(&child_relative, context.limits, depth + 1)?;
        let metadata = fs::symlink_metadata(&source_path)?;
        #[cfg(windows)]
        reject_windows_reparse_point(&metadata, &source_path)?;
        if metadata.file_type().is_symlink() {
            bail!("plugin package may not contain symbolic links");
        }
        let target = destination.join(entry.file_name());
        if metadata.is_dir() {
            fs::create_dir(&target)?;
            kcoder_config::set_user_only_dir_permissions(&target)?;
            copy_directory_portable(
                &source_path,
                &target,
                &child_relative,
                depth + 1,
                context,
                stats,
            )?;
        } else if metadata.is_file() {
            if metadata.len() > context.limits.max_file_bytes
                || stats.files >= context.limits.max_files
            {
                bail!("plugin package exceeds configured file limits");
            }
            let remaining = context
                .limits
                .max_total_bytes
                .checked_sub(stats.total_bytes)
                .context("plugin package exceeds total byte limit")?;
            let allowed = remaining.min(context.limits.max_file_bytes);
            #[cfg(windows)]
            let mut input = open_windows_regular_file(&source_path)?;
            #[cfg(not(windows))]
            let mut input = fs::File::open(&source_path)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?;
            let copied =
                std::io::copy(&mut Read::by_ref(&mut input).take(allowed + 1), &mut output)?;
            if copied > allowed {
                bail!("plugin package exceeds configured byte limits");
            }
            output.flush()?;
            output.sync_all()?;
            kcoder_config::set_user_only_file_permissions(&target)?;
            stats.files += 1;
            stats.total_bytes += copied;
        } else {
            bail!("plugin package contains an unsupported file type");
        }
    }
    Ok(())
}

#[cfg(windows)]
fn reject_windows_reparse_point(metadata: &std::fs::Metadata, path: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!(
            "plugin package contains a Windows reparse point at {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(windows)]
fn open_windows_regular_file(path: &Path) -> Result<std::fs::File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_SEQUENTIAL_SCAN: u32 = 0x0800_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN)
        .open(path)?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!(
            "plugin package contains a Windows reparse point at {}",
            path.display()
        );
    }
    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: file owns a valid live Windows handle and the output pointer targets a complete writable structure.
    let succeeded = unsafe {
        GetFileInformationByHandle(
            file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
            information.as_mut_ptr(),
        )
    };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to inspect Windows plugin file link count");
    }
    // SAFETY: a successful API call initialized the complete BY_HANDLE_FILE_INFORMATION structure.
    let information = unsafe { information.assume_init() };
    if information.nNumberOfLinks != 1 {
        bail!(
            "plugin package contains a hard-linked file at {}",
            path.display()
        );
    }
    Ok(file)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    #[test]
    fn secure_copy_rejects_symlinks_and_hard_links() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(source.join("real"), "secret").unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, "outside-secret").unwrap();
        symlink(&outside, source.join("linked")).unwrap();

        assert!(
            copy_local_tree(
                &source,
                &target,
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(1),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );

        std::fs::remove_file(source.join("linked")).unwrap();
        std::fs::hard_link(source.join("real"), source.join("alias")).unwrap();
        let second_target = temp.path().join("target-2");
        std::fs::create_dir(&second_target).unwrap();
        assert!(
            copy_local_tree(
                &source,
                &second_target,
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(1),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );
    }

    #[test]
    fn secure_copy_enforces_file_and_byte_limits() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(source.join("large"), b"12345").unwrap();
        let limits = InstallLimits {
            max_file_bytes: 4,
            ..InstallLimits::default()
        };

        assert!(
            copy_local_tree(
                &source,
                &target,
                limits,
                Instant::now() + std::time::Duration::from_secs(1),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::os::windows::fs::symlink_file;
    use tempfile::TempDir;

    #[test]
    fn secure_copy_rejects_windows_reparse_points_and_hard_links() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(&outside, "outside-secret").unwrap();
        symlink_file(&outside, source.join("linked")).unwrap();

        assert!(
            copy_local_tree(
                &source,
                &target,
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(2),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );

        std::fs::remove_file(source.join("linked")).unwrap();
        std::fs::write(source.join("real"), "content").unwrap();
        std::fs::hard_link(source.join("real"), source.join("alias")).unwrap();
        let second_target = temp.path().join("target-2");
        std::fs::create_dir(&second_target).unwrap();
        assert!(
            copy_local_tree(
                &source,
                &second_target,
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(2),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );
    }
}
