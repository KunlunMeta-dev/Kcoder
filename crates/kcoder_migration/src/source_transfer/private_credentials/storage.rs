//! Independent native secret namespace; ordinary received payloads never enter here.
use super::super::storage::{self as ordinary, Anchor, Control, Store};
use super::{crypto, model::*};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io::{Cursor, Read},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u32,
    operations: BTreeMap<String, Option<Record>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    preparations: BTreeMap<String, super::preparation::PreparationIntent>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    anchor: Anchor,
    parent_request: String,
    milestones: BTreeMap<String, bool>,
}

pub(super) struct Operation {
    pub directory: PrivateDirectory,
    pub fresh: bool,
    writer: Option<VerifiedPrivateLease>,
    root: PrivateDirectory,
    catalog_lock: PortableLeaseIdentity,
    name: String,
    anchor: Anchor,
}

pub(super) fn operation(
    store: &Store,
    role: &str,
    context: &PrivateCredentialContext,
    binding: &str,
    create: bool,
) -> Result<Operation> {
    open(store, role, context, binding, create, true)
}

/// Observation and cancellation must not wait for the executing writer.
pub(super) fn controller(
    store: &Store,
    role: &str,
    context: &PrivateCredentialContext,
    binding: &str,
) -> Result<Operation> {
    open(store, role, context, binding, false, false)
}

fn open(
    store: &Store,
    role: &str,
    context: &PrivateCredentialContext,
    binding: &str,
    create: bool,
    take_writer: bool,
) -> Result<Operation> {
    let offer = &context.offer_id;
    ensure!(
        matches!(role, "source" | "target"),
        "private_credentials_invalid_role"
    );
    super::super::model::valid_uuid(offer)?;
    ensure!(
        super::super::model::valid_sha(binding),
        "private_credentials_invalid_binding"
    );
    let (root, lock) = store.private_credential_root(create)?;
    let _catalog_lease = root
        .try_existing_portable_lock(
            OsStr::new("catalog.lock"),
            &lock,
            PrivateLeaseMode::Exclusive,
        )?
        .context("private_credentials_busy")?;
    let mut catalog: Catalog =
        ordinary::load(&root, "catalog.json")?.context("private_credentials_owner_unknown")?;
    validate_catalog(&catalog)?;
    let name = format!("{role}-{offer}");
    let fresh = !catalog.operations.contains_key(&name);
    if fresh {
        ensure!(create, "private_credentials_unavailable");
        ensure!(
            catalog.operations.len() < 256
                && catalog
                    .operations
                    .values()
                    .flatten()
                    .filter(|v| v.parent_request == context.request_id)
                    .count()
                    < MAX_PRIVATE_OFFERS,
            "private_credentials_operation_limit"
        );
        let capacity = root.available_storage()?;
        ensure!(
            capacity.bytes >= 2 * 1024 * 1024
                && capacity.file_nodes.is_none_or(|nodes| nodes >= 16),
            "private_credentials_storage_unavailable"
        );
        match root.open_child(OsStr::new(&name), false) {
            Err(error) if ordinary::missing(&error) => {}
            _ => anyhow::bail!("private_credentials_owner_unknown"),
        }
        // Claim intent before directory creation, so an interrupted birth is never adopted.
        catalog.operations.insert(name.clone(), None);
        ordinary::save(&root, "catalog.json", &catalog)?;
        let directory = root.create_private_child(OsStr::new(&name))?;
        let _writer = ordinary::lease(&directory, "writer.lock")?;
        let _control = ordinary::lease(&directory, "control.lock")?;
        let anchor = Anchor {
            owner: store.identity.clone(),
            directory: directory.directory_identity()?,
            request: offer.into(),
            binding: binding.into(),
            writer: directory.portable_regular_identity(OsStr::new("writer.lock"))?,
            controller: directory.portable_regular_identity(OsStr::new("control.lock"))?,
        };
        ordinary::exact(&directory, "control.json", &Control::default())?;
        ordinary::exact(&directory, "binding.json", &anchor)?;
        catalog.operations.insert(
            name.clone(),
            Some(Record {
                anchor,
                parent_request: context.request_id.clone(),
                milestones: BTreeMap::new(),
            }),
        );
        ordinary::save(&root, "catalog.json", &catalog)?;
    }
    let record = catalog
        .operations
        .get(&name)
        .and_then(Option::as_ref)
        .context("private_credentials_owner_unknown")?;
    ensure!(
        record.parent_request == context.request_id,
        "private_credentials_binding_changed"
    );
    let anchor = &record.anchor;
    ensure!(
        anchor.owner == store.identity && anchor.request == *offer && anchor.binding == binding,
        "private_credentials_binding_changed"
    );
    let directory = root.open_child(OsStr::new(&name), false)?;
    directory.verify_trusted_config_directory()?;
    ensure!(
        directory.directory_identity()? == anchor.directory,
        "private_credentials_owner_unknown"
    );
    let saved: Anchor =
        ordinary::load(&directory, "binding.json")?.context("private_credentials_owner_unknown")?;
    ensure!(&saved == anchor, "private_credentials_owner_unknown");
    // Even a busy observer verifies both original lock identities without creating them.
    ensure!(
        directory.portable_regular_identity(OsStr::new("writer.lock"))? == anchor.writer
            && directory.portable_regular_identity(OsStr::new("control.lock"))?
                == anchor.controller,
        "private_credentials_owner_unknown"
    );
    let writer = take_writer
        .then(|| ordinary::operation_lease(&directory, "writer.lock"))
        .transpose()?;
    ordinary::control(&directory)?;
    Ok(Operation {
        directory,
        fresh,
        writer,
        root: root.duplicate_handle()?,
        catalog_lock: lock,
        name,
        anchor: anchor.clone(),
    })
}

