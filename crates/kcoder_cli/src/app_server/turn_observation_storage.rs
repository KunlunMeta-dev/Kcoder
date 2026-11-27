//! Bounded private storage for turn observation families under the existing journal.
use crate::{
    error_is_not_found,
    private_files::{ensure_private_artifact_directory, write_private_artifact_file},
};
use anyhow::{Context, Result, ensure};
use kcoder_cli_storage::transcript_artifact_journal;
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_workspace_resources::managed_worktrees::{valid_artifact_id, validate_thread_id};
use kcoder_workspace_resources::snapshots::snapshot_leases;
use std::ffi::OsStr;
use std::path::PathBuf;

pub const MAX_OBSERVATION_FAMILY_BYTES: usize = 32 * 1024 * 1024;

pub struct TurnObservationStorage {
    pub directory: PathBuf,
    pub thread: String,
    kind: transcript_artifact_journal::Kind,
    _lease: std::fs::File,
}

impl TurnObservationStorage {
    pub fn open(
        engine: &QueryEngine,
        family: &str,
        kind: transcript_artifact_journal::Kind,
    ) -> Result<Self> {
        ensure!(
            matches!(family, "turn-file-captures" | "turn-review-evidence"),
            "invalid observation family"
        );
        let thread = engine.session_id();
        validate_thread_id(&thread)?;
        let parent = engine.session_storage_dir_for(&thread);
        ensure_private_artifact_directory(&parent)?;
        let lease = snapshot_leases::active(&parent)?;
        let directory = parent.join(family);
        ensure_private_artifact_directory(&directory)?;
        Ok(Self {
            directory,
            thread,
            kind,
            _lease: lease,
        })
    }

    pub fn write(&self, id: &str, bytes: &[u8], limit: usize) -> Result<()> {
        ensure!(
            valid_artifact_id(id) && bytes.len() <= limit,
            "observation record exceeds bounds"
        );
        transcript_artifact_journal::write_after_preflight(
            &self.directory,
            &self.thread,
            self.kind,
            || {
                let directory = PrivateDirectory::open_existing(&self.directory)?;
                let name = format!("{id}.json");
                let existing = match directory.open_regular_file(OsStr::new(&name)) {
                    Ok(_) => true,
                    Err(error) if error_is_not_found(&error) => false,
                    Err(error) => return Err(error),
                };
                let mut count = 0usize;
                let mut total = bytes.len() as u64;
                directory.visit_entry_names_bounded(8192, |entry| {
                    if entry.to_str().is_some_and(|n| n.ends_with(".json")) {
                        count += 1;
                        if entry != OsStr::new(&name) {
                            total = total
                                .checked_add(directory.open_regular_file(entry)?.metadata()?.len())
                                .context("observation byte overflow")?;
                        }
                    }
                    Ok(())
                })?;
                ensure!(existing || count < 4096, "observation capacity reached");
                ensure!(
                    total <= MAX_OBSERVATION_FAMILY_BYTES as u64,
                    "observation family exceeds byte budget"
                );
                Ok(())
            },
            || write_private_artifact_file(&self.directory.join(format!("{id}.json")), bytes),
        )
    }
}
