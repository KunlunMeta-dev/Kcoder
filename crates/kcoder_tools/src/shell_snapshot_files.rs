//! Snapshot files are private at creation and owned until the complete set is published.
use anyhow::{Context, Result};
use std::{
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

pub(super) fn private_file(directory: &Path, content: &[u8]) -> Result<NamedTempFile> {
    let mut file = tempfile::Builder::new()
        .prefix(".kcoder-snapshot-")
        .suffix(".tmp")
        .tempfile_in(directory)
        .context("failed to create private shell snapshot")?;
    file.write_all(content)
        .context("failed to write private shell snapshot")?;
    file.as_file()
        .sync_all()
        .context("failed to sync private shell snapshot")?;
    Ok(file)
}

pub(super) struct Publication {
    paths: Vec<PathBuf>,
    committed: bool,
}
impl Publication {
    pub(super) fn publish(files: Vec<(NamedTempFile, PathBuf)>) -> Result<Self> {
        let mut publication = Self {
            paths: Vec::new(),
            committed: false,
        };
        for (file, path) in files {
            file.persist_noclobber(&path)
                .map_err(|error| error.error)
                .with_context(|| format!("failed to publish shell snapshot {path:?}"))?;
            publication.paths.push(path);
        }
        Ok(publication)
    }
    pub(super) fn commit(mut self) -> Vec<PathBuf> {
        self.committed = true;
        std::mem::take(&mut self.paths)
    }
}
impl Drop for Publication {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.paths {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
