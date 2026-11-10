mod native_code_services;
pub use native_code_services::{AuthenticatedNativeCodeServiceSource, NativeCodeServicePermit};
mod journal_cache;
mod member_self_revocation;
use super::claims::{
    AuthenticatedDelegationPolicy, AuthenticatedDelegationSubject, DelegationClaims,
    DelegationPermit, SignedDelegation, SubjectBinding, canonical_resources, issue_intent, label,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use kcoder_types::integrations::core::{
    IntegrationDelegationAction, IntegrationDelegationPrepareParams, IntegrationDelegationStatus,
    IntegrationDelegationView, IntegrationEntityRef, IntegrationOwner, IntegrationRevisionRef,
    IntegrationScope,
};
pub use member_self_revocation::NativeMemberSelfRevocation;
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, fs::File, io::Read, sync::Mutex};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_JOURNAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 96 * 1024;
const MAX_RECORDS: usize = 8192;
const BINDING_FILE: &str = "issuer.json";
const KEY_FILE: &str = "issuer.pk8";
const LOCK_FILE: &str = "authority.lock";
const JOURNAL_FILE: &str = "delegations.jsonl";
const HEAD_FILE: &str = "head.json";

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    version: u32,
    issuer_id: String,
    directory_identity: String,
    owner: IntegrationOwner,
    initial_epoch: String,
    public_key: Vec<u8>,
    key_identity: PortableLeaseIdentity,
    lock_identity: PortableLeaseIdentity,
    journal_identity: PortableLeaseIdentity,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Head {
    version: u32,
    sequence: u64,
    digest: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    sequence: u64,
    previous_digest: String,
    event: Event,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    NativeCodeIssued {
        operation_id: String,
        intent: String,
        proof: Box<native_code_services::SignedNativeCodeService>,
    },
    NativeCodeRevoked {
        operation_id: String,
        intent: String,
        grant_id: String,
        expected_revision: u64,
        revoked_at_ms: u64,
    },
    Issued {
        operation_id: String,
        intent: String,
        proof: Box<SignedDelegation>,
    },
    Revoked {
        operation_id: String,
        intent: String,
        delegation_id: String,
        expected_revision: u64,
        revoked_at_ms: u64,
    },
    IdentityRevoked {
        operation_id: String,
        intent: String,
        previous_epoch: String,
        next_epoch: String,
        revoked_at_ms: u64,
    },
}

#[derive(Clone)]
struct Grant {
    proof: SignedDelegation,
    revision: u64,
    revoked: bool,
}

#[derive(Clone)]
struct Journal {
    epoch: String,
    identity_enabled: bool,
    grants: BTreeMap<String, Grant>,
    code_services: BTreeMap<String, native_code_services::NativeCodeGrant>,
    operations: BTreeMap<String, (String, String)>,
    sequence: u64,
    digest: String,
    bytes: usize,
}

/// Account-owned issuer with a fixed key, native file identities, and durable revocation.
/// Native hosts must additionally validate their captured parent namespace before use.
pub struct NativeDelegationAuthority {
    directory: PrivateDirectory,
    binding: Binding,
    key: Ed25519KeyPair,
    key_digest: [u8; 32],
    key_anchor: File,
    lock_anchor: File,
    journal_anchor: File,
    // The current head/file version is checked under the original OS lock.
    // No decision, expiration or revocation result is cached.
    verified_journal: Mutex<Option<journal_cache::VerifiedJournal>>,
    #[cfg(test)]
    journal_replays: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    journal_bytes_read: std::sync::atomic::AtomicUsize,
}

impl std::fmt::Debug for NativeDelegationAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NativeDelegationAuthority { issuer: native, secrets: redacted }")
    }
}