fn milestone(name: &str) -> bool {
    matches!(
        name,
        "key_started"
            | "seal_started"
            | "receive_started"
            | "receive_verified"
            | "publication_started"
            | "key_delete_started"
            | "key_deleted"
    )
}
fn validate_catalog(catalog: &Catalog) -> Result<()> {
    ensure!(
        catalog.version == 1
            && catalog.operations.len() <= 256
            && catalog.preparations.len() <= 256
            && catalog
                .preparations
                .iter()
                .all(|(id, intent)| id == &intent.job_id && intent.validate().is_ok())
            && catalog.operations.values().flatten().all(|record| record
                .milestones
                .iter()
                .all(|(name, value)| milestone(name) && *value)),
        "private_credentials_owner_unknown"
    );
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BlobProof {
    pub identity: PortableLeaseIdentity,
    pub bytes: u64,
    pub sha256: String,
}

pub(super) fn publish(directory: &PrivateDirectory, name: &str, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() <= MAX_PRIVATE_BYTES.div_ceil(3) * 4 + 128 * 1024,
        "private_credentials_budget_exceeded"
    );
    let proof_name = format!("{name}.proof.json");
    ensure!(
        ordinary::load::<BlobProof>(directory, &proof_name)?.is_none(),
        "private_credentials_previous_publication_unknown"
    );
    // Persist the flushed temporary handle identity before no-replace publication.
    directory.atomic_publish_observed_from_reader(
        OsStr::new(name),
        &mut Cursor::new(bytes),
        false,
        || Ok(None),
        |file| {
            let proof = BlobProof {
                identity: directory.portable_regular_handle_identity(file)?,
                bytes: bytes.len() as u64,
                sha256: crypto::digest(bytes),
            };
            ordinary::exact(directory, &proof_name, &proof)
        },
    )?;
    Ok(())
}

pub(super) fn read(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    let proof: BlobProof = ordinary::load(directory, &format!("{name}.proof.json"))?
        .context("private_credentials_publication_unknown")?;
    ensure!(
        proof.bytes <= (MAX_PRIVATE_BYTES.div_ceil(3) * 4 + 128 * 1024) as u64,
        "private_credentials_budget_exceeded"
    );
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        directory.portable_regular_handle_identity(&file)? == proof.identity
            && file.metadata()?.len() == proof.bytes,
        "private_credentials_publication_unknown"
    );
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    Read::by_ref(&mut file)
        .take(proof.bytes + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == proof.bytes
            && crypto::digest(&bytes) == proof.sha256
            && directory.portable_regular_handle_identity(&file)? == proof.identity
            && directory.portable_regular_identity(OsStr::new(name))? == proof.identity,
        "private_credentials_publication_unknown"
    );
    Ok(bytes)
}

pub(super) fn json<T: serde::de::DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<T> {
    serde_json::from_slice(&read(directory, name)?)
        .map_err(|_| anyhow::anyhow!("private_credentials_invalid_metadata"))
}
pub(super) fn publish_json(
    directory: &PrivateDirectory,
    name: &str,
    value: &impl Serialize,
) -> Result<()> {
    publish(
        directory,
        name,
        &serde_json::to_vec(value)
            .map_err(|_| anyhow::anyhow!("private_credentials_invalid_metadata"))?,
    )
}

