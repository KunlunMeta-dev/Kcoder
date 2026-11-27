//! Stable profile epochs with per-observer native bindings, never connection labels.
use super::{NativeDomain, NativeDomainGuard};
use anyhow::{Context, Result, ensure};
use kcoder_config::profile_identity::ProfileIdentity;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner, IntegrationScope};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(any(test, feature = "native-identity-test-hooks"))]
use std::io::{Seek, SeekFrom};
use std::{
    ffi::OsStr,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
};

const RECORD: &str = "native-identity.jsonl";
const LOCK: &str = "native-identity.lock";
const HEAD: &str = "native-identity-head.jsonl";
const LOCK_PLACEMENT: &str = "native-identity-lock-placement.json";
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const MAX_LOCK_PLACEMENT_BYTES: u64 = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeIdentitySnapshot {
    pub generation: String,
    pub revision: u64,
    pub enabled: bool,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    owner: IntegrationOwner,
    profile_identity: String,
    namespace_identity: String,
    record_identity: PortableLeaseIdentity,
    lock_identity: PortableLeaseIdentity,
    head_identity: PortableLeaseIdentity,
    initialization_operation: String,
    initial_generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relocation: Option<relocation::RelocationReceipt>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Epoch {
    generation: String,
    revision: u64,
    enabled: bool,
    operation_id: String,
    expected_revision: u64,
    observed_at_ms: u64,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Head {
    revision: u64,
    epoch_hash: String,
    previous_hash: Option<String>,
}
impl Epoch {
    fn initial(header: &Header) -> Self {
        Self {
            generation: header.initial_generation.clone(),
            revision: 1,
            enabled: true,
            operation_id: header.initialization_operation.clone(),
            expected_revision: 0,
            observed_at_ms: 0,
        }
    }

    fn snapshot(&self) -> NativeIdentitySnapshot {
        NativeIdentitySnapshot {
            generation: self.generation.clone(),
            revision: self.revision,
            enabled: self.enabled,
        }
    }
}

struct InitialIdentity {
    epoch: Epoch,
    head: Head,
    record_bytes: Vec<u8>,
    head_bytes: Vec<u8>,
}

impl InitialIdentity {
    fn new(header: &Header) -> Result<Self> {
        let epoch = Epoch::initial(header);
        let head = Head {
            revision: 1,
            epoch_hash: hash(&epoch)?,
            previous_hash: None,
        };
        let mut record_bytes = Vec::new();
        append_json(&mut record_bytes, header)?;
        append_json(&mut record_bytes, &epoch)?;
        let mut head_bytes = Vec::new();
        append_json(&mut head_bytes, &head)?;
        Ok(Self {
            epoch,
            head,
            record_bytes,
            head_bytes,
        })
    }
}

// Physical observations protect this open lifetime. The lock additionally has
// a cold-open pin in the original header or current offline placement.
struct ObservedBinding {
    profile_identity: String,
    namespace_identity: String,
    record_identity: PortableLeaseIdentity,
    lock_identity: PortableLeaseIdentity,
    head_identity: PortableLeaseIdentity,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LockPlacement {
    version: u32,
    header_digest: String,
    lock_identity: PortableLeaseIdentity,
}

struct ObservedLockPlacement {
    anchor: File,
    bytes: Vec<u8>,
}

pub struct NativeIdentity {
    binding: ObservedBinding,
    guard: NativeDomainGuard,
    directory: PrivateDirectory,
    header: Header,
    initial: InitialIdentity,
    record_anchor: File,
    lock_anchor: File,
    head_anchor: File,
    lock_placement: Option<ObservedLockPlacement>,
    logical_profile: ProfileIdentity,
    #[cfg(test)]
    lose_disable_ack: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    stop_after_revocation_witness: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    lose_relocation_ack: std::sync::atomic::AtomicBool,
}
impl std::fmt::Debug for NativeIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NativeIdentity { native_objects: pinned }")
    }
}

impl NativeIdentity {
    /// Pure observation. Existing partial/missing domain state never becomes a fresh identity.
    pub fn observe(
        profile: &PrivateDirectory,
        global_scope: &IntegrationScope,
    ) -> Result<Option<Self>> {
        validate_global_scope(global_scope)?;
        let logical_profile = ProfileIdentity::observe(profile)?;
        let Some(guard) =
            NativeDomainGuard::observe(profile, global_scope, NativeDomain::Identity)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(profile)?;
        let record_anchor = directory
            .open_single_link_regular_file(OsStr::new(RECORD))
            .context("INTEGRATION_IDENTITY_RECORD_UNAVAILABLE")?;
        let record_identity = directory.portable_regular_handle_identity(&record_anchor)?;
        // Read only the immutable header before taking the current real control lock.
        let header = read_header(&record_anchor)?;
        ensure!(
            relocation::valid_version(&header)
                && header.owner == IntegrationOwner::from(global_scope),
            "INTEGRATION_IDENTITY_BINDING_CHANGED"
        );
        relocation::verify_logical_binding(&header, &logical_profile)?;
        validate_operation(&header.initialization_operation)?;
        uuid::Uuid::parse_str(&header.initial_generation)
            .context("INTEGRATION_IDENTITY_RECORD_INVALID")?;
        let lock_anchor = directory
            .open_single_link_regular_file(OsStr::new(LOCK))
            .context("INTEGRATION_IDENTITY_LOCK_UNAVAILABLE")?;
        let lock_placement = read_lock_placement(&directory)?;
        let lock_identity = match &lock_placement {
            Some(placement) => {
                let placement: LockPlacement = serde_json::from_slice(&placement.bytes)
                    .context("INTEGRATION_IDENTITY_LOCK_PLACEMENT_INVALID")?;
                ensure!(
                    placement.version == 1 && placement.header_digest == hash(&header)?,
                    "INTEGRATION_IDENTITY_LOCK_PLACEMENT_INVALID"
                );
                placement.lock_identity
            }
            None => header.lock_identity.clone(),
        };
        ensure!(
            directory.portable_regular_handle_identity(&lock_anchor)? == lock_identity,
            "INTEGRATION_IDENTITY_LOCK_CHANGED"
        );

        let head_anchor = directory
            .open_single_link_regular_file(OsStr::new(HEAD))
            .context("INTEGRATION_IDENTITY_HEAD_UNAVAILABLE")?;

        let identity = Self {
            binding: ObservedBinding {
                profile_identity: profile.directory_identity()?,
                namespace_identity: directory.directory_identity()?,
                record_identity,
                lock_identity,
                head_identity: directory.portable_regular_handle_identity(&head_anchor)?,
            },
            guard,
            directory,
            initial: InitialIdentity::new(&header)?,
            header,
            record_anchor,
            lock_anchor,
            head_anchor,
            lock_placement,
            logical_profile,
            #[cfg(test)]
            lose_disable_ack: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            stop_after_revocation_witness: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            lose_relocation_ack: std::sync::atomic::AtomicBool::new(false),
        };
        identity.snapshot(profile)?;
        Ok(Some(identity))
    }

    /// Only the first real authenticated, capability-opted-in handshake may call this writer.
    /// A replay of that same initialization operation only reads its original identity.
    pub fn initialize(
        profile: &PrivateDirectory,
        global_scope: &IntegrationScope,
        operation_id: &str,
    ) -> Result<Self> {
        validate_global_scope(global_scope)?;
        validate_operation(operation_id)?;
        if let Some(identity) = Self::observe(profile, global_scope)? {
            ensure!(
                identity.header.initialization_operation == operation_id,
                "INTEGRATION_IDENTITY_ALREADY_INITIALIZED"
            );
            return Ok(identity);
        }
        let profile_identity = profile.directory_identity()?;
        let logical_profile = ProfileIdentity::observe(profile)?;
        let owner = IntegrationOwner::from(global_scope);
        let (guard, (header, initial, record_anchor, lock_anchor, head_anchor, directory)) =
            NativeDomainGuard::initialize(
                profile,
                global_scope,
                NativeDomain::Identity,
                operation_id,
                |directory| {
                    let lock_anchor = directory.open_read_write_file(OsStr::new(LOCK), true)?;
                    lock_anchor.sync_all()?;
                    let mut record_anchor =
                        directory.open_read_write_file(OsStr::new(RECORD), true)?;
                    let mut head_anchor = directory.open_read_write_file(OsStr::new(HEAD), true)?;
                    let generation = uuid::Uuid::new_v4().to_string();
                    let header = Header {
                        version: 1,
                        owner,
                        profile_identity,
                        namespace_identity: directory.directory_identity()?,
                        record_identity: directory
                            .portable_regular_handle_identity(&record_anchor)?,
                        lock_identity: directory.portable_regular_handle_identity(&lock_anchor)?,
                        head_identity: directory.portable_regular_handle_identity(&head_anchor)?,
                        initialization_operation: operation_id.into(),
                        initial_generation: generation,
                        relocation: None,
                    };
                    let initial = InitialIdentity::new(&header)?;
                    record_anchor.write_all(&initial.record_bytes)?;
                    record_anchor.sync_all()?;
                    head_anchor.write_all(&initial.head_bytes)?;
                    head_anchor.sync_all()?;
                    directory.sync()?;
                    Ok((
                        header,
                        initial,
                        record_anchor,
                        lock_anchor,
                        head_anchor,
                        directory.duplicate_handle()?,
                    ))
                },
            )?;
        let identity = Self {
            binding: ObservedBinding {
                profile_identity: profile.directory_identity()?,
                namespace_identity: directory.directory_identity()?,
                record_identity: directory.portable_regular_handle_identity(&record_anchor)?,
                lock_identity: directory.portable_regular_handle_identity(&lock_anchor)?,
                head_identity: directory.portable_regular_handle_identity(&head_anchor)?,
            },
            guard,
            directory,
            header,
            initial,
            record_anchor,
            lock_anchor,
            head_anchor,
            lock_placement: None,
            logical_profile,
            #[cfg(test)]
            lose_disable_ack: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            stop_after_revocation_witness: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            lose_relocation_ack: std::sync::atomic::AtomicBool::new(false),
        };
        identity.snapshot(profile)?;
        Ok(identity)
    }

    fn verify_binding(&self, profile: &PrivateDirectory) -> Result<&PrivateDirectory> {
        self.logical_profile.verify(profile)?;
        ensure!(
            profile.directory_identity()? == self.binding.profile_identity,
            "INTEGRATION_IDENTITY_PROFILE_CHANGED"
        );
        let directory = self.guard.verified_directory(profile)?;
        verify_lock_placement(directory, self.lock_placement.as_ref())?;
        let current_file_matches = |name: &str, anchor: &File, expected: &PortableLeaseIdentity| {
            let current = directory.open_regular_file(OsStr::new(name))?;
            Ok::<_, anyhow::Error>(
                &PortableLeaseIdentity::from_private_regular_handle(anchor)? == expected
                    && &PortableLeaseIdentity::from_private_regular_handle(&current)? == expected,
            )
        };
        ensure!(
            directory.directory_identity()? == self.binding.namespace_identity
                && current_file_matches(
                    RECORD,
                    &self.record_anchor,
                    &self.binding.record_identity
                )?,
            "INTEGRATION_IDENTITY_RECORD_CHANGED"
        );
        ensure!(
            current_file_matches(LOCK, &self.lock_anchor, &self.binding.lock_identity)?,
            "INTEGRATION_IDENTITY_LOCK_CHANGED"
        );
        ensure!(
            current_file_matches(HEAD, &self.head_anchor, &self.binding.head_identity)?,
            "INTEGRATION_IDENTITY_HEAD_CHANGED"
        );
        Ok(directory)
    }

    #[cfg(any(test, feature = "native-identity-test-hooks"))]
    fn read_epoch(&self, directory: &PrivateDirectory) -> Result<Epoch> {
        // A fresh handle has an independent cursor even during concurrent shared observations.
        let file = directory.open_single_link_regular_file(OsStr::new(RECORD))?;
        ensure!(
            directory.portable_regular_handle_identity(&file)? == self.binding.record_identity,
            "INTEGRATION_IDENTITY_RECORD_CHANGED"
        );
        let mut bytes = Vec::new();
        (&file).take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes)?;
        self.decode_epoch(&bytes, || self.read_head(directory))
    }

    fn read_snapshot_epoch(&self) -> Result<Epoch> {
        let bytes = read_anchored_bytes(&self.record_anchor)?;
        self.decode_epoch(&bytes, || {
            let head = read_anchored_bytes(&self.head_anchor)?;
            ensure!(
                head.len() <= MAX_RECORD_BYTES as usize,
                "INTEGRATION_IDENTITY_HEAD_INVALID"
            );
            Ok(head)
        })
    }

    fn decode_epoch(
        &self,
        bytes: &[u8],
        read_head: impl FnOnce() -> Result<Vec<u8>>,
    ) -> Result<Epoch> {
        ensure!(
            bytes.len() <= MAX_RECORD_BYTES as usize,
            "INTEGRATION_IDENTITY_RECORD_INVALID"
        );
        // Compare the complete current files under the caller's existing lock.
        // An append, rewrite or different encoding takes the full verification path.
        if bytes == self.initial.record_bytes {
            let head = read_head()?;
            if head != self.initial.head_bytes {
                self.verify_head(&head, &self.initial.epoch)?;
            }
            return Ok(self.initial.epoch.clone());
        }
        let lines = bytes.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        ensure!(
            (lines.len() == 3 || lines.len() == 4) && lines.last() == Some(&&b""[..]),
            "INTEGRATION_IDENTITY_RECORD_INVALID"
        );
        let header: Header =
            serde_json::from_slice(lines[0]).context("INTEGRATION_IDENTITY_RECORD_INVALID")?;
        ensure!(
            header == self.header,
            "INTEGRATION_IDENTITY_BINDING_CHANGED"
        );
        let initial: Epoch =
            serde_json::from_slice(lines[1]).context("INTEGRATION_IDENTITY_RECORD_INVALID")?;
        ensure!(
            initial == self.initial.epoch,
            "INTEGRATION_IDENTITY_RECORD_INVALID"
        );
        if lines.len() == 3 {
            self.verify_head(&read_head()?, &initial)?;
            return Ok(initial);
        }
        let disabled: Epoch =
            serde_json::from_slice(lines[2]).context("INTEGRATION_IDENTITY_RECORD_INVALID")?;
        validate_operation(&disabled.operation_id)?;
        uuid::Uuid::parse_str(&disabled.generation)
            .context("INTEGRATION_IDENTITY_RECORD_INVALID")?;
        ensure!(
            disabled.generation != initial.generation
                && disabled.revision == 2
                && !disabled.enabled
                && disabled.expected_revision == 1
                && disabled.operation_id != initial.operation_id,
            "INTEGRATION_IDENTITY_RECORD_INVALID"
        );
        self.verify_head(&read_head()?, &disabled)?;
        Ok(disabled)
    }

    #[cfg(any(test, feature = "native-identity-test-hooks"))]
    fn read_head(&self, directory: &PrivateDirectory) -> Result<Vec<u8>> {
        let file = directory.open_single_link_regular_file(OsStr::new(HEAD))?;
        ensure!(
            directory.portable_regular_handle_identity(&file)? == self.binding.head_identity,
            "INTEGRATION_IDENTITY_HEAD_CHANGED"
        );
        let mut bytes = Vec::new();
        (&file).take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_RECORD_BYTES as usize,
            "INTEGRATION_IDENTITY_HEAD_INVALID"
        );
        Ok(bytes)
    }

    fn verify_head(&self, bytes: &[u8], epoch: &Epoch) -> Result<()> {
        let lines = bytes.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        ensure!(
            (lines.len() == 2 || lines.len() == 3) && lines.last() == Some(&&b""[..]),
            "INTEGRATION_IDENTITY_HEAD_INVALID"
        );
        let genesis: Head =
            serde_json::from_slice(lines[0]).context("INTEGRATION_IDENTITY_HEAD_INVALID")?;
        ensure!(
            genesis == self.initial.head,
            "INTEGRATION_IDENTITY_HEAD_INVALID"
        );
        let current = if lines.len() == 3 {
            let current: Head =
                serde_json::from_slice(lines[1]).context("INTEGRATION_IDENTITY_HEAD_INVALID")?;
            ensure!(
                current.revision == 2
                    && current.previous_hash.as_deref() == Some(hash(&genesis)?.as_str()),
                "INTEGRATION_IDENTITY_HEAD_INVALID"
            );
            current
        } else {
            genesis
        };
        ensure!(
            current.revision == epoch.revision && current.epoch_hash == hash(epoch)?,
            "INTEGRATION_IDENTITY_COMMIT_MISMATCH"
        );
        Ok(())
    }

    pub fn snapshot(&self, profile: &PrivateDirectory) -> Result<NativeIdentitySnapshot> {
        let directory = &self.directory;
        let _lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.binding.lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("INTEGRATION_IDENTITY_BUSY")?;
        // Read current bytes at explicit offsets on the original handles. The
        // complete binding check below still opens the current names and checks
        // permissions/identities before publishing, under the same shared lease.
        let epoch = self.read_snapshot_epoch()?;
        self.verify_binding(profile)?;
        Ok(epoch.snapshot())
    }

    /// Permanently revokes the profile epoch. A lost acknowledgement reconciles the same
    /// operation; partial writes fail closed and are never truncated, repaired or replayed.
    #[cfg(any(test, feature = "native-identity-test-hooks"))]
    pub fn disable(
        &self,
        profile: &PrivateDirectory,
        operation_id: &str,
        expected_revision: u64,
        now_ms: u64,
    ) -> Result<NativeIdentitySnapshot> {
        validate_operation(operation_id)?;
        ensure!(
            i64::try_from(now_ms)
                .ok()
                .and_then(chrono::DateTime::from_timestamp_millis)
                .is_some(),
            "INTEGRATION_IDENTITY_INVALID_CLOCK"
        );
        let directory = self.verify_binding(profile)?;
        let _lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.binding.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("INTEGRATION_IDENTITY_BUSY")?;
        self.verify_binding(profile)?;
        let current = self.read_epoch(directory)?;
        if !current.enabled {
            ensure!(
                current.operation_id == operation_id
                    && current.expected_revision == expected_revision,
                "INTEGRATION_IDENTITY_OPERATION_CONFLICT"
            );
            return Ok(current.snapshot());
        }
        ensure!(
            operation_id != self.header.initialization_operation,
            "INTEGRATION_IDENTITY_OPERATION_CONFLICT"
        );
        ensure!(
            current.revision == expected_revision,
            "INTEGRATION_IDENTITY_REVISION_CONFLICT"
        );
        let disabled = Epoch {
            generation: uuid::Uuid::new_v4().to_string(),
            revision: current.revision + 1,
            enabled: false,
            operation_id: operation_id.into(),
            expected_revision,
            observed_at_ms: now_ms,
        };
        // Publish the independent revocation witness first. Any interrupted later write
        // leaves an unavailable identity; truncating only the record cannot restore genesis.
        let next_head = Head {
            revision: disabled.revision,
            epoch_hash: hash(&disabled)?,
            previous_hash: Some(hash(&self.initial.head)?),
        };
        let mut head = directory.open_read_write_file(OsStr::new(HEAD), false)?;
        ensure!(
            directory.portable_regular_handle_identity(&head)? == self.binding.head_identity,
            "INTEGRATION_IDENTITY_HEAD_CHANGED"
        );
        head.seek(SeekFrom::End(0))?;
        append_json(&mut head, &next_head).context("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED")?;
        head.sync_all()
            .context("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED")?;
        #[cfg(test)]
        if self
            .stop_after_revocation_witness
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            anyhow::bail!("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED");
        }
        let committed = (|| -> Result<()> {
            let mut file = directory.open_read_write_file(OsStr::new(RECORD), false)?;
            ensure!(
                directory.portable_regular_handle_identity(&file)? == self.binding.record_identity,
                "INTEGRATION_IDENTITY_RECORD_CHANGED"
            );
            file.seek(SeekFrom::End(0))?;
            append_json(&mut file, &disabled).context("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED")?;
            file.sync_all()
                .context("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED")?;
            ensure!(
                self.read_epoch(directory)? == disabled,
                "INTEGRATION_IDENTITY_WRITE_UNCONFIRMED"
            );
            self.verify_binding(profile)
                .context("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED")?;
            Ok(())
        })();
        committed.context("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED")?;
        #[cfg(test)]
        if self
            .lose_disable_ack
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            anyhow::bail!("INTEGRATION_IDENTITY_WRITE_UNCONFIRMED");
        }
        Ok(disabled.snapshot())
    }
}

