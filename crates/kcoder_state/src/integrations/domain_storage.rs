//! Owner-bound domain storage, independent of integration identity and authorization.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateFileLock, PrivateLeaseMode};
use kcoder_types::integrations::core::{IntegrationOwner, IntegrationScope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs::File, io::Write};

const MAX_CONTROL_BYTES: u64 = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageDomain {
    BrowserProfiles,
    RemoteDelegations,
    Connectivity,
    // Retired channel domains. Keep these variants: their persisted labels are
    // needed to parse old markers (a removed variant would make an unrelated
    // owner scan incomplete), to detect and explicitly clean legacy data
    // (see `legacy_channel`), and `ConnectivityCredentials` remains a
    // task-workspace invalidation fence. Never initialize them again.
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
    // Preserve the existing shared catalog/artifact namespace and its file identity.
    #[serde(rename = "office")]
    WorkspaceResources,
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
    domain: StorageDomain,
    // Historical initialization evidence, not the current opened file's identity.
    marker_identity: PortableLeaseIdentity,
    operation_id: String,
    directory_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relocation: Option<relocation::RelocationReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    // Preserve the completed initialization bytes across cold copies.
    directory_identity: String,
}

#[path = "domain_storage/relocation.rs"]
mod relocation;
pub use relocation::DomainStorageRelocation;

#[path = "domain_storage/registered.rs"]
mod registered;
pub use registered::RegisteredDomain;

pub struct DomainStorageGuard {
    initialization: Initialization,
    ready: Ready,
    control_bytes: Box<[u8]>,
    marker_name: String,
    marker_identity: PortableLeaseIdentity,
    marker_anchor: File,
    profile_identity: String,
    directory: PrivateDirectory,
}

impl std::fmt::Debug for DomainStorageGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DomainStorageGuard { initialization: verified }")
    }
}

