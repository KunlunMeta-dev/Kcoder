//! Streaming inert backup container. Callers own file grants, staging and publication.
use super::manifest::{
    SOURCE_UPLOAD_MANIFEST_MAX_BYTES, SOURCE_UPLOAD_MAX_BYTES, ValidatedManifest, parse_manifest,
};
use anyhow::{Result, ensure};
use kcoder_types::migration_source_upload::SourceUploadFile;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use zeroize::Zeroizing;

pub const SOURCE_PACKAGE_MAGIC: &[u8; 8] = b"KCMBNDL1";
pub const SOURCE_PACKAGE_HEADER_BYTES: u64 = 16;
/// The payload retains its 2 GiB limit; the container also contains bounded metadata.
pub const SOURCE_PACKAGE_MAX_BYTES: u64 =
    SOURCE_UPLOAD_MAX_BYTES + SOURCE_UPLOAD_MANIFEST_MAX_BYTES as u64 + SOURCE_PACKAGE_HEADER_BYTES;
pub const SOURCE_PACKAGE_CHUNK_BYTES: usize = 128 * 1024;

/// Only byte ranges, never executable or filesystem authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackageEntry {
    pub file_index: usize,
    pub offset: u64,
    pub bytes: u64,
}

/// Construction verifies layout and canonical metadata, not the payload digests.
/// Copying a file verifies the exact bytes delivered to the caller's staging writer.
pub struct PackageReader<R> {
    reader: R,
    manifest: ValidatedManifest,
    entries: Vec<PackageEntry>,
    length: u64,
}

impl<R: Read + Seek> PackageReader<R> {
    pub fn new(mut reader: R, cancel: &mut dyn FnMut() -> Result<()>) -> Result<Self> {
        let length = stream_length(&mut reader, cancel)?;
        ensure!(
            (SOURCE_PACKAGE_HEADER_BYTES..=SOURCE_PACKAGE_MAX_BYTES).contains(&length),
            "source_upload_package_length"
        );
        seek(&mut reader, 0, cancel)?;
        let mut header = [0; SOURCE_PACKAGE_HEADER_BYTES as usize];
        read_fully(&mut reader, &mut header, cancel)?;
        ensure!(
            &header[..8] == SOURCE_PACKAGE_MAGIC,
            "source_upload_package_magic"
        );
        let manifest_len = u64::from_le_bytes(header[8..].try_into().expect("fixed header"));
        ensure!(
            (1..=SOURCE_UPLOAD_MANIFEST_MAX_BYTES as u64).contains(&manifest_len),
            "source_upload_manifest_budget"
        );
        let mut bytes = vec![0; manifest_len as usize];
        read_fully(&mut reader, &mut bytes, cancel)?;
        let manifest = parse_manifest(&bytes)?;
        ensure!(
            manifest.canonical_json() == bytes,
            "source_upload_package_noncanonical_manifest"
        );
        let mut offset = SOURCE_PACKAGE_HEADER_BYTES
            .checked_add(manifest_len)
            .ok_or_else(|| anyhow::anyhow!("source_upload_package_length"))?;
        let mut entries = Vec::with_capacity(manifest.manifest().files.len());
        for (file_index, file) in manifest.manifest().files.iter().enumerate() {
            cancel()?;
            entries.push(PackageEntry {
                file_index,
                offset,
                bytes: file.bytes,
            });
            offset = offset
                .checked_add(file.bytes)
                .ok_or_else(|| anyhow::anyhow!("source_upload_package_length"))?;
        }
        ensure!(offset == length, "source_upload_package_length");
        cancel()?;
        Ok(Self {
            reader,
            manifest,
            entries,
            length,
        })
    }

    pub fn manifest(&self) -> &ValidatedManifest {
        &self.manifest
    }

    pub fn entries(&self) -> &[PackageEntry] {
        &self.entries
    }

    pub fn total_container_bytes(&self) -> u64 {
        self.length
    }

    /// Errors can leave partial staging bytes. Never publish them on error or cancellation.
    pub fn copy_file<W: Write + ?Sized>(
        &mut self,
        file_index: usize,
        output: &mut W,
        cancel: &mut dyn FnMut() -> Result<()>,
    ) -> Result<u64> {
        let entry = *self
            .entries
            .get(file_index)
            .ok_or_else(|| anyhow::anyhow!("source_upload_unknown_file"))?;
        self.verify_layout(cancel)?;
        seek(&mut self.reader, entry.offset, cancel)?;
        let file = &self.manifest.manifest().files[file_index];
        copy_checked(&mut self.reader, output, file, cancel)?;
        self.verify_layout(cancel)?;
        Ok(entry.bytes)
    }

    pub fn verify_all(&mut self, cancel: &mut dyn FnMut() -> Result<()>) -> Result<()> {
        self.verify_layout(cancel)?;
        seek(&mut self.reader, self.entries[0].offset, cancel)?;
        for file in &self.manifest.manifest().files {
            copy_checked(&mut self.reader, &mut std::io::sink(), file, cancel)?;
        }
        self.verify_layout(cancel)
    }

    pub fn into_inner(self) -> R {
        self.reader
    }

