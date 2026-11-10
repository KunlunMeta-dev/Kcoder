//! Owner-bound private bindings; native receipts remain the execution authority.
use super::types::*;
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::integrations::core::{IntegrationOwner, IntegrationScope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Write},
};
const MAX_BINDINGS: usize = 4096;
const MAX_BYTES: usize = 768 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    owner: IntegrationOwner,
    directory_identity: String,
    lock_identity: PortableLeaseIdentity,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialization {
    version: u32,
    owner: IntegrationOwner,
    directory_identity: String,
}
const INITIALIZATION: &str = "runtime-bindings.initialized";
pub struct RuntimeBindings {
    parent: PrivateDirectory,
    initialization_identity: PortableLeaseIdentity,
    initialization_anchor: File,
    directory: PrivateDirectory,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
    anchor: File,
}

/// These outcomes are created only before the binding write starts. An I/O or
/// observation error after atomic_replace is deliberately not retryable here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeBindingPrewriteConflict {
    Busy,
    Stale,
}
impl std::fmt::Display for RuntimeBindingPrewriteConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Busy => "RUNTIME_BINDING_BUSY",
            Self::Stale => "RUNTIME_BINDING_CONFLICT",
        })
    }
}
impl std::error::Error for RuntimeBindingPrewriteConflict {}
impl RuntimeBindings {
    pub fn create(parent: &PrivateDirectory, scope: &IntegrationScope) -> Result<Self> {
        // Create-only intent precedes the directory. A crash never permits reinitialization.
        let mut marker = parent.open_read_write_file(OsStr::new(INITIALIZATION), true)?;
        marker.write_all(b"runtime-binding-initialization-incomplete\n")?;
        marker.sync_all()?;
        parent.sync()?;
        let directory = parent.create_private_child(OsStr::new("runtime-bindings"))?;
        let file = directory.open_read_write_file(OsStr::new("bindings.lock"), true)?;
        let lock_identity = directory.portable_regular_handle_identity(&file)?;
        let owner = IntegrationOwner::from(scope);
        let header = Header {
            version: 1,
            owner: owner.clone(),
            directory_identity: directory.directory_identity()?,
            lock_identity: lock_identity.clone(),
        };
        directory.atomic_replace(OsStr::new("owner.json"), &serde_json::to_vec(&header)?)?;
        parent.atomic_replace(
            OsStr::new(INITIALIZATION),
            &serde_json::to_vec(&Initialization {
                version: 1,
                owner: owner.clone(),
                directory_identity: directory.directory_identity()?,
            })?,
        )?;
        let initialization_anchor =
            parent.open_single_link_regular_file(OsStr::new(INITIALIZATION))?;
        Ok(Self {
            parent: parent.duplicate_handle()?,
            initialization_identity: parent
                .portable_regular_handle_identity(&initialization_anchor)?,
            initialization_anchor,
            directory,
            owner,
            lock_identity,
            anchor: file,
        })
    }
    pub fn open(parent: &PrivateDirectory, scope: &IntegrationScope) -> Result<Option<Self>> {
        let initialized = read(parent, INITIALIZATION)?;
        let entry = match parent.open_entry_handle(OsStr::new("runtime-bindings")) {
            Ok(entry) => entry,
            Err(error) if missing(&error) && initialized.is_none() => return Ok(None),
            Err(error) => return Err(error),
        };
        let directory = entry.open_child_directory()?;
        let initialized: Initialization = serde_json::from_slice(
            &initialized.context("RUNTIME_BINDING_INITIALIZATION_MISSING")?,
        )?;
        ensure!(
            initialized.version == 1
                && initialized.owner == IntegrationOwner::from(scope)
                && initialized.directory_identity == directory.directory_identity()?,
            "RUNTIME_BINDING_INITIALIZATION_CHANGED"
        );
        let header: Header = serde_json::from_slice(
            &read(&directory, "owner.json")?.context("RUNTIME_BINDING_HEADER_MISSING")?,
        )?;
        let anchor = directory.open_single_link_regular_file(OsStr::new("bindings.lock"))?;
        let initialization_anchor =
            parent.open_single_link_regular_file(OsStr::new(INITIALIZATION))?;
        let store = Self {
            parent: parent.duplicate_handle()?,
            initialization_identity: parent
                .portable_regular_handle_identity(&initialization_anchor)?,
            initialization_anchor,
            directory,
            owner: IntegrationOwner::from(scope),
            lock_identity: header.lock_identity,
            anchor,
        };
        store.verify()?;
        Ok(Some(store))
    }
    pub fn owner(&self) -> IntegrationOwner {
        self.owner.clone()
    }

