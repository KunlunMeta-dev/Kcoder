//! Per-export byte observations. Completion here is not a client acknowledgement.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};

pub(super) struct ExportReadProgress {
    expected_bytes: u64,
    expected_sha256: String,
    prefix: u64,
    digest: Sha256,
    completed_at_ms: Option<u64>,
    poisoned: bool,
}

/// Not serializable: only original native byte reads construct this witness.
pub(super) struct CompleteExportRead {
    pub(super) bytes: u64,
    pub(super) sha256: String,
    pub(super) completed_at_ms: u64,
}

impl ExportReadProgress {
    pub(super) fn new(bytes: u64, sha256: &str) -> Result<Self> {
        ensure!(
            sha256.len() == 64
                && sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "OFFICE_EXPORT_HASH_MISMATCH"
        );
        Ok(Self {
            expected_bytes: bytes,
            expected_sha256: sha256.into(),
            prefix: 0,
            digest: Sha256::new(),
            completed_at_ms: None,
            poisoned: false,
        })
    }

    /// Count only the contiguous original stream. Duplicate/overlapping reads
    /// cannot inflate coverage. Ahead-of-prefix previews remain readable but
    /// cannot manufacture completion without reading the missing prefix.
    pub(super) fn observe(
        &mut self,
        offset: u64,
        bytes: &[u8],
        total: u64,
        now_ms: u64,
    ) -> Result<()> {
        ensure!(!self.poisoned, "OFFICE_EXPORT_HASH_MISMATCH");
        let end = offset
            .checked_add(bytes.len().try_into()?)
            .ok_or_else(|| anyhow::anyhow!("OFFICE_EXPORT_SIZE_MISMATCH"))?;
        ensure!(
            total == self.expected_bytes && end <= total,
            "OFFICE_EXPORT_SIZE_MISMATCH"
        );
        if offset > self.prefix || end < self.prefix {
            return Ok(());
        }
        let skip: usize = (self.prefix - offset).try_into()?;
        self.digest.update(&bytes[skip..]);
        self.prefix = end;
        if self.prefix == self.expected_bytes {
            let actual = format!("{:x}", self.digest.clone().finalize());
            if actual != self.expected_sha256 {
                self.poisoned = true;
                anyhow::bail!("OFFICE_EXPORT_HASH_MISMATCH");
            }
            self.completed_at_ms.get_or_insert(now_ms);
        }
        Ok(())
    }

    pub(super) fn complete(&self) -> Result<CompleteExportRead> {
        ensure!(
            !self.poisoned && self.prefix == self.expected_bytes,
            "OFFICE_EXPORT_UNCONFIRMED"
        );
        Ok(CompleteExportRead {
            bytes: self.expected_bytes,
            sha256: self.expected_sha256.clone(),
            completed_at_ms: self
                .completed_at_ms
                .ok_or_else(|| anyhow::anyhow!("OFFICE_EXPORT_UNCONFIRMED"))?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn progress(bytes: &[u8]) -> ExportReadProgress {
        ExportReadProgress::new(bytes.len() as u64, &format!("{:x}", Sha256::digest(bytes)))
            .unwrap()
    }
    #[test]
    fn final_range_and_duplicate_bytes_cannot_claim_a_missing_prefix() {
        let mut state = progress(b"abcdef");
        state.observe(4, b"ef", 6, 10).unwrap();
        assert!(state.complete().is_err());
        state.observe(0, b"abc", 6, 11).unwrap();
        state.observe(0, b"abc", 6, 12).unwrap();
        assert!(state.complete().is_err());
        state.observe(2, b"cdef", 6, 13).unwrap();
        let complete = state.complete().unwrap();
        assert_eq!(complete.bytes, 6);
        assert_eq!(complete.completed_at_ms, 13);
        assert_eq!(complete.sha256, format!("{:x}", Sha256::digest(b"abcdef")));
        state.observe(0, b"abcdef", 6, 20).unwrap();
        assert_eq!(state.complete().unwrap().completed_at_ms, 13);
    }
    #[test]
    fn corrupted_bytes_poison_completion_and_cannot_be_replaced_by_a_later_good_read() {
        let mut state = progress(b"abcdef");
        assert!(state.observe(0, b"abcdeg", 6, 10).is_err());
        assert!(state.complete().is_err());
        assert!(state.observe(0, b"abcdef", 6, 11).is_err());
        assert!(state.complete().is_err());
    }
    #[test]
    fn inconsistent_size_and_overflow_never_advance_coverage() {
        let mut state = progress(b"abc");
        assert!(state.observe(0, b"abc", 4, 10).is_err());
        assert!(state.observe(u64::MAX, b"abc", 3, 10).is_err());
        assert!(state.complete().is_err());
        state.observe(0, b"abc", 3, 11).unwrap();
        assert_eq!(state.complete().unwrap().bytes, 3);
    }
    #[test]
    fn empty_content_still_requires_an_actual_read_observation() {
        let mut state = progress(b"");
        assert!(state.complete().is_err());
        state.observe(0, b"", 0, 10).unwrap();
        assert_eq!(state.complete().unwrap().completed_at_ms, 10);
    }
}
