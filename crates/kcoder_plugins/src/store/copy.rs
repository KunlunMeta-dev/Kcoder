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

pub(crate) fn copy_local_tree(
    source: &Path,
    destination: &Path,
    limits: InstallLimits,
    deadline: Instant,
    cancellation: &PluginCancellationToken,
) -> Result<CopyStats> {
    cancellation.check()?;
    #[cfg(unix)]
    {
        let canonical_source = dunce::canonicalize(source).with_context(|| {
            format!("failed to resolve local plugin source {}", source.display())
        })?;
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
    {
        let source_path = std::path::absolute(source).with_context(|| {
            format!("failed to resolve local plugin source {}", source.display())
        })?;
        let destination_path = std::path::absolute(destination).with_context(|| {
            format!(
                "failed to resolve local plugin destination {}",
                destination.display()
            )
        })?;
        let source =
            kcoder_config::PrivateDirectory::open_existing(&source_path).with_context(|| {
                format!("failed to securely open plugin source {}", source.display())
            })?;
        let destination = kcoder_config::PrivateDirectory::open_existing(&destination_path)
            .with_context(|| {
                format!(
                    "failed to securely open plugin destination {}",
                    destination.display()
                )
            })?;
        copy_local_tree_platform(&source, &destination, limits, deadline, cancellation)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source, destination, limits, deadline, cancellation);
        bail!("secure plugin copying is unavailable on this platform")
    }
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

#[cfg(unix)]
fn copy_local_tree_platform(
    source: &Path,
    destination: &Path,
    limits: InstallLimits,
    deadline: Instant,
    cancellation: &PluginCancellationToken,
) -> Result<CopyStats> {
    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::Mode;
    use std::fs::File;

    fn open_absolute_directory(path: &Path) -> Result<std::os::fd::OwnedFd> {
        let relative = path
            .strip_prefix("/")
            .context("secure plugin copy requires an absolute path")?;
        let mut current = File::open("/")
            .context("failed to open filesystem root")?
            .into();
        for component in relative.components() {
            let std::path::Component::Normal(name) = component else {
                bail!("secure plugin copy requires a normalized absolute path");
            };
            current = openat(
                &current,
                name,
                OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
                Mode::empty(),
            )
            .map_err(std::io::Error::from)
            .with_context(|| format!("failed to securely open directory {}", path.display()))?;
        }
        Ok(current)
    }

    #[cfg(not(target_os = "linux"))]
    let destination_path = {
        let metadata = std::fs::symlink_metadata(destination)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("plugin copy destination must be an ordinary directory");
        }
        dunce::canonicalize(destination)?
    };
    #[cfg(target_os = "linux")]
    let destination_path = destination.to_path_buf();

    let source = open_absolute_directory(source)?;
    let destination = open_absolute_directory(&destination_path)?;
    let mut stats = CopyStats::default();
    let context = CopyContext {
        limits,
        deadline,
        cancellation,
    };
    let mut visited_entries = 0;
    copy_open_directory_unix(
        source,
        destination,
        Path::new(""),
        0,
        &context,
        &mut stats,
        &mut visited_entries,
    )?;
    Ok(stats)
}

