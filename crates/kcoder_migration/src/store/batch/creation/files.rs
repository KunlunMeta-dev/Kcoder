//! First birth is create-new; observation never repairs missing or replaced ownership facts.
use super::{intent::BatchCreateIntent, model::*};
use anyhow::{Result, ensure};
use kcoder_config::{PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Read, Write},
    path::Path,
};

const BIRTH: &str = "create.birth.json";
const CONTROL: &str = "create.control.json";
const LEASE: &str = "create.lock";
const CONTROL_LEASE: &str = "create.control.lock";

pub(super) struct CreationFiles {
    pub directory: PrivateDirectory,
    pub birth: Birth,
    pub birth_sha256: String,
}
impl CreationFiles {
    pub fn lookup(
        parent: &PrivateDirectory,
        profile: &Path,
        request_id: &str,
    ) -> Result<Option<Self>> {
        uuid(request_id)?;
        profile_identity(parent, profile)?;
        let job_id = job_id(request_id);
        let directory = match parent.open_child(OsStr::new(&format!("{job_id}.plans")), false) {
            Ok(directory) => directory,
            Err(error) if missing(&error) => {
                ensure!(
                    read_bytes(parent, &format!("{job_id}.json"), 16 * 1024 * 1024)?.is_none(),
                    "migration_batch_creation_unknown"
                );
                return Ok(None);
            }
            Err(_) => anyhow::bail!("migration_batch_creation_unknown"),
        };
        directory.verify_private_directory()?;
        let birth: Birth = read_json(&directory, BIRTH, 16 * 1024)?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        let sha256 = birth_hash(&birth)?;
        let files = Self {
            directory,
            birth,
            birth_sha256: sha256,
        };
        files.verify(parent, profile, request_id)?;
        files.control()?;
        Ok(Some(files))
    }

    /// The caller holds the original migrations catalog writer until birth is durable.
    pub fn create(
        parent: &PrivateDirectory,
        profile: &Path,
        intent: &BatchCreateIntent,
    ) -> Result<(Self, VerifiedPrivateLease)> {
        let owner = profile_identity(parent, profile)?;
        let job_id = job_id(intent.request_id());
        let directory = parent
            .create_private_child(OsStr::new(&format!("{job_id}.plans")))
            .map_err(|_| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let mut lease = directory.open_read_write_file(OsStr::new(LEASE), true)?;
        lease.write_all(&lease_body(&nonce, "create"))?;
        lease.sync_all()?;
        let lease_identity = directory.portable_regular_handle_identity(&lease)?;
        let guard = directory
            .try_existing_portable_lock(
                OsStr::new(LEASE),
                &lease_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        drop(lease);
        let mut control = directory.open_read_write_file(OsStr::new(CONTROL_LEASE), true)?;
        control.write_all(&lease_body(&nonce, "control"))?;
        control.sync_all()?;
        let control_identity = directory.portable_regular_handle_identity(&control)?;
        drop(control);
        let birth = Birth {
            version: 1,
            request_id: intent.request_id().into(),
            intent_sha256: intent.digest().into(),
            profile_identity: owner,
            job_id,
            nonce,
            directory_identity: directory.directory_identity()?,
            lease_identity,
            control_identity,
        };
        let birth_sha256 = birth_hash(&birth)?;
        publish_json(
            &directory,
            CONTROL,
            &Control {
                version: 1,
                birth_sha256: birth_sha256.clone(),
                revision: 1,
                cancel_requested: false,
                receipts: Vec::new(),
            },
        )?;
        publish_json(&directory, BIRTH, &birth)?;
        let files = Self {
            directory,
            birth,
            birth_sha256,
        };
        files.verify(parent, profile, intent.request_id())?;
        Ok((files, guard))
    }

    pub fn verify(
        &self,
        parent: &PrivateDirectory,
        profile: &Path,
        request_id: &str,
    ) -> Result<()> {
        let birth = &self.birth;
        ensure!(
            birth.version == 1
                && birth.request_id == request_id
                && birth.job_id == job_id(request_id)
                && birth.profile_identity == profile_identity(parent, profile)?
                && birth.directory_identity == self.directory.directory_identity()?
                && parent
                    .open_child(OsStr::new(&format!("{}.plans", birth.job_id)), false)?
                    .directory_identity()?
                    == birth.directory_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(LEASE))?
                    == birth.lease_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(CONTROL_LEASE))?
                    == birth.control_identity,
            "migration_batch_creation_unknown"
        );
        uuid(&birth.nonce)?;
        digest(&birth.intent_sha256)?;
        self.verify_lease_body(LEASE, "create")?;
        self.verify_lease_body(CONTROL_LEASE, "control")?;
        Ok(())
    }
    pub fn require_intent(&self, intent: &BatchCreateIntent) -> Result<()> {
        ensure!(
            self.birth.request_id == intent.request_id()
                && self.birth.intent_sha256 == intent.digest(),
            "migration_batch_create_intent_conflict"
        );
        Ok(())
    }
    pub fn claim(&self) -> Result<VerifiedPrivateLease> {
        self.verify_lease_body(LEASE, "create")?;
        self.directory
            .try_existing_portable_lock(
                OsStr::new(LEASE),
                &self.birth.lease_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_busy"))
    }
    pub fn running(&self) -> Result<bool> {
        self.verify_lease_body(LEASE, "create")?;
        Ok(self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LEASE),
                &self.birth.lease_identity,
                PrivateLeaseMode::Shared,
            )?
            .is_none())
    }
    pub fn control(&self) -> Result<Control> {
        let control: Control = read_json(&self.directory, CONTROL, 64 * 1024)?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unknown"))?;
        control.validate(&self.birth_sha256)?;
        Ok(control)
    }
    pub fn control_lease(&self) -> Result<VerifiedPrivateLease> {
        self.verify_lease_body(CONTROL_LEASE, "control")?;
        self.directory
            .try_existing_portable_lock(
                OsStr::new(CONTROL_LEASE),
                &self.birth.control_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_busy"))
    }
    pub fn save_control(&self, control: &Control, lease: &VerifiedPrivateLease) -> Result<()> {
        ensure!(
            lease.identity() == &self.birth.control_identity,
            "migration_batch_creation_unknown"
        );
        self.verify_lease_body(CONTROL_LEASE, "control")?;
        control.validate(&self.birth_sha256)?;
        self.directory
            .atomic_replace(OsStr::new(CONTROL), &serde_json::to_vec(control)?)
    }
    pub fn binding(&self) -> BatchCreationBinding {
        BatchCreationBinding {
            request_id: self.birth.request_id.clone(),
            intent_sha256: self.birth.intent_sha256.clone(),
            profile_identity: self.birth.profile_identity.clone(),
            birth_sha256: self.birth_sha256.clone(),
        }
    }
    fn verify_lease_body(&self, name: &str, role: &str) -> Result<()> {
        ensure!(
            read_bytes(&self.directory, name, 512)?.as_deref()
                == Some(lease_body(&self.birth.nonce, role).as_slice()),
            "migration_batch_creation_unknown"
        );
        Ok(())
    }
}

