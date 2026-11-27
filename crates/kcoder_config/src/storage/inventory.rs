//! Exact, read-only source inventory for an explicitly stopped storage root.
//!
//! Callers must hold the storage coordinator's exclusive lease and have confirmed
//! that all source writers are stopped before invoking this module. It performs
//! full-tree I/O and is not suitable for startup, status, or ordinary query paths.

use crate::{PortableLeaseIdentity, PrivateDirectory};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
};

// The no-follow fs visitor fails rather than truncating above this per-directory limit.
const DIRECTORY_ENTRY_BUDGET: usize = 65_536;
const HASH_BUFFER_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageTreeEntryKind {
    RegularFile,
    Directory,
    Symlink,
}

/// One exact source entry. Link targets are deliberately not read or followed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageTreeEntry {
    /// Relative to the held inventory root; native path components are preserved.
    pub relative_path: PathBuf,
    pub kind: StorageTreeEntryKind,
    /// Opaque stable identity from the held native object, not a path hash.
    pub identity: String,
    /// Present only for ordinary file content; directories and links have no payload size.
    pub size_bytes: Option<u64>,
    /// SHA-256 of ordinary file bytes. Excluded writer leases and links are not read.
    pub sha256: Option<String>,
    /// True only for an exact path supplied by the caller, such as its writer lease.
    pub excluded: bool,
}

/// In-memory inventory captured from one already-held ordinary directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageTreeInventory {
    pub root_identity: String,
    pub entries: Vec<StorageTreeEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MutationStamp {
    len: u64,
    #[cfg(unix)]
    modified: (i64, i64),
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(windows)]
    modified: u64,
    #[cfg(not(any(unix, windows)))]
    modified: Option<std::time::SystemTime>,
}

impl MutationStamp {
    fn read(metadata: &Metadata) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                len: metadata.len(),
                modified: (metadata.mtime(), metadata.mtime_nsec()),
                changed: (metadata.ctime(), metadata.ctime_nsec()),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            Ok(Self {
                len: metadata.len(),
                modified: metadata.last_write_time(),
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(Self {
                len: metadata.len(),
                modified: metadata.modified().ok(),
            })
        }
    }
}

fn regular_handle_identity(file: &File) -> Result<String> {
    serde_json::to_string(&PortableLeaseIdentity::from_regular_handle(file)?)
        .context("storage_inventory_identity_unavailable")
}

fn entry_kind(metadata: &Metadata) -> Result<StorageTreeEntryKind> {
    let file_type = metadata.file_type();
    if file_type.is_file() {
        Ok(StorageTreeEntryKind::RegularFile)
    } else if file_type.is_dir() {
        Ok(StorageTreeEntryKind::Directory)
    } else if file_type.is_symlink() {
        Ok(StorageTreeEntryKind::Symlink)
    } else {
        anyhow::bail!("storage_inventory_unsupported_entry")
    }
}

fn validate_exclusions(exclusions: &BTreeSet<PathBuf>) -> Result<()> {
    for path in exclusions {
        ensure!(path.is_relative(), "storage_inventory_invalid_exclusion");
        let components = path.components().collect::<Vec<_>>();
        ensure!(
            !components.is_empty()
                && components
                    .iter()
                    .all(|part| matches!(part, Component::Normal(_))),
            "storage_inventory_invalid_exclusion"
        );
    }
    Ok(())
}

fn read_names(directory: &PrivateDirectory) -> Result<Vec<OsString>> {
    let mut names = Vec::new();
    if let Err(error) = directory.visit_entry_names_bounded(DIRECTORY_ENTRY_BUDGET, |name| {
        names.push(name.to_os_string());
        Ok(())
    }) {
        let code = if PrivateDirectory::is_entry_budget_exhausted(&error) {
            "storage_inventory_directory_entry_budget_exceeded"
        } else {
            "storage_inventory_directory_read_failed"
        };
        return Err(error.context(code));
    }
    names.sort();
    ensure!(
        names.windows(2).all(|pair| pair[0] != pair[1]),
        "storage_inventory_duplicate_name"
    );
    Ok(names)
}

