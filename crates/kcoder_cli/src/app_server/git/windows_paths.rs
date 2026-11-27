//! Command-owned short aliases for Git's early Windows MAX_PATH checks.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use std::{
    ffi::OsStr,
    fs::{File, OpenOptions},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Storage::FileSystem::*,
    System::{IO::DeviceIoControl, Ioctl::FSCTL_SET_REPARSE_POINT},
};

// Git setup.c rejects GIT_DIR beyond PATH_MAX - 40, before reading core.longpaths.
const MAX_GIT_DIRECTORY_BYTES: usize = 219;
const MOUNT_POINT_TAG: u32 = 0xa0000003;

struct OwnedDirectory(File);
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // OPEN_REPARSE_POINT binds deletion to this alias, never to its target.
        let result = unsafe {
            SetFileInformationByHandle(
                self.0.as_raw_handle().cast(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if result == 0 {
            tracing::warn!(error = %std::io::Error::last_os_error(), "failed to remove owned Git path alias");
        }
    }
}

pub(super) struct GitPaths {
    // Aliases are removed before their private containing directory and target pins.
    aliases: Vec<OwnedDirectory>,
    _root: OwnedDirectory,
    pins: Vec<File>,
    directory: PrivateDirectory,
    root_path: PathBuf,
    pub cwd: PathBuf,
    pub git_dir: PathBuf,
    pub work_tree: Option<PathBuf>,
    pub index: Option<PathBuf>,
    pub initialized: bool,
}

impl GitPaths {
    pub fn needed(
        cwd: &Path,
        git_dir: &Path,
        work_tree: Option<&Path>,
        index: Option<&Path>,
    ) -> bool {
        [Some(cwd), Some(git_dir), work_tree, index]
            .into_iter()
            .flatten()
            .any(|path| path.as_os_str().to_string_lossy().len() > MAX_GIT_DIRECTORY_BYTES)
    }

    pub fn new(
        cwd: &Path,
        git_dir: &Path,
        work_tree: Option<&Path>,
        index: Option<&Path>,
        initialize: bool,
    ) -> Result<Self> {
        let temp = std::env::temp_dir().canonicalize()?;
        let parent = PrivateDirectory::open_existing(&temp)?;
        let name = format!("kg-{}", uuid::Uuid::new_v4().simple());
        let directory = parent.create_private_child(OsStr::new(&name))?;
        let root_path = temp.join(name);
        let root = own_directory(&root_path, &directory, FILE_READ_ATTRIBUTES | DELETE)?;
        directory.verify_private_directory()?;
        let root_path = dunce::simplified(&root_path).to_path_buf();
        ensure!(
            root_path.as_os_str().to_string_lossy().len() + 2 <= MAX_GIT_DIRECTORY_BYTES,
            "Windows temporary directory is too long for Git path aliases"
        );
        let mut result = Self {
            aliases: Vec::new(),
            _root: root,
            pins: Vec::new(),
            directory,
            root_path,
            cwd: cwd.to_path_buf(),
            git_dir: git_dir.to_path_buf(),
            work_tree: work_tree.map(Path::to_path_buf),
            index: index.map(Path::to_path_buf),
            initialized: initialize,
        };
        for ancestor in result.root_path.ancestors().skip(1) {
            result
                .pins
                .push(open_pinned(ancestor, FILE_READ_ATTRIBUTES, false)?);
        }
        if initialize {
            // These repositories contain only owned snapshot objects, never user refs/hooks.
            // Git's bare init canonicalizes the long path before honoring core.longpaths.
            let repository = PrivateDirectory::open_or_create(git_dir)?;
            repository.verify_private_directory()?;
            repository.open_child(OsStr::new("objects"), true)?;
            repository.open_child(OsStr::new("refs"), true)?;
            super::ensure_bare_snapshot_layout(git_dir)?;
        }
        result.git_dir = result.alias("g", git_dir, true)?;
        if let Some(index) = index {
            let parent = index.parent().context("Git index has no parent")?;
            let filename = index.file_name().context("Git index has no filename")?;
            result.index = Some(result.alias("i", parent, true)?.join(filename));
        }
        if cwd.as_os_str().to_string_lossy().len() > MAX_GIT_DIRECTORY_BYTES {
            result.cwd = result.alias("c", cwd, false)?;
        }
        if work_tree == Some(cwd) {
            // Git realpath() lstats an absolute worktree junction before loading
            // core.longpaths; Windows can reject its long target with ERANGE.
            // Dot resolves from the already pinned cwd without walking that alias.
            result.work_tree = Some(PathBuf::from("."));
        } else if let Some(work_tree) = work_tree
            && work_tree.as_os_str().to_string_lossy().len() > MAX_GIT_DIRECTORY_BYTES
        {
            result.work_tree = Some(result.alias("w", work_tree, false)?);
        }
        Ok(result)
    }

    fn alias(&mut self, name: &str, target: &Path, private: bool) -> Result<PathBuf> {
        let target = target.canonicalize()?;
        let target_directory = PrivateDirectory::open_existing(&target)?;
        if private {
            target_directory.verify_private_directory()?;
        }
        let target_pin = open_pinned(&target, FILE_READ_ATTRIBUTES, false)?;
        ensure!(
            identity(&target_pin)? == target_directory.directory_identity()?,
            "Git alias target changed"
        );
        self.pins.push(target_pin);
        // Pin ancestor spellings too: an alias must not start following a replaced parent.
        for ancestor in target.ancestors().skip(1) {
            self.pins
                .push(open_pinned(ancestor, FILE_READ_ATTRIBUTES, false)?);
        }
        let child = self.directory.create_private_child(OsStr::new(name))?;
        let alias = self.root_path.join(name);
        let owned = own_directory(
            &alias,
            &child,
            FILE_READ_ATTRIBUTES | FILE_WRITE_DATA | DELETE,
        )?;
        self.aliases.push(owned);
        drop(child);
        let file = &self.aliases.last().expect("alias was retained").0;
        set_junction(file, &target)?;
        Ok(alias)
    }
}

fn own_directory(path: &Path, directory: &PrivateDirectory, access: u32) -> Result<OwnedDirectory> {
    let expected = directory.directory_identity()?;
    match open_pinned(path, access, true) {
        Ok(file) => {
            // Never acquire delete authority over a replacement at the same pathname.
            ensure!(
                identity(&file)? == expected,
                "owned Git alias directory changed"
            );
            Ok(OwnedDirectory(file))
        }
        Err(error) => {
            // Cleanup uses a separate identity-checked handle if the stricter pin fails.
            if let Ok(file) = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES | DELETE)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                && identity(&file).is_ok_and(|id| id == expected)
            {
                drop(OwnedDirectory(file));
            }
            Err(error)
        }
    }
}