    pub(super) fn verify_directory_entry(&self) -> Result<()> {
        let current = self
            .parent
            .open_entry_handle(OsStr::new("runtime-bindings"))?
            .open_child_directory()?;
        ensure!(
            current.directory_identity()? == self.directory.directory_identity()?,
            "RUNTIME_BINDING_INITIALIZATION_CHANGED"
        );
        Ok(())
    }

    pub fn visit(&self, mut visitor: impl FnMut(&RuntimeBinding) -> Result<()>) -> Result<()> {
        self.verify()?;
        let predicate = |name: &OsStr| name.to_string_lossy().starts_with("binding-");
        ensure!(
            self.directory
                .count_regular_files_bounded(predicate, MAX_BINDINGS + 1)?
                <= MAX_BINDINGS,
            "RUNTIME_BINDING_CAPACITY"
        );
        let mut count = 0;
        self.directory.visit_regular_files(predicate, |name, _| {
            ensure!(count < MAX_BINDINGS, "RUNTIME_BINDING_CAPACITY");
            let name = name.to_str().context("RUNTIME_BINDING_CORRUPT")?;
            let value: RuntimeBinding = serde_json::from_slice(
                &read(&self.directory, name)?.context("RUNTIME_BINDING_MISSING")?,
            )?;
            self.validate(&value)?;
            ensure!(
                leaf(&value.operation_id)? == name,
                "RUNTIME_BINDING_CORRUPT"
            );
            visitor(&value)?;
            count += 1;
            Ok(())
        })?;
        self.verify()?;
        Ok(())
    }
    pub fn verify(&self) -> Result<()> {
        self.parent.verify_private_directory()?;
        let initialized: Initialization = serde_json::from_slice(
            &read(&self.parent, INITIALIZATION)?
                .context("RUNTIME_BINDING_INITIALIZATION_MISSING")?,
        )?;
        ensure!(
            initialized.version == 1
                && initialized.owner == self.owner
                && initialized.directory_identity == self.directory.directory_identity()?
                && self
                    .parent
                    .portable_regular_identity(OsStr::new(INITIALIZATION))?
                    == self.initialization_identity
                && self
                    .parent
                    .portable_regular_handle_identity(&self.initialization_anchor)?
                    == self.initialization_identity,
            "RUNTIME_BINDING_INITIALIZATION_CHANGED"
        );
        self.directory.verify_private_directory()?;
        let header: Header = serde_json::from_slice(
            &read(&self.directory, "owner.json")?.context("RUNTIME_BINDING_HEADER_MISSING")?,
        )?;
        ensure!(
            header.version == 1
                && header.owner == self.owner
                && header.directory_identity == self.directory.directory_identity()?
                && header.lock_identity == self.lock_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new("bindings.lock"))?
                    == self.lock_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.anchor)?
                    == self.lock_identity,
            "RUNTIME_BINDING_OWNER_CHANGED"
        );
        Ok(())
    }
    pub fn get(&self, operation: &str) -> Result<Option<RuntimeBinding>> {
        self.verify()?;
        self.read_binding(operation)
    }

    // The caller checks the held directory at this operation's boundary.
    fn read_binding(&self, operation: &str) -> Result<Option<RuntimeBinding>> {
        let name = leaf(operation)?;
        let Some(bytes) = read(&self.directory, &name)? else {
            return Ok(None);
        };
        let value: RuntimeBinding = serde_json::from_slice(&bytes)?;
        self.validate(&value)?;
        ensure!(value.operation_id == operation, "RUNTIME_BINDING_CORRUPT");
        Ok(Some(value))
    }
    pub fn save(
        &self,
        mut binding: RuntimeBinding,
        expected: Option<u64>,
    ) -> Result<RuntimeBinding> {
        let _lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new("bindings.lock"),
                &self.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or(RuntimeBindingPrewriteConflict::Busy)?;
        self.verify()?;
        let old = self.read_binding(&binding.operation_id)?;
        if old.as_ref().map(|old| old.revision) != expected {
            return Err(RuntimeBindingPrewriteConflict::Stale.into());
        }
        if let Some(old) = old {
            super::child_records::preserve_records(&old, &binding)?;
            ensure!(
                old.intent_sha256 == binding.intent_sha256
                    && old.owner == binding.owner
                    && old.thread_request_id == binding.thread_request_id
                    && old.client_message_id == binding.client_message_id,
                "RUNTIME_BINDING_IMMUTABLE"
            );
            if let Some(accepted) = old.acceptance {
                ensure!(
                    binding.acceptance.as_ref() == Some(&accepted),
                    "RUNTIME_BINDING_ACCEPTANCE_IMMUTABLE"
                );
            }
            if let Some(thread) = old.thread_id {
                ensure!(
                    binding.thread_id.as_ref() == Some(&thread),
                    "RUNTIME_BINDING_THREAD_IMMUTABLE"
                );
            }
            if matches!(
                old.task_state,
                kcoder_types::integrations::core::IntegrationTaskState::Completed
                    | kcoder_types::integrations::core::IntegrationTaskState::Failed
                    | kcoder_types::integrations::core::IntegrationTaskState::Cancelled
            ) {
                ensure!(
                    binding.task_state == old.task_state,
                    "RUNTIME_TERMINAL_OUTCOME_IMMUTABLE"
                );
            }
            if let Some(cancel) = old.cancel_operation {
                ensure!(
                    binding.cancel_operation.as_ref() == Some(&cancel),
                    "RUNTIME_CANCEL_IMMUTABLE"
                );
            }
        } else {
            ensure!(
                self.directory.count_regular_files_bounded(
                    |name| name.to_string_lossy().starts_with("binding-"),
                    MAX_BINDINGS + 1
                )? < MAX_BINDINGS,
                "RUNTIME_BINDING_CAPACITY"
            );
        }
        binding.revision = expected
            .unwrap_or(0)
            .checked_add(1)
            .context("RUNTIME_REVISION_OVERFLOW")?;
        self.validate(&binding)?;
        let bytes = serde_json::to_vec(&binding)?;
        ensure!(bytes.len() <= MAX_BYTES, "RUNTIME_BINDING_TOO_LARGE");
        self.directory
            .atomic_replace(OsStr::new(&leaf(&binding.operation_id)?), &bytes)?;
        self.verify()?;
        Ok(binding)
    }
    fn validate(&self, value: &RuntimeBinding) -> Result<()> {
        super::child_records::validate_records(value)?;
        ensure!(
            value.version == 1
                && value.revision > 0
                && value.owner == self.owner
                && value.owner == IntegrationOwner::from(&value.source_scope)
                && value.intent_sha256.len() == 64,
            "RUNTIME_BINDING_CORRUPT"
        );
        value.source_scope.validate()?;
        value.spec.validate()?;
        ensure!(
            value.artifact_refs.len() <= 256
                && value.artifact_refs.iter().all(|reference| matches!(
                    reference.kind,
                    kcoder_types::integrations::core::IntegrationEntityKind::Artifact
                        | kcoder_types::integrations::core::IntegrationEntityKind::Dataset
                ) && !reference.id.is_empty()
                    && reference.id.len() <= 256
                    && reference
                        .revision
                        .as_ref()
                        .is_some_and(|revision| !revision.is_empty() && revision.len() <= 256)),
            "RUNTIME_ARTIFACT_REFERENCE_INVALID"
        );
        ensure!(
            value.pending_interactions.len() <= 32
                && value
                    .pending_interactions
                    .iter()
                    .all(|interaction| !interaction.interaction_id.is_empty()
                        && interaction.interaction_id.len() <= 256
                        && !interaction.revision.is_empty()
                        && interaction.revision.len() <= 256
                        && interaction.prompt.len() <= 16 * 1024),
            "RUNTIME_INTERACTION_INVALID"
        );
        ensure!(
            value.original_request.scope == value.source_scope
                && value.original_request.operation_id.as_deref()
                    == Some(value.operation_id.as_str())
                && super::prepared_intent(&value.original_request, &value.spec)?
                    == value.intent_sha256,
            "RUNTIME_BINDING_INTENT_CHANGED"
        );
        if let Some(acceptance) = &value.acceptance {
            acceptance.validate()?;
            ensure!(
                value.thread_id.as_deref() == Some(acceptance.thread_id.as_str()),
                "RUNTIME_BINDING_CORRUPT"
            );
        }
        Ok(())
    }
}
fn leaf(operation: &str) -> Result<String> {
    ensure!(
        !operation.is_empty() && operation.chars().count() <= 256,
        "RUNTIME_OPERATION_INVALID"
    );
    Ok(format!(
        "binding-{:x}.json",
        Sha256::digest(operation.as_bytes())
    ))
}
fn read(directory: &PrivateDirectory, name: &str) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_BYTES, "RUNTIME_BINDING_TOO_LARGE");
    Ok(Some(bytes))
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
