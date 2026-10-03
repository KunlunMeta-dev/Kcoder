use super::*;

pub(super) struct StoreDirectoryEntry(PathBuf);
impl StoreDirectoryEntry {
    pub(super) fn path(&self) -> PathBuf {
        self.0.clone()
    }
    pub(super) fn file_name(&self) -> std::ffi::OsString {
        self.0.file_name().unwrap_or_default().to_owned()
    }
}

pub(super) fn read_directory(
    path: &Path,
) -> anyhow::Result<impl Iterator<Item = std::io::Result<StoreDirectoryEntry>> + '_> {
    #[cfg(windows)]
    {
        let lease = windows_io::DirectoryLease::acquire(path, false)?;
        Ok(windows_directory::enumerate(lease.handle())?
            .into_iter()
            .map(|name| Ok(StoreDirectoryEntry(path.join(name)))))
    }
    #[cfg(not(windows))]
    Ok(fs::read_dir(path)?.map(|entry| entry.map(|entry| StoreDirectoryEntry(entry.path()))))
}

pub(super) fn remove_directory_tree(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let lease = windows_io::DirectoryLease::parent(path)?;
        windows_directory::delete_tree(lease.handle(), path.file_name().context("missing leaf")?)
    }
    #[cfg(not(windows))]
    Ok(fs::remove_dir_all(path)?)
}

pub(super) fn create_new_directory(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let lease = windows_io::DirectoryLease::parent(path)?;
        windows_io::open_relative(
            lease.handle(),
            path.file_name().context("missing leaf")?,
            FILE_GENERIC_READ,
            2,
            1,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )?;
        Ok(())
    }
    #[cfg(not(windows))]
    Ok(fs::create_dir(path)?)
}

pub(super) fn validate_work_id(work_id: &str) -> anyhow::Result<()> {
    let Some(uuid) = work_id.strip_prefix("work_") else {
        return Err(PlanStoreError::InvalidWorkId(work_id.to_string()).into());
    };
    let parsed =
        Uuid::parse_str(uuid).map_err(|_| PlanStoreError::InvalidWorkId(work_id.to_string()))?;
    if parsed.get_version_num() != 4 {
        return Err(PlanStoreError::InvalidWorkId(work_id.to_string()).into());
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn create_dir_all_safe(path: &Path) -> anyhow::Result<()> {
    windows_io::DirectoryLease::acquire(path, true)?;
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn create_dir_all_safe(path: &Path) -> anyhow::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(PlanStoreError::UnsafePath(path.display().to_string()).into());
            }
            Component::Normal(part) => current.push(part),
        }
        if current.exists() {
            ensure_not_symlink(&current)?;
        } else {
            fs::create_dir(&current)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn create_directory_no_follow(path: &Path) -> anyhow::Result<()> {
    create_dir_all_safe(path)
}

#[cfg(not(windows))]
pub(super) fn create_directory_no_follow(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        ensure_not_symlink(path)?;
    } else {
        fs::create_dir(path)?;
        ensure_not_symlink(path)?;
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn ensure_not_symlink(path: &Path) -> anyhow::Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    let lease = windows_io::DirectoryLease::parent(path)?;
    let file = windows_io::open_relative(
        lease.handle(),
        path.file_name().context("missing leaf")?,
        FILE_READ_ATTRIBUTES,
        1,
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(PlanStoreError::UnsafePath(path.display().to_string()).into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn ensure_not_symlink(path: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect PlanStore path {}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(PlanStoreError::UnsafePath(path.display().to_string()).into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn open_options_no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = options;
}

#[cfg(windows)]
pub(super) fn open_rw_no_follow(path: &Path) -> anyhow::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    windows_io::open_file(
        path,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        3,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
}

#[cfg(not(windows))]
pub(super) fn open_rw_no_follow(path: &Path) -> anyhow::Result<File> {
    if let Some(parent) = path.parent() {
        if parent.exists() {
            if !is_unix_fd_root(parent) {
                ensure_not_symlink(parent)?;
            }
        } else {
            create_dir_all_safe(parent)?;
        }
    }
    if path.exists() {
        ensure_not_symlink(path)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    open_options_no_follow(&mut options);
    let file = options.open(path)?;
    Ok(file)
}

#[cfg(not(windows))]
pub(super) fn is_unix_fd_root(path: &Path) -> bool {
    #[cfg(unix)]
    {
        let components = path.components().collect::<Vec<_>>();
        let proc_fd = components.len() == 5
            && components[0] == Component::RootDir
            && components[1].as_os_str() == "proc"
            && components[2].as_os_str() == "self"
            && components[3].as_os_str() == "fd"
            && components[4]
                .as_os_str()
                .to_string_lossy()
                .parse::<i32>()
                .is_ok();
        let dev_fd = components.len() == 4
            && components[0] == Component::RootDir
            && components[1].as_os_str() == "dev"
            && components[2].as_os_str() == "fd"
            && components[3]
                .as_os_str()
                .to_string_lossy()
                .parse::<i32>()
                .is_ok();
        proc_fd || dev_fd
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

#[cfg(windows)]
pub(super) fn open_append_no_follow(path: &Path) -> anyhow::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_APPEND_DATA, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    windows_io::open_file(
        path,
        FILE_APPEND_DATA | FILE_READ_ATTRIBUTES,
        3,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
}

#[cfg(not(windows))]
pub(super) fn open_append_no_follow(path: &Path) -> anyhow::Result<File> {
    if path.exists() {
        ensure_not_symlink(path)?;
    }
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    open_options_no_follow(&mut options);
    let file = options.open(path)?;
    Ok(file)
}

pub(super) fn read_bytes_no_follow(path: &Path) -> anyhow::Result<Vec<u8>> {
    #[cfg(windows)]
    let mut file = {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        windows_io::open_file(
            path,
            FILE_GENERIC_READ,
            1,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )?
    };
    #[cfg(not(windows))]
    let mut file = {
        ensure_not_symlink(path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        open_options_no_follow(&mut options);
        options.open(path)?
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub(super) fn read_string_no_follow(path: &Path) -> anyhow::Result<String> {
    String::from_utf8(read_bytes_no_follow(path)?).context("PlanStore file is not UTF-8")
}

pub(super) fn read_json_no_follow<T: for<'de> Deserialize<'de>>(path: &Path) -> anyhow::Result<T> {
    Ok(serde_json::from_slice(&read_bytes_no_follow(path)?)?)
}

pub(super) fn write_new_file(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    #[cfg(windows)]
    let mut file = {
        use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_WRITE, FILE_SHARE_READ};
        windows_io::open_file(path, FILE_GENERIC_WRITE, 2, FILE_SHARE_READ)?
    };
    #[cfg(not(windows))]
    let mut file = {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        open_options_no_follow(&mut options);
        options.open(path)?
    };
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub(super) fn write_json_atomic(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    #[cfg(windows)]
    return windows_io::write_atomic(path, &serde_json::to_vec_pretty(value)?);
    #[cfg(not(windows))]
    write_bytes_atomic(path, &serde_json::to_vec_pretty(value)?)
}

pub(super) fn sync_directory(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        // File contents are flushed before and after handle-relative publication.
        // Windows does not support FlushFileBuffers on a read-only directory handle.
        let _lease = windows_io::DirectoryLease::acquire(path, false)?;
    }
    #[cfg(not(windows))]
    File::open(path)?.sync_all()?;
    Ok(())
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn utf8_tail(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}
