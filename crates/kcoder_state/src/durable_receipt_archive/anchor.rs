//! Monotonic cutover fences on the original namespace lock handle.
use super::*;
use kcoder_config::VerifiedPrivateLease;
use std::io::{Read, Seek, SeekFrom, Write};
const MAX_ANCHOR_BYTES: u64 = 16 * 1024;
const FINAL_SUFFIX: &[u8] = b"\nreceipt-archive-final-v1\n";

fn read_anchor(lease: &VerifiedPrivateLease) -> Result<Vec<u8>> {
    let mut file = lease.file();
    ensure!(
        file.metadata()?.len() <= MAX_ANCHOR_BYTES,
        "RECEIPT_ARCHIVE_ANCHOR_INVALID"
    );
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take(MAX_ANCHOR_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_ANCHOR_BYTES,
        "RECEIPT_ARCHIVE_ANCHOR_INVALID"
    );
    Ok(bytes)
}
impl DurableReceiptArchiveBinding {
    fn anchor_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let bytes = serde_json::to_vec(
            &serde_json::json!({"format":"receipt_archive_anchor_v1","binding":self}),
        )?;
        ensure!(
            bytes.len() + FINAL_SUFFIX.len() <= MAX_ANCHOR_BYTES as usize,
            "RECEIPT_ARCHIVE_ANCHOR_INVALID"
        );
        Ok(bytes)
    }
    /// Legacy bytes are authoritative only before this original lock has ever
    /// acquired an archive fence. Nonempty or malformed bytes cannot mean empty.
    pub fn verify_unbound_anchor(lease: &VerifiedPrivateLease) -> Result<()> {
        ensure!(
            read_anchor(lease)?.is_empty(),
            "RECEIPT_ARCHIVE_DOWNGRADE_REJECTED"
        );
        Ok(())
    }
    pub fn verify_bootstrap_anchor(&self, lease: &VerifiedPrivateLease) -> Result<()> {
        let raw = read_anchor(lease)?;
        ensure!(
            raw.is_empty() || raw == self.anchor_bytes()?,
            "RECEIPT_ARCHIVE_BOOTSTRAP_ANCHOR_UNKNOWN"
        );
        Ok(())
    }
    /// The caller holds its original EXCLUSIVE verified namespace lease and
    /// has published the complete exact-seed Bootstrap checkpoint. Partial
    /// prefix writes may be completed; different bytes are never overwritten.
    pub fn prepare_bootstrap_anchor(&self, lease: &VerifiedPrivateLease) -> Result<()> {
        self.append_anchor_prefix(lease, &self.anchor_bytes()?, 0)
    }
    pub fn verify_committed_anchor(&self, lease: &VerifiedPrivateLease) -> Result<()> {
        let base = self.anchor_bytes()?;
        let mut final_bytes = base.clone();
        final_bytes.extend_from_slice(FINAL_SUFFIX);
        let raw = read_anchor(lease)?;
        // The final JSON manifest is published only after the SQL seed commits.
        // A crash during the final suffix can still be observed from that same
        // bound DB, but cannot permit a legacy/Bootstrap fallback.
        ensure!(
            raw.len() >= base.len() && final_bytes.starts_with(&raw),
            "RECEIPT_ARCHIVE_COMMIT_ANCHOR_UNKNOWN"
        );
        Ok(())
    }
    /// The caller holds its original EXCLUSIVE lease and has atomically
    /// published the final manifest. No later SQL mutation precedes this fence.
    pub fn finish_commit_anchor(&self, lease: &VerifiedPrivateLease) -> Result<()> {
        let base = self.anchor_bytes()?;
        let mut final_bytes = base.clone();
        final_bytes.extend_from_slice(FINAL_SUFFIX);
        self.append_anchor_prefix(lease, &final_bytes, base.len())
    }
    fn append_anchor_prefix(
        &self,
        lease: &VerifiedPrivateLease,
        expected: &[u8],
        minimum: usize,
    ) -> Result<()> {
        let raw = read_anchor(lease)?;
        ensure!(
            raw.len() >= minimum && expected.starts_with(&raw),
            "RECEIPT_ARCHIVE_ANCHOR_CONFLICT"
        );
        if raw.len() != expected.len() {
            let mut file = lease.file();
            file.seek(SeekFrom::Start(raw.len() as u64))?;
            file.write_all(&expected[raw.len()..])?;
            file.sync_all()?;
        }
        ensure!(
            read_anchor(lease)? == expected,
            "RECEIPT_ARCHIVE_ANCHOR_UNKNOWN"
        );
        Ok(())
    }
}