#[cfg(unix)]
fn copy_open_directory_unix(
    source: std::os::fd::OwnedFd,
    destination: std::os::fd::OwnedFd,
    relative: &Path,
    depth: usize,
    context: &CopyContext<'_>,
    stats: &mut CopyStats,
    visited_entries: &mut usize,
) -> Result<()> {
    use nix::dir::Dir;
    use nix::fcntl::{OFlag, openat};
    use nix::sys::stat::{Mode, SFlag, fstat, mkdirat};
    use std::ffi::OsStr;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::AsFd;
    use std::os::unix::ffi::OsStrExt;

    check_deadline(context.deadline)?;
    context.cancellation.check()?;
    validate_relative_path(relative, context.limits, depth)?;
    let mut entries = Dir::from_fd(
        source
            .as_fd()
            .try_clone_to_owned()
            .context("failed to duplicate plugin source directory handle")?,
    )
    .context("failed to enumerate plugin source directory")?;
    for entry in entries.iter() {
        check_deadline(context.deadline)?;
        context.cancellation.check()?;
        let entry = entry?;
        let name = entry.file_name().to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        if name.is_empty() || name.contains(&0) || name.contains(&b'/') {
            bail!("plugin package contains an invalid file name");
        }
        let name = OsStr::from_bytes(name);
        if *visited_entries >= context.limits.max_files {
            bail!(
                "plugin package exceeds {} entries",
                context.limits.max_files
            );
        }
        *visited_entries += 1;
        let child_relative = relative.join(name);
        validate_relative_path(&child_relative, context.limits, depth + 1)?;
        let child = openat(
            &source,
            name,
            OFlag::O_RDONLY | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW,
            Mode::empty(),
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
            copy_open_directory_unix(
                child,
                target_child,
                &child_relative,
                depth + 1,
                context,
                stats,
                visited_entries,
            )?;
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

#[cfg(windows)]
fn copy_local_tree_platform(
    source: &kcoder_config::PrivateDirectory,
    destination: &kcoder_config::PrivateDirectory,
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
    let mut visited_entries = 0;
    copy_directory_windows(
        source,
        destination,
        Path::new(""),
        0,
        &context,
        &mut stats,
        &mut visited_entries,
    )?;
    Ok(stats)
}

#[cfg(windows)]
fn copy_directory_windows(
    source: &kcoder_config::PrivateDirectory,
    destination: &kcoder_config::PrivateDirectory,
    relative: &Path,
    depth: usize,
    context: &CopyContext<'_>,
    stats: &mut CopyStats,
    visited_entries: &mut usize,
) -> Result<()> {
    use std::io::{Read, Write};

    check_deadline(context.deadline)?;
    context.cancellation.check()?;
    validate_relative_path(relative, context.limits, depth)?;

    let remaining = context.limits.max_files.saturating_sub(*visited_entries);
    let mut names = source.entry_names_bounded(remaining.saturating_add(1))?;
    if names.len() > remaining {
        bail!(
            "plugin package exceeds {} entries",
            context.limits.max_files
        );
    }
    *visited_entries += names.len();
    names.sort();

    for name in names {
        check_deadline(context.deadline)?;
        context.cancellation.check()?;
        let child_relative = relative.join(&name);
        validate_relative_path(&child_relative, context.limits, depth + 1)?;
        let entry = source.open_entry_handle(&name).with_context(|| {
            format!(
                "failed to securely open plugin package entry {}",
                child_relative.display()
            )
        })?;
        reject_windows_reparse_point(entry.metadata(), &child_relative)?;
        let metadata = entry.metadata();
        if metadata.is_dir() {
            let child_source = entry.open_child_directory().with_context(|| {
                format!(
                    "plugin package directory changed while opening {}",
                    child_relative.display()
                )
            })?;
            let child_destination = destination.create_private_child(&name).with_context(|| {
                format!(
                    "failed to create staged plugin directory {}",
                    child_relative.display()
                )
            })?;
            copy_directory_windows(
                &child_source,
                &child_destination,
                &child_relative,
                depth + 1,
                context,
                stats,
                visited_entries,
            )?;
        } else if metadata.is_file() {
            let mut input = source
                .open_single_link_regular_file(&name)
                .with_context(|| {
                    format!(
                        "plugin package file is unsafe: {}",
                        child_relative.display()
                    )
                })?;
            let declared_size = input.metadata()?.len();
            if declared_size > context.limits.max_file_bytes {
                bail!(
                    "plugin file {} exceeds {} bytes",
                    child_relative.display(),
                    context.limits.max_file_bytes
                );
            }
            let remaining_bytes = context
                .limits
                .max_total_bytes
                .checked_sub(stats.total_bytes)
                .context("plugin package exceeds total byte limit")?;
            if declared_size > remaining_bytes {
                bail!(
                    "plugin package exceeds {} total bytes",
                    context.limits.max_total_bytes
                );
            }
            let allowed = remaining_bytes.min(context.limits.max_file_bytes);
            let mut output = destination
                .open_read_write_file(&name, true)
                .with_context(|| {
                    format!(
                        "failed to create staged plugin file {}",
                        child_relative.display()
                    )
                })?;
            let copied = std::io::copy(
                &mut Read::by_ref(&mut input).take(allowed.saturating_add(1)),
                &mut output,
            )
            .with_context(|| format!("failed to copy plugin file {}", child_relative.display()))?;
            if copied > allowed {
                bail!("plugin package grew beyond configured limits while being copied");
            }
            output.flush()?;
            output.sync_all()?;
            stats.files += 1;
            stats.total_bytes += copied;
        } else {
            bail!(
                "plugin package contains unsupported file type at {}",
                child_relative.display()
            );
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
    fn copy_keeps_plugin_scripts_executable() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        let script = source.join("run-server");
        std::fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        copy_local_tree(
            &source,
            &target,
            InstallLimits::default(),
            Instant::now() + std::time::Duration::from_secs(1),
            &PluginCancellationToken::default(),
        )
        .unwrap();

        let copied_mode = std::fs::metadata(target.join("run-server"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111;
        assert_ne!(copied_mode, 0);
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
    use std::os::windows::fs::{symlink_dir, symlink_file};
    use tempfile::TempDir;

    #[test]
    fn secure_copy_accepts_windows_drive_and_verbatim_paths() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.txt"), "plugin content").unwrap();
        let ordinary = dunce::canonicalize(&source).unwrap();
        let verbatim = std::fs::canonicalize(&source).unwrap();
        assert!(matches!(
            verbatim.components().next(),
            Some(std::path::Component::Prefix(prefix))
                if matches!(prefix.kind(), std::path::Prefix::VerbatimDisk(_))
        ));
        for (index, path) in [ordinary, verbatim].iter().enumerate() {
            let destination = temp.path().join(format!("copy-{index}"));
            std::fs::create_dir(&destination).unwrap();
            let stats = copy_local_tree(
                path,
                &destination,
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(5),
                &PluginCancellationToken::default(),
            )
            .unwrap();
            assert_eq!(stats.files, 1);
            assert_eq!(
                std::fs::read_to_string(destination.join("plugin.txt")).unwrap(),
                "plugin content"
            );
        }
    }

    #[test]
    fn secure_copy_accepts_relative_source_paths() {
        let temp = TempDir::new_in(".").unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(source.join("plugin.txt"), "relative content").unwrap();

        let cwd = dunce::canonicalize(".").unwrap();
        let absolute_source = dunce::canonicalize(&source).unwrap();
        let relative_source = absolute_source.strip_prefix(cwd).unwrap();
        let stats = copy_local_tree(
            relative_source,
            &destination,
            InstallLimits::default(),
            Instant::now() + std::time::Duration::from_secs(5),
            &PluginCancellationToken::default(),
        )
        .unwrap();

        assert_eq!(stats.files, 1);
        assert_eq!(
            std::fs::read_to_string(destination.join("plugin.txt")).unwrap(),
            "relative content"
        );
    }

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

    #[test]
    fn secure_copy_reserves_parent_entries_before_recursing_into_children() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let child = source.join("a-dir");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(child.join("marker"), b"nested").unwrap();
        std::fs::write(source.join("z1"), b"first sibling").unwrap();
        std::fs::write(source.join("z2"), b"second sibling").unwrap();
        let limits = InstallLimits {
            max_files: 3,
            ..InstallLimits::default()
        };

        assert!(
            copy_local_tree(
                &source,
                &target,
                limits,
                Instant::now() + std::time::Duration::from_secs(5),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );
        assert!(!target.join("a-dir").join("marker").exists());
    }

    #[test]
    fn secure_copy_rejects_replaced_directory_reparse_without_copying_external_content() {
        use std::ffi::OsStr;

        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        let outside = temp.path().join("outside");
        let linked = source.join("linked-dir");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::create_dir(&linked).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(linked.join("original.txt"), b"original").unwrap();
        std::fs::write(outside.join("secret.txt"), b"outside-secret").unwrap();

        let source_handle = kcoder_config::PrivateDirectory::open_existing(&source).unwrap();
        let held_entry = source_handle
            .open_entry_handle(OsStr::new("linked-dir"))
            .unwrap();
        std::fs::rename(&linked, source.join("moved-dir")).unwrap();
        symlink_dir(&outside, &linked).unwrap();

        assert!(held_entry.open_child_directory().is_err());
        assert!(
            copy_local_tree(
                &source,
                &target,
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(5),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );
        assert!(!target.join("linked-dir").exists());
        assert_eq!(
            std::fs::read(outside.join("secret.txt")).unwrap(),
            b"outside-secret"
        );
    }
}

#[cfg(all(test, any(unix, windows)))]
mod budget_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn copy_limits_empty_directories_and_stops_for_cancellation_or_deadline() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(source.join("first-empty")).unwrap();
        std::fs::create_dir(source.join("second-empty")).unwrap();

        let target = temp.path().join("target-limited");
        std::fs::create_dir(&target).unwrap();
        let limits = InstallLimits {
            max_files: 1,
            ..InstallLimits::default()
        };
        assert!(
            copy_local_tree(
                &source,
                &target,
                limits,
                Instant::now() + std::time::Duration::from_secs(2),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );

        let cancellation = PluginCancellationToken::default();
        cancellation.cancel();
        let target = temp.path().join("target-cancelled");
        std::fs::create_dir(&target).unwrap();
        assert!(
            copy_local_tree(
                &source,
                &target,
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(2),
                &cancellation,
            )
            .is_err()
        );

        let target = temp.path().join("target-expired");
        std::fs::create_dir(&target).unwrap();
        assert!(
            copy_local_tree(
                &source,
                &target,
                InstallLimits::default(),
                Instant::now(),
                &PluginCancellationToken::default(),
            )
            .is_err()
        );
    }
}
