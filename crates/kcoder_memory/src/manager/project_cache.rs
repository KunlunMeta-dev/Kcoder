//! Metadata is a freshness hint, not a transactional filesystem snapshot.
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

#[derive(Debug, Default)]
pub(super) struct ProjectCache {
    pub revision: Option<Vec<FileRevision>>,
    pub memories: Vec<crate::Memory>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileRevision {
    pub path: PathBuf,
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

pub(super) fn revision(dir: &Path) -> Result<Vec<FileRevision>> {
    match std::fs::metadata(dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => anyhow::bail!("project memory path is not a directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("failed to inspect project memory directory"),
    }
    let mut files = Vec::new();
    for entry in WalkDir::new(dir).follow_links(false) {
        let entry = entry.context("failed to scan project memory files")?;
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|ext| ext.to_str()) != Some("md")
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .context("failed to inspect project memory file")?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        };
        files.push(FileRevision {
            path: entry.into_path(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub(super) fn cacheable(revision: &[FileRevision]) -> bool {
    // If modification time is unavailable, re-read instead of trusting an
    // unchanged length. Windows has no change-time/file-id signal here.
    revision.iter().all(|file| file.modified.is_some())
}
