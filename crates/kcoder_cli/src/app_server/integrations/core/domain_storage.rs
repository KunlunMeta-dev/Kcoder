//! Native domain initialization receipts, separate from business operation receipts.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::integrations::core::{IntegrationOwner, IntegrationScope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Write},
};

const MAX_CONTROL_BYTES: u64 = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeDomain {
    BrowserProfiles,
    RemoteDelegations,
    Connectivity,
    ConnectivityBots,
    ConnectivityEvents,
    ConnectivityChatBindings,
    ConnectivityCredentials,
    ConnectivitySecretContexts,
    ConnectivitySources,
    // Keep the legacy serialized domain name and namespace hash input stable.
    #[serde(rename = "connectivity_task_sources")]
    ConnectivityTaskCapabilityScope,
    Memory,
    Budgets,
    Automation,
    Office,
    Operations,
    Policy,
    Identity,
    Knowledge,
    Services,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialization {
    version: u32,
    owner: IntegrationOwner,
    domain: NativeDomain,
    marker_identity: PortableLeaseIdentity,
    operation_id: String,
    directory_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    directory_identity: String,
}

pub struct NativeDomainGuard {
    initialization: Initialization,
    ready: Ready,
    control_bytes: Box<[u8]>,
    marker_name: String,
    marker_identity: PortableLeaseIdentity,
    marker_anchor: File,
}

impl std::fmt::Debug for NativeDomainGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeDomainGuard { initialization: verified }")
    }
}

impl NativeDomainGuard {
    /// Deterministic display/routing name only; callers still need the original
    /// profile and namespace handles before accessing or creating any entry.
    pub fn expected_namespace_id(scope: &IntegrationScope, domain: NativeDomain) -> Result<String> {
        scope.validate()?;
        Ok(names(&IntegrationOwner::from(scope), domain)?.1)
    }

