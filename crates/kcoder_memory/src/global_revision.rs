//! Global cache freshness hints; Windows length/mtime is not a strong snapshot.
use anyhow::{Context, Result};
use std::path::Path;
use std::time::SystemTime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Revision {
    Missing,
    Present {
        len: u64,
        modified: Option<SystemTime>,
        #[cfg(unix)]
        identity: (u64, u64, i64, i64),
    },
}

impl Revision {
    pub fn read(path: &Path) -> Result<Self> {
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Self::Missing),
            Err(error) => return Err(error).context("failed to inspect global memory file"),
        };
        if !metadata.is_file() {
            anyhow::bail!("global memory path is not a file");
        }
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
        Ok(Self::Present {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity,
        })
    }

    pub fn cacheable(&self) -> bool {
        matches!(
            self,
            Self::Missing
                | Self::Present {
                    modified: Some(_),
                    ..
                }
        )
    }
}
