//! A private draft binds selectors and explicit source roots; Native receipts remain authoritative.
use anyhow::{Result, ensure};
use kcoder_app_protocol::{
    MigrationSourceAdoptionSelection, MigrationSourceSelectionV1, MigrationSourceSessionParams,
    MigrationSourceSessionPurpose,
};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

const LIMIT: usize = 256 * 1024;
#[cfg(test)]
#[path = "record/tests.rs"]
pub(super) mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Draft {
    pub version: u32,
    pub gateway: String,
    pub source_scope: String,
    pub target_scope: String,
    pub source_principal: Option<String>,
    pub target_principal: Option<String>,
    pub include_project: bool,
    pub include_history: bool,
    pub source_kind: kcoder_types::migration::MigrationSourceKind,
    pub source: MigrationSourceSessionParams,
    pub target: MigrationSourceSessionParams,
    pub recovery: MigrationSourceSessionParams,
    pub request_id: String,
    pub attempt_id: String,
    pub adoption_id: String,
    pub selections: Vec<MigrationSourceSelectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_views: Option<SourceViews>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction_capture: Option<super::instructions::Capture>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instruction_mappings: Vec<kcoder_app_protocol::MigrationSourceInstructionMapping>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub resource_increases:
        std::collections::BTreeMap<String, kcoder_app_protocol::MigrationResourceIncreaseParams>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_credentials: Option<super::private::Journal>,
    pub copy_prepared: bool,
    pub resume: Option<kcoder_app_protocol::MigrationSourceTransferResume>,
    pub cancel_command_id: Option<String>,
    pub target_finish_attempt: Option<String>,
    pub target_cancel_id: Option<String>,
    pub target_resume: Option<kcoder_app_protocol::MigrationSourceTransferTargetResumeParams>,
    pub manifest_sha256: Option<String>,
    pub adoption_selections: Option<Vec<MigrationSourceAdoptionSelection>>,
    pub adoption_prepared: bool,
    pub adoption_resume: Option<kcoder_app_protocol::MigrationSourceAdoptionControl>,
    pub adoption_cancel_id: Option<String>,
    pub selected_job: Option<String>,
    pub batch_operations:
        std::collections::BTreeMap<String, kcoder_app_protocol::MigrationBatchRunParams>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceViews {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<DirectoryChoice>,
    pub directory_decided: bool,
    pub discovery_started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_layers: Option<LayerChoice>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DirectoryChoice {
    pub params: kcoder_app_protocol::MigrationSourceDirectorySelectParams,
    pub confirmed: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LayerChoice {
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<kcoder_app_protocol::MigrationCodexLayersSelectResult>,
}
impl Draft {
    pub fn validate(&self) -> Result<()> {
        let uuid = |id: &str| {
            uuid::Uuid::parse_str(id).is_ok_and(|value| {
                value.to_string() == id
                    && (1..=8).contains(&value.get_version_num())
                    && value.get_variant() == uuid::Variant::RFC4122
            })
        };
        ensure!(
            self.version == 1
                && uuid(&self.request_id)
                && uuid(&self.attempt_id)
                && uuid(&self.adoption_id),
            "migration_transfer_record_invalid"
        );
        ensure!(
            [
                &self.cancel_command_id,
                &self.target_finish_attempt,
                &self.target_cancel_id,
                &self.adoption_cancel_id
            ]
            .iter()
            .all(|value| value.as_ref().is_none_or(|value| uuid(value)))
                && self.batch_operations.len() <= 4
                && self
                    .batch_operations
                    .iter()
                    .all(|(job, operation)| operation.job_id == *job
                        && job.len() == 36
                        && job.starts_with("mig-")
                        && job[4..]
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        && uuid(&operation.request_id)),
            "migration_transfer_record_invalid"
        );
        ensure!(
            [&self.source, &self.target, &self.recovery]
                .iter()
                .all(|s| uuid(&s.session_id)
                    && !s.target_id.is_empty()
                    && s.target_id.len() <= 64
                    && s.target_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                    && s.workspace_path
                        .as_ref()
                        .is_none_or(|p| p.len() <= 4096 && !p.chars().any(char::is_control)))
                && [&self.source_scope, &self.target_scope]
                    .iter()
                    .all(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())),
            "migration_transfer_record_invalid"
        );
        ensure!(
            self.source.purpose == MigrationSourceSessionPurpose::Source
                && self.target.purpose == MigrationSourceSessionPurpose::Target
                && self.recovery.purpose == MigrationSourceSessionPurpose::TargetRecovery
                && self.target.target_id == self.recovery.target_id
                && self.target.workspace_path == self.recovery.workspace_path,
            "migration_transfer_record_invalid"
        );
        ensure!(
            self.selections.len() <= 64
                && self
                    .selections
                    .iter()
                    .all(MigrationSourceSelectionV1::valid),
            "migration_transfer_record_invalid"
        );
        let selections = self
            .selections
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        ensure!(
            selections.len() == self.selections.len()
                && (!self.copy_prepared || !self.selections.is_empty()),
            "migration_transfer_record_invalid"
        );
        if let Some(views) = &self.source_views {
            ensure!(
                uuid(&views.session_id)
                    && (views.session_id == self.source.session_id || self.copy_prepared),
                "migration_transfer_record_invalid"
            );
            if let Some(directory) = &views.requested_directory {
                ensure!(
                    !directory.trim().is_empty()
                        && directory.len() <= 4096
                        && !directory.chars().any(char::is_control),
                    "migration_transfer_record_invalid"
                );
            }
            if let Some(directory) = &views.directory {
                // Reuse the exact wire decoder rather than accepting a weaker private form.
                let parsed: kcoder_app_protocol::MigrationSourceDirectorySelectParams =
                    serde_json::from_value(serde_json::to_value(&directory.params)?)
                        .map_err(|_| anyhow::anyhow!("migration_transfer_record_invalid"))?;
                ensure!(
                    parsed.source == self.source_kind
                        && views.directory_decided
                        && views.requested_directory.as_ref() == Some(&parsed.directory),
                    "migration_transfer_record_invalid"
                );
            }
            ensure!(
                !views.directory_decided
                    || views.requested_directory.is_none()
                    || views.directory.is_some(),
                "migration_transfer_record_invalid"
            );
            if let Some(layers) = &views.codex_layers {
                let bounded = |id: &str| {
                    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
                };
                ensure!(
                    self.source_kind == kcoder_types::migration::MigrationSourceKind::Codex
                        && views.discovery_started
                        && self.include_project
                        && bounded(&layers.source_id),
                    "migration_transfer_record_invalid"
                );
                if let Some(result) = &layers.result {
                    ensure!(
                        result.source.kind == self.source_kind
                            && result.source.scope == "codex-project-layers"
                            && bounded(&result.source.source_id)
                            && result.replaces_source_ids.len() <= 1024
                            && result.replaces_source_ids.iter().all(|id| bounded(id)),
                        "migration_transfer_record_invalid"
                    );
                }
            }
        }
        ensure!(
            self.resource_increases.len() <= 4
                && self
                    .resource_increases
                    .iter()
                    .all(|(job, params)| job == &params.job_id
                        && job.len() == 36
                        && job.starts_with("mig-")
                        && job[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
                        && uuid(&params.request_id)
                        && params.confirm
                        && params.limits.is_supported()
                        && !params.plan_id.is_empty()
                        && params.plan_id.len() <= 256
                        && !params.plan_id.chars().any(char::is_control)),
            "migration_transfer_record_invalid"
        );
        if let Some(private) = &self.private_credentials {
            private.validate(self)?;
        }
        if let Some(capture) = &self.instruction_capture {
            let parsed: kcoder_app_protocol::MigrationInstructionCaptureParams =
                serde_json::from_value(serde_json::to_value(&capture.params)?)
                    .map_err(|_| anyhow::anyhow!("migration_transfer_record_invalid"))?;
            ensure!(
                uuid(&capture.session_id)
                    && (capture.session_id == self.source.session_id || self.copy_prepared)
                    && parsed.source == self.source_kind,
                "migration_transfer_record_invalid"
            );
        }
        ensure!(
            self.instruction_mappings.len() <= 64,
            "migration_transfer_record_invalid"
        );
        let mut entries = BTreeSet::new();
        for mapping in &self.instruction_mappings {
            let _: kcoder_app_protocol::MigrationSourceInstructionMapping =
                serde_json::from_value(serde_json::to_value(mapping)?)
                    .map_err(|_| anyhow::anyhow!("migration_transfer_record_invalid"))?;
            ensure!(entries.insert(&mapping.entry_id) && self.adoption_selections.as_ref().is_some_and(|selected| selected.iter().any(|row| row.entry_id == mapping.entry_id && row.project_mapping == Some(kcoder_app_protocol::MigrationSourceProjectMapping::CurrentWorkspace))), "migration_transfer_record_invalid");
        }
        ensure!(
            self.manifest_sha256
                .as_ref()
                .is_none_or(|value| value.len() == 64
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
            "migration_transfer_record_invalid"
        );
        if let Some(selected) = &self.adoption_selections {
            ensure!(
                !selected.is_empty()
                    && selected.len() <= 64
                    && selected
                        .iter()
                        .map(|v| &v.entry_id)
                        .collect::<BTreeSet<_>>()
                        .len()
                        == selected.len(),
                "migration_transfer_record_invalid"
            );
        }
        ensure!(
            !self.adoption_prepared
                || self.manifest_sha256.is_some() && self.adoption_selections.is_some(),
            "migration_transfer_record_invalid"
        );
        ensure!(
            self.selected_job.as_ref().is_none_or(|id| id.len() == 36
                && id.starts_with("mig-")
                && id[4..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
            "migration_transfer_record_invalid"
        );
        Ok(())
    }
}

pub(super) struct Store {
    parent: PathBuf,
    directory: PrivateDirectory,
    directory_identity: String,
    name: OsString,
    lock_name: OsString,
    lock: File,
    lock_identity: PortableLeaseIdentity,
    digest: Option<[u8; 32]>,
}
impl Store {
    pub fn open(path: &Path, cwd: Option<&Path>) -> Result<(Self, Option<Draft>)> {
        let path = crate::migration_cli::absolute(path, cwd)?;
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("migration_transfer_record_unavailable"))?
            .to_owned();
        let name = path
            .file_name()
            .filter(|name| {
                name.to_str()
                    .is_some_and(|value| !value.is_empty() && value.len() <= 160)
            })
            .ok_or_else(|| anyhow::anyhow!("migration_transfer_record_unavailable"))?
            .to_owned();
        let lock_name = OsString::from(format!(".{}.lock", name.to_str().unwrap()));
        let directory = PrivateDirectory::open_existing(&parent)
            .map_err(|_| anyhow::anyhow!("migration_transfer_record_unavailable"))?;
        directory
            .verify_private_directory()
            .map_err(|_| anyhow::anyhow!("migration_transfer_record_unavailable"))?;
        let directory_identity = directory.directory_identity()?;
        let lock = directory
            .try_exclusive_lock(&lock_name)
            .map_err(|_| anyhow::anyhow!("migration_transfer_record_unavailable"))?
            .ok_or_else(|| anyhow::anyhow!("migration_transfer_record_busy"))?;
        let lock_identity = directory.portable_regular_handle_identity(&lock)?;
        let bytes = read(&directory, &name)?;
        let draft = bytes
            .as_ref()
            .map(|bytes| {
                serde_json::from_slice::<Draft>(bytes)
                    .map_err(|_| anyhow::anyhow!("migration_transfer_record_invalid"))
            })
            .transpose()?;
        if let Some(draft) = &draft {
            draft.validate()?;
        }
        let digest = bytes.map(|bytes| Sha256::digest(bytes).into());
        Ok((
            Self {
                parent,
                directory,
                directory_identity,
                name,
                lock_name,
                lock,
                lock_identity,
                digest,
            },
            draft,
        ))
    }
    fn verify(&self) -> Result<()> {
        let directory = PrivateDirectory::open_existing(&self.parent)
            .map_err(|_| anyhow::anyhow!("migration_transfer_record_owner_changed"))?;
        ensure!(
            directory.directory_identity()? == self.directory_identity
                && self.directory.portable_regular_identity(&self.lock_name)? == self.lock_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.lock)?
                    == self.lock_identity,
            "migration_transfer_record_owner_changed"
        );
        Ok(())
    }
    pub fn save(&mut self, draft: &Draft) -> Result<()> {
        draft.validate()?;
        self.verify()?;
        let bytes = serde_json::to_vec(draft)?;
        ensure!(
            bytes.len() <= LIMIT,
            "migration_transfer_record_budget_exceeded"
        );
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        self.directory
            .atomic_publish_from_reader(
                &self.name,
                &mut Cursor::new(&bytes),
                self.digest.is_some(),
                || {
                    self.verify()?;
                    let current = read(&self.directory, &self.name)?
                        .map(|value| <[u8; 32]>::from(Sha256::digest(value)));
                    ensure!(current == self.digest, "migration_transfer_record_changed");
                    Ok(None)
                },
            )
            .map_err(|_| anyhow::anyhow!("migration_transfer_record_changed_read_original"))?;
        self.digest = Some(digest);
        Ok(())
    }
}
fn read(directory: &PrivateDirectory, name: &std::ffi::OsStr) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(name) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(_) => anyhow::bail!("migration_transfer_record_unavailable"),
    };
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("migration_transfer_record_unavailable"))?;
    ensure!(
        bytes.len() <= LIMIT,
        "migration_transfer_record_budget_exceeded"
    );
    Ok(Some(bytes))
}