impl DomainStorageGuard {
    /// Duplicate this live observation's file object, not a newly opened marker.
    /// Current path, contents and directory identity are still checked on use.
    pub fn try_clone(&self, profile: &PrivateDirectory) -> Result<Self> {
        self.directory(profile)?;
        Ok(Self {
            initialization: self.initialization.clone(),
            ready: self.ready.clone(),
            control_bytes: self.control_bytes.clone(),
            marker_name: self.marker_name.clone(),
            marker_identity: self.marker_identity.clone(),
            marker_anchor: self.marker_anchor.try_clone()?,
            profile_identity: self.profile_identity.clone(),
            directory: self.directory.duplicate_handle()?,
        })
    }
    /// Deterministic display/routing name only; callers still need the original
    /// profile and namespace handles before accessing or creating any entry.
    pub fn expected_namespace_id(
        scope: &IntegrationScope,
        domain: StorageDomain,
    ) -> Result<String> {
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
        domain: StorageDomain,
    ) -> Result<(Vec<(IntegrationOwner, Self)>, bool)> {
        scope.validate()?;
        profile.verify_config_root_directory()?;
        let verify_profile = || -> Result<()> {
            ensure!(
                PrivateDirectory::open_existing(profile_path)?.directory_identity()?
                    == profile.directory_identity()?,
                "INTEGRATION_DIRECTORY_PROFILE_CHANGED"
            );
            profile.verify_config_root_directory()
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
        domain: StorageDomain,
    ) -> Result<Option<Self>> {
        scope.validate()?;
        Self::observe_owner(profile, &IntegrationOwner::from(scope), domain)
    }

    fn observe_owner(
        profile: &PrivateDirectory,
        owner: &IntegrationOwner,
        domain: StorageDomain,
    ) -> Result<Option<Self>> {
        profile.verify_config_root_directory()?;
        let (marker_name, directory_name) = names(owner, domain)?;
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
        let marker_identity = PortableLeaseIdentity::from_private_regular_handle(&marker_anchor)?;
        let _lease = profile
            .try_existing_config_root_lock(
                OsStr::new(&marker_name),
                &marker_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("INTEGRATION_STORAGE_BUSY")?;
        let control = read_control_bytes(&marker_anchor)?;
        let (initialization, ready) = parse_control(&control)?;
        ensure!(
            initialization.owner == *owner
                && initialization.domain == domain
                && initialization.directory_name == directory_name
                && !initialization.operation_id.is_empty()
                && initialization.operation_id.chars().count() <= 256
                && !ready.directory_identity.is_empty(),
            "INTEGRATION_STORAGE_OWNER_MISMATCH"
        );
        relocation::validate_history(&initialization)?;
        let directory = profile.open_child(OsStr::new(&directory_name), false)?;
        directory.verify_private_directory()?;
        let guard = Self {
            initialization,
            ready,
            control_bytes: control.into_boxed_slice(),
            marker_name,
            marker_identity,
            marker_anchor,
            profile_identity: profile.directory_identity()?,
            directory,
        };
        guard.directory(profile)?;
        Ok(Some(guard))
    }

    /// Call only for an authorized first write. An interrupted initialization is never reset.
    pub fn initialize<T>(
        profile: &PrivateDirectory,
        scope: &IntegrationScope,
        domain: StorageDomain,
        operation_id: &str,
        initialize: impl FnOnce(&PrivateDirectory) -> Result<T>,
    ) -> Result<(Self, T)> {
        scope.validate()?;
        ensure!(
            !operation_id.is_empty() && operation_id.chars().count() <= 256,
            "INTEGRATION_STORAGE_INVALID_OPERATION"
        );
        profile.verify_config_root_directory()?;
        ensure!(
            Self::observe(profile, scope, domain)?.is_none(),
            "INTEGRATION_STORAGE_ALREADY_INITIALIZED"
        );
        let owner = IntegrationOwner::from(scope);
        let (marker_name, directory_name) = names(&owner, domain)?;
        let marker_anchor = profile.open_read_write_file(OsStr::new(&marker_name), true)?;
        FileExt::try_lock_exclusive(&marker_anchor)?;
        // Every early return below releases the lock explicitly, not only by close:
        // a concurrently forked child's inherited descriptor would otherwise keep
        // the marker busy for observers until that child execs.
        let marker_lock = PrivateFileLock::from_locked(marker_anchor);
        let mut marker_writer: &File = marker_lock.file();
        let marker_identity = PortableLeaseIdentity::from_private_regular_handle(&marker_lock)?;
        let initialization = Initialization {
            version: 1,
            owner,
            domain,
            marker_identity: marker_identity.clone(),
            operation_id: operation_id.into(),
            directory_name,
            relocation: None,
        };
        let mut control = serde_json::to_vec(&initialization)?;
        control.push(b'\n');
        marker_writer.write_all(&control)?;
        marker_lock.sync_all()?;
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
        marker_writer.write_all(&control[ready_start..])?;
        marker_lock.sync_all()?;
        profile.sync()?;
        let marker_anchor = marker_lock.into_locked_file();
        FileExt::unlock(&marker_anchor)?;
        let guard = Self {
            initialization,
            ready,
            control_bytes: control.into_boxed_slice(),
            marker_name,
            marker_identity,
            marker_anchor,
            profile_identity: profile.directory_identity()?,
            directory,
        };
        guard.directory(profile)?;
        Ok((guard, result))
    }

    /// Return the actual held child; consumers must not reopen a path after this check.
    pub fn directory(&self, profile: &PrivateDirectory) -> Result<PrivateDirectory> {
        self.verified_directory(profile)?.duplicate_handle()
    }

    /// Borrow the held child after checking the live control bytes and directory name.
    pub fn verified_directory(&self, profile: &PrivateDirectory) -> Result<&PrivateDirectory> {
        profile.verify_config_root_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity,
            "INTEGRATION_STORAGE_PROFILE_CHANGED"
        );
        let current = profile.open_regular_file(OsStr::new(&self.marker_name))?;
        ensure!(
            PortableLeaseIdentity::from_private_regular_handle(&self.marker_anchor)?
                == self.marker_identity
                && PortableLeaseIdentity::from_private_regular_handle(&current)?
                    == self.marker_identity,
            "INTEGRATION_STORAGE_CONTROL_CHANGED"
        );
        let control = read_control_bytes(&self.marker_anchor)?;
        // A fresh, complete byte match can reuse the verified interpretation.
        if control.as_slice() != self.control_bytes.as_ref() {
            let (initialization, ready) = parse_control(&control)?;
            ensure!(
                initialization == self.initialization && ready == self.ready,
                "INTEGRATION_STORAGE_CONTROL_CHANGED"
            );
        }
        // The original handle is the identity anchor. Check it against the
        // current no-follow child without taking a second pathname snapshot.
        let current = profile.open_child(OsStr::new(&self.initialization.directory_name), false)?;
        self.directory.verify_private_directory()?;
        ensure!(
            current.directory_identity()? == self.directory.directory_identity()?,
            "INTEGRATION_STORAGE_DIRECTORY_CHANGED"
        );
        Ok(&self.directory)
    }
}

fn names(owner: &IntegrationOwner, domain: StorageDomain) -> Result<(String, String)> {
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
    // Explicit offsets keep a held marker usable during its own Windows lease
    // without depending on the cursor left by another control read.
    let size = file.metadata()?.len();
    ensure!(
        size <= MAX_CONTROL_BYTES,
        "INTEGRATION_STORAGE_CONTROL_INVALID"
    );
    let mut bytes = vec![0; size as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        #[cfg(unix)]
        let count = std::os::unix::fs::FileExt::read_at(file, &mut bytes[offset..], offset as u64)?;
        #[cfg(windows)]
        let count =
            std::os::windows::fs::FileExt::seek_read(file, &mut bytes[offset..], offset as u64)?;
        ensure!(count > 0, "INTEGRATION_STORAGE_CONTROL_CHANGED");
        offset += count;
    }
    ensure!(
        file.metadata()?.len() == size,
        "INTEGRATION_STORAGE_CONTROL_CHANGED"
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

#[path = "domain_storage/legacy_channel.rs"]
pub mod legacy_channel;

#[cfg(test)]
#[path = "domain_storage/tests.rs"]
mod tests;