fn lease_body(nonce: &str, role: &str) -> Vec<u8> {
    format!("kcoder.migration.batch-create.lease/1\0{nonce}\0{role}").into_bytes()
}

pub(super) fn job_id(request_id: &str) -> String {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("kcoder.migration.batch-create.job/1\0{request_id}"))
    );
    format!("mig-{}", &digest[..32])
}
pub(super) fn profile_identity(parent: &PrivateDirectory, profile: &Path) -> Result<String> {
    let native_profile = PrivateDirectory::open_existing(profile)?;
    native_profile.verify_trusted_config_directory()?;
    ensure!(
        native_profile
            .open_child(OsStr::new("migrations"), false)?
            .directory_identity()?
            == parent.directory_identity()?,
        "migration_batch_creation_unknown"
    );
    Ok(format!(
        "{:x}",
        Sha256::digest(format!(
            "{}\0{}\0{}",
            profile.canonicalize()?.display(),
            native_profile.directory_identity()?,
            parent.directory_identity()?
        ))
    ))
}
fn birth_hash(birth: &Birth) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(birth)?)))
}
pub(super) fn read_json<T: DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    max: u64,
) -> Result<Option<T>> {
    read_bytes(directory, name, max)?
        .map(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|_| anyhow::anyhow!("migration_batch_creation_unknown"))
        })
        .transpose()
}
pub(super) fn read_bytes(
    directory: &PrivateDirectory,
    name: &str,
    max: u64,
) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(_) => anyhow::bail!("migration_batch_creation_unknown"),
    };
    let identity = directory.portable_regular_handle_identity(&file)?;
    ensure!(
        file.metadata()?.len() <= max,
        "migration_batch_creation_unknown"
    );
    let mut bytes = Vec::new();
    (&file).take(max + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= max
            && directory.portable_regular_handle_identity(&file)? == identity
            && directory.portable_regular_identity(OsStr::new(name))? == identity,
        "migration_batch_creation_unknown"
    );
    Ok(Some(bytes))
}
pub(super) fn publish_json(
    directory: &PrivateDirectory,
    name: &str,
    value: &impl serde::Serialize,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() <= 64 * 1024, "migration_batch_creation_unknown");
    directory.atomic_publish_from_reader(
        OsStr::new(name),
        &mut std::io::Cursor::new(bytes),
        false,
        || Ok(None),
    )?;
    Ok(())
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
    })
}
