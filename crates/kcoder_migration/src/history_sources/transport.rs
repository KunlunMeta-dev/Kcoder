//! Native transport reads the exact selected physical representation, not a client path.
use super::*;

impl HistorySourceBinding {
    /// The binding must come from an explicitly selected native source. The returned reader
    /// retains the existing root, parent, file, boundary and end-of-stream verification.
    pub fn transport_reader(&self) -> Result<impl Read + '_> {
        ensure!(self.version == 1, "migration_history_unsupported_binding");
        Ok(SnapshotReader {
            binding: self,
            selected: None,
            consumed: 0,
        })
    }

    /// Only a target-owned transport receipt may authorize this private, received path.
    /// The foreign origin remains foreign; relocating bytes does not invent a new rollout ID.
    pub fn bind_transferred_snapshot(
        root: &Path,
        relative: &Path,
        snapshot: &ExternalHistorySnapshot,
        check: &mut impl FnMut(u64, u64) -> bool,
    ) -> Result<Self> {
        ensure!(
            serde_json::to_vec(snapshot)?.len() <= 32 * 1024,
            "migration_history_origin_budget_exceeded"
        );
        let mut selected = open_selected(root, relative)?;
        let physical_bytes = snapshot
            .original
            .as_ref()
            .map_or(snapshot.source_bytes, |source| source.bytes);
        ensure!(
            physical_bytes <= EXTERNAL_HISTORY_MAX_BYTES
                && selected.file.metadata()?.len() == physical_bytes,
            "migration_history_source_changed"
        );
        let (bytes, sha, original) = if snapshot.original.is_some() {
            ensure!(
                encoded::is_zstd(relative),
                "migration_history_encoded_source_requires_decoder"
            );
            encoded::capture(&mut selected.file, physical_bytes, check)?
        } else {
            ensure!(
                !encoded::is_zstd(relative),
                "migration_history_source_changed"
            );
            let mut hash = Sha256::new();
            let mut consumed = 0;
            let mut buffer = [0; 64 * 1024];
            while consumed < physical_bytes {
                ensure!(
                    check(consumed, physical_bytes),
                    "migration_history_cancelled"
                );
                let count = (physical_bytes - consumed).min(buffer.len() as u64) as usize;
                let read = selected.file.read(&mut buffer[..count])?;
                ensure!(read > 0, "migration_history_source_changed");
                consumed += read as u64;
                hash.update(&buffer[..read]);
            }
            (physical_bytes, format!("{:x}", hash.finalize()), None)
        };
        ensure!(
            bytes == snapshot.source_bytes
                && sha == snapshot.source_sha256
                && original == snapshot.original
                && snapshot.record_limit > 0
                && snapshot.record_limit <= EXTERNAL_HISTORY_MAX_RECORDS,
            "migration_history_source_changed"
        );
        ensure!(
            check(physical_bytes, physical_bytes),
            "migration_history_cancelled"
        );
        let binding = Self {
            version: 1,
            root: root.into(),
            relative: relative.into(),
            root_identity: selected.root_identity.clone(),
            parent_identity: selected.parent_identity.clone(),
            file_identity: selected.file_identity.clone(),
            snapshot: snapshot.clone(),
            uploaded_source: None,
        };
        selected.verify(&binding)?;
        Ok(binding)
    }
}