#[path = "native_identity/relocation.rs"]
mod relocation;

#[path = "native_identity/domain_inventory.rs"]
mod domain_inventory;
pub use domain_inventory::{
    NativeObservedDomain, NativeObservedDomainRelocation, NativeProfileDomains,
};

fn validate_global_scope(scope: &IntegrationScope) -> Result<()> {
    scope.validate()?;
    ensure!(
        matches!(scope.workspace_id, IntegrationNullable::Null)
            && scope
                .organization_id
                .as_ref()
                .is_none_or(|value| matches!(value, IntegrationNullable::Null)),
        "INTEGRATION_IDENTITY_GLOBAL_SCOPE_REQUIRED"
    );
    Ok(())
}
fn validate_operation(operation: &str) -> Result<()> {
    ensure!(
        !operation.trim().is_empty() && operation.chars().count() <= 256,
        "INTEGRATION_IDENTITY_INVALID_OPERATION"
    );
    Ok(())
}
fn append_json(file: &mut impl Write, value: &impl Serialize) -> Result<()> {
    serde_json::to_writer(&mut *file, value)?;
    file.write_all(b"\n")?;
    Ok(())
}
fn read_header(file: &File) -> Result<Header> {
    // Observation starts with its own newly opened record descriptor, never a cloned cursor.
    let mut bytes = Vec::new();
    BufReader::new(file.take(MAX_RECORD_BYTES + 1)).read_until(b'\n', &mut bytes)?;
    ensure!(
        bytes.len() <= MAX_RECORD_BYTES as usize && bytes.pop() == Some(b'\n'),
        "INTEGRATION_IDENTITY_RECORD_INVALID"
    );
    serde_json::from_slice(&bytes).context("INTEGRATION_IDENTITY_RECORD_INVALID")
}