    pub fn namespace_id(&self) -> &str {
        &self.initialization.directory_name
    }
    /// Enumerate committed owner domains through the held profile. Paths only
    /// enumerate names; every accepted entry is reopened and verified by handle.
    pub fn observe_owned_domains(
        profile: &PrivateDirectory,
        profile_path: &std::path::Path,
        scope: &IntegrationScope,
        domain: NativeDomain,
    ) -> Result<(Vec<(IntegrationOwner, Self)>, bool)> {
        scope.validate()?;
        profile.verify_private_directory()?;
        let verify_profile = || -> Result<()> {
            ensure!(
                PrivateDirectory::open_existing(profile_path)?.directory_identity()?
                    == profile.directory_identity()?,
                "INTEGRATION_DIRECTORY_PROFILE_CHANGED"
            );
            profile.verify_private_directory()
        };
        verify_profile()?;
        let mut result = Vec::new();
        let mut complete = true;
        let mut scanned = 0usize;
        for entry in std::fs::read_dir(profile_path)? {
            scanned += 1;
            ensure!(scanned <= 8192, "INTEGRATION_DIRECTORY_CAPACITY");
            let name = entry?.file_name();
            let Some(text) = name.to_str() else { continue };
            let Some(digest) = text
                .strip_prefix(".integration-")
                .and_then(|value| value.strip_suffix(".jsonl"))
            else {
                continue;
            };
            if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                continue;
            }
            let observed = (|| -> Result<Option<(IntegrationOwner, Self)>> {
                let file = profile.open_single_link_regular_file(&name)?;
                let (initial, _) = parse_control(&read_control_bytes(&file)?)?;
                let owner = initial.owner;
                if initial.domain != domain
                    || owner.account_id != scope.account_id
                    || owner.target_id != scope.target_id
                    || owner.organization_id != scope.organization_id
                {
                    return Ok(None);
                }
                ensure!(
                    names(&owner, domain)?.0 == text,
                    "INTEGRATION_DIRECTORY_MARKER_MISMATCH"
                );
                let mut source_scope = scope.clone();
                source_scope.workspace_id = owner.workspace_id.clone();
                let guard = Self::observe(profile, &source_scope, domain)?
                    .context("INTEGRATION_DIRECTORY_SOURCE_CHANGED")?;
                Ok(Some((owner, guard)))
            })();
            match observed {
                Ok(Some(value)) => {
                    ensure!(result.len() < 256, "INTEGRATION_DIRECTORY_CAPACITY");
                    result.push(value);
                }
                Ok(None) => {}
                Err(_) => complete = false,
            }
        }
        result.sort_by(|a, b| a.1.namespace_id().cmp(b.1.namespace_id()));
        verify_profile()?;
        Ok((result, complete))
    }

    /// Reads never initialize storage or adopt a directory left without its receipt.
    pub fn observe(
        profile: &PrivateDirectory,
        scope: &IntegrationScope,
        domain: NativeDomain,
    ) -> Result<Option<Self>> {
        scope.validate()?;
        profile.verify_private_directory()?;
        let owner = IntegrationOwner::from(scope);
        let (marker_name, directory_name) = names(&owner, domain)?;
        let marker_anchor = match profile.open_single_link_regular_file(OsStr::new(&marker_name)) {
            Ok(file) => file,
            Err(error) if missing(&error) => {
                match profile.entry_metadata(OsStr::new(&directory_name)) {
                    Err(error) if missing(&error) => return Ok(None),
                    _ => anyhow::bail!("INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED"),
                }
            }
            Err(error) => return Err(error),
        };
        let marker_identity = profile.portable_regular_handle_identity(&marker_anchor)?;
        let _lease = profile
            .try_existing_portable_lock(
                OsStr::new(&marker_name),
                &marker_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("INTEGRATION_STORAGE_BUSY")?;
        let control = read_control_bytes(&marker_anchor)?;
        let (initialization, ready) = parse_control(&control)?;
        ensure!(
            initialization.version == 1
                && initialization.owner == owner
                && initialization.domain == domain
                && initialization.directory_name == directory_name
                && initialization.marker_identity == marker_identity,
            "INTEGRATION_STORAGE_OWNER_MISMATCH"
        );
        let guard = Self {
            initialization,
            ready,
            control_bytes: control.into_boxed_slice(),
            marker_name,
            marker_identity,
            marker_anchor,
        };
        guard.directory(profile)?;
        Ok(Some(guard))
    }

    /// Call only for an authorized first write. An interrupted initialization is never reset.
    pub fn initialize<T>(
        profile: &PrivateDirectory,
        scope: &IntegrationScope,
        domain: NativeDomain,
        operation_id: &str,
        initialize: impl FnOnce(&PrivateDirectory) -> Result<T>,
    ) -> Result<(Self, T)> {
        scope.validate()?;
        ensure!(
            !operation_id.is_empty() && operation_id.chars().count() <= 256,
            "INTEGRATION_STORAGE_INVALID_OPERATION"
        );
        profile.verify_private_directory()?;
        ensure!(
            Self::observe(profile, scope, domain)?.is_none(),
            "INTEGRATION_STORAGE_ALREADY_INITIALIZED"
        );
        let owner = IntegrationOwner::from(scope);
        let (marker_name, directory_name) = names(&owner, domain)?;
        let mut marker_anchor = profile.open_read_write_file(OsStr::new(&marker_name), true)?;
        FileExt::try_lock_exclusive(&marker_anchor)?;
        let marker_identity = profile.portable_regular_handle_identity(&marker_anchor)?;
        let initialization = Initialization {
            version: 1,
            owner,
            domain,
            marker_identity: marker_identity.clone(),
            operation_id: operation_id.into(),
            directory_name,
        };
        let mut control = serde_json::to_vec(&initialization)?;
        control.push(b'\n');
        marker_anchor.write_all(&control)?;
        marker_anchor.sync_all()?;
        profile.sync()?;
        let directory = profile.create_private_child(OsStr::new(&initialization.directory_name))?;
        directory.verify_private_directory()?;
        let ready = Ready {
            directory_identity: directory.directory_identity()?,
        };
        let result =
            initialize(&directory).context("INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED")?;
        let ready_start = control.len();
        serde_json::to_writer(&mut control, &ready)?;
        control.push(b'\n');
        marker_anchor.write_all(&control[ready_start..])?;
        marker_anchor.sync_all()?;
        profile.sync()?;
        FileExt::unlock(&marker_anchor)?;
        let guard = Self {
            initialization,
            ready,
            control_bytes: control.into_boxed_slice(),
            marker_name,
            marker_identity,
            marker_anchor,
        };
        guard.directory(profile)?;
        Ok((guard, result))
    }

    /// Return the actual held child; consumers must not reopen a path after this check.
    pub fn directory(&self, profile: &PrivateDirectory) -> Result<PrivateDirectory> {
        profile.verify_private_directory()?;
        let current = profile.open_single_link_regular_file(OsStr::new(&self.marker_name))?;
        ensure!(
            profile.portable_regular_handle_identity(&self.marker_anchor)? == self.marker_identity
                && profile.portable_regular_handle_identity(&current)? == self.marker_identity,
            "INTEGRATION_STORAGE_CONTROL_CHANGED"
        );
        let control = read_control_bytes(&current)?;
        // A fresh, complete byte match can reuse the verified interpretation.
        if control.as_slice() != self.control_bytes.as_ref() {
            let (initialization, ready) = parse_control(&control)?;
            ensure!(
                initialization == self.initialization && ready == self.ready,
                "INTEGRATION_STORAGE_CONTROL_CHANGED"
            );
        }
        let entry = profile.open_entry_handle(OsStr::new(&self.initialization.directory_name))?;
        let directory = entry.open_child_directory()?;
        directory.verify_private_directory()?;
        ensure!(
            directory.directory_identity()? == self.ready.directory_identity,
            "INTEGRATION_STORAGE_DIRECTORY_CHANGED"
        );
        Ok(directory)
    }
}

fn names(owner: &IntegrationOwner, domain: NativeDomain) -> Result<(String, String)> {
    // The serialized domain label is part of the existing namespace hash input.
    let digest = Sha256::digest(serde_json::to_vec(&("native-domain-v1", owner, domain))?);
    let name = format!("integration-{digest:x}");
    Ok((format!(".{name}.jsonl"), name))
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}

fn read_control_bytes(file: &File) -> Result<Vec<u8>> {
    // Callers pass a freshly opened handle. The original writer's cursor is
    // never reused for current authority.
    let mut bytes = Vec::new();
    file.take(MAX_CONTROL_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_CONTROL_BYTES as usize,
        "INTEGRATION_STORAGE_CONTROL_INVALID"
    );
    Ok(bytes)
}

fn parse_control(bytes: &[u8]) -> Result<(Initialization, Ready)> {
    let lines = bytes.split(|b| *b == b'\n').collect::<Vec<_>>();
    ensure!(
        lines.len() == 3 && lines[2].is_empty(),
        "INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED"
    );
    Ok((
        serde_json::from_slice(lines[0])?,
        serde_json::from_slice(lines[1])?,
    ))
}

#[cfg(test)]
#[path = "domain_storage/tests.rs"]
mod tests;
