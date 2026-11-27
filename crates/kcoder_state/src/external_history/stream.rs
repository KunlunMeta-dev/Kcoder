use anyhow::{Result, ensure};
use kcoder_types::external_history::{
    EXTERNAL_HISTORY_CHUNK_BYTES as CHUNK, ExternalHistoryPhase as Phase,
    ExternalHistoryProgress as Progress,
};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Read};

pub(super) const ENTRY_BYTES: u64 = 64;
const READ_BYTES: usize = 64 * 1024;

pub(super) struct Fingerprint {
    pub bytes: u64,
    pub sha256: String,
    pub chunks: Vec<u8>,
}

pub(super) struct HashingReader<R> {
    pub inner: R,
    maximum: u64,
    expected: Option<(u64, String)>,
    bytes: u64,
    hash: Sha256,
    chunk_hash: Sha256,
    chunk_bytes: usize,
    chunks: Vec<u8>,
    ended: bool,
}

impl<R: Read> HashingReader<R> {
    pub fn new(inner: R, maximum: u64, expected: Option<(u64, String)>) -> Self {
        Self {
            inner,
            maximum,
            expected,
            bytes: 0,
            hash: Sha256::new(),
            chunk_hash: Sha256::new(),
            chunk_bytes: 0,
            chunks: Vec::new(),
            ended: false,
        }
    }

    pub fn fingerprint(&self) -> Result<Fingerprint> {
        ensure!(self.ended, "external_history_incomplete_stream");
        Ok(Fingerprint {
            bytes: self.bytes,
            sha256: format!("{:x}", self.hash.clone().finalize()),
            chunks: self.chunks.clone(),
        })
    }
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.ended {
            return Ok(0);
        }
        let count = buffer
            .len()
            .min(READ_BYTES)
            .min((self.maximum.saturating_sub(self.bytes) + 1) as usize);
        let read = self.inner.read(&mut buffer[..count])?;
        if read == 0 {
            if let Some((bytes, hash)) = &self.expected
                && (*bytes != self.bytes || *hash != format!("{:x}", self.hash.clone().finalize()))
            {
                return Err(io::Error::other("external_history_source_changed"));
            }
            if self.chunk_bytes > 0 {
                self.chunks
                    .extend_from_slice(&std::mem::take(&mut self.chunk_hash).finalize());
            }
            self.ended = true;
            return Ok(0);
        }
        if read as u64 > self.maximum.saturating_sub(self.bytes) {
            return Err(io::Error::other("external_history_byte_budget_exceeded"));
        }
        self.bytes += read as u64;
        self.hash.update(&buffer[..read]);
        let mut remaining = &buffer[..read];
        while !remaining.is_empty() {
            let take = remaining.len().min(CHUNK - self.chunk_bytes);
            self.chunk_hash.update(&remaining[..take]);
            self.chunk_bytes += take;
            remaining = &remaining[take..];
            if self.chunk_bytes == CHUNK {
                self.chunks
                    .extend_from_slice(&std::mem::take(&mut self.chunk_hash).finalize());
                self.chunk_bytes = 0;
            }
        }
        Ok(read)
    }
}

pub(super) struct ControlledReader<'a, R, C> {
    pub reader: R,
    pub check: &'a mut C,
    pub phase: Phase,
    pub total: u64,
    pub processed: u64,
}

impl<R: Read, C: FnMut(Progress) -> bool> Read for ControlledReader<'_, R, C> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if !(self.check)(Progress {
            phase: self.phase,
            processed_bytes: self.processed,
            total_bytes: self.total,
        }) {
            return Err(io::Error::other("external_history_cancelled"));
        }
        let count = buffer.len().min(READ_BYTES);
        let read = self.reader.read(&mut buffer[..count])?;
        self.processed += read as u64;
        Ok(read)
    }
}

/// Emit fixed-width references while hashing one line incrementally, including oversized records.
pub(super) struct RecordIndexReader<R> {
    reader: std::io::BufReader<R>,
    pub count: u64,
    limit: u64,
    offset: u64,
    pending: [u8; ENTRY_BYTES as usize],
    pending_offset: usize,
    ended: bool,
}

impl<R: Read> RecordIndexReader<R> {
    pub fn new(reader: R, limit: u64) -> Self {
        Self {
            reader: std::io::BufReader::with_capacity(READ_BYTES, reader),
            count: 0,
            limit,
            offset: 0,
            pending: [0; ENTRY_BYTES as usize],
            pending_offset: ENTRY_BYTES as usize,
            ended: false,
        }
    }

    fn next_record(&mut self) -> io::Result<bool> {
        let start = self.offset;
        let mut hash = Sha256::new();
        let terminated = loop {
            let bytes = self.reader.fill_buf()?;
            if bytes.is_empty() {
                if self.offset == start {
                    return Ok(false);
                }
                break false;
            }
            if self.count >= self.limit {
                return Err(io::Error::other("external_history_record_budget_exceeded"));
            }
            let end = bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1);
            let count = end.unwrap_or(bytes.len());
            hash.update(&bytes[..count]);
            self.offset += count as u64;
            self.reader.consume(count);
            if end.is_some() {
                break true;
            }
        };
        self.pending.fill(0);
        self.pending[..8].copy_from_slice(&start.to_le_bytes());
        self.pending[8..16].copy_from_slice(&(self.offset - start).to_le_bytes());
        self.pending[16..48].copy_from_slice(&hash.finalize());
        self.pending[48] = u8::from(terminated);
        self.pending_offset = 0;
        self.count += 1;
        Ok(true)
    }
}

impl<R: Read> RecordIndexReader<HashingReader<R>> {
    pub fn reader_fingerprint(&self) -> Result<Fingerprint> {
        self.reader.get_ref().fingerprint()
    }
}

impl<R: Read> Read for RecordIndexReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.ended {
            return Ok(0);
        }
        if self.pending_offset == self.pending.len() && !self.next_record()? {
            self.ended = true;
            return Ok(0);
        }
        let count = buffer.len().min(self.pending.len() - self.pending_offset);
        buffer[..count]
            .copy_from_slice(&self.pending[self.pending_offset..self.pending_offset + count]);
        self.pending_offset += count;
        Ok(count)
    }
}
