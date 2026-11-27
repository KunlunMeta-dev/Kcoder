//! Read-only namespace pins for already-authorized installed resources.
//! No ownership/ACL repair, creation, publication or deletion is performed.
use super::{PortableLeaseIdentity, PrivateDirectory, private_file_identity, windows_native};
use anyhow::{Context, Result, ensure};
use std::os::windows::io::AsRawHandle;
use std::{
    ffi::OsStr,
    fs::File,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandleEx,
};

struct DirectoryNode {
    directory: PrivateDirectory,
    _parent: Option<Arc<DirectoryNode>>,
}

/// Holds every traversed ancestor without share-delete. New children still
/// require independent inventory checks; this does not prevent child insertion.
#[derive(Clone)]
pub struct ReadOnlyDirectoryPin {
    node: Arc<DirectoryNode>,
    _traversed: Arc<Vec<Arc<DirectoryNode>>>,
    path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadOnlyDirectoryStamp {
    identity: (u64, u64),
    change: i64,
    write: i64,
}

fn basic(file: &File) -> Result<FILE_BASIC_INFO> {
    let mut value = FILE_BASIC_INFO::default();
    // SAFETY: the owned handle and correctly sized output remain live.
    ensure!(
        unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle().cast(),
                FileBasicInfo,
                (&mut value as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } != 0,
        "Read-only resource metadata unavailable"
    );
    Ok(value)
}

impl ReadOnlyDirectoryPin {
    /// Walk original components before normalization, including components later
    /// removed by `..`, so junctions cannot hide behind lexical normalization.
    pub fn open_existing(path: &Path) -> Result<Self> {
        let absolute = if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir()?.join(path)
        };
        let mut components = absolute.components();
        let prefix = match components.next() {
            Some(Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_)
                        | std::path::Prefix::UNC(_, _)
                        | std::path::Prefix::VerbatimDisk(_)
                        | std::path::Prefix::VerbatimUNC(_, _)
                ) =>
            {
                prefix.as_os_str().to_owned()
            }
            _ => anyhow::bail!("Read-only resource root must be absolute"),
        };
        ensure!(
            matches!(components.next(), Some(Component::RootDir)),
            "Read-only resource root must be absolute"
        );
        let mut normalized = PathBuf::from(prefix);
        normalized.push(Path::new(r"\"));
        let directory = windows_native::open_absolute_directory(&normalized)?;
        let directory = windows_native::open_same_directory_no_delete_share(&directory)?;
        let root = Arc::new(DirectoryNode {
            directory: PrivateDirectory { directory },
            _parent: None,
        });
        let mut stack = vec![root.clone()];
        let mut traversed = vec![root];
        for component in components {
            match component {
                Component::Normal(name) => {
                    let parent = stack.last().context("Missing read-only resource parent")?;
                    let directory =
                        windows_native::open_pinned_directory(&parent.directory.directory, name)?;
                    let node = Arc::new(DirectoryNode {
                        directory: PrivateDirectory { directory },
                        _parent: Some(parent.clone()),
                    });
                    normalized.push(name);
                    stack.push(node.clone());
                    traversed.push(node);
                }
                Component::ParentDir => {
                    ensure!(
                        stack.len() > 1,
                        "Read-only resource root escaped its volume"
                    );
                    stack.pop();
                    normalized.pop();
                }
                Component::CurDir => {}
                _ => anyhow::bail!("Unsafe read-only resource root component"),
            }
        }
        let node = stack.pop().context("Missing read-only resource root")?;
        // Ancestors are now pinned; this one normalization cannot traverse a
        // replaced directory. Descendants never canonicalize or reopen paths.
        let path = normalized.canonicalize()?;
        ensure!(
            PrivateDirectory::open_existing(&path)?.directory_identity()?
                == node.directory.directory_identity()?,
            "Normalized read-only resource root changed identity"
        );
        Ok(Self {
            node,
            _traversed: Arc::new(traversed),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn open_child(&self, name: &OsStr) -> Result<Self> {
        let directory =
            windows_native::open_pinned_directory(&self.node.directory.directory, name)?;
        Ok(Self {
            node: Arc::new(DirectoryNode {
                directory: PrivateDirectory { directory },
                _parent: Some(self.node.clone()),
            }),
            _traversed: self._traversed.clone(),
            path: self.path.join(name),
        })
    }

    pub fn names_bounded(&self, limit: usize) -> Result<Vec<std::ffi::OsString>> {
        ensure!(
            (1..=60000).contains(&limit),
            "Invalid read-only inventory budget"
        );
        let names =
            windows_native::directory_names_bounded(&self.node.directory.directory, limit + 1)?;
        ensure!(names.len() <= limit, "Read-only inventory budget exceeded");
        for name in &names {
            windows_native::validate_single_component(name)?;
        }
        Ok(names)
    }

    pub fn stamp(&self) -> Result<ReadOnlyDirectoryStamp> {
        let file = &self.node.directory.directory;
        let value = basic(file)?;
        Ok(ReadOnlyDirectoryStamp {
            identity: private_file_identity(file)?,
            change: value.ChangeTime,
            write: value.LastWriteTime,
        })
    }

    /// An existing writer/deleter prevents acquiring this read-only pin.
    pub fn open_file(&self, name: &OsStr) -> Result<ReadOnlyFilePin> {
        let started = std::time::Instant::now();
        let file = windows_native::open_pinned_regular(&self.node.directory.directory, name)?;
        let opened = started.elapsed();
        let (snapshot, identity, basic) = FileSnapshot::capture_timed(&file)?;
        Ok(ReadOnlyFilePin {
            file,
            snapshot,
            timings: (opened, identity, basic),
            _parent: self.clone(),
        })
    }
}

#[derive(PartialEq, Eq)]
struct FileSnapshot {
    identity: PortableLeaseIdentity,
    length: u64,
    change: i64,
    write: i64,
}
impl FileSnapshot {
    fn capture(file: &File) -> Result<Self> {
        Ok(Self::capture_timed(file)?.0)
    }

    fn capture_timed(file: &File) -> Result<(Self, std::time::Duration, std::time::Duration)> {
        let started = std::time::Instant::now();
        let identity = PortableLeaseIdentity::from_regular_handle(file)?;
        let identity_elapsed = started.elapsed();
        let started = std::time::Instant::now();
        let value = basic(file)?;
        let snapshot = Self {
            identity,
            length: file.metadata()?.len(),
            change: value.ChangeTime,
            write: value.LastWriteTime,
        };
        Ok((snapshot, identity_elapsed, started.elapsed()))
    }
}

/// Same read handle from validation through hashing; share-write/delete are denied.
pub struct ReadOnlyFilePin {
    file: File,
    snapshot: FileSnapshot,
    timings: (
        std::time::Duration,
        std::time::Duration,
        std::time::Duration,
    ),
    _parent: ReadOnlyDirectoryPin,
}
impl ReadOnlyFilePin {
    /// Aggregate timing of native open/no-reparse, identity, and basic metadata.
    pub fn open_timings(
        &self,
    ) -> (
        std::time::Duration,
        std::time::Duration,
        std::time::Duration,
    ) {
        self.timings
    }
    pub fn file(&self) -> &File {
        &self.file
    }
    pub fn len(&self) -> u64 {
        self.snapshot.length
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn verify_unchanged(&self) -> Result<()> {
        ensure!(
            FileSnapshot::capture(&self.file)? == self.snapshot,
            "Read-only resource changed during verification"
        );
        Ok(())
    }
}

#[cfg(test)]
#[path = "readonly_handles_tests.rs"]
mod tests;
