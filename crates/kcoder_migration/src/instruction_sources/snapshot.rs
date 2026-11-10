//! Immutable previews and live-source verification are different operations.
use super::{model::*, read};
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zeroize::Zeroizing;
impl InstructionSourceSnapshot {
    /// Preview the fixed captured interpretation; this never refreshes a live dependency.
    pub fn compiled_text(&self, id: &str) -> Result<String> {
        self.validate_payload()?;
        let candidate = self
            .candidates
            .iter()
            .find(|candidate| candidate.id == id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        ensure!(
            candidate.disposition == InstructionDisposition::Selected,
            "migration_instruction_semantics_require_review"
        );
        if self.version == 2
            && self.source() == kcoder_types::migration::MigrationSourceKind::ClaudeCode
        {
            return super::format::compile(self, &candidate.relative_path)
                .map(|compiled| compiled.text);
        }
        String::from_utf8(self.original_bytes(id)?.to_vec())
            .map_err(|_| anyhow::anyhow!("migration_instruction_encoding_requires_review"))
    }
    pub fn verify_source(&self, mut check: impl FnMut(u64) -> bool) -> Result<()> {
        self.validate_payload()?;
        if self.root.is_received() {
            return self.root.verify_received(self, check);
        }
        let root = self.root.physical()?;
        root.verify()?;
        let mut current = BTreeMap::new();
        for expected in self.directories.values() {
            let directory = read::open_directory(root, &expected.relative, &mut current)?;
            let identity = directory
                .map(|directory| directory.directory_identity())
                .transpose()?;
            ensure!(
                identity == expected.identity,
                "migration_instruction_source_changed"
            );
        }
        for expected in self.observations.values() {
            let (actual, _) = read::read(root, &expected.relative, &mut current, &mut check)?;
            ensure!(&actual == expected, "migration_instruction_source_changed");
        }
        for expected in self.markers.values() {
            let (parent, name) = expected
                .relative
                .rsplit_once('/')
                .unwrap_or(("", &expected.relative));
            ensure!(
                read::marker(root, parent, name, &mut current)? == *expected,
                "migration_instruction_source_changed"
            );
        }
        root.verify()
    }
    /// The original checked snapshot can be previewed offline without refreshing source authority.
    pub fn original_bytes(&self, id: &str) -> Result<Zeroizing<Vec<u8>>> {
        self.validate_payload()?;
        let item = self
            .candidates
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let source = self
            .sources
            .iter()
            .find(|source| source.relative == item.relative_path)
            .ok_or_else(|| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
        Ok(Zeroizing::new(STANDARD.decode(&source.data).map_err(
            |_| anyhow::anyhow!("migration_instruction_snapshot_invalid"),
        )?))
    }
    pub(super) fn validate_payload(&self) -> Result<()> {
        self.root.validate_shape(self)?;
        ensure!(
            matches!(self.version, 1 | 2)
                && self.candidates.len() <= MAX_FILES
                && self.sources.len() <= MAX_FILES
                && (if self.version == 1 {
                    self.sources.len() == self.candidates.len()
                } else {
                    self.sources.len() >= self.candidates.len()
                })
                && self.directories.len() <= MAX_DIRECTORIES
                && self.markers.len() <= 1024
                && self.observations.len() <= MAX_ENTRIES,
            "migration_instruction_snapshot_invalid"
        );
        let mut metadata = 0usize;
        for (key, record) in &self.observations {
            ensure!(
                key == &record.relative,
                "migration_instruction_snapshot_invalid"
            );
            read::parts(key)?;
            metadata = metadata.saturating_add(2 * key.len() + 256);
        }
        for (key, record) in &self.markers {
            ensure!(
                key == &record.relative,
                "migration_instruction_snapshot_invalid"
            );
            read::parts(key)?;
            metadata = metadata.saturating_add(2 * key.len() + 256);
        }
        ensure!(
            metadata <= MAX_METADATA_BYTES,
            "migration_instruction_snapshot_invalid"
        );
        let mut directories = 0usize;
        for (key, record) in &self.directories {
            ensure!(
                key == &record.relative,
                "migration_instruction_snapshot_invalid"
            );
            read::parts(key)?;
            directories = directories.saturating_add(
                2 * key.len() + record.identity.as_ref().map_or(0, String::len) + 96,
            );
        }
        ensure!(
            directories <= MAX_METADATA_BYTES,
            "migration_instruction_snapshot_invalid"
        );
        let mut total = 0usize;
        let mut ids = std::collections::BTreeSet::new();
        let mut paths = std::collections::BTreeSet::new();
        let mut source_paths = std::collections::BTreeSet::new();
        for source in &self.sources {
            ensure!(
                source_paths.insert(&source.relative),
                "migration_instruction_snapshot_invalid"
            );
        }
        for (index, candidate) in self.candidates.iter().enumerate() {
            ensure!(
                ids.insert(&candidate.id)
                    && paths.insert(&candidate.relative_path)
                    && candidate.rank == index as u32
                    && candidate
                        .reason_code
                        .as_ref()
                        .is_none_or(|code| self.version == 2
                            && code.len() <= 160
                            && code.starts_with("migration_instruction_")
                            && code.bytes().all(|byte| byte.is_ascii_lowercase()
                                || byte.is_ascii_digit()
                                || byte == b'_')),
                "migration_instruction_snapshot_invalid"
            );
            read::parts(&candidate.relative_path)?;
            read::parts(&candidate.relative_scope)?;
            let source = self
                .sources
                .iter()
                .find(|source| source.relative == candidate.relative_path)
                .ok_or_else(|| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
            let observed = self
                .observations
                .get(&candidate.relative_path)
                .ok_or_else(|| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
            ensure!(
                source.data.len() <= MAX_FILE_BYTES.div_ceil(3) * 4,
                "migration_instruction_snapshot_invalid"
            );
            let bytes = Zeroizing::new(
                STANDARD
                    .decode(&source.data)
                    .map_err(|_| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?,
            );
            ensure!(
                bytes.len() <= MAX_FILE_BYTES
                    && (observed.identity.is_some() || self.root.is_received())
                    && observed.bytes == bytes.len() as u64
                    && observed.bytes == candidate.bytes
                    && observed.sha256.as_deref() == Some(&format!("{:x}", Sha256::digest(&bytes))),
                "migration_instruction_snapshot_invalid"
            );
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
        }
        if self.version == 2 {
            for source in &self.sources {
                if paths.contains(&source.relative) {
                    continue;
                }
                read::parts(&source.relative)?;
                ensure!(
                    source.data.len() <= MAX_FILE_BYTES.div_ceil(3) * 4,
                    "migration_instruction_snapshot_invalid"
                );
                let observed = self
                    .observations
                    .get(&source.relative)
                    .ok_or_else(|| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
                let bytes = Zeroizing::new(
                    STANDARD
                        .decode(&source.data)
                        .map_err(|_| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?,
                );
                ensure!(
                    (observed.identity.is_some() || self.root.is_received())
                        && observed.bytes == bytes.len() as u64
                        && bytes.len() <= MAX_FILE_BYTES
                        && observed.sha256.as_deref()
                            == Some(&format!("{:x}", Sha256::digest(&bytes))),
                    "migration_instruction_snapshot_invalid"
                );
                total = total
                    .checked_add(bytes.len())
                    .ok_or_else(|| anyhow::anyhow!("migration_instruction_snapshot_invalid"))?;
            }
        }
        ensure!(total <= MAX_BYTES, "migration_instruction_snapshot_invalid");
        Ok(())
    }
}
