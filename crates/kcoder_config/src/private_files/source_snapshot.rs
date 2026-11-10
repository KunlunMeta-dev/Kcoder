//! A bounded same-descriptor source document read. Contents remain transient and private.
use super::{
    PrivateDirectory,
    sqlite_source::{mutation_stamp, safe_leaf},
};
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Read, Seek, SeekFrom},
};
use zeroize::Zeroizing;

pub struct SourceDocumentSnapshot {
    bytes: Zeroizing<Vec<u8>>,
    pub sha256: String,
    pub identity_sha256: String,
}
impl SourceDocumentSnapshot {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl PrivateDirectory {
    /// The Native caller authorizes this directory and known leaf. No path in the document is opened.
    pub fn read_source_document_snapshot(
        &self,
        name: &OsStr,
        maximum: u64,
        mut check: impl FnMut() -> bool,
    ) -> Result<SourceDocumentSnapshot> {
        ensure!(
            maximum > 0 && maximum <= 8 * 1024 * 1024,
            "source_document_invalid_budget"
        );
        self.verify_trusted_config_directory()?;
        let mut file = self.open_single_link_regular_file(name)?;
        let identity = safe_leaf(&file)?;
        let stamp = mutation_stamp(&file)?;
        let length = file.metadata()?.len();
        ensure!(length <= maximum, "source_document_budget_exceeded");
        let mut bytes = Zeroizing::new(Vec::new());
        let mut block = Zeroizing::new([0; 128 * 1024]);
        loop {
            ensure!(check(), "source_document_cancelled");
            let limit = usize::try_from((maximum + 1 - bytes.len() as u64).min(block.len() as u64))
                .map_err(|_| anyhow::anyhow!("source_document_budget_exceeded"))?;
            let count = file.read(&mut block[..limit])?;
            if count == 0 {
                break;
            }
            ensure!(
                bytes.len() as u64 + count as u64 <= maximum,
                "source_document_budget_exceeded"
            );
            bytes.extend_from_slice(&block[..count]);
        }
        ensure!(
            safe_leaf(&file)? == identity
                && mutation_stamp(&file)? == stamp
                && bytes.len() as u64 == length,
            "source_document_changed"
        );
        // Filesystem timestamps can remain unchanged within one clock tick.
        // Recheck the actual bytes through the original descriptor before
        // publishing a snapshot, without trusting a restored modification time.
        file.seek(SeekFrom::Start(0))?;
        let mut verified = 0;
        while verified < bytes.len() {
            ensure!(check(), "source_document_cancelled");
            let limit = (bytes.len() - verified).min(block.len());
            let count = file.read(&mut block[..limit])?;
            ensure!(
                count > 0 && bytes[verified..verified + count] == block[..count],
                "source_document_changed"
            );
            verified += count;
        }
        ensure!(check(), "source_document_cancelled");
        ensure!(
            file.read(&mut block[..1])? == 0
                && safe_leaf(&file)? == identity
                && mutation_stamp(&file)? == stamp,
            "source_document_changed"
        );
        let current = self.open_single_link_regular_file(name)?;
        ensure!(
            safe_leaf(&current)? == identity
                && mutation_stamp(&current)? == stamp
                && current.metadata()?.len() == length,
            "source_document_changed"
        );
        let identity_sha256 = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "kcoder-project-document/1",
                self.directory_identity()?,
                identity,
                stamp,
                length
            ))?)
        );
        Ok(SourceDocumentSnapshot {
            sha256: format!("{:x}", Sha256::digest(&*bytes)),
            identity_sha256,
            bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_same_descriptor_bytes_have_a_stable_private_identity_without_source_changes() {
        let root = tempfile::tempdir().unwrap();
        crate::set_user_only_dir_permissions(root.path()).unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        directory
            .atomic_replace(OsStr::new(".claude.json"), b"{\"projects\":{}}")
            .unwrap();
        let first = directory
            .read_source_document_snapshot(OsStr::new(".claude.json"), 1024, || true)
            .unwrap();
        let second = directory
            .read_source_document_snapshot(OsStr::new(".claude.json"), 1024, || true)
            .unwrap();
        assert_eq!(first.bytes(), b"{\"projects\":{}}");
        assert_eq!(first.sha256, format!("{:x}", Sha256::digest(first.bytes())));
        assert_eq!(first.identity_sha256, second.identity_sha256);
        assert_eq!(
            std::fs::read(root.path().join(".claude.json")).unwrap(),
            first.bytes()
        );
    }
    #[test]
    fn same_size_and_restored_time_mutations_during_the_read_are_rejected() {
        use std::io::Write;
        let root = tempfile::tempdir().unwrap();
        crate::set_user_only_dir_permissions(root.path()).unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        directory
            .atomic_replace(OsStr::new(".claude.json"), &[b'a'; 256 * 1024])
            .unwrap();
        let path = root.path().join(".claude.json");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let mut calls = 0;
        assert!(
            directory
                .read_source_document_snapshot(OsStr::new(".claude.json"), 512 * 1024, || {
                    calls += 1;
                    if calls == 2 {
                        let mut raw = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
                        raw.write_all(&[b'b'; 256 * 1024]).unwrap();
                        raw.set_times(std::fs::FileTimes::new().set_modified(modified))
                            .unwrap();
                    }
                    true
                })
                .is_err()
        );
    }
    #[test]
    fn cancellation_and_budgets_do_not_produce_partial_snapshots() {
        let root = tempfile::tempdir().unwrap();
        crate::set_user_only_dir_permissions(root.path()).unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        directory
            .atomic_replace(OsStr::new(".claude.json"), b"{}")
            .unwrap();
        assert!(
            directory
                .read_source_document_snapshot(OsStr::new(".claude.json"), 1024, || false)
                .is_err()
        );
        assert!(
            directory
                .read_source_document_snapshot(OsStr::new(".claude.json"), 1, || true)
                .is_err()
        );
        assert_eq!(
            std::fs::read(root.path().join(".claude.json")).unwrap(),
            b"{}"
        );
    }
}
