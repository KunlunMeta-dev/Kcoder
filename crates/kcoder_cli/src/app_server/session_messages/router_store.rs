//! Native source routing facts. A signature is provenance, never a permission verdict.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{RetentionPrincipalV1, cross_session_router::*};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_state::cross_session_messages::CrossSessionMessageStore;
use kcoder_types::{
    cross_session_messages::{
        AgentMessageIntent, AgentMessageReceipt, AgentMessageStatus, valid_agent_message_id,
    },
    session_address::SessionAddressV1,
};
use ring::{
    rand::SystemRandom,
    signature::{self, Ed25519KeyPair, KeyPair},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[path = "router_store/archive.rs"]
mod archive;
#[path = "router_store/rate.rs"]
mod rate;
#[path = "router_store/source_list.rs"]
mod source_list;
pub use rate::SourcePrepareRatePolicy;

const HEADER: &str = "router-owner.json";
const KEY: &str = "router.pk8";
const LOCK: &str = "router.lock";
const DATA: &str = "router-operations.json";
const MAX_OPERATIONS: usize = 256;
const MAX_DATA_BYTES: u64 = 2 * 1024 * 1024;
const LOCK_WAIT: Duration = Duration::from_millis(50);
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(1);

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    target_id: String,
    identity_epoch: String,
    // Original namespace seed, also used by archive scopes and signed cursors.
    directory: String,
    principal: RetentionPrincipalV1,
    public_key: Vec<u8>,
    key_identity: PortableLeaseIdentity,
    lock_identity: PortableLeaseIdentity,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    version: u32,
    identity_epoch: String,
    operations: BTreeMap<String, PeerRouterOperationV1>,
    mailboxes: BTreeMap<String, String>,
    #[serde(default)]
    incoming: BTreeMap<String, IncomingPeerOperation>,
    #[serde(default)]
    source_history: BTreeMap<String, kcoder_state::PeerSourceHistoryReference>,
    #[serde(default)]
    source_prepare_rate: Option<rate::State>,
}

/// Immutable provenance captured on the authenticated private route. This is
/// deliberately not a stored authorization or permission to wake a receiver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IncomingPeerOperation {
    pub source_identity: PeerRouterIdentityV1,
    pub destination_identity: PeerRouterIdentityV1,
    pub attestation: SignedPeerMessageAttestationV1,
}
fn incoming_key(source: &SessionAddressV1, client_id: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(source, client_id))?)
    ))
}

/// Captured by a host from its own authenticated profile. Never deserializable.
pub struct NativePeerRouterStore {
    parent: PrivateDirectory,
    name: OsString,
    directory: PrivateDirectory,
    header: Header,
    header_identity: PortableLeaseIdentity,
    key_identity: PortableLeaseIdentity,
    header_anchor: File,
    key_anchor: File,
    lock_anchor: File,
    key: Ed25519KeyPair,
}

fn read(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Vec<u8>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(file.metadata()?.len() <= limit, "peer_router_data_limit");
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "peer_router_data_limit");
    Ok(bytes)
}
fn signed_bytes(claims: &PeerMessageAttestationClaimsV1) -> Result<Vec<u8>> {
    claims.validate().map_err(anyhow::Error::msg)?;
    let mut bytes = AGENT_MESSAGE_ATTESTATION_DOMAIN.to_vec();
    bytes.extend(serde_json::to_vec(claims)?);
    Ok(bytes)
}
pub fn verify_peer_attestation(
    proof: &SignedPeerMessageAttestationV1,
    source: &PeerRouterIdentityV1,
) -> Result<()> {
    source.validate().map_err(anyhow::Error::msg)?;
    ensure!(
        source.contains(&proof.claims.source_address)
            && source.identity_epoch == proof.claims.source_identity_epoch
            && proof.signature.len() == 64,
        "peer_router_source_changed"
    );
    signature::UnparsedPublicKey::new(&signature::ED25519, &source.public_key)
        .verify(&signed_bytes(&proof.claims)?, &proof.signature)
        .map_err(|_| anyhow::anyhow!("peer_router_invalid_signature"))
}

