//! Private Host intents retain exact Native grants; public selectors never grant a path.
use super::{model::*, source::ExportSelection, storage::*};
use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, VerifiedPrivateLease};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TransferSelector {
    Projects {
        catalog_id: String,
        source_handle: String,
    },
    Instructions {
        capture_id: String,
    },
    Plugin {
        candidate_id: String,
    },
    Configuration {
        source_id: String,
    },
    Assets {
        source_id: String,
    },
    History {
        catalog_id: String,
        source_handle: String,
    },
}
impl TransferSelector {
    fn validate(&self) -> Result<()> {
        let atom = |value: &str| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        };
        ensure!(
            match self {
                Self::Instructions { capture_id } =>
                    uuid::Uuid::parse_str(capture_id).is_ok_and(|id| id.to_string() == *capture_id),
                Self::Projects {
                    catalog_id,
                    source_handle,
                } => atom(catalog_id) && atom(source_handle),
                Self::Plugin { candidate_id } => atom(candidate_id),
                Self::Configuration { source_id } | Self::Assets { source_id } => atom(source_id),
                Self::History {
                    catalog_id,
                    source_handle,
                } => atom(catalog_id) && atom(source_handle),
            },
            "source_transfer_invalid_selection"
        );
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ResolvedTransferSelection {
    Project {
        binding: crate::project_migration::ProjectBatchSource,
    },
    Instructions {
        binding: super::source::InstructionExportBinding,
    },
    Plugin {
        selection: crate::plugin_migration::PluginExportSelection,
    },
    Configuration {
        binding: crate::discovery::ConfigurationBinding,
    },
    Asset {
        binding: crate::asset_sources::AssetBundleBinding,
        key: String,
    },
    History {
        selection: crate::history_discovery::HistoryPendingSelection,
    },
}
impl ResolvedTransferSelection {
    pub fn export(&self) -> ExportSelection {
        match self {
            Self::Instructions { binding } => ExportSelection::Instructions(binding.export()),
            Self::Project { binding } => ExportSelection::Project(binding.clone()),
            Self::Plugin { selection } => ExportSelection::Plugin(selection.clone()),
            Self::Configuration { binding } => ExportSelection::Configuration(binding.clone()),
            Self::Asset { binding, key } => ExportSelection::Asset {
                binding: binding.clone(),
                key: key.clone(),
            },
            Self::History { selection } => ExportSelection::History(selection.clone()),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    source: TransferAuthority,
    destination: TransferDestination,
    selectors: Vec<TransferSelector>,
    selection_digest: String,
    bindings: Option<Vec<ResolvedTransferSelection>>,
    capture: CaptureObservation,
}
impl Intent {
    fn binding(&self) -> Result<String> {
        digest(&(
            &self.source,
            &self.destination,
            &self.selectors,
            &self.selection_digest,
        ))
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureObservation {
    pub status: String,
    pub error_code: Option<String>,
}
impl CaptureObservation {
    fn new(status: &str, error: Option<&str>) -> Self {
        Self {
            status: status.into(),
            error_code: error.map(str::to_owned),
        }
    }
}

pub struct SourceTransferIntents {
    store: Store,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelMirror {
    command_id: String,
    host_watermark: u64,
    snapshot_watermark: Option<u64>,
}
impl SourceTransferIntents {
    pub fn open(profile: &Path) -> Result<Self> {
        Ok(Self {
            store: Store::open(profile, "host-source")?,
        })
    }
    fn read_at(&self, request: &str) -> Result<(PrivateDirectory, Intent)> {
        let directory = self.store.existing(request)?;
        let intent = self.read_in_directory(request, &directory)?;
        Ok((directory, intent))
    }
    fn read_in_directory(&self, request: &str, directory: &PrivateDirectory) -> Result<Intent> {
        let intent: Intent =
            load(directory, "intent.json")?.context("source_transfer_recovery_required")?;
        ensure!(
            intent.source == self.store.authority && intent.destination.grant_id == request,
            "source_transfer_authority_changed"
        );
        let anchor: Anchor =
            load(directory, "binding.json")?.context("source_transfer_recovery_required")?;
        ensure!(
            anchor.binding == intent.binding()?,
            "source_transfer_request_changed"
        );
        Ok(intent)
    }
    pub fn exists(&self, request: &str) -> Result<bool> {
        self.store.has_operation(request)
    }
    pub fn destination(
        &self,
        request: &str,
        target: &TransferAuthority,
    ) -> Result<TransferDestination> {
        let (_, intent) = self.read_at(request)?;
        ensure!(
            &intent.destination.authority == target,
            "source_transfer_authority_changed"
        );
        Ok(intent.destination)
    }
    pub fn selectors(&self, request: &str) -> Result<(Vec<TransferSelector>, String)> {
        let (_, intent) = self.read_at(request)?;
        Ok((intent.selectors, intent.selection_digest))
    }
    pub fn prepare(
        &self,
        request: &str,
        destination: &TransferDestination,
        selectors: Vec<TransferSelector>,
        resolve: impl FnOnce() -> Result<Vec<ResolvedTransferSelection>>,
    ) -> Result<Vec<ResolvedTransferSelection>> {
        valid_uuid(request)?;
        destination.authority.validate()?;
        ensure!(
            destination.grant_id == request
                && valid_sha(&destination.scope)
                && !selectors.is_empty()
                && selectors.len() <= 64,
            "source_transfer_invalid_selection"
        );
        let mut seen = std::collections::BTreeSet::new();
        for selector in &selectors {
            selector.validate()?;
            ensure!(
                seen.insert(digest(selector)?),
                "source_transfer_invalid_selection"
            );
        }
        let mut desired = Intent {
            source: self.store.authority.clone(),
            destination: destination.clone(),
            selection_digest: digest(&selectors)?,
            selectors,
            bindings: None,
            capture: CaptureObservation::new("idle", None),
        };
        let existed = self.store.has_operation(request)?;
        let directory = self
            .store
            .operation(request, &desired.binding()?, !existed)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        if existed {
            let (_, old) = self.read_at(request)?;
            ensure!(
                old.binding()? == desired.binding()?,
                "source_transfer_request_changed"
            );
            return old.bindings.context("source_transfer_recovery_required");
        }
        // The accepted public intent survives even if resolution or its reply fails.
        ensure!(
            load::<Intent>(&directory, "intent.json")?.is_none(),
            "source_transfer_recovery_required"
        );
        save(&directory, "intent.json", &desired)?;
        let bindings = match resolve() {
            Ok(bindings) => bindings,
            Err(_) => {
                desired.capture = CaptureObservation::new(
                    "failed",
                    Some("source_transfer_selection_unavailable"),
                );
                save(&directory, "intent.json", &desired)?;
                anyhow::bail!("source_transfer_selection_unavailable");
            }
        };
        ensure!(
            !bindings.is_empty() && bindings.len() <= 1024,
            "source_transfer_budget_exceeded"
        );
        desired.bindings = Some(bindings.clone());
        save(&directory, "intent.json", &desired)?;
        Ok(bindings)
    }
    pub fn bindings(&self, request: &str) -> Result<Vec<ResolvedTransferSelection>> {
        self.read_at(request)?
            .1
            .bindings
            .context("source_transfer_recovery_required")
    }
    pub fn prepare_snapshot<T>(
        &self,
        request: &str,
        prepare: impl FnOnce(&[ResolvedTransferSelection]) -> Result<T>,
    ) -> Result<T> {
        let (directory, mut intent) = self.read_at(request)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        active(&directory)?;
        let result = prepare(
            intent
                .bindings
                .as_deref()
                .context("source_transfer_recovery_required")?,
        );
        if let Err(error) = &result {
            intent.capture = CaptureObservation::new("failed", Some(safe_transfer_error(error)));
            save(&directory, "intent.json", &intent)?;
        }
        result
    }
    pub fn state(&self, request: &str, ready: bool) -> Result<TransferState> {
        Ok(control(&self.read_at(request)?.0)?.state(ready))
    }
    pub fn cancel(&self, request: &str, command: &str) -> Result<TransferState> {
        cancel(&self.read_at(request)?.0, command)
    }
    pub fn mirror_cancellation(
        &self,
        request: &str,
        command: &str,
        mirror: impl FnOnce() -> Result<Option<u64>>,
    ) -> Result<()> {
        valid_uuid(command)?;
        let (directory, _) = self.read_at(request)?;
        let _controller = operation_lease(&directory, "control.lock")?;
        let value = control(&directory)?;
        let host_watermark = value
            .commands
            .iter()
            .position(|id| id == command)
            .context("source_transfer_unknown_cancel_command")? as u64
            + 1;
        if host_watermark <= value.acknowledged {
            return Ok(());
        }
        let mut mirrors: Vec<CancelMirror> =
            load(&directory, "cancel-mirrors.json")?.unwrap_or_default();
        ensure!(mirrors.len() <= 256, "source_transfer_invalid_metadata");
        let position = mirrors.iter().position(|saved| saved.command_id == command);
        let index = if let Some(index) = position {
            ensure!(
                mirrors[index].host_watermark == host_watermark,
                "source_transfer_invalid_metadata"
            );
            index
        } else {
            ensure!(mirrors.len() < 256, "source_transfer_command_limit");
            mirrors.push(CancelMirror {
                command_id: command.into(),
                host_watermark,
                snapshot_watermark: None,
            });
            save(&directory, "cancel-mirrors.json", &mirrors)?;
            mirrors.len() - 1
        };
        let observed = mirror()?;
        if let Some(old) = mirrors[index].snapshot_watermark {
            ensure!(
                observed == Some(old),
                "source_transfer_cancel_mirror_changed"
            );
        }
        mirrors[index].snapshot_watermark = observed;
        save(&directory, "cancel-mirrors.json", &mirrors)
    }
    pub fn active_cancel_commands(&self, request: &str) -> Result<Vec<String>> {
        let value = control(&self.read_at(request)?.0)?;
        Ok(value
            .commands
            .into_iter()
            .skip(value.acknowledged as usize)
            .collect())
    }
    pub fn active(&self, request: &str) -> Result<()> {
        active(&self.read_at(request)?.0)
    }
    pub fn observe(&self, request: &str, ready: bool) -> Result<CaptureObservation> {
        self.observe_after_read(request, ready, || {})
    }
    pub(super) fn observe_after_read(
        &self,
        request: &str,
        ready: bool,
        after_read: impl FnOnce(),
    ) -> Result<CaptureObservation> {
        let (directory, _) = self.read_at(request)?;
        after_read();
        let Some(_writer) = try_operation_lease(&directory, "writer.lock")? else {
            return Ok(CaptureObservation::new("running", None));
        };
        // The writer may have completed after the first read. Never overwrite
        // its terminal receipt with a stale inferred interruption.
        let mut intent = self.read_in_directory(request, &directory)?;
        if ready {
            return Ok(CaptureObservation::new("ready", None));
        }
        if intent.capture.status == "running" {
            intent.capture =
                CaptureObservation::new("interrupted", Some("source_transfer_capture_interrupted"));
            save(&directory, "intent.json", &intent)?;
        }
        Ok(intent.capture)
    }
    pub fn start_capture(&self, request: &str) -> Result<CaptureLease> {
        let (directory, mut intent) = self.read_at(request)?;
        let writer = operation_lease(&directory, "writer.lock")?;
        active(&directory)?;
        ensure!(
            intent.bindings.is_some() && intent.capture.status == "idle",
            "source_transfer_resume_required"
        );
        intent.capture = CaptureObservation::new("running", None);
        save(&directory, "intent.json", &intent)?;
        Ok(CaptureLease {
            directory,
            _writer: writer,
            completed: false,
        })
    }
    pub fn resume(
        &self,
        request: &str,
        sequence: u64,
        watermark: u64,
        resume_child: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let (directory, mut intent) = self.read_at(request)?;
        let _writer = operation_lease(&directory, "writer.lock")?;
        let _controller = operation_lease(&directory, "control.lock")?;
        let mut value = control(&directory)?;
        ensure!(
            value.sequence == sequence && value.cancelled == watermark,
            "source_transfer_revision_conflict"
        );
        ensure!(
            intent.bindings.is_some(),
            "source_transfer_recovery_required"
        );
        resume_child()?;
        value.acknowledged = watermark;
        value.sequence = value
            .sequence
            .checked_add(1)
            .context("source_transfer_revision_exhausted")?;
        save(&directory, "control.json", &value)?;
        intent.capture = CaptureObservation::new("idle", None);
        save(&directory, "intent.json", &intent)
    }
}

pub struct CaptureLease {
    directory: PrivateDirectory,
    _writer: VerifiedPrivateLease,
    completed: bool,
}
impl CaptureLease {
    pub fn complete(mut self, result: Result<()>) -> Result<()> {
        let mut intent: Intent =
            load(&self.directory, "intent.json")?.context("source_transfer_recovery_required")?;
        intent.capture = match result {
            Ok(()) => CaptureObservation::new("ready", None),
            Err(error) => {
                let code = safe_transfer_error(&error);
                CaptureObservation::new(
                    if code == "source_transfer_capture_interrupted" {
                        "interrupted"
                    } else {
                        "failed"
                    },
                    Some(code),
                )
            }
        };
        save(&self.directory, "intent.json", &intent)?;
        self.completed = true;
        Ok(())
    }
}
impl Drop for CaptureLease {
    fn drop(&mut self) {
        if !self.completed
            && let Ok(Some(mut intent)) = load::<Intent>(&self.directory, "intent.json")
        {
            intent.capture =
                CaptureObservation::new("interrupted", Some("source_transfer_capture_interrupted"));
            let _ = save(&self.directory, "intent.json", &intent);
        }
    }
}

pub fn safe_transfer_error(error: &anyhow::Error) -> &'static str {
    if error.chain().any(|error| {
        matches!(
            error.to_string().as_str(),
            "migration_source_changed" | "migration_history_source_changed"
        )
    }) {
        return "source_transfer_source_changed";
    }
    for code in [
        "source_transfer_cancelled",
        "source_transfer_busy",
        "source_transfer_revision_conflict",
        "source_transfer_recovery_required",
        "source_transfer_source_changed",
        "source_transfer_authority_changed",
        "source_transfer_owner_changed",
        "source_transfer_capture_interrupted",
    ] {
        if error.chain().any(|error| error.to_string() == code) {
            return code;
        }
    }
    "source_transfer_capture_failed"
}