fn hash_once(file: &mut File, expected_bytes: u64) -> Result<(String, u64)> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    // Windows rejects even an EOF read through another owner's byte-range
    // lock. An empty file has no content; the caller still rechecks its stamp.
    if expected_bytes == 0 {
        return Ok((format!("{:x}", hash.finalize()), 0));
    }
    let mut buffer = [0u8; HASH_BUFFER_BYTES];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .context("storage_inventory_size_overflow")?;
        ensure!(total <= expected_bytes, "storage_inventory_source_changed");
        hash.update(&buffer[..count]);
    }
    Ok((format!("{:x}", hash.finalize()), total))
}

fn hash_stable_file(file: &mut File, identity: &str, stamp: &MutationStamp) -> Result<String> {
    let digest = hash_once(file, stamp.len)?;
    ensure!(
        regular_handle_identity(file)? == identity
            && MutationStamp::read(&file.metadata()?)? == *stamp
            && digest.1 == stamp.len,
        "storage_inventory_source_changed"
    );
    Ok(digest.0)
}

struct EntryFact {
    name: OsString,
    kind: StorageTreeEntryKind,
    identity: String,
    stamp: MutationStamp,
    // Present only for an exact explicit regular exclusion. It is transient
    // observation evidence, not another manifest field or copying permission.
    observed_links: Option<u64>,
}

struct DirectoryFrame {
    relative_path: PathBuf,
    directory: PrivateDirectory,
    identity: String,
    stamp: MutationStamp,
    names: Vec<OsString>,
    next_name: usize,
    direct_entries: Vec<EntryFact>,
}

fn open_frame(relative_path: PathBuf, directory: PrivateDirectory) -> Result<DirectoryFrame> {
    let metadata = directory.directory_metadata()?;
    ensure!(metadata.is_dir(), "storage_inventory_directory_changed");
    let identity = directory.directory_identity()?;
    let stamp = MutationStamp::read(&metadata)?;
    let names = read_names(&directory)?;
    Ok(DirectoryFrame {
        relative_path,
        directory,
        identity,
        stamp,
        names,
        next_name: 0,
        direct_entries: Vec::new(),
    })
}

fn verify_entry(parent: &PrivateDirectory, expected: &EntryFact) -> Result<()> {
    let current = parent
        .open_entry_handle(&expected.name)
        .context("storage_inventory_source_changed")?;
    let metadata = current.metadata();
    let (identity, observed_links) = if expected.observed_links.is_some() {
        let (identity, links) = current.observe_regular_metadata()?;
        (serde_json::to_string(&identity)?, Some(links))
    } else {
        (current.identity()?, None)
    };
    ensure!(
        entry_kind(metadata)? == expected.kind
            && identity == expected.identity
            && MutationStamp::read(metadata)? == expected.stamp
            && observed_links == expected.observed_links,
        "storage_inventory_source_changed"
    );
    if expected.kind == StorageTreeEntryKind::RegularFile && expected.observed_links.is_none() {
        // This also rejects a newly introduced hard link; reads stay bound to a
        // single ordinary object beneath the held parent directory.
        let file = parent
            .open_regular_file_snapshot(&expected.name)
            .context("storage_inventory_source_changed")?;
        ensure!(
            regular_handle_identity(&file)? == expected.identity
                && MutationStamp::read(&file.metadata()?)? == expected.stamp,
            "storage_inventory_source_changed"
        );
    }
    Ok(())
}

fn finish_frame(frame: &DirectoryFrame) -> Result<()> {
    for entry in &frame.direct_entries {
        verify_entry(&frame.directory, entry)?;
    }
    let names = read_names(&frame.directory)?;
    let metadata = frame.directory.directory_metadata()?;
    ensure!(
        metadata.is_dir()
            && frame.directory.directory_identity()? == frame.identity
            && MutationStamp::read(&metadata)? == frame.stamp
            && names == frame.names,
        "storage_inventory_source_changed"
    );
    Ok(())
}

/// Capture a deterministic inventory from a held ordinary root.
///
/// `exclusions` are exact relative leaf paths supplied by the owning module;
/// an excluded item is still recorded with its identity and type, but is not
/// hashed or eligible for copy. An excluded directory's subtree belongs to its
/// explicit owner and is not traversed. Unknown names are always retained.
pub(super) fn inventory_tree(
    root: &PrivateDirectory,
    exclusions: &BTreeSet<PathBuf>,
) -> Result<StorageTreeInventory> {
    inventory_tree_with_fences(root, exclusions, &BTreeSet::new())
}