    fn verify_layout(&mut self, cancel: &mut dyn FnMut() -> Result<()>) -> Result<()> {
        ensure!(
            stream_length(&mut self.reader, cancel)? == self.length,
            "source_upload_package_changed"
        );
        seek(&mut self.reader, 0, cancel)?;
        let mut header = [0; SOURCE_PACKAGE_HEADER_BYTES as usize];
        read_fully(&mut self.reader, &mut header, cancel)?;
        ensure!(
            &header[..8] == SOURCE_PACKAGE_MAGIC
                && u64::from_le_bytes(header[8..].try_into().expect("fixed header"))
                    == self.manifest.canonical_json().len() as u64,
            "source_upload_package_changed"
        );
        let mut observed = vec![0; self.manifest.canonical_json().len()];
        read_fully(&mut self.reader, &mut observed, cancel)?;
        ensure!(
            observed == self.manifest.canonical_json(),
            "source_upload_package_changed"
        );
        Ok(())
    }
}

/// Readers must already be granted regular-file handles. This function does not
/// resolve paths, follow links, authenticate source identity or commit output.
/// A failed write leaves untrusted partial output; the owner must discard/reconcile it.
pub fn write_package<R: Read, W: Write + ?Sized>(
    manifest: &ValidatedManifest,
    output: &mut W,
    mut open_file: impl FnMut(usize, &SourceUploadFile) -> Result<R>,
    cancel: &mut dyn FnMut() -> Result<()>,
) -> Result<u64> {
    cancel()?;
    write_fully(output, SOURCE_PACKAGE_MAGIC, cancel)?;
    write_fully(
        output,
        &(manifest.canonical_json().len() as u64).to_le_bytes(),
        cancel,
    )?;
    write_fully(output, manifest.canonical_json(), cancel)?;
    for (index, file) in manifest.manifest().files.iter().enumerate() {
        cancel()?;
        let mut input = open_file(index, file)
            .map_err(|_| anyhow::anyhow!("source_upload_file_open_failed"))?;
        copy_checked(&mut input, output, file, cancel)?;
        let mut extra = [0];
        cancel()?;
        let count = input
            .read(&mut extra)
            .map_err(|_| anyhow::anyhow!("source_upload_file_read_failed"))?;
        ensure!(count == 0, "source_upload_file_length_changed");
    }
    cancel()?;
    output
        .flush()
        .map_err(|_| anyhow::anyhow!("source_upload_package_write_failed"))?;
    cancel()?;
    SOURCE_PACKAGE_HEADER_BYTES
        .checked_add(manifest.canonical_json().len() as u64)
        .and_then(|bytes| bytes.checked_add(manifest.total_bytes()))
        .ok_or_else(|| anyhow::anyhow!("source_upload_package_length"))
}

fn copy_checked<R: Read, W: Write + ?Sized>(
    input: &mut R,
    output: &mut W,
    file: &SourceUploadFile,
    cancel: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    let mut buffer = Zeroizing::new(vec![0u8; SOURCE_PACKAGE_CHUNK_BYTES]);
    let mut remaining = file.bytes;
    let mut digest = Sha256::new();
    while remaining > 0 {
        cancel()?;
        let requested = remaining.min(buffer.len() as u64) as usize;
        let count = input
            .read(&mut buffer[..requested])
            .map_err(|_| anyhow::anyhow!("source_upload_file_read_failed"))?;
        ensure!(
            count > 0 && count <= requested,
            "source_upload_file_truncated"
        );
        cancel()?;
        digest.update(&buffer[..count]);
        write_fully(output, &buffer[..count], cancel)?;
        remaining -= count as u64;
    }
    cancel()?;
    ensure!(
        format!("{:x}", digest.finalize()) == file.sha256,
        "source_upload_file_digest_mismatch"
    );
    Ok(())
}

fn read_fully<R: Read>(
    input: &mut R,
    mut bytes: &mut [u8],
    cancel: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    while !bytes.is_empty() {
        cancel()?;
        let requested = bytes.len().min(SOURCE_PACKAGE_CHUNK_BYTES);
        let count = input
            .read(&mut bytes[..requested])
            .map_err(|_| anyhow::anyhow!("source_upload_package_read_failed"))?;
        ensure!(
            count > 0 && count <= requested,
            "source_upload_package_truncated"
        );
        bytes = &mut bytes[count..];
    }
    cancel()
}

fn write_fully<W: Write + ?Sized>(
    output: &mut W,
    mut bytes: &[u8],
    cancel: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    while !bytes.is_empty() {
        cancel()?;
        let requested = bytes.len().min(SOURCE_PACKAGE_CHUNK_BYTES);
        let count = output
            .write(&bytes[..requested])
            .map_err(|_| anyhow::anyhow!("source_upload_package_write_failed"))?;
        ensure!(
            count > 0 && count <= requested,
            "source_upload_package_write_failed"
        );
        bytes = &bytes[count..];
    }
    cancel()
}

fn seek<R: Seek>(input: &mut R, offset: u64, cancel: &mut dyn FnMut() -> Result<()>) -> Result<()> {
    cancel()?;
    ensure!(
        input
            .seek(SeekFrom::Start(offset))
            .map_err(|_| anyhow::anyhow!("source_upload_package_seek_failed"))?
            == offset,
        "source_upload_package_seek_failed"
    );
    cancel()
}

fn stream_length<R: Seek>(input: &mut R, cancel: &mut dyn FnMut() -> Result<()>) -> Result<u64> {
    cancel()?;
    let length = input
        .seek(SeekFrom::End(0))
        .map_err(|_| anyhow::anyhow!("source_upload_package_seek_failed"))?;
    cancel()?;
    Ok(length)
}

#[cfg(test)]
#[path = "package_tests.rs"]
mod tests;
