//! Dedicated SSH pin transactions. Only an explicit OS-owner command writes here.
//!
//! Reading a private file is not by itself a route grant. The connection owner
//! must bind this witness to its actual factory profile/key/workspace and held
//! SSH/stdio transport, then complete the purpose-bound mutual challenge.
use kcoder_app_protocol::cross_session_router::ssh_enrollment::*;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::diagnostic_cause::DiagnosticCause;
use ring::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

const NAMESPACE: &str = "peer-ssh-pins-v1";
const ADOPTED: &str = "peer-ssh-v2-adopted";
const HEADER: &str = "owner.json";
const LOCK: &str = "pins.lock";
const DATA: &str = "pins.json";
const MAX_BYTES: u64 = 512 * 1024;
const MAX_PINS: usize = 64;
const MAX_OPERATIONS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SshPeerPinError {
    #[error("peer_ssh_pin_store_unavailable")]
    Unavailable,
    #[error("peer_ssh_pin_store_busy")]
    Busy,
    #[error("peer_ssh_pin_revision_conflict")]
    RevisionConflict,
    #[error("peer_ssh_pin_operation_conflict")]
    OperationConflict,
    #[error("peer_ssh_pin_generation_changed")]
    GenerationChanged,
    #[error("peer_ssh_pin_scope_changed")]
    ScopeChanged,
    #[error("peer_ssh_pin_revoked")]
    Revoked,
    #[error("peer_ssh_pin_capacity")]
    Capacity,
    #[error("peer_ssh_pin_publish_unknown_reconcile_original")]
    PublishUnknown,
}
type Result<T> = std::result::Result<T, SshPeerPinError>;

/// Pin failures stay fieldless for callers and the wire; the host trace keeps
/// only a sanitized cause (I/O kind, JSON category), never pin data or paths.
fn pin_failure<E: PinCause>(failure: SshPeerPinError) -> impl FnOnce(E) -> SshPeerPinError {
    move |error| {
        tracing::debug!(%failure, cause = %error.diagnostic_cause(), "SSH peer pin store step failed");
        failure
    }
}
trait PinCause {
    fn diagnostic_cause(&self) -> DiagnosticCause;
}
impl PinCause for anyhow::Error {
    fn diagnostic_cause(&self) -> DiagnosticCause {
        DiagnosticCause::of_chain(&**self)
    }
}
impl PinCause for std::io::Error {
    fn diagnostic_cause(&self) -> DiagnosticCause {
        DiagnosticCause::of(self)
    }
}
impl PinCause for serde_json::Error {
    fn diagnostic_cause(&self) -> DiagnosticCause {
        DiagnosticCause::of(self)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u8,
    profile_identity: String,
    directory_identity: String,
    lock_identity: PortableLeaseIdentity,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Row {
    pin: PeerSshEnrollmentV1,
    generation: u64,
    status: PeerSshPinStatusV1,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    digest: Vec<u8>,
    receipt: PeerSshPinReceiptV1,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    version: u8,
    profile_identity: String,
    revision: u64,
    #[serde(deserialize_with = "unique_map")]
    pins: BTreeMap<String, Row>,
    #[serde(deserialize_with = "unique_map")]
    gateway_keys: BTreeMap<String, PeerSshGatewayKeyV1>,
    #[serde(deserialize_with = "unique_map")]
    operations: BTreeMap<String, Operation>,
}

pub struct SshPeerPinStore {
    profile_path: PathBuf,
    profile: PrivateDirectory,
    directory: PrivateDirectory,
    header: Header,
    header_identity: PortableLeaseIdentity,
    header_anchor: File,
    lock_anchor: File,
}

/// Constructed only by reading the existing held store. No JSON constructor exists.
/// A caller must still prove that this is its actual factory profile and transport.
pub struct StoredSshPeerPin {
    store: Arc<SshPeerPinStore>,
    expected: PeerSshEnrollmentV1,
}
impl StoredSshPeerPin {
    pub fn expected(&self) -> &PeerSshEnrollmentV1 {
        &self.expected
    }
    pub fn verify_current(&self, actual_profile: &PeerSshNativeProfileV1) -> Result<()> {
        self.store.compare_actual_profile(actual_profile)?;
        let data = self.store.read_data()?;
        let row = data
            .pins
            .get(self.expected.enrollment_id.as_str())
            .ok_or(SshPeerPinError::Revoked)?;
        self.store.check_row(&data, row, actual_profile)?;
        if row.pin != self.expected {
            return Err(SshPeerPinError::GenerationChanged);
        }
        Ok(())
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}
fn read<T: serde::de::DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    limit: u64,
) -> Result<T> {
    let file = directory
        .open_single_link_regular_file(OsStr::new(name))
        .map_err(pin_failure(SshPeerPinError::Unavailable))?;
    if file
        .metadata()
        .map_err(pin_failure(SshPeerPinError::Unavailable))?
        .len()
        > limit
    {
        return Err(SshPeerPinError::Unavailable);
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(pin_failure(SshPeerPinError::Unavailable))?;
    if bytes.len() as u64 > limit {
        return Err(SshPeerPinError::Unavailable);
    }
    serde_json::from_slice(&bytes).map_err(pin_failure(SshPeerPinError::Unavailable))
}
fn encoded<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(pin_failure(SshPeerPinError::Unavailable))
}
fn next(value: u64) -> Result<u64> {
    value
        .checked_add(1)
        .filter(|v| *v <= PEER_SSH_MAX_GENERATION)
        .ok_or(SshPeerPinError::Capacity)
}

fn unique_map<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    decoder: D,
) -> std::result::Result<BTreeMap<String, T>, D::Error> {
    struct Unique<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Unique<T> {
        type Value = BTreeMap<String, T>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("unique SSH pin entries")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut entries = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, T>()? {
                if entries.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate SSH pin entry"));
                }
            }
            Ok(entries)
        }
    }
    decoder.deserialize_map(Unique(std::marker::PhantomData))
}