pub(super) fn inventory_tree_with_fences(
    root: &PrivateDirectory,
    exclusions: &BTreeSet<PathBuf>,
    held_fences: &BTreeSet<String>,
) -> Result<StorageTreeInventory> {
    inventory_tree_with_hook(root, exclusions, held_fences, |_| {})
}

fn inventory_tree_with_hook(
    root: &PrivateDirectory,
    exclusions: &BTreeSet<PathBuf>,
    held_fences: &BTreeSet<String>,
    mut before_hash: impl FnMut(&Path),
) -> Result<StorageTreeInventory> {
    validate_exclusions(exclusions)?;
    let root_handle = root.duplicate_handle()?;
    let root_frame = open_frame(PathBuf::new(), root_handle)?;
    let root_identity = root_frame.identity.clone();
    let mut frames = vec![root_frame];
    let mut entries = Vec::new();

    while !frames.is_empty() {
        if frames
            .last()
            .is_some_and(|frame| frame.next_name == frame.names.len())
        {
            let finished = frames.pop().expect("the top frame exists");
            finish_frame(&finished)?;
            continue;
        }

        let (relative_path, name) = {
            let frame = frames.last_mut().expect("a frame remains");
            let name = frame.names[frame.next_name].clone();
            frame.next_name += 1;
            let mut relative_path = frame.relative_path.clone();
            relative_path.push(&name);
            (relative_path, name)
        };

        let held_entry = frames
            .last()
            .expect("the parent frame remains")
            .directory
            .open_entry_handle(&name)
            .context("storage_inventory_entry_open_failed")
            .map_err(|error| {
                super::writers::permission_context(
                    error,
                    format!(
                        "storage inventory entry access: {}",
                        relative_path.display()
                    ),
                )
            })?;
        let metadata = held_entry.metadata();
        let kind = entry_kind(metadata)?;
        let explicit_exclusion = exclusions.contains(&relative_path);
        let (identity, observed_links) =
            if explicit_exclusion && kind == StorageTreeEntryKind::RegularFile {
                let (identity, links) = held_entry.observe_regular_metadata()?;
                (serde_json::to_string(&identity)?, Some(links))
            } else {
                (held_entry.identity()?, None)
            };
        let stamp = MutationStamp::read(metadata)?;
        // Only the actual held runtime fence is automatic. An unknown file with
        // the same basename remains ordinary persistent data.
        let excluded = explicit_exclusion
            || kind == StorageTreeEntryKind::RegularFile && held_fences.contains(&identity);

        let size_bytes = if kind == StorageTreeEntryKind::RegularFile {
            Some(stamp.len)
        } else {
            None
        };

        let sha256 = if kind == StorageTreeEntryKind::RegularFile && !excluded {
            let mut file = frames
                .last()
                .expect("the parent frame remains")
                .directory
                .open_regular_file_snapshot(&name)
                .context("storage_inventory_entry_open_failed")
                .map_err(|error| {
                    super::writers::permission_context(
                        error,
                        format!(
                            "storage inventory entry access: {}",
                            relative_path.display()
                        ),
                    )
                })?;
            ensure!(
                regular_handle_identity(&file)? == identity
                    && MutationStamp::read(&file.metadata()?)? == stamp,
                "storage_inventory_source_changed"
            );
            before_hash(&relative_path);
            Some(hash_stable_file(&mut file, &identity, &stamp)?)
        } else {
            None
        };

        let mut child_frame = None;
        if kind == StorageTreeEntryKind::Directory && !excluded {
            let child = held_entry.open_child_directory()?;
            ensure!(
                child.directory_identity()? == identity,
                "storage_inventory_source_changed"
            );
            child_frame = Some(open_frame(relative_path.clone(), child)?);
        }

        drop(held_entry);
        frames
            .last_mut()
            .expect("the current parent frame remains")
            .direct_entries
            .push(EntryFact {
                name: name.clone(),
                kind,
                identity: identity.clone(),
                stamp: stamp.clone(),
                observed_links,
            });
        entries.push(StorageTreeEntry {
            relative_path: relative_path.clone(),
            kind,
            identity: identity.clone(),
            size_bytes,
            sha256,
            excluded,
        });

        if let Some(child_frame) = child_frame {
            frames.push(child_frame);
        }
    }

    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(StorageTreeInventory {
        root_identity,
        entries,
    })
}

#[cfg(test)]
#[path = "inventory_tests.rs"]
mod tests;