fn read_anchored_bytes(file: &File) -> std::io::Result<Vec<u8>> {
    read_anchored_bytes_bounded(file, MAX_RECORD_BYTES)
}

fn read_lock_placement(directory: &PrivateDirectory) -> Result<Option<ObservedLockPlacement>> {
    let anchor = match directory.open_single_link_regular_file(OsStr::new(LOCK_PLACEMENT)) {
        Ok(anchor) => anchor,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let bytes = read_anchored_bytes_bounded(&anchor, MAX_LOCK_PLACEMENT_BYTES)?;
    ensure!(
        bytes.len() <= MAX_LOCK_PLACEMENT_BYTES as usize,
        "INTEGRATION_IDENTITY_LOCK_PLACEMENT_INVALID"
    );
    Ok(Some(ObservedLockPlacement { anchor, bytes }))
}

fn verify_lock_placement(
    directory: &PrivateDirectory,
    expected: Option<&ObservedLockPlacement>,
) -> Result<()> {
    match (expected, read_lock_placement(directory)?) {
        (None, None) => Ok(()),
        (Some(expected), Some(current)) => {
            ensure!(
                current.bytes == expected.bytes
                    && directory.portable_regular_handle_identity(&current.anchor)?
                        == directory.portable_regular_handle_identity(&expected.anchor)?,
                "INTEGRATION_IDENTITY_LOCK_PLACEMENT_CHANGED"
            );
            Ok(())
        }
        _ => anyhow::bail!("INTEGRATION_IDENTITY_LOCK_PLACEMENT_CHANGED"),
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn read_anchored_bytes_bounded(file: &File, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut bytes = vec![0; limit as usize + 1];
    let mut offset = 0;
    while offset < bytes.len() {
        #[cfg(unix)]
        let read = std::os::unix::fs::FileExt::read_at(file, &mut bytes[offset..], offset as u64);
        #[cfg(windows)]
        let read =
            std::os::windows::fs::FileExt::seek_read(file, &mut bytes[offset..], offset as u64);
        #[cfg(not(any(unix, windows)))]
        let read: std::io::Result<usize> = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "native identity positioned reads are unavailable",
        ));
        match read {
            Ok(0) => break,
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    bytes.truncate(offset);
    Ok(bytes)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}

#[cfg(test)]
#[path = "native_identity/tests.rs"]
mod tests;
