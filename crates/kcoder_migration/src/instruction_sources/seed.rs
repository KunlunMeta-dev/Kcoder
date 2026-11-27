//! A private resolved source intent retains exact metadata, never silently refreshes its bytes.
use super::{grant::RootBinding, model::*, read};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Native-only persisted selection. Public protocols must resolve an opaque catalog handle.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionSourceSeed {
    version: u32,
    root: RootBinding,
    directories: BTreeMap<String, DirectoryObservation>,
    observations: BTreeMap<String, FileObservation>,
    markers: BTreeMap<String, MarkerObservation>,
    source_paths: Vec<String>,
    candidates: Vec<Candidate>,
    complete_launch_chain: bool,
    dynamic_scope_present: bool,
}
impl InstructionSourceSeed {
    pub(crate) fn capture(snapshot: &InstructionSourceSnapshot) -> Result<Self> {
        snapshot.validate_payload()?;
        ensure!(
            snapshot.version == 2,
            "source_transfer_instruction_parser_unsupported"
        );
        let seed = Self {
            version: 2,
            root: snapshot.root.physical()?.clone(),
            directories: snapshot.directories.clone(),
            observations: snapshot.observations.clone(),
            markers: snapshot.markers.clone(),
            source_paths: snapshot
                .sources
                .iter()
                .map(|s| s.relative.clone())
                .collect(),
            candidates: snapshot.candidates.clone(),
            complete_launch_chain: snapshot.complete_launch_chain,
            dynamic_scope_present: snapshot.dynamic_scope_present,
        };
        seed.validate()?;
        Ok(seed)
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 2
                && !self.source_paths.is_empty()
                && self.source_paths.len() <= MAX_FILES
                && self.candidates.len() <= MAX_FILES
                && self.directories.len() <= MAX_DIRECTORIES
                && self.markers.len() <= 1024
                && self.observations.len() <= MAX_ENTRIES,
            "source_transfer_instruction_seed_invalid"
        );
        let mut paths = BTreeSet::new();
        let mut total = 0u64;
        for path in &self.source_paths {
            read::parts(path)?;
            ensure!(
                paths.insert(path),
                "source_transfer_instruction_seed_invalid"
            );
            let observation = self
                .observations
                .get(path)
                .ok_or_else(|| anyhow::anyhow!("source_transfer_instruction_seed_invalid"))?;
            ensure!(
                observation.relative == *path
                    && observation.identity.is_some()
                    && observation.bytes <= MAX_FILE_BYTES as u64
                    && observation
                        .sha256
                        .as_ref()
                        .is_some_and(|hash| hash.len() == 64
                            && hash
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
                "source_transfer_instruction_seed_invalid"
            );
            total = total
                .checked_add(observation.bytes)
                .ok_or_else(|| anyhow::anyhow!("source_transfer_instruction_seed_invalid"))?;
        }
        ensure!(
            total <= MAX_BYTES as u64
                && self
                    .candidates
                    .iter()
                    .all(|candidate| paths.contains(&candidate.relative_path)),
            "source_transfer_instruction_seed_invalid"
        );
        let mut metadata = 0usize;
        for (path, observation) in &self.observations {
            read::parts(path)?;
            ensure!(
                path == &observation.relative,
                "source_transfer_instruction_seed_invalid"
            );
            metadata = metadata.saturating_add(2 * path.len() + 256);
        }
        for (path, marker) in &self.markers {
            read::parts(path)?;
            ensure!(
                path == &marker.relative,
                "source_transfer_instruction_seed_invalid"
            );
            metadata = metadata.saturating_add(2 * path.len() + 256);
        }
        ensure!(
            metadata <= MAX_METADATA_BYTES,
            "source_transfer_instruction_seed_invalid"
        );
        for (path, directory) in &self.directories {
            read::parts(path)?;
            ensure!(
                path == &directory.relative,
                "source_transfer_instruction_seed_invalid"
            );
        }
        Ok(())
    }
    pub(crate) fn reopen(
        &self,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<InstructionSourceSnapshot> {
        self.validate()?;
        self.root.verify()?;
        let mut directories = BTreeMap::new();
        let mut sources = Vec::new();
        let mut total = 0u64;
        for path in &self.source_paths {
            ensure!(check(total), "source_transfer_cancelled");
            let (actual, source) = read::read(&self.root, path, &mut directories, &mut check)?;
            ensure!(
                self.observations.get(path) == Some(&actual),
                "migration_instruction_source_changed"
            );
            total = total
                .checked_add(actual.bytes)
                .ok_or_else(|| anyhow::anyhow!("source_transfer_instruction_seed_invalid"))?;
            ensure!(
                total <= MAX_BYTES as u64,
                "source_transfer_instruction_seed_invalid"
            );
            sources.push(
                source.ok_or_else(|| anyhow::anyhow!("migration_instruction_source_changed"))?,
            );
        }
        let snapshot = InstructionSourceSnapshot {
            version: 2,
            root: self.root.clone().into(),
            directories: self.directories.clone(),
            observations: self.observations.clone(),
            markers: self.markers.clone(),
            sources,
            candidates: self.candidates.clone(),
            complete_launch_chain: self.complete_launch_chain,
            dynamic_scope_present: self.dynamic_scope_present,
        };
        snapshot.verify_source(check)?;
        Ok(snapshot)
    }
}
