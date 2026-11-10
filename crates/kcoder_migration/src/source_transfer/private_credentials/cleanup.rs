//! Release only the original transport key, after publication ownership is settled.
use super::super::storage as ordinary;
use super::{
    crypto,
    model::*,
    storage,
    target::{self, KeyIntent, PublicationClaim, ReceivedPrivateCredentialBinding},
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use kcoder_config::{CredentialBackend, PortableLeaseIdentity, PrivateDirectory};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteIntent {
    fingerprint: String,
    account: Option<String>,
    file_identity: Option<PortableLeaseIdentity>,
}

/// An unused, original offer can be released without inventing an accepted envelope.
pub fn release_private_credential_offer_key(
    target: &super::super::IncomingTransfers,
    authenticated_source: &super::super::TransferAuthority,
    receipt: &super::super::TransferReceipt,
    offer: &PrivateCredentialOffer,
    backend: &dyn CredentialBackend,
) -> Result<()> {
    let store = target::existing_offer_store(target, authenticated_source, receipt, offer)?;
    let operation = storage::operation(
        &store,
        "target",
        &offer.context,
        &target::ordinary_context_digest(&offer.context)?,
        false,
    )?;
    ensure!(
        !operation.started("publication_started")? && !operation.reserved_for_preparation()?,
        "private_credentials_publication_unsettled"
    );
    release(&operation, &offer.context, backend)
}

impl ReceivedPrivateCredentialBinding {
    /// No publication intent may exist. Cancellation alone never proves this.
    pub fn release_unpublished_key(
        &self,
        profile: &std::path::Path,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        let store = self.reopen_secret(profile)?;
        let operation = storage::operation(
            &store,
            "target",
            self.context(),
            &target::ordinary_context_digest(self.context())?,
            false,
        )?;
        ensure!(
            !operation.started("publication_started")? && !operation.reserved_for_preparation()?,
            "private_credentials_publication_unsettled"
        );
        release(&operation, self.context(), backend)
    }
    pub(crate) fn publication_claim(&self, profile: &std::path::Path) -> Result<PublicationClaim> {
        let store = self.reopen_secret(profile)?;
        let operation = storage::operation(
            &store,
            "target",
            self.context(),
            &target::ordinary_context_digest(self.context())?,
            false,
        )?;
        ensure!(
            operation.started("publication_started")?,
            "private_credentials_publication_unsettled"
        );
        storage::json(&operation.directory, "publication.json")
    }
    // Only MigrationStore may prove the original group and all original refs are undone.
    pub(crate) fn release_undone_key(
        &self,
        profile: &std::path::Path,
        claim: &PublicationClaim,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        let store = self.reopen_secret(profile)?;
        let operation = storage::operation(
            &store,
            "target",
            self.context(),
            &target::ordinary_context_digest(self.context())?,
            false,
        )?;
        let original: PublicationClaim = storage::json(&operation.directory, "publication.json")?;
        ensure!(
            &original == claim,
            "private_credentials_publication_binding_changed"
        );
        release(&operation, self.context(), backend)
    }
}

fn release(
    operation: &storage::Operation,
    context: &PrivateCredentialContext,
    backend: &dyn CredentialBackend,
) -> Result<()> {
    let directory = &operation.directory;
    let offer: PrivateCredentialOffer = storage::json(directory, "offer.json")?;
    ensure!(
        &offer.context == context,
        "private_credentials_binding_changed"
    );
    let key: KeyIntent = storage::json(directory, "key-intent.json")?;
    ensure!(
        key.public_key == offer.public_key,
        "private_credentials_key_unknown"
    );
    if let Some(account) = &key.account {
        ensure!(
            *account
                == format!(
                    "migration-private-{}",
                    uuid::Uuid::parse_str(&context.offer_id)?.simple()
                ),
            "private_credentials_key_unknown"
        );
    }
    let started = operation.started("key_delete_started")?;
    if !started {
        // Verify the exact original value before recording any deletion authority.
        target::read_key(directory, &offer, backend)?;
        let file_identity = if key.account.is_none() {
            let proof: storage::BlobProof =
                ordinary::load(directory, "private-key.bin.proof.json")?
                    .context("private_credentials_key_unknown")?;
            Some(proof.identity)
        } else {
            None
        };
        operation.mark("key_delete_started")?;
        storage::publish_json(
            directory,
            "key-delete.json",
            &DeleteIntent {
                fingerprint: key.fingerprint.clone(),
                account: key.account.clone(),
                file_identity,
            },
        )?;
    }
    let intent: DeleteIntent = storage::json(directory, "key-delete.json")?;
    ensure!(
        intent.fingerprint == key.fingerprint
            && intent.account == key.account
            && (intent.account.is_some() != intent.file_identity.is_some()),
        "private_credentials_key_unknown"
    );
    if let Some(account) = &intent.account {
        let current = backend
            .get(account)
            .map_err(|_| anyhow::anyhow!("private_credentials_key_unknown"))?
            .map(Zeroizing::new);
        if let Some(current) = current {
            ensure!(
                !operation.started("key_deleted")?,
                "private_credentials_key_unknown"
            );
            let bytes = Zeroizing::new(
                STANDARD
                    .decode(current.as_bytes())
                    .map_err(|_| anyhow::anyhow!("private_credentials_key_unknown"))?,
            );
            ensure!(
                bytes.len() == 32 && crypto::digest(&bytes) == intent.fingerprint,
                "private_credentials_key_unknown"
            );
            // A lost delete acknowledgement is reconciled by this exact account, never repeated blindly.
            let _result = backend.delete(account);
            ensure!(
                backend
                    .get(account)
                    .map_err(|_| anyhow::anyhow!("private_credentials_key_unknown"))?
                    .is_none(),
                "private_credentials_key_unknown"
            );
        }
    } else {
        let identity = intent.file_identity.as_ref().unwrap();
        let original = file_identity(directory, "private-key.bin")?;
        let quarantined = file_identity(directory, ".private-key.retired")?;
        if operation.started("key_deleted")? {
            ensure!(
                original.is_none() && quarantined.is_none(),
                "private_credentials_key_unknown"
            );
            return Ok(());
        }
        match (original, quarantined) {
            (Some(original), None) if &original == identity => {
                // Recheck bytes as well as identity immediately before the owned move.
                storage::read(directory, "private-key.bin")?;
                directory.portable_quarantine_verified_entry(
                    OsStr::new("private-key.bin"),
                    identity,
                    OsStr::new(".private-key.retired"),
                )?;
            }
            (None, Some(quarantined)) if &quarantined == identity => {}
            (None, None) if started => {
                operation.mark("key_deleted")?;
                return Ok(());
            }
            _ => anyhow::bail!("private_credentials_key_unknown"),
        }
        let removed = directory
            .portable_remove_verified_regular_leaf(OsStr::new(".private-key.retired"), identity)?;
        // Preserve a durability error; the next explicit call observes only this original intent.
        if let Some(error) = removed.failure {
            return Err(error);
        }
    }
    operation.mark("key_deleted")
}
fn file_identity(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<Option<PortableLeaseIdentity>> {
    match directory.portable_retention_regular_identity(OsStr::new(name)) {
        Ok(identity) => Ok(Some(identity)),
        Err(error) if ordinary::missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