fn verify_profile_path(profile_path: &Path, actual: &PeerSshNativeProfileV1) -> Result<()> {
    let profile = PrivateDirectory::open_existing(profile_path)
        .map_err(pin_failure(SshPeerPinError::Unavailable))?;
    profile
        .verify_private_directory()
        .map_err(pin_failure(SshPeerPinError::Unavailable))?;
    if actual.profile_identity.as_str()
        != profile
            .directory_identity()
            .map_err(pin_failure(SshPeerPinError::Unavailable))?
    {
        return Err(SshPeerPinError::ScopeChanged);
    }
    #[cfg(unix)]
    if actual.account_uid != unsafe { libc::geteuid() } {
        return Err(SshPeerPinError::ScopeChanged);
    }
    Ok(())
}

/// Denial-only compatibility check. True permits attempting the existing kernel
/// proof; it never authenticates a parent. Unknown or any existing entry blocks
/// that old lane, including a malformed/dangling marker or pin namespace.
pub fn may_attempt_legacy_kernel_capture(profile_path: &Path) -> Result<bool> {
    let profile = PrivateDirectory::open_existing(profile_path)
        .map_err(pin_failure(SshPeerPinError::Unavailable))?;
    profile
        .verify_private_directory()
        .map_err(pin_failure(SshPeerPinError::Unavailable))?;
    for name in [ADOPTED, NAMESPACE] {
        match profile.open_entry_handle(OsStr::new(name)) {
            Ok(_) => return Ok(false),
            Err(error) if missing(&error) => {}
            Err(_) => return Err(SshPeerPinError::Unavailable),
        }
    }
    Ok(true)
}