impl NativePeerRouterStore {
    /// Sign only this profile's fresh, separately pinned transport facts. This
    /// does not create an operation attestation or authorize a source/destination.
    #[cfg(target_os = "linux")]
    pub(crate) fn sign_ssh_native_facts(
        &self,
        claims: &ssh_enrollment::PeerSshChallengeClaimsV1,
    ) -> Result<ssh_enrollment::PeerSshSignatureV1> {
        self.verify()?;
        let native = &claims.enrollment.native;
        let identity = self.identity_from_header(native.workspace_id.as_str())?;
        ensure!(
            identity.target_id == native.target_id.as_str()
                && identity.identity_epoch == native.identity_epoch.as_str()
                && identity.public_key == native.public_key
                && self.parent.directory_identity()? == native.profile_identity.as_str(),
            "peer_ssh_native_fact_scope_changed"
        );
        #[cfg(unix)]
        ensure!(
            native.account_uid == unsafe { libc::geteuid() },
            "peer_ssh_native_fact_uid_changed"
        );
        let bytes = claims.native_signing_bytes()?;
        let signature = self
            .key
            .sign(&bytes)
            .as_ref()
            .to_vec()
            .try_into()
            .map_err(anyhow::Error::msg)?;
        self.verify()?;
        Ok(signature)
    }
    /// Enrollment signs only a fresh presence challenge. The caller must be
    /// the actual holder; a device/Gateway still checks current access on each
    /// operation. This proof cannot be used as a message attestation.
    pub fn sign_source_presence(
        &self,
        claims: &PeerSourcePresenceClaimsV1,
    ) -> Result<SignedPeerSourcePresenceV1> {
        self.verify()?;
        claims.validate().map_err(anyhow::Error::msg)?;
        let identity = self.identity_from_header(&claims.source.workspace_id)?;
        ensure!(
            identity.contains(&claims.source) && identity.identity_epoch == claims.identity_epoch,
            "peer_source_presence_scope_changed"
        );
        let mut bytes = PEER_SOURCE_PRESENCE_DOMAIN.to_vec();
        bytes.extend(serde_json::to_vec(claims)?);
        let signature = self.key.sign(&bytes).as_ref().to_vec();
        self.verify()?;
        Ok(SignedPeerSourcePresenceV1 {
            claims: claims.clone(),
            signature,
        })
    }
    /// Explicit authorized initialization; never repair an existing incomplete namespace.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        principal: &RetentionPrincipalV1,
    ) -> Result<Self> {
        parent.verify_private_directory()?;
        let directory = parent.create_private_child(name)?;
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| anyhow::anyhow!("peer_router_key_generation_failed"))?;
        let key = Ed25519KeyPair::from_pkcs8(document.as_ref())
            .map_err(|_| anyhow::anyhow!("peer_router_key_invalid"))?;
        directory.atomic_replace(OsStr::new(KEY), document.as_ref())?;
        let key_anchor = directory.open_single_link_regular_file(OsStr::new(KEY))?;
        let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
        let header = Header {
            version: 1,
            target_id: uuid::Uuid::new_v4().to_string(),
            identity_epoch: uuid::Uuid::new_v4().to_string(),
            directory: directory.directory_identity()?,
            principal: principal.clone(),
            public_key: key.public_key().as_ref().to_vec(),
            key_identity: directory.portable_regular_handle_identity(&key_anchor)?,
            lock_identity: directory.portable_regular_handle_identity(&lock)?,
        };
        let data = Data {
            version: 1,
            identity_epoch: header.identity_epoch.clone(),
            operations: BTreeMap::new(),
            mailboxes: BTreeMap::new(),
            incoming: BTreeMap::new(),
            source_history: BTreeMap::new(),
            source_prepare_rate: Some(rate::State::default()),
        };
        directory.atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&data)?)?;
        directory.atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
        directory.sync()?;
        Self::bind(parent, name, directory, principal)
    }
    /// Read-only open. Missing is separate from corruption, replacement or wrong owner.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        principal: &RetentionPrincipalV1,
    ) -> Result<Option<Self>> {
        parent.verify_private_directory()?;
        let entry = match parent.open_entry_handle(name) {
            Ok(entry) => entry,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        Self::bind(parent, name, entry.open_child_directory()?, principal).map(Some)
    }
    fn bind(
        parent: &PrivateDirectory,
        name: &OsStr,
        directory: PrivateDirectory,
        principal: &RetentionPrincipalV1,
    ) -> Result<Self> {
        let header: Header = serde_json::from_slice(&read(&directory, HEADER, 8192)?)?;
        ensure!(
            header.version == 1 && header.principal == *principal,
            "peer_router_owner_changed"
        );
        let key = Ed25519KeyPair::from_pkcs8(&read(&directory, KEY, 1024)?)
            .map_err(|_| anyhow::anyhow!("peer_router_key_invalid"))?;
        let header_anchor = directory.open_single_link_regular_file(OsStr::new(HEADER))?;
        let key_anchor = directory.open_single_link_regular_file(OsStr::new(KEY))?;
        let store = Self {
            parent: parent.duplicate_handle()?,
            name: name.to_owned(),
            header_identity: directory.portable_regular_handle_identity(&header_anchor)?,
            key_identity: directory.portable_regular_handle_identity(&key_anchor)?,
            header_anchor,
            key_anchor,
            lock_anchor: directory.open_single_link_regular_file(OsStr::new(LOCK))?,
            directory,
            header,
            key,
        };
        store.access(false, |_| Ok(((), false)))?;
        Ok(store)
    }
    pub fn identity(&self, workspace_id: &str) -> Result<PeerRouterIdentityV1> {
        self.verify()?;
        self.identity_from_header(workspace_id)
    }
    fn identity_from_header(&self, workspace_id: &str) -> Result<PeerRouterIdentityV1> {
        let identity = PeerRouterIdentityV1 {
            target_id: self.header.target_id.clone(),
            workspace_id: workspace_id.into(),
            principal: self.header.principal.clone(),
            public_key: self.header.public_key.clone(),
            identity_epoch: self.header.identity_epoch.clone(),
        };
        identity.validate().map_err(anyhow::Error::msg)?;
        Ok(identity)
    }
    fn verify(&self) -> Result<()> {
        self.parent.verify_private_directory()?;
        self.directory.verify_private_directory()?;
        let actual = self
            .parent
            .open_entry_handle(&self.name)?
            .open_child_directory()?;
        let header: Header = serde_json::from_slice(&read(&self.directory, HEADER, 8192)?)?;
        ensure!(
            header == self.header
                && actual.directory_identity()? == self.directory.directory_identity()?
                && header.public_key == self.key.public_key().as_ref(),
            "peer_router_namespace_changed"
        );
        for (name, anchor, identity) in [
            (HEADER, &self.header_anchor, &self.header_identity),
            (KEY, &self.key_anchor, &self.key_identity),
            (LOCK, &self.lock_anchor, &header.lock_identity),
        ] {
            ensure!(
                &self.directory.portable_regular_identity(OsStr::new(name))? == identity
                    && &self.directory.portable_regular_handle_identity(anchor)? == identity,
                "peer_router_namespace_changed"
            );
        }
        // Key material is small and checked before signing, never a full executable or history hash.
        let key = Ed25519KeyPair::from_pkcs8(&read(&self.directory, KEY, 1024)?)
            .map_err(|_| anyhow::anyhow!("peer_router_key_changed"))?;
        ensure!(
            key.public_key().as_ref() == self.header.public_key,
            "peer_router_key_changed"
        );
        Ok(())
    }
    fn validate_data(&self, data: &Data) -> Result<()> {
        if let Some(rate) = &data.source_prepare_rate {
            rate.validate(self)?;
        }
        ensure!(
            data.version == 1
                && data.identity_epoch == self.header.identity_epoch
                && data.operations.len() <= MAX_OPERATIONS * 2
                && data
                    .operations
                    .values()
                    .filter(|operation| !archive::terminal(operation))
                    .count()
                    <= MAX_OPERATIONS
                && data.mailboxes.len() <= MAX_OPERATIONS
                && data.incoming.len() <= MAX_OPERATIONS * 2,
            "peer_router_ledger_invalid"
        );
        ensure!(
            data.source_history.len() <= MAX_OPERATIONS * 2,
            "peer_router_source_history_capacity"
        );
        for (id, reference) in &data.source_history {
            reference.validate()?;
            let operation = data
                .operations
                .get(id)
                .context("peer_router_source_history_operation_missing")?;
            ensure!(
                reference.thread_id() == operation.source_address.thread_id,
                "peer_router_source_history_thread_changed"
            );
        }
        ensure!(
            data.mailboxes
                .iter()
                .all(|(workspace, identity)| valid_agent_message_id(workspace)
                    && !identity.is_empty()
                    && identity.len() <= 1024
                    && !identity.chars().any(char::is_control)),
            "peer_router_mailbox_binding_invalid"
        );
        for (id, operation) in &data.operations {
            self.validate_operation(id, operation)?;
        }
        for (key, incoming) in &data.incoming {
            self.validate_incoming(key, incoming)?;
        }

        Ok(())
    }
    fn validate_operation(&self, id: &str, operation: &PeerRouterOperationV1) -> Result<()> {
        let claims = &operation.attestation.claims;
        ensure!(
            id == operation.operation_id
                && id == claims.operation_id
                && operation.source_address == claims.source_address
                && operation.destination == claims.destination
                && operation.body_sha256 == claims.body_sha256,
            "peer_router_operation_invalid"
        );
        verify_peer_attestation(
            &operation.attestation,
            &self.identity_from_header(&claims.source_address.workspace_id)?,
        )?;
        if let Some(receipt) = &operation.receipt {
            validate_receipt(operation, receipt)?;
            ensure!(
                operation.stage == PeerRouterStageV1::Receipted,
                "peer_router_stage_invalid"
            );
        } else {
            ensure!(
                operation.stage != PeerRouterStageV1::Receipted,
                "peer_router_stage_invalid"
            );
        }
        Ok(())
    }
    fn validate_incoming(&self, key: &str, incoming: &IncomingPeerOperation) -> Result<()> {
        let claims = &incoming.attestation.claims;
        verify_peer_attestation(&incoming.attestation, &incoming.source_identity)?;
        incoming
            .destination_identity
            .validate()
            .map_err(anyhow::Error::msg)?;
        ensure!(
            key == incoming_key(&claims.source_address, &claims.client_message_id)?
                && incoming.destination_identity.contains(&claims.destination)
                && incoming.destination_identity.target_id == self.header.target_id
                && incoming.destination_identity.identity_epoch == self.header.identity_epoch
                && incoming.destination_identity.public_key == self.header.public_key,
            "peer_router_incoming_binding_changed"
        );
        Ok(())
    }
    fn acquire_namespace_lease(&self, write: bool) -> Result<kcoder_config::VerifiedPrivateLease> {
        self.verify()?;
        let deadline = Instant::now() + LOCK_WAIT;
        // Wait only for the original kernel lock. The action is executed once,
        // after fresh namespace validation; no side effect is retried here.
        let lease = loop {
            if let Some(lease) = self.directory.try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.header.lock_identity,
                if write {
                    PrivateLeaseMode::Exclusive
                } else {
                    PrivateLeaseMode::Shared
                },
            )? {
                break lease;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            ensure!(!remaining.is_zero(), "peer_router_busy");
            std::thread::sleep(remaining.min(LOCK_RETRY_INTERVAL));
        };
        self.verify()?;
        Ok(lease)
    }
    fn access<R>(
        &self,
        write: bool,
        action: impl FnOnce(&mut Data) -> Result<(R, bool)>,
    ) -> Result<R> {
        self.access_with_archive(write, |data, _| action(data))
    }
    #[cfg(test)]
    pub fn prepare(
        &self,
        operation_id: &str,
        source_address: SessionAddressV1,
        intent: &AgentMessageIntent,
    ) -> Result<PeerRouterOperationV1> {
        self.prepare_with_rate_policy(
            operation_id,
            source_address,
            intent,
            SourcePrepareRatePolicy::default(),
        )
    }
    pub fn prepare_with_rate_policy(
        &self,
        operation_id: &str,
        source_address: SessionAddressV1,
        intent: &AgentMessageIntent,
        policy: SourcePrepareRatePolicy,
    ) -> Result<PeerRouterOperationV1> {
        let now_ms = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
        self.prepare_at(operation_id, source_address, intent, policy, now_ms)
    }
    // The explicit clock is private to this implementation and deterministic
    // tests; no request, attestation or model can provide admission time.
    fn prepare_at(
        &self,
        operation_id: &str,
        source_address: SessionAddressV1,
        intent: &AgentMessageIntent,
        policy: SourcePrepareRatePolicy,
        now_ms: u64,
    ) -> Result<PeerRouterOperationV1> {
        ensure!(
            valid_agent_message_id(operation_id),
            "peer_router_invalid_operation"
        );
        intent.validate().map_err(anyhow::Error::msg)?;
        let destination = intent
            .target_address
            .clone()
            .context("peer_router_address_required")?;
        let identity = self.identity(&source_address.workspace_id)?;
        ensure!(
            identity.contains(&source_address),
            "peer_router_source_changed"
        );
        let claims = PeerMessageAttestationClaimsV1 {
            reply_to_message_id: intent.reply_to_message_id.clone(),
            version: 1,
            purpose: AGENT_MESSAGE_ROUTE_PURPOSE.into(),
            operation_id: operation_id.into(),
            source_address,
            destination,
            source_identity_epoch: identity.identity_epoch,
            client_message_id: intent.client_message_id.clone(),
            mode: intent.mode,
            expected_turn_id: intent.expected_turn_id.clone(),
            body_sha256: format!("{:x}", Sha256::digest(intent.text.as_bytes())),
        };
        let signature = self.key.sign(&signed_bytes(&claims)?).as_ref().to_vec();
        let operation = PeerRouterOperationV1 {
            operation_id: operation_id.into(),
            source_address: claims.source_address.clone(),
            destination: claims.destination.clone(),
            body_sha256: claims.body_sha256.clone(),
            stage: PeerRouterStageV1::Prepared,
            attestation: SignedPeerMessageAttestationV1 { claims, signature },
            receipt: None,
        };
        self.access_with_archive(true, |data, archive| {
            if let Some(tx) = archive {
                if let Some((old, _)) = self.archived_by_id(tx, operation_id)? {
                    ensure!(
                        old.attestation == operation.attestation,
                        "peer_router_intent_conflict"
                    );
                    return Ok((Ok(old), false));
                }
                ensure!(
                    self.archived_by_client(
                        tx,
                        &operation.source_address,
                        &operation.attestation.claims.client_message_id
                    )?
                    .is_none(),
                    "peer_router_client_identity_already_bound"
                );
            }
            if let Some(old) = data.operations.get(operation_id) {
                ensure!(
                    old.attestation == operation.attestation,
                    "peer_router_intent_conflict"
                );
                return Ok((Ok(old.clone()), false));
            }
            ensure!(
                data.operations
                    .values()
                    .filter(|operation| !archive::terminal(operation))
                    .count()
                    < MAX_OPERATIONS,
                "peer_router_capacity"
            );
            // Client identity is source-wide, including its frozen destination.
            ensure!(
                !data
                    .operations
                    .values()
                    .any(|old| old.source_address == operation.source_address
                        && old.attestation.claims.client_message_id
                            == operation.attestation.claims.client_message_id),
                "peer_router_client_identity_already_bound"
            );
            let initialized = data.source_prepare_rate.is_none();
            if initialized {
                data.source_prepare_rate = Some(rate::State::from_legacy(data, now_ms));
            }
            let next_rate = data
                .source_prepare_rate
                .as_ref()
                .context("peer_router_rate_state_missing")?
                .charge(&operation, intent.text.len(), policy, now_ms);
            let next_rate = match next_rate {
                Ok(next) => next,
                Err(error) => return Ok((Err(error), initialized)),
            };
            data.source_prepare_rate = Some(next_rate);
            data.operations
                .insert(operation_id.into(), operation.clone());
            Ok((Ok(operation), true))
        })?
    }
    pub fn read_operation(&self, operation_id: &str) -> Result<Option<PeerRouterOperationV1>> {
        ensure!(
            valid_agent_message_id(operation_id),
            "peer_router_invalid_operation"
        );
        self.access_with_archive(false, |data, archive| {
            let operation = if let Some(operation) = data.operations.get(operation_id) {
                Some(operation.clone())
            } else {
                archive
                    .map(|tx| self.archived_by_id(tx, operation_id))
                    .transpose()?
                    .flatten()
                    .map(|(operation, _)| operation)
            };
            Ok((operation, false))
        })
    }

    /// Store positive original-history facts, never an authorization verdict.
    /// Only a live native State witness can create this binding.
    pub fn record_source_history(
        &self,
        operation_id: &str,
        witness: &kcoder_state::PeerSourceAdmissionHistoryWitness,
    ) -> Result<()> {
        witness.verify_current()?;
        let reference = witness.reference().clone();
        self.access_with_archive(true, |data, archive| {
            if !data.operations.contains_key(operation_id) {
                let tx = archive.context("peer_router_source_history_operation_missing")?;
                let (operation, old) = self
                    .archived_by_id(tx, operation_id)?
                    .context("peer_router_source_history_operation_missing")?;
                ensure!(
                    reference.thread_id() == operation.source_address.thread_id,
                    "peer_router_source_history_thread_changed"
                );
                let previous = old.context("peer_router_archived_source_history_missing")?;
                if previous != reference {
                    kcoder_state::verify_peer_source_history_reference(
                        reference.history_path(),
                        &previous,
                    )?;
                }
                return Ok(((), false));
            }
            let operation = data
                .operations
                .get(operation_id)
                .context("peer_router_source_history_operation_missing")?;
            ensure!(
                reference.thread_id() == operation.source_address.thread_id,
                "peer_router_source_history_thread_changed"
            );
            if let Some(previous) = data.source_history.get(operation_id) {
                if previous != &reference {
                    // Retain the original admission boundary after ordinary
                    // appends; a changed incarnation/file/generation cannot rebind it.
                    kcoder_state::verify_peer_source_history_reference(
                        reference.history_path(),
                        previous,
                    )?;
                }
                return Ok(((), false));
            }
            ensure!(
                data.source_history.len() < MAX_OPERATIONS,
                "peer_router_source_history_capacity"
            );
            witness.verify_current()?;
            data.source_history.insert(operation_id.into(), reference);
            Ok(((), true))
        })?;
        witness.verify_current()
    }
    pub fn read_source_history(
        &self,
        operation_id: &str,
    ) -> Result<Option<kcoder_state::PeerSourceHistoryReference>> {
        ensure!(
            valid_agent_message_id(operation_id),
            "peer_router_invalid_operation"
        );
        self.access_with_archive(false, |data, archive| {
            let reference = if let Some(reference) = data.source_history.get(operation_id) {
                Some(reference.clone())
            } else {
                archive
                    .map(|tx| self.archived_by_id(tx, operation_id))
                    .transpose()?
                    .flatten()
                    .and_then(|(_, reference)| reference)
            };
            Ok((reference, false))
        })
    }

    /// Must precede enqueue. A later worker can recover the original signed
    /// origin, but must obtain fresh source/destination permission separately.
    pub fn remember_incoming(&self, incoming: IncomingPeerOperation) -> Result<()> {
        let claims = &incoming.attestation.claims;
        verify_peer_attestation(&incoming.attestation, &incoming.source_identity)?;
        let key = incoming_key(&claims.source_address, &claims.client_message_id)?;
        self.validate_incoming(&key, &incoming)?;
        self.access_requiring_archive(|data, archive| {
            if let Some(tx) = archive
                && let Some(old) = self.archived_incoming(tx, &key)?
            {
                ensure!(old == incoming, "peer_router_incoming_conflict");
                return Ok(((), false));
            }
            if let Some(old) = data.incoming.get(&key) {
                ensure!(old == &incoming, "peer_router_incoming_conflict");
                return Ok(((), false));
            }
            ensure!(
                data.incoming.len() < MAX_OPERATIONS * 2,
                "peer_router_incoming_capacity"
            );
            data.incoming.insert(key, incoming);
            Ok(((), true))
        })
    }
    /// Provenance only; callers must not treat this result as an allow verdict.
    pub fn read_incoming(
        &self,
        source: &SessionAddressV1,
        client_message_id: &str,
    ) -> Result<Option<IncomingPeerOperation>> {
        source.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            valid_agent_message_id(client_message_id),
            "peer_router_invalid_operation"
        );
        let key = incoming_key(source, client_message_id)?;
        self.access_with_archive(false, |data, archive| {
            let incoming = if let Some(incoming) = data.incoming.get(&key) {
                Some(incoming.clone())
            } else {
                archive
                    .map(|tx| self.archived_incoming(tx, &key))
                    .transpose()?
                    .flatten()
            };
            Ok((incoming, false))
        })
    }

    pub fn find_source_operation(
        &self,
        source: &SessionAddressV1,
        query: &kcoder_app_protocol::cross_session_messages::AgentMessageGetParams,
    ) -> Result<Option<PeerRouterOperationV1>> {
        source.validate().map_err(anyhow::Error::msg)?;
        query.validate().map_err(anyhow::Error::msg)?;
        self.access_with_archive(false, |data, archive| {
            let mut candidates = data
                .operations
                .values()
                .filter(|operation| {
                    &operation.source_address == source
                        && (query.client_message_id.as_deref()
                            == Some(&operation.attestation.claims.client_message_id)
                            || query.message_id.as_deref().is_some_and(|id| {
                                operation
                                    .receipt
                                    .as_ref()
                                    .is_some_and(|receipt| receipt.message_id == id)
                            }))
                })
                .take(2)
                .cloned()
                .collect::<Vec<_>>();
            if let Some(tx) = archive {
                let archived = if let Some(id) = query.client_message_id.as_deref() {
                    self.archived_by_client(tx, source, id)?
                } else {
                    self.archived_by_receipt(
                        tx,
                        source,
                        query
                            .message_id
                            .as_deref()
                            .context("peer_router_selector_missing")?,
                    )?
                };
                if let Some(operation) = archived {
                    candidates.push(operation);
                }
            }
            ensure!(
                candidates.len() <= 1,
                "peer_message_original_operation_ambiguous"
            );
            Ok((candidates.pop(), false))
        })
    }

    /// Open the original workspace queue. A committed missing namespace is an
    /// error even on a new process; never turn lost receipts into a fresh queue.
    pub fn workspace_mailbox(
        &self,
        workspace_id: &str,
        allow_create: bool,
    ) -> Result<Option<CrossSessionMessageStore>> {
        let identity = self.identity(workspace_id)?;
        let scope = kcoder_types::cross_session_messages::CrossSessionMessageScope {
            account_id: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    "kcoder.peer-message.account.v1",
                    &identity.target_id,
                    &identity.principal,
                ))?)
            ),
            target_id: identity.target_id,
            workspace_id: identity.workspace_id,
        };
        let name = OsString::from(format!("mailbox-{workspace_id}"));
        self.access(allow_create, |data| {
            if let Some(expected) = data.mailboxes.get(workspace_id) {
                let queue = CrossSessionMessageStore::open_in(&self.directory, &name, &scope)?
                    .context("peer_router_original_mailbox_missing")?;
                ensure!(
                    queue.namespace_identity()? == *expected,
                    "peer_router_mailbox_changed"
                );
                return Ok((Some(queue), false));
            }
            if !allow_create {
                return Ok((None, false));
            }
            ensure!(
                data.mailboxes.len() < MAX_OPERATIONS,
                "peer_router_mailbox_capacity"
            );
            let queue = CrossSessionMessageStore::create_in(&self.directory, &name, &scope)?;
            data.mailboxes
                .insert(workspace_id.into(), queue.namespace_identity()?);
            Ok((Some(queue), true))
        })
    }
    pub fn mark_dispatching(&self, operation_id: &str) -> Result<PeerRouterOperationV1> {
        self.access_with_archive(true, |data, archive| {
            if !data.operations.contains_key(operation_id) {
                let tx = archive.context("peer_router_operation_missing")?;
                return Ok((
                    self.archived_by_id(tx, operation_id)?
                        .context("peer_router_operation_missing")?
                        .0,
                    false,
                ));
            }
            let operation = data
                .operations
                .get_mut(operation_id)
                .context("peer_router_operation_missing")?;
            let changed = operation.stage == PeerRouterStageV1::Prepared;
            if changed {
                operation.stage = PeerRouterStageV1::Dispatching;
            }
            Ok((operation.clone(), changed))
        })
    }
    pub fn record_receipt(
        &self,
        operation_id: &str,
        receipt: AgentMessageReceipt,
    ) -> Result<PeerRouterOperationV1> {
        let unchanged = self.access_with_archive(false, |data, archive| {
            let operation = if let Some(operation) = data.operations.get(operation_id) {
                operation.clone()
            } else {
                self.archived_by_id(
                    archive.context("peer_router_operation_missing")?,
                    operation_id,
                )?
                .context("peer_router_operation_missing")?
                .0
            };
            ensure!(
                operation.stage != PeerRouterStageV1::Prepared,
                "peer_router_not_dispatched"
            );
            validate_receipt(&operation, &receipt)?;
            Ok((
                (operation.receipt.as_ref() == Some(&receipt)).then(|| operation.clone()),
                false,
            ))
        })?;
        if let Some(operation) = unchanged {
            return Ok(operation);
        }
        // Reopen and validate under an exclusive lease; the shared read above
        // is never carried across as a mutable snapshot or an allow verdict.
        self.access_with_archive(true, |data, archive| {
            if !data.operations.contains_key(operation_id) {
                let tx = archive.context("peer_router_operation_missing")?;
                let operation = self
                    .archived_by_id(tx, operation_id)?
                    .context("peer_router_operation_missing")?
                    .0;
                if operation.receipt.as_ref() == Some(&receipt) {
                    return Ok((operation, false));
                }
                let operation = self.record_archived_receipt(tx, &operation, receipt)?;
                return Ok((operation, true));
            }
            let operation = data
                .operations
                .get_mut(operation_id)
                .context("peer_router_operation_missing")?;
            ensure!(
                operation.stage != PeerRouterStageV1::Prepared,
                "peer_router_not_dispatched"
            );
            validate_receipt(operation, &receipt)?;
            if let Some(old) = &operation.receipt {
                ensure!(
                    old.message_id == receipt.message_id && receipt.revision >= old.revision,
                    "peer_router_receipt_conflict"
                );
                if receipt.revision == old.revision {
                    ensure!(old == &receipt, "peer_router_receipt_conflict");
                    return Ok((operation.clone(), false));
                }
                ensure!(
                    !matches!(
                        old.status,
                        AgentMessageStatus::Applied
                            | AgentMessageStatus::Rejected
                            | AgentMessageStatus::Expired
                    ) || old.status == receipt.status,
                    "peer_router_terminal_receipt_conflict"
                );
            }
            operation.receipt = Some(receipt);
            operation.stage = PeerRouterStageV1::Receipted;
            Ok((operation.clone(), true))
        })
    }
}
fn validate_receipt(
    operation: &PeerRouterOperationV1,
    receipt: &AgentMessageReceipt,
) -> Result<()> {
    ensure!(
        valid_agent_message_id(&receipt.message_id)
            && receipt.revision > 0
            && receipt.client_message_id == operation.attestation.claims.client_message_id
            && receipt.target_thread_id == operation.destination.thread_id
            && receipt.source_address.as_ref() == Some(&operation.source_address)
            && receipt.target_address.as_ref() == Some(&operation.destination)
            && receipt.reply_to_message_id == operation.attestation.claims.reply_to_message_id,
        "peer_router_receipt_scope_changed"
    );
    Ok(())
}

#[cfg(test)]
#[path = "router_store/tests.rs"]
mod tests;