fn open_pinned(path: &Path, access: u32, exclusive_write: bool) -> Result<File> {
    let file = OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | if exclusive_write { 0 } else { FILE_SHARE_WRITE })
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let attributes = attributes(&file)?;
    ensure!(
        attributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        "Git alias target is not a directory"
    );
    ensure!(
        attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "Git alias target is a reparse point"
    );
    Ok(file)
}

fn information(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    ensure!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } != 0,
        "cannot identify Git alias directory: {}",
        std::io::Error::last_os_error()
    );
    Ok(info)
}
fn identity(file: &File) -> Result<String> {
    let info = information(file)?;
    Ok(format!(
        "windows:{}:{}:{}",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}
fn attributes(file: &File) -> Result<u32> {
    Ok(information(file)?.dwFileAttributes)
}

fn set_junction(file: &File, target: &Path) -> Result<()> {
    let target = target.as_os_str().encode_wide().collect::<Vec<_>>();
    let prefix = "\\\\?\\".encode_utf16().collect::<Vec<_>>();
    ensure!(
        target.starts_with(&prefix),
        "Git alias target is not canonical"
    );
    let mut substitute = "\\??\\".encode_utf16().collect::<Vec<_>>();
    substitute.extend_from_slice(&target[prefix.len()..]);
    let name_bytes = u16::try_from(substitute.len() * 2)?;
    let data_len = name_bytes
        .checked_add(12)
        .context("Git alias target too long")?;
    let mut data = Vec::with_capacity(usize::from(data_len) + 8);
    data.extend_from_slice(&MOUNT_POINT_TAG.to_le_bytes());
    data.extend_from_slice(&data_len.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&name_bytes.to_le_bytes());
    data.extend_from_slice(&(name_bytes + 2).to_le_bytes());
    data.extend_from_slice(&0u16.to_le_bytes());
    for unit in substitute {
        data.extend_from_slice(&unit.to_le_bytes());
    }
    data.extend_from_slice(&[0; 4]);
    let mut returned = 0;
    let ok = unsafe {
        DeviceIoControl(
            file.as_raw_handle().cast(),
            FSCTL_SET_REPARSE_POINT,
            data.as_ptr().cast(),
            data.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    ensure!(
        ok != 0,
        "failed to create owned Git path alias: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