fn mark_adopted_explicit(profile: &PrivateDirectory) -> Result<()> {
    match profile.open_entry_handle(OsStr::new(ADOPTED)) {
        Ok(_) => return Ok(()),
        Err(error) if missing(&error) => {}
        Err(_) => return Err(SshPeerPinError::Unavailable),
    }
    // Persist before the mutation commit. Even an unconfirmed first grant must
    // not turn back into a legacy SSH grant after its pin ledger is lost.
    profile
        .atomic_replace(OsStr::new(ADOPTED), b"kcoder.peer-ssh.v2-adopted.v1\n")
        .map_err(pin_failure(SshPeerPinError::PublishUnknown))
}

impl SshPeerPinStore {
    /// Zero is known only for a profile which has never adopted this purpose.
    /// A lost adopted ledger is unavailable, not an empty configuration.
    pub fn observed_revision(profile_path: &Path) -> Result<u64> {
        match Self::open_existing(profile_path)? {
            Some(store) => store.revision(),
            None if may_attempt_legacy_kernel_capture(profile_path)? => Ok(0),
            None => Err(SshPeerPinError::Unavailable),
        }
    }
    pub fn read_original_receipt(
        profile_path: &Path,
        operation_id: &PeerSshIdentityTextV1,
    ) -> Result<Option<PeerSshPinReceiptV1>> {
        match Self::open_existing(profile_path)? {
            Some(store) => store.original_receipt(operation_id),
            None if may_attempt_legacy_kernel_capture(profile_path)? => Ok(None),
            None => Err(SshPeerPinError::Unavailable),
        }
    }
    /// Read-only open. Missing never creates a store, key or enrollment.
    pub fn open_existing(profile_path: &Path) -> Result<Option<Arc<Self>>> {
        let profile = PrivateDirectory::open_existing(profile_path)
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        profile
            .verify_private_directory()
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let directory = match profile.open_entry_handle(OsStr::new(NAMESPACE)) {
            Ok(entry) => entry
                .open_child_directory()
                .map_err(pin_failure(SshPeerPinError::Unavailable))?,
            Err(error) if missing(&error) => return Ok(None),
            Err(_) => return Err(SshPeerPinError::Unavailable),
        };
        let header: Header = read(&directory, HEADER, 8192)?;
        let header_anchor = directory
            .open_single_link_regular_file(OsStr::new(HEADER))
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let lock_anchor = directory
            .open_single_link_regular_file(OsStr::new(LOCK))
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let header_identity = directory
            .portable_regular_handle_identity(&header_anchor)
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let store = Arc::new(Self {
            profile_path: profile_path.into(),
            profile,
            directory,
            header,
            header_identity,
            header_anchor,
            lock_anchor,
        });
        store.read_data()?;
        Ok(Some(store))
    }
    fn create_explicit(profile_path: &Path) -> Result<Arc<Self>> {
        let profile = PrivateDirectory::open_existing(profile_path)
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        profile
            .verify_private_directory()
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let directory = profile
            .create_private_child(OsStr::new(NAMESPACE))
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let lock = directory
            .open_read_write_file(OsStr::new(LOCK), true)
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let header = Header {
            version: 1,
            profile_identity: profile
                .directory_identity()
                .map_err(pin_failure(SshPeerPinError::Unavailable))?,
            directory_identity: directory
                .directory_identity()
                .map_err(pin_failure(SshPeerPinError::Unavailable))?,
            lock_identity: directory
                .portable_regular_handle_identity(&lock)
                .map_err(pin_failure(SshPeerPinError::Unavailable))?,
        };
        let data = Data {
            version: 1,
            profile_identity: header.profile_identity.clone(),
            revision: 0,
            pins: BTreeMap::new(),
            gateway_keys: BTreeMap::new(),
            operations: BTreeMap::new(),
        };
        directory
            .atomic_replace(OsStr::new(DATA), &encoded(&data)?)
            .map_err(pin_failure(SshPeerPinError::PublishUnknown))?;
        directory
            .atomic_replace(OsStr::new(HEADER), &encoded(&header)?)
            .map_err(pin_failure(SshPeerPinError::PublishUnknown))?;
        directory
            .sync()
            .map_err(pin_failure(SshPeerPinError::PublishUnknown))?;
        Self::open_existing(profile_path)?.ok_or(SshPeerPinError::Unavailable)
    }
    fn verify_roots(&self) -> Result<()> {
        self.profile
            .verify_private_directory()
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let current = PrivateDirectory::open_existing(&self.profile_path)
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        let directory = self
            .profile
            .open_entry_handle(OsStr::new(NAMESPACE))
            .and_then(|e| e.open_child_directory())
            .map_err(pin_failure(SshPeerPinError::Unavailable))?;
        if self.header.version != 1
            || current
                .directory_identity()
                .map_err(pin_failure(SshPeerPinError::Unavailable))?
                != self.header.profile_identity
            || self
                .profile
                .directory_identity()
                .map_err(pin_failure(SshPeerPinError::Unavailable))?
                != self.header.profile_identity
            || directory
                .directory_identity()
                .map_err(pin_failure(SshPeerPinError::Unavailable))?
                != self.header.directory_identity
            || self
                .directory
                .directory_identity()
                .map_err(pin_failure(SshPeerPinError::Unavailable))?
                != self.header.directory_identity
            || read::<Header>(&self.directory, HEADER, 8192)? != self.header
        {
            return Err(SshPeerPinError::ScopeChanged);
        }
        for (name, anchor, expected) in [
            (HEADER, &self.header_anchor, &self.header_identity),
            (LOCK, &self.lock_anchor, &self.header.lock_identity),
        ] {
            if self
                .directory
                .portable_regular_identity(OsStr::new(name))
                .map_err(pin_failure(SshPeerPinError::Unavailable))?
                != *expected
                || self
                    .directory
                    .portable_regular_handle_identity(anchor)
                    .map_err(pin_failure(SshPeerPinError::Unavailable))?
                    != *expected
            {
                return Err(SshPeerPinError::ScopeChanged);
            }
        }
        Ok(())
    }
    fn verify_actual_profile(&self, actual: &PeerSshNativeProfileV1) -> Result<()> {
        self.verify_roots()?;
        self.compare_actual_profile(actual)
    }
    fn compare_actual_profile(&self, actual: &PeerSshNativeProfileV1) -> Result<()> {
        if actual.profile_identity.as_str() != self.header.profile_identity {
            return Err(SshPeerPinError::ScopeChanged);
        }
        #[cfg(unix)]
        if actual.account_uid != unsafe { libc::geteuid() } {
            return Err(SshPeerPinError::ScopeChanged);
        }
        Ok(())
    }
    fn read_data(&self) -> Result<Data> {
        self.verify_roots()?;
        let _lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.header.lock_identity,
                PrivateLeaseMode::Shared,
            )
            .map_err(pin_failure(SshPeerPinError::Unavailable))?
            .ok_or(SshPeerPinError::Busy)?;
        self.read_locked()
    }
    fn read_locked(&self) -> Result<Data> {
        let data: Data = read(&self.directory, DATA, MAX_BYTES)?;
        if data.version != 1
            || data.profile_identity != self.header.profile_identity
            || data.revision > PEER_SSH_MAX_GENERATION
            || data.pins.len() > MAX_PINS
            || data.operations.len() > MAX_OPERATIONS
            || data.gateway_keys.len() > MAX_PINS
        {
            return Err(SshPeerPinError::Unavailable);
        }
        for (id, row) in &data.pins {
            if row.pin.validate().is_err()
                || row.pin.enrollment_id.as_str() != id
                || row.pin.native.profile_identity.as_str() != data.profile_identity
                || row.generation == 0
                || row.generation > PEER_SSH_MAX_GENERATION
                || row.generation < row.pin.generation
                || row.status == PeerSshPinStatusV1::Pinned && row.generation != row.pin.generation
                || row.status == PeerSshPinStatusV1::Revoked && row.generation <= row.pin.generation
            {
                return Err(SshPeerPinError::Unavailable);
            }
        }
        for (id, key) in &data.gateway_keys {
            if key.gateway_id.as_str() != id {
                return Err(SshPeerPinError::Unavailable);
            }
        }
        for (id, operation) in &data.operations {
            if operation.digest.len() != 32
                || operation.receipt.operation_id.as_str() != id
                || operation.receipt.version != 1
                || operation.receipt.revision == 0
                || operation.receipt.revision > data.revision
                || operation.receipt.generation == 0
                || operation.receipt.generation > PEER_SSH_MAX_GENERATION
                || !data
                    .pins
                    .contains_key(operation.receipt.enrollment_id.as_str())
            {
                return Err(SshPeerPinError::Unavailable);
            }
        }
        Ok(data)
    }
    fn check_row(&self, data: &Data, row: &Row, actual: &PeerSshNativeProfileV1) -> Result<()> {
        if row.status == PeerSshPinStatusV1::Revoked {
            return Err(SshPeerPinError::Revoked);
        }
        if row.pin.native != *actual {
            return Err(SshPeerPinError::ScopeChanged);
        }
        if data.gateway_keys.get(row.pin.gateway.gateway_id.as_str()) != Some(&row.pin.gateway) {
            return Err(SshPeerPinError::GenerationChanged);
        }
        Ok(())
    }
    pub fn revision(&self) -> Result<u64> {
        Ok(self.read_data()?.revision)
    }
    pub fn original_receipt(
        &self,
        operation_id: &PeerSshIdentityTextV1,
    ) -> Result<Option<PeerSshPinReceiptV1>> {
        Ok(self
            .read_data()?
            .operations
            .get(operation_id.as_str())
            .map(|operation| operation.receipt.clone()))
    }
    pub fn current_pin(
        self: &Arc<Self>,
        enrollment_id: &PeerSshIdentityTextV1,
        actual: &PeerSshNativeProfileV1,
    ) -> Result<Option<StoredSshPeerPin>> {
        self.compare_actual_profile(actual)?;
        let data = self.read_data()?;
        let Some(row) = data.pins.get(enrollment_id.as_str()) else {
            return Ok(None);
        };
        self.check_row(&data, row, actual)?;
        Ok(Some(StoredSshPeerPin {
            store: self.clone(),
            expected: row.pin.clone(),
        }))
    }

    /// Explicit OS-owner filesystem administration only. This method authenticates
    /// no JSON caller and returns a receipt, never a transport or routing owner.
    pub fn apply_explicit(
        profile_path: &Path,
        actual: &PeerSshNativeProfileV1,
        command: &PeerSshPinCommandV1,
    ) -> Result<PeerSshPinReceiptV1> {
        // A malformed command is reported as a scope change by contract; its
        // validation detail names the rejected pin field only.
        command
            .validate()
            .map_err(|_| SshPeerPinError::ScopeChanged)?;
        verify_profile_path(profile_path, actual)?;
        if let PeerSshPinActionV1::Authorize { enrollment } = &command.action
            && enrollment.native != *actual
        {
            return Err(SshPeerPinError::ScopeChanged);
        }
        let store = match Self::open_existing(profile_path)? {
            Some(store) => store,
            None if matches!(&command.action, PeerSshPinActionV1::Authorize { enrollment } if enrollment.generation == 1)
                && command.expected_revision == 0
                && may_attempt_legacy_kernel_capture(profile_path)? =>
            {
                Self::create_explicit(profile_path)?
            }
            None if !may_attempt_legacy_kernel_capture(profile_path)? => {
                return Err(SshPeerPinError::Unavailable);
            }
            None => return Err(SshPeerPinError::RevisionConflict),
        };
        store.verify_actual_profile(actual)?;
        let _lease = store
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &store.header.lock_identity,
                PrivateLeaseMode::Exclusive,
            )
            .map_err(pin_failure(SshPeerPinError::Unavailable))?
            .ok_or(SshPeerPinError::Busy)?;
        let mut data = store.read_locked()?;
        let operation_digest = digest(&SHA256, &encoded(command)?).as_ref().to_vec();
        if let Some(previous) = data.operations.get(command.operation_id.as_str()) {
            if previous.digest != operation_digest {
                return Err(SshPeerPinError::OperationConflict);
            }
            return Ok(previous.receipt.clone());
        }
        if data.revision != command.expected_revision {
            return Err(SshPeerPinError::RevisionConflict);
        }
        if data.operations.len() >= MAX_OPERATIONS {
            return Err(SshPeerPinError::Capacity);
        }
        let (enrollment_id, generation, status) = match &command.action {
            PeerSshPinActionV1::Authorize { enrollment } => {
                if enrollment.native != *actual {
                    return Err(SshPeerPinError::ScopeChanged);
                }
                let prior = data.pins.get(enrollment.enrollment_id.as_str());
                let generation = prior.map_or(Ok(1), |prior| next(prior.generation))?;
                if generation != enrollment.generation {
                    return Err(SshPeerPinError::GenerationChanged);
                }
                if prior.is_none() && data.pins.len() >= MAX_PINS {
                    return Err(SshPeerPinError::Capacity);
                }
                if let Some(key) = data
                    .gateway_keys
                    .get(enrollment.gateway.gateway_id.as_str())
                {
                    if enrollment.gateway.key_generation < key.key_generation
                        || enrollment.gateway.key_generation == key.key_generation
                            && enrollment.gateway != *key
                    {
                        return Err(SshPeerPinError::GenerationChanged);
                    }
                } else if data.gateway_keys.len() >= MAX_PINS {
                    return Err(SshPeerPinError::Capacity);
                }
                data.gateway_keys.insert(
                    enrollment.gateway.gateway_id.as_str().into(),
                    enrollment.gateway.clone(),
                );
                data.pins.insert(
                    enrollment.enrollment_id.as_str().into(),
                    Row {
                        pin: *enrollment.clone(),
                        generation,
                        status: PeerSshPinStatusV1::Pinned,
                    },
                );
                (
                    enrollment.enrollment_id.clone(),
                    generation,
                    PeerSshPinStatusV1::Pinned,
                )
            }
            PeerSshPinActionV1::Revoke {
                enrollment_id,
                expected_generation,
            } => {
                let row = data
                    .pins
                    .get_mut(enrollment_id.as_str())
                    .ok_or(SshPeerPinError::GenerationChanged)?;
                if row.generation != *expected_generation {
                    return Err(SshPeerPinError::GenerationChanged);
                }
                row.generation = next(row.generation)?;
                row.status = PeerSshPinStatusV1::Revoked;
                (enrollment_id.clone(), row.generation, row.status)
            }
        };
        data.revision = next(data.revision)?;
        let receipt = PeerSshPinReceiptV1 {
            version: 1,
            operation_id: command.operation_id.clone(),
            enrollment_id,
            revision: data.revision,
            generation,
            status,
        };
        data.operations.insert(
            command.operation_id.as_str().into(),
            Operation {
                digest: operation_digest,
                receipt: receipt.clone(),
            },
        );
        let bytes = encoded(&data)?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(SshPeerPinError::Capacity);
        }
        store.verify_roots()?;
        mark_adopted_explicit(&store.profile)?;
        store
            .directory
            .atomic_replace(OsStr::new(DATA), &bytes)
            .map_err(pin_failure(SshPeerPinError::PublishUnknown))?;
        store.verify_roots()?;
        Ok(receipt)
    }
}

#[cfg(test)]
#[path = "ssh_peer_pins/tests.rs"]
mod tests;
