//! Remember the latest accepted recipe; immutable view receipts remain separate and reusable.
use super::*;
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    time::{Duration, Instant},
};
mod managed;

const CHOICE_LOCK_WAIT: Duration = Duration::from_secs(30);

fn lock_choices(directory: &PrivateDirectory) -> Result<File> {
    let deadline = Instant::now() + CHOICE_LOCK_WAIT;
    loop {
        if let Some(lease) = directory.try_exclusive_lock(OsStr::new("choices.lock"))? {
            return Ok(lease);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        ensure!(!remaining.is_zero(), "history_branch_choices_busy");
        // Only wait for the original lease; no choice or archive write is retried.
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Choice {
    version: u32,
    owner: String,
    root_archive: String,
    choice: HistoricalBranchChoice,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(default, skip_serializing_if = "not_retired")]
    retired: bool,
}
fn not_retired(value: &bool) -> bool {
    !*value
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
impl HistoryBranchStore {
    fn choices(&self, create: bool) -> Result<Option<PrivateDirectory>> {
        self.profile.verify_trusted_config_directory()?;
        let parent = self.profile.open_child(OsStr::new("migrations"), false)?;
        parent.verify_private_directory()?;
        let directory = match parent.open_child(OsStr::new("branch-selections"), create) {
            Ok(directory) => directory,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        Ok(Some(directory))
    }
    pub(super) fn remember(
        &self,
        job: &str,
        archive: &str,
        choice: &HistoricalBranchChoice,
    ) -> Result<()> {
        let directory = self
            .choices(true)?
            .context("history_branch_choices_unavailable")?;
        let _lease = lock_choices(&directory)?;
        let operation = self.remember_managed(&directory, job, archive, choice)?;
        let value = Choice {
            version: if operation.is_some() { 2 } else { 1 },
            owner: self.archives.scope_fingerprint()?,
            root_archive: archive.into(),
            choice: choice.clone(),
            operation,
            retired: false,
        };
        let bytes = serde_json::to_vec(&value)?;
        ensure!(
            bytes.len() <= 16 * 1024,
            "history_branch_choices_budget_exceeded"
        );
        directory.atomic_replace(OsStr::new(&format!("{job}.json")), &bytes)
    }
    pub fn last_choice(&self, job: &str) -> Result<Option<HistoricalBranchChoice>> {
        let (_, root, _) = self.source(job)?;
        let Some(directory) = self.choices(false)? else {
            return Ok(None);
        };
        let file = match directory.open_single_link_regular_file(OsStr::new(&format!("{job}.json")))
        {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.len() <= 16 * 1024,
            "history_branch_choices_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(16 * 1024 + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= 16 * 1024,
            "history_branch_choices_budget_exceeded"
        );
        let value: Choice = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_branch_choices_invalid"))?;
        ensure!(
            matches!(value.version, 1 | 2)
                && value.owner == self.archives.scope_fingerprint()?
                && value.root_archive == root.archive_id,
            "history_branch_choices_changed"
        );
        if value.retired {
            return Ok(None);
        }
        if value.version == 2 {
            self.verify_managed_choice(&directory, job, &value)?;
        }
        self.validate(job, &value.choice.view_id)?;
        Ok(Some(value.choice))
    }
}