impl NativeDelegationAuthority {
    /// Only an explicitly authorized, pristine namespace may create an issuer.
    /// A missing committed issuer/key/journal must be opened as an error, never recreated.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent.create_private_child(name)?;
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| anyhow::anyhow!("DELEGATION_KEY_GENERATION_FAILED"))?;
        let key_bytes = Zeroizing::new(document.as_ref().to_vec());
        let key = Ed25519KeyPair::from_pkcs8(&key_bytes)
            .map_err(|_| anyhow::anyhow!("DELEGATION_KEY_INVALID"))?;
        directory.atomic_replace(OsStr::new(KEY_FILE), &key_bytes)?;
        directory.append(OsStr::new(LOCK_FILE), b"")?;
        directory.append(OsStr::new(JOURNAL_FILE), b"")?;
        let key_anchor = directory.open_single_link_regular_file(OsStr::new(KEY_FILE))?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK_FILE))?;
        let journal_anchor = directory.open_single_link_regular_file(OsStr::new(JOURNAL_FILE))?;
        let binding = Binding {
            version: 1,
            issuer_id: Uuid::new_v4().to_string(),
            directory_identity: directory.directory_identity()?,
            owner: IntegrationOwner::from(scope),
            initial_epoch: Uuid::new_v4().to_string(),
            public_key: key.public_key().as_ref().to_vec(),
            key_identity: directory.portable_regular_handle_identity(&key_anchor)?,
            lock_identity: directory.portable_regular_handle_identity(&lock_anchor)?,
            journal_identity: directory.portable_regular_handle_identity(&journal_anchor)?,
        };
        let head = Head {
            version: 1,
            sequence: 0,
            digest: binding_digest(&binding)?,
        };
        directory.atomic_replace(OsStr::new(HEAD_FILE), &serde_json::to_vec(&head)?)?;
        directory.atomic_replace(OsStr::new(BINDING_FILE), &serde_json::to_vec(&binding)?)?;
        directory.sync()?;
        let authority = Self {
            directory,
            binding,
            key,
            key_digest: Sha256::digest(&key_bytes[..]).into(),
            key_anchor,
            lock_anchor,
            journal_anchor,
            verified_journal: Mutex::new(None),
            #[cfg(test)]
            journal_replays: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            journal_bytes_read: std::sync::atomic::AtomicUsize::new(0),
        };
        authority.verify_storage()?;
        Ok(authority)
    }

    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent.open_entry_handle(name)?.open_child_directory()?;
        let binding: Binding =
            serde_json::from_slice(&read_file(&directory, BINDING_FILE, MAX_RECORD_BYTES)?)
                .map_err(|_| anyhow::anyhow!("DELEGATION_BINDING_INVALID"))?;
        ensure!(
            binding.version == 1 && binding.owner == IntegrationOwner::from(scope),
            "DELEGATION_OWNER_MISMATCH"
        );
        let key_bytes = Zeroizing::new(read_file(&directory, KEY_FILE, 1024)?);
        let key = Ed25519KeyPair::from_pkcs8(&key_bytes)
            .map_err(|_| anyhow::anyhow!("DELEGATION_KEY_INVALID"))?;
        let key_anchor = directory.open_single_link_regular_file(OsStr::new(KEY_FILE))?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK_FILE))?;
        let journal_anchor = directory.open_single_link_regular_file(OsStr::new(JOURNAL_FILE))?;
        let authority = Self {
            directory,
            binding,
            key,
            key_digest: Sha256::digest(&key_bytes[..]).into(),
            key_anchor,
            lock_anchor,
            journal_anchor,
            verified_journal: Mutex::new(None),
            #[cfg(test)]
            journal_replays: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            journal_bytes_read: std::sync::atomic::AtomicUsize::new(0),
        };
        let _lock = authority.lock(PrivateLeaseMode::Shared)?;
        authority.read_journal()?;
        Ok(authority)
    }

    pub fn storage_directory_identity(&self) -> Result<String> {
        self.verify_storage()?;
        self.directory.directory_identity()
    }

    pub fn issue(
        &self,
        operation_id: &str,
        params: &IntegrationDelegationPrepareParams,
        subject: &AuthenticatedDelegationSubject,
        policy: &AuthenticatedDelegationPolicy,
        now_ms: u64,
    ) -> Result<(IntegrationDelegationView, SignedDelegation)> {
        label(operation_id)?;
        params.validate()?;
        subject.validate()?;
        ensure!(
            subject.connection_ref.id == params.connection_id
                && subject.observed_subject_ref == params.observed_subject_ref,
            "DELEGATION_OBSERVATION_MISMATCH"
        );
        self.check_owner(policy)?;
        policy.check(&params.actions, &params.resource_refs)?;
        let intent = issue_intent(params, subject, policy)?;
        let _lock = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut journal = self.read_journal()?;
        if let Some((prior_intent, id)) = journal.operations.get(operation_id) {
            ensure!(prior_intent == &intent, "DELEGATION_INTENT_CONFLICT");
            let grant = journal
                .grants
                .get(id)
                .context("DELEGATION_OPERATION_INVALID")?;
            return Ok((view(grant, &journal.epoch, now_ms), grant.proof.clone()));
        }
        ensure!(journal.identity_enabled, "DELEGATION_IDENTITY_DISABLED");
        let expires_at_ms = params
            .expires_in_ms
            .deadline(now_ms)
            .context("DELEGATION_TIME_OVERFLOW")?;
        let claims = DelegationClaims {
            version: 1,
            issuer_id: self.binding.issuer_id.clone(),
            delegation_id: Uuid::new_v4().to_string(),
            nonce: Uuid::new_v4().to_string(),
            owner: self.binding.owner.clone(),
            purpose: params.purpose,
            audience: policy.scope.target_id.clone(),
            identity_epoch: journal.epoch.clone(),
            identity_generation: policy.scope.identity_generation.clone(),
            target_revision: policy.scope.target_revision.clone(),
            policy_revision: policy.revision.clone(),
            subject: SubjectBinding::from(subject),
            actions: params.actions.clone(),
            resource_refs: canonical_resources(&params.resource_refs)?,
            issued_at_ms: now_ms,
            expires_at_ms,
            service_lease: None,
        };
        let proof = SignedDelegation::sign(claims, &self.key)?;
        let result = view(
            &Grant {
                proof: proof.clone(),
                revision: 1,
                revoked: false,
            },
            &journal.epoch,
            now_ms,
        );
        self.commit(
            &mut journal,
            Event::Issued {
                operation_id: operation_id.into(),
                intent,
                proof: Box::new(proof.clone()),
            },
        )?;
        Ok((result, proof))
    }

    pub fn read(
        &self,
        delegation_id: &str,
        now_ms: u64,
    ) -> Result<Option<IntegrationDelegationView>> {
        label(delegation_id)?;
        let _lock = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        Ok(journal
            .grants
            .get(delegation_id)
            .map(|grant| view(grant, &journal.epoch, now_ms)))
    }

    pub fn read_issue_operation(
        &self,
        operation_id: &str,
        now_ms: u64,
    ) -> Result<Option<IntegrationDelegationView>> {
        label(operation_id)?;
        let _lock = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        let Some((_, id)) = journal.operations.get(operation_id) else {
            return Ok(None);
        };
        Ok(journal
            .grants
            .get(id)
            .map(|grant| view(grant, &journal.epoch, now_ms)))
    }

    /// Resolves only an already committed private proof; it never renews or issues one.
    pub fn read_private_proof(
        &self,
        reference: &IntegrationRevisionRef,
    ) -> Result<SignedDelegation> {
        reference.validate()?;
        let _lock = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        let grant = journal
            .grants
            .get(&reference.id)
            .context("DELEGATION_NOT_FOUND")?;
        ensure!(
            grant.revision.to_string() == reference.revision,
            "DELEGATION_REVISION_CONFLICT"
        );
        Ok(grant.proof.clone())
    }

    pub fn authorize(
        &self,
        proof: &SignedDelegation,
        policy: &AuthenticatedDelegationPolicy,
        subject: &AuthenticatedDelegationSubject,
        action: IntegrationDelegationAction,
        resources: &[IntegrationEntityRef],
        now_ms: u64,
    ) -> Result<DelegationPermit> {
        self.check_owner(policy)?;
        subject.validate()?;
        let resources = canonical_resources(resources)?;
        ensure!(
            !resources.is_empty() && resources.len() <= 32,
            "DELEGATION_RESOURCES_REQUIRED"
        );
        let actions = [action].into_iter().collect();
        policy.check(&actions, &resources)?;
        let _lock = self.lock(PrivateLeaseMode::Shared)?;
        let journal = self.read_journal()?;
        proof.verify(&self.key)?;
        let grant = journal
            .grants
            .get(&proof.claims.delegation_id)
            .context("DELEGATION_NOT_FOUND")?;
        ensure!(grant.proof == *proof, "DELEGATION_ORIGINAL_PROOF_MISMATCH");
        self.authorize_committed(&journal, grant, policy, subject, action, &resources, now_ms)?;
        Ok(DelegationPermit {
            proof: proof.clone(),
            action,
            resource_refs: resources,
        })
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Keep scope, subject, action and the exact resources explicit"
    )]
    fn authorize_committed(
        &self,
        journal: &Journal,
        grant: &Grant,
        policy: &AuthenticatedDelegationPolicy,
        subject: &AuthenticatedDelegationSubject,
        action: IntegrationDelegationAction,
        resources: &[IntegrationEntityRef],
        now_ms: u64,
    ) -> Result<()> {
        let claims = &grant.proof.claims;
        ensure!(claims.service_lease.is_none(), "DELEGATION_SERVICE_RETIRED");
        ensure!(
            journal.identity_enabled && !grant.revoked && claims.identity_epoch == journal.epoch,
            "DELEGATION_REVOKED"
        );
        ensure!(
            claims.issued_at_ms <= now_ms && claims.expires_at_ms.active_at(now_ms),
            "DELEGATION_EXPIRED"
        );
        ensure!(
            claims.issuer_id == self.binding.issuer_id
                && claims.owner == self.binding.owner
                && claims.audience == policy.scope.target_id
                && claims.identity_generation == policy.scope.identity_generation
                && claims.target_revision == policy.scope.target_revision
                && claims.policy_revision == policy.revision,
            "DELEGATION_CURRENT_POLICY_MISMATCH"
        );
        ensure!(
            claims.subject.same_principal(subject),
            "DELEGATION_SUBJECT_CHANGED"
        );
        ensure!(
            claims.actions.contains(&action)
                && resources
                    .iter()
                    .all(|item| claims.resource_refs.contains(item)),
            "DELEGATION_SCOPE_DENIED"
        );
        Ok(())
    }

    pub fn revalidate(
        &self,
        permit: &DelegationPermit,
        policy: &AuthenticatedDelegationPolicy,
        subject: &AuthenticatedDelegationSubject,
        now_ms: u64,
    ) -> Result<()> {
        self.authorize(
            &permit.proof,
            policy,
            subject,
            permit.action,
            &permit.resource_refs,
            now_ms,
        )
        .map(|_| ())
    }

    /// Revocation is durable before the host signals cancellation of owned runtime tasks.
    /// This method does not execute or claim to settle those cancellations.
    pub fn revoke(
        &self,
        operation_id: &str,
        delegation_id: &str,
        expected_revision: &str,
        now_ms: u64,
    ) -> Result<IntegrationDelegationView> {
        label(operation_id)?;
        label(delegation_id)?;
        let expected: u64 = expected_revision
            .parse()
            .ok()
            .filter(|value| *value > 0)
            .context("DELEGATION_REVISION_INVALID")?;
        let intent = digest(&serde_json::to_vec(&("revoke", delegation_id, expected))?);
        let _lock = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut journal = self.read_journal()?;
        if let Some((prior, id)) = journal.operations.get(operation_id) {
            ensure!(
                prior == &intent && id == delegation_id,
                "DELEGATION_INTENT_CONFLICT"
            );
            return Ok(view(
                journal
                    .grants
                    .get(id)
                    .context("DELEGATION_OPERATION_INVALID")?,
                &journal.epoch,
                now_ms,
            ));
        }
        let grant = journal
            .grants
            .get(delegation_id)
            .context("DELEGATION_NOT_FOUND")?;
        ensure!(
            grant.revision == expected && !grant.revoked,
            "DELEGATION_REVISION_CONFLICT"
        );
        self.commit(
            &mut journal,
            Event::Revoked {
                operation_id: operation_id.into(),
                intent,
                delegation_id: delegation_id.into(),
                expected_revision: expected,
                revoked_at_ms: now_ms,
            },
        )?;
        let journal = self.read_journal()?;
        Ok(view(
            journal
                .grants
                .get(delegation_id)
                .context("DELEGATION_NOT_FOUND")?,
            &journal.epoch,
            now_ms,
        ))
    }

    /// Account/SSO disable must invoke this native management operation. Reopening
    /// the issuer preserves the revoked epoch and cannot reactivate old sessions.
    pub fn revoke_identity(&self, operation_id: &str, now_ms: u64) -> Result<()> {
        label(operation_id)?;
        let intent = digest(b"identity_revoke");
        let _lock = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut journal = self.read_journal()?;
        if let Some((prior, _)) = journal.operations.get(operation_id) {
            ensure!(prior == &intent, "DELEGATION_INTENT_CONFLICT");
            return Ok(());
        }
        let previous_epoch = journal.epoch.clone();
        self.commit(
            &mut journal,
            Event::IdentityRevoked {
                operation_id: operation_id.into(),
                intent,
                previous_epoch,
                next_epoch: Uuid::new_v4().to_string(),
                revoked_at_ms: now_ms,
            },
        )
    }

    fn check_owner(&self, policy: &AuthenticatedDelegationPolicy) -> Result<()> {
        policy.scope.validate()?;
        ensure!(
            IntegrationOwner::from(&policy.scope) == self.binding.owner,
            "DELEGATION_OWNER_MISMATCH"
        );
        Ok(())
    }

    fn lock(&self, mode: PrivateLeaseMode) -> Result<VerifiedPrivateLease> {
        self.verify_storage()?;
        let lock = self
            .directory
            .try_existing_portable_lock(OsStr::new(LOCK_FILE), &self.binding.lock_identity, mode)?
            .context("DELEGATION_AUTHORITY_BUSY")?;
        // The process may retain this issuer between calls. Reject an in-place
        // key change as well as a replaced key file before using its authority.
        let bytes = Zeroizing::new(read_file(&self.directory, KEY_FILE, 1024)?);
        let current: [u8; 32] = Sha256::digest(&bytes[..]).into();
        ensure!(current == self.key_digest, "DELEGATION_KEY_CHANGED");
        Ok(lock)
    }

    fn verify_storage(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        let binding: Binding =
            serde_json::from_slice(&read_file(&self.directory, BINDING_FILE, MAX_RECORD_BYTES)?)
                .map_err(|_| anyhow::anyhow!("DELEGATION_BINDING_INVALID"))?;
        ensure!(
            binding == self.binding
                && binding.directory_identity == self.directory.directory_identity()?
                && binding.public_key == self.key.public_key().as_ref(),
            "DELEGATION_STORAGE_CHANGED"
        );
        for (name, file, expected) in [
            (KEY_FILE, &self.key_anchor, &binding.key_identity),
            (LOCK_FILE, &self.lock_anchor, &binding.lock_identity),
            (
                JOURNAL_FILE,
                &self.journal_anchor,
                &binding.journal_identity,
            ),
        ] {
            ensure!(
                &self.directory.portable_regular_handle_identity(file)? == expected
                    && &self.directory.portable_regular_identity(OsStr::new(name))? == expected,
                "DELEGATION_STORAGE_CHANGED"
            );
        }
        Ok(())
    }

    fn read_journal(&self) -> Result<Journal> {
        self.verify_storage()?;
        let head_bytes = read_file(&self.directory, HEAD_FILE, MAX_RECORD_BYTES)?;
        let head: Head = serde_json::from_slice(&head_bytes)
            .map_err(|_| anyhow::anyhow!("DELEGATION_HEAD_INVALID"))?;
        ensure!(head.version == 1, "DELEGATION_HEAD_INVALID");
        let bytes = read_file(&self.directory, JOURNAL_FILE, MAX_JOURNAL_BYTES)?;
        #[cfg(test)]
        self.journal_bytes_read
            .fetch_add(bytes.len(), std::sync::atomic::Ordering::Relaxed);
        let mut verified = self
            .verified_journal
            .lock()
            .map_err(|_| anyhow::anyhow!("DELEGATION_JOURNAL_CACHE_UNAVAILABLE"))?;
        if let Some(old) = &*verified
            && old.head == head_bytes
            && old.bytes == bytes
        {
            return Ok(old.state.clone());
        }
        // TODO(channel-latency): incrementally consume committed journal tails.
        // Compare actual current bytes, not file times, before reusing a parsed
        // snapshot. This also covers coarse timestamps and clock adjustments.
        #[cfg(test)]
        self.journal_replays
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        ensure!(
            bytes.is_empty() || bytes.last() == Some(&b'\n'),
            "DELEGATION_JOURNAL_INCOMPLETE"
        );
        let mut journal = Journal {
            epoch: self.binding.initial_epoch.clone(),
            identity_enabled: true,
            grants: BTreeMap::new(),
            code_services: BTreeMap::new(),
            operations: BTreeMap::new(),
            sequence: 0,
            digest: binding_digest(&self.binding)?,
            bytes: bytes.len(),
        };
        let mut head_seen = head.sequence == 0 && head.digest == journal.digest;
        let records = bytes.strip_suffix(b"\n").unwrap_or(&[]);
        for line in records
            .split(|value| *value == b'\n')
            .filter(|_| !bytes.is_empty())
        {
            ensure!(
                line.len() <= MAX_RECORD_BYTES && journal.sequence < MAX_RECORDS as u64,
                "DELEGATION_JOURNAL_TOO_LARGE"
            );
            let entry: Entry = serde_json::from_slice(line)
                .map_err(|_| anyhow::anyhow!("DELEGATION_JOURNAL_INVALID"))?;
            ensure!(
                entry.sequence == journal.sequence + 1 && entry.previous_digest == journal.digest,
                "DELEGATION_JOURNAL_CHAIN_INVALID"
            );
            self.apply_event(&mut journal, entry.event)?;
            journal.sequence = entry.sequence;
            journal.digest = digest(line);
            if journal.sequence == head.sequence && journal.digest == head.digest {
                head_seen = true;
            }
        }
        ensure!(head_seen, "DELEGATION_COMMITTED_HISTORY_MISSING");
        *verified = Some(journal_cache::VerifiedJournal {
            head: head_bytes,
            bytes,
            state: journal.clone(),
        });
        Ok(journal)
    }

    fn apply_event(&self, journal: &mut Journal, event: Event) -> Result<()> {
        let (operation_id, intent, id) = match event {
            Event::NativeCodeIssued {
                operation_id,
                intent,
                proof,
            } => self.apply_native_code_issue(journal, operation_id, intent, *proof)?,
            Event::NativeCodeRevoked {
                operation_id,
                intent,
                grant_id,
                expected_revision,
                revoked_at_ms: _,
            } => self.apply_native_code_revoke(
                journal,
                operation_id,
                intent,
                grant_id,
                expected_revision,
            )?,
            Event::Issued {
                operation_id,
                intent,
                proof,
            } => {
                proof.verify(&self.key)?;
                let claims = &proof.claims;
                ensure!(
                    claims.version == 1
                        && claims.issuer_id == self.binding.issuer_id
                        && claims.owner == self.binding.owner
                        && claims.identity_epoch == journal.epoch
                        && claims.audience == self.binding.owner.target_id
                        && claims.expires_at_ms.valid_issuance(claims.issued_at_ms)
                        && !claims.actions.is_empty()
                        && !claims.resource_refs.is_empty()
                        && claims.resource_refs.len() <= 32,
                    "DELEGATION_JOURNAL_CLAIMS_INVALID"
                );
                ensure!(
                    claims
                        .service_lease
                        .as_ref()
                        .is_none_or(|service| service.operation_id == operation_id),
                    "SERVICE_LEASE_ORIGINAL_OPERATION_MISMATCH"
                );
                let id = claims.delegation_id.clone();
                ensure!(
                    !journal.grants.contains_key(&id),
                    "DELEGATION_JOURNAL_DUPLICATE_GRANT"
                );
                journal.grants.insert(
                    id.clone(),
                    Grant {
                        proof: *proof,
                        revision: 1,
                        revoked: false,
                    },
                );
                (operation_id, intent, id)
            }
            Event::Revoked {
                operation_id,
                intent,
                delegation_id,
                expected_revision,
                revoked_at_ms: _,
            } => {
                let grant = journal
                    .grants
                    .get_mut(&delegation_id)
                    .context("DELEGATION_JOURNAL_UNKNOWN_GRANT")?;
                ensure!(
                    !grant.revoked && grant.revision == expected_revision,
                    "DELEGATION_JOURNAL_REVISION_INVALID"
                );
                grant.revoked = true;
                grant.revision = grant
                    .revision
                    .checked_add(1)
                    .context("DELEGATION_REVISION_OVERFLOW")?;
                (operation_id, intent, delegation_id)
            }
            Event::IdentityRevoked {
                operation_id,
                intent,
                previous_epoch,
                next_epoch,
                revoked_at_ms: _,
            } => {
                ensure!(
                    previous_epoch == journal.epoch && previous_epoch != next_epoch,
                    "DELEGATION_JOURNAL_EPOCH_INVALID"
                );
                label(&next_epoch)?;
                journal.epoch = next_epoch;
                journal.identity_enabled = false;
                (operation_id, intent, String::new())
            }
        };
        label(&operation_id)?;
        ensure!(
            intent.len() == 64 && intent.bytes().all(|value| value.is_ascii_hexdigit()),
            "DELEGATION_JOURNAL_INTENT_INVALID"
        );
        ensure!(
            journal
                .operations
                .insert(operation_id, (intent, id))
                .is_none(),
            "DELEGATION_JOURNAL_DUPLICATE_OPERATION"
        );
        Ok(())
    }

    fn commit(&self, journal: &mut Journal, event: Event) -> Result<()> {
        ensure!(
            journal.sequence < MAX_RECORDS as u64,
            "DELEGATION_JOURNAL_FULL"
        );
        let entry = Entry {
            sequence: journal.sequence + 1,
            previous_digest: journal.digest.clone(),
            event,
        };
        let mut bytes = serde_json::to_vec(&entry)?;
        ensure!(
            bytes.len() <= MAX_RECORD_BYTES && journal.bytes + bytes.len() < MAX_JOURNAL_BYTES,
            "DELEGATION_JOURNAL_FULL"
        );
        let head = Head {
            version: 1,
            sequence: entry.sequence,
            digest: digest(&bytes),
        };
        bytes.push(b'\n');
        self.verify_storage()?;
        // Append through the held, verified original journal, never O_CREAT on a missing log.
        let mut file = self
            .directory
            .open_read_write_file(OsStr::new(JOURNAL_FILE), false)?;
        ensure!(
            self.directory.portable_regular_handle_identity(&file)?
                == self.binding.journal_identity,
            "DELEGATION_STORAGE_CHANGED"
        );
        use std::io::{Seek, SeekFrom, Write};
        ensure!(
            file.seek(SeekFrom::End(0))? == journal.bytes as u64,
            "DELEGATION_JOURNAL_CHANGED"
        );
        file.write_all(&bytes)?;
        file.sync_all()?;
        // A lost head update leaves a complete original event available for reconciliation;
        // a truncated committed journal cannot match its independently persisted head.
        self.directory
            .atomic_replace(OsStr::new(HEAD_FILE), &serde_json::to_vec(&head)?)?;
        self.directory.sync()
    }
}

fn view(grant: &Grant, epoch: &str, now_ms: u64) -> IntegrationDelegationView {
    IntegrationDelegationView {
        delegation_ref: IntegrationRevisionRef {
            id: grant.proof.claims.delegation_id.clone(),
            revision: grant.revision.to_string(),
        },
        status: if grant.revoked
            || grant.proof.claims.identity_epoch != epoch
            || grant.proof.claims.service_lease.is_some()
        {
            IntegrationDelegationStatus::Revoked
        } else if now_ms < grant.proof.claims.issued_at_ms
            || !grant.proof.claims.expires_at_ms.active_at(now_ms)
        {
            IntegrationDelegationStatus::Expired
        } else {
            IntegrationDelegationStatus::Active
        },
        expires_at_ms: grant.proof.claims.expires_at_ms,
        policy_revision: grant.proof.claims.policy_revision.clone(),
    }
}

fn binding_digest(binding: &Binding) -> Result<String> {
    Ok(digest(&serde_json::to_vec(binding)?))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read_file(directory: &PrivateDirectory, name: &str, limit: usize) -> Result<Vec<u8>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "DELEGATION_STORAGE_TOO_LARGE");
    Ok(bytes)
}

#[cfg(test)]
mod tests;