impl Operation {
    pub fn started(&self, name: &str) -> Result<bool> {
        let _lock = self
            .root
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                &self.catalog_lock,
                PrivateLeaseMode::Shared,
            )?
            .context("private_credentials_busy")?;
        let catalog: Catalog = ordinary::load(&self.root, "catalog.json")?
            .context("private_credentials_owner_unknown")?;
        validate_catalog(&catalog)?;
        let record = catalog
            .operations
            .get(&self.name)
            .and_then(Option::as_ref)
            .context("private_credentials_owner_unknown")?;
        ensure!(
            record.anchor == self.anchor,
            "private_credentials_owner_unknown"
        );
        Ok(record.milestones.get(name).copied().unwrap_or(false))
    }
    pub fn mark(&self, name: &str) -> Result<()> {
        ensure!(
            milestone(name) && self.writer.is_some(),
            "private_credentials_invalid_milestone"
        );
        let _lock = self
            .root
            .try_existing_portable_lock(
                OsStr::new("catalog.lock"),
                &self.catalog_lock,
                PrivateLeaseMode::Exclusive,
            )?
            .context("private_credentials_busy")?;
        let mut catalog: Catalog = ordinary::load(&self.root, "catalog.json")?
            .context("private_credentials_owner_unknown")?;
        validate_catalog(&catalog)?;
        let record = catalog
            .operations
            .get_mut(&self.name)
            .and_then(Option::as_mut)
            .context("private_credentials_owner_unknown")?;
        ensure!(
            record.anchor == self.anchor,
            "private_credentials_owner_unknown"
        );
        record.milestones.insert(name.into(), true);
        ordinary::save(&self.root, "catalog.json", &catalog)
    }
}

/// Resolve only original catalog/handle ownership; material may be unavailable.
pub(super) fn controller_by_id(
    store: &Store,
    role: &str,
    request: &str,
    offer_id: &str,
) -> Result<Operation> {
    ensure!(
        matches!(role, "source" | "target"),
        "private_credentials_invalid_role"
    );
    super::super::model::valid_uuid(request)?;
    super::super::model::valid_uuid(offer_id)?;
    let (root, lock) = store.private_credential_root(false)?;
    let _lease = root
        .try_existing_portable_lock(OsStr::new("catalog.lock"), &lock, PrivateLeaseMode::Shared)?
        .context("private_credentials_busy")?;
    let catalog: Catalog =
        ordinary::load(&root, "catalog.json")?.context("private_credentials_owner_unknown")?;
    validate_catalog(&catalog)?;
    let name = format!("{role}-{offer_id}");
    let record = catalog
        .operations
        .get(&name)
        .and_then(Option::as_ref)
        .context("private_credentials_owner_unknown")?;
    ensure!(
        record.parent_request == request
            && record.anchor.owner == store.identity
            && record.anchor.request == offer_id
            && super::super::model::valid_sha(&record.anchor.binding),
        "private_credentials_binding_changed"
    );
    let directory = root.open_child(OsStr::new(&name), false)?;
    directory.verify_trusted_config_directory()?;
    ensure!(
        directory.directory_identity()? == record.anchor.directory,
        "private_credentials_owner_unknown"
    );
    let saved: Anchor =
        ordinary::load(&directory, "binding.json")?.context("private_credentials_owner_unknown")?;
    ensure!(
        saved == record.anchor
            && directory.portable_regular_identity(OsStr::new("writer.lock"))?
                == record.anchor.writer
            && directory.portable_regular_identity(OsStr::new("control.lock"))?
                == record.anchor.controller,
        "private_credentials_owner_unknown"
    );
    ordinary::control(&directory)?;
    Ok(Operation {
        directory,
        fresh: false,
        writer: None,
        root: root.duplicate_handle()?,
        catalog_lock: lock,
        name,
        anchor: record.anchor.clone(),
    })
}

/// Resolve by the original catalog before reading context; request IDs are not authority.
pub(super) fn recover_offer(
    store: &Store,
    role: &str,
    request: &str,
    offer_id: &str,
) -> Result<PrivateCredentialOffer> {
    let operation = controller_by_id(store, role, request, offer_id)?;
    let offer: PrivateCredentialOffer = json(&operation.directory, "offer.json")?;
    crypto::offer_bytes(&offer)?;
    ensure!(
        offer.context.offer_id == offer_id
            && offer.context.request_id == request
            && offer_binding(role, &offer)? == operation.anchor.binding,
        "private_credentials_binding_changed"
    );
    Ok(offer)
}

impl Operation {
    pub fn writer_running(&self) -> Result<bool> {
        let lease = self.directory.try_existing_portable_lock(
            OsStr::new("writer.lock"),
            &self.anchor.writer,
            PrivateLeaseMode::Exclusive,
        )?;
        Ok(lease.is_none())
    }
}

pub(super) fn offer_binding(role: &str, offer: &PrivateCredentialOffer) -> Result<String> {
    if role == "source" {
        Ok(crypto::digest(&crypto::offer_bytes(offer)?))
    } else {
        super::target::ordinary_context_digest(&offer.context)
    }
}

mod preparations;
pub(super) use preparations::{legacy_publication_for_job, preparation_for_job};
