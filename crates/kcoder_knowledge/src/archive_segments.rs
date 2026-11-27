//! A collection splits stream bytes without changing object identity or import atomicity.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_ARCHIVE_SEGMENT_BYTES: u64 = 96 * 1024 * 1024;
const MAX_COLLECTION_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_SEGMENTS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveSegment {
    pub index: usize,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveCollectionManifest {
    pub format: String,
    pub version: u32,
    pub collection_id: String,
    pub size: u64,
    pub sha256: String,
    pub segments: Vec<ArchiveSegment>,
}

/// The returned owner deletes only this export's temporary directory on drop.
pub struct ArchiveCollection {
    pub manifest: ArchiveCollectionManifest,
    directory: tempfile::TempDir,
}
impl ArchiveCollection {
    pub fn segment_path(&self, index: usize) -> Result<PathBuf> {
        let entry = self
            .manifest
            .segments
            .get(index)
            .context("archive segment missing")?;
        Ok(self.directory.path().join(&entry.name))
    }
}

pub struct ArchiveSegmentWriter {
    directory: tempfile::TempDir,
    max_segment_bytes: u64,
    current: Option<File>,
    current_size: u64,
    current_hash: Sha256,
    total_size: u64,
    total_hash: Sha256,
    segments: Vec<ArchiveSegment>,
}
impl ArchiveSegmentWriter {
    pub fn new(parent: &Path, max_segment_bytes: u64) -> Result<Self> {
        ensure!(
            max_segment_bytes > 0 && max_segment_bytes <= MAX_ARCHIVE_SEGMENT_BYTES,
            "invalid archive segment size"
        );
        Ok(Self {
            directory: tempfile::tempdir_in(parent)?,
            max_segment_bytes,
            current: None,
            current_size: 0,
            current_hash: Sha256::new(),
            total_size: 0,
            total_hash: Sha256::new(),
            segments: vec![],
        })
    }
    fn close_segment(&mut self) -> Result<()> {
        if let Some(file) = self.current.take() {
            file.sync_all()?;
            let index = self.segments.len();
            self.segments.push(ArchiveSegment {
                index,
                name: segment_name(index),
                size: self.current_size,
                sha256: format!("{:x}", std::mem::take(&mut self.current_hash).finalize()),
            });
            self.current_size = 0;
        }
        Ok(())
    }
    pub fn finish(mut self) -> Result<ArchiveCollection> {
        self.close_segment()?;
        ensure!(!self.segments.is_empty(), "empty archive collection");
        Ok(ArchiveCollection {
            manifest: ArchiveCollectionManifest {
                format: "kcoder-wiki-collection".into(),
                version: 1,
                collection_id: uuid::Uuid::new_v4().to_string(),
                size: self.total_size,
                sha256: format!("{:x}", self.total_hash.finalize()),
                segments: self.segments,
            },
            directory: self.directory,
        })
    }
}
impl Write for ArchiveSegmentWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        if self.total_size >= MAX_COLLECTION_BYTES {
            return Err(std::io::Error::other("Wiki collection exceeds 1 GiB"));
        }
        if self.current_size == self.max_segment_bytes {
            self.close_segment().map_err(std::io::Error::other)?;
        }
        if self.current.is_none() {
            if self.segments.len() >= MAX_SEGMENTS {
                return Err(std::io::Error::other("Wiki collection exceeds 16 segments"));
            }
            self.current = Some(File::create(
                self.directory
                    .path()
                    .join(segment_name(self.segments.len())),
            )?);
        }
        let take = (self.max_segment_bytes - self.current_size)
            .min(MAX_COLLECTION_BYTES - self.total_size)
            .min(bytes.len() as u64) as usize;
        self.current
            .as_mut()
            .expect("created segment")
            .write_all(&bytes[..take])?;
        self.current_hash.update(&bytes[..take]);
        self.total_hash.update(&bytes[..take]);
        self.current_size += take as u64;
        self.total_size += take as u64;
        Ok(take)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(file) = &mut self.current {
            file.flush()?;
        }
        Ok(())
    }
}
fn segment_name(index: usize) -> String {
    format!("part-{:05}.kwiki", index + 1)
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The host first authorizes each path. Names in a manifest never select filesystem paths.
/// Segment and whole-collection hashes are checked before exposing EOF to the importer.
pub struct ArchiveSegmentReader {
    manifest: ArchiveCollectionManifest,
    files: Vec<File>,
    index: usize,
    current_size: u64,
    current_hash: Sha256,
    total_size: u64,
    total_hash: Sha256,
    complete: bool,
}
impl ArchiveSegmentReader {
    pub fn open(manifest: ArchiveCollectionManifest, paths: &[PathBuf]) -> Result<Self> {
        ensure!(
            manifest.format == "kcoder-wiki-collection" && manifest.version == 1,
            "unsupported Wiki collection version"
        );
        ensure!(
            uuid::Uuid::parse_str(&manifest.collection_id)?.to_string() == manifest.collection_id,
            "invalid Wiki collection identity"
        );
        ensure!(
            !manifest.segments.is_empty()
                && manifest.segments.len() <= MAX_SEGMENTS
                && paths.len() == manifest.segments.len(),
            "incomplete Wiki collection"
        );
        ensure!(valid_hash(&manifest.sha256), "invalid Wiki collection hash");
        let mut total = 0u64;
        let mut files = Vec::new();
        for (index, (entry, path)) in manifest.segments.iter().zip(paths).enumerate() {
            ensure!(
                entry.index == index
                    && entry.name == segment_name(index)
                    && valid_hash(&entry.sha256),
                "invalid Wiki segment identity"
            );
            ensure!(
                entry.size > 0 && entry.size <= MAX_ARCHIVE_SEGMENT_BYTES,
                "invalid Wiki segment size"
            );
            total = total
                .checked_add(entry.size)
                .context("Wiki collection size overflow")?;
            ensure!(
                total <= MAX_COLLECTION_BYTES,
                "Wiki collection exceeds 1 GiB"
            );
            let metadata = std::fs::symlink_metadata(path)?;
            ensure!(
                metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() == entry.size,
                "Wiki segment file mismatch"
            );
            let file = File::open(path)?;
            ensure!(
                file.metadata()?.is_file() && file.metadata()?.len() == entry.size,
                "Wiki segment changed"
            );
            files.push(file);
        }
        ensure!(total == manifest.size, "Wiki collection size mismatch");
        Ok(Self {
            manifest,
            files,
            index: 0,
            current_size: 0,
            current_hash: Sha256::new(),
            total_size: 0,
            total_hash: Sha256::new(),
            complete: false,
        })
    }
}
impl Read for ArchiveSegmentReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if bytes.is_empty() || self.complete {
            return Ok(0);
        }
        while self.index < self.files.len() {
            let entry = &self.manifest.segments[self.index];
            let remaining = entry.size - self.current_size;
            if remaining > 0 {
                let take = remaining.min(bytes.len() as u64) as usize;
                let count = self.files[self.index].read(&mut bytes[..take])?;
                if count == 0 {
                    return Err(std::io::Error::other("incomplete Wiki segment"));
                }
                self.current_hash.update(&bytes[..count]);
                self.total_hash.update(&bytes[..count]);
                self.current_size += count as u64;
                self.total_size += count as u64;
                return Ok(count);
            }
            let mut extra = [0];
            if self.files[self.index].read(&mut extra)? != 0
                || format!("{:x}", std::mem::take(&mut self.current_hash).finalize())
                    != entry.sha256
            {
                return Err(std::io::Error::other("Wiki segment integrity failure"));
            }
            self.index += 1;
            self.current_size = 0;
        }
        if self.total_size != self.manifest.size
            || format!("{:x}", std::mem::take(&mut self.total_hash).finalize())
                != self.manifest.sha256
        {
            return Err(std::io::Error::other("Wiki collection integrity failure"));
        }
        self.complete = true;
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn segments_preserve_bytes_and_reject_corruption_duplicates_and_missing_parts() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut writer = ArchiveSegmentWriter::new(root.path(), 3)?;
        writer.write_all(b"12345678")?;
        let collection = writer.finish()?;
        assert_eq!(collection.manifest.segments.len(), 3);
        let paths = (0..3)
            .map(|index| collection.segment_path(index))
            .collect::<Result<Vec<_>>>()?;
        let mut reader = ArchiveSegmentReader::open(collection.manifest.clone(), &paths)?;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        assert_eq!(bytes, b"12345678");
        assert!(ArchiveSegmentReader::open(collection.manifest.clone(), &paths[..2]).is_err());
        let mut duplicate = collection.manifest.clone();
        duplicate.segments[1].index = 0;
        assert!(ArchiveSegmentReader::open(duplicate, &paths).is_err());
        let mut invalid = collection.manifest.clone();
        invalid.segments[0].name = "../outside".into();
        assert!(ArchiveSegmentReader::open(invalid, &paths).is_err());
        std::fs::write(&paths[1], b"xyz")?;
        assert!(
            ArchiveSegmentReader::open(collection.manifest.clone(), &paths)?
                .read_to_end(&mut Vec::new())
                .is_err()
        );
        let directory = collection.directory.path().to_owned();
        drop(collection);
        assert!(!directory.exists());
        Ok(())
    }
}
