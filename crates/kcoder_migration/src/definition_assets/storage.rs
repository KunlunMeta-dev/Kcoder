//! Empty metadata initialization has explicit recovery; reads never create or repair storage.
use super::model::{State, StoreBinding};
use anyhow::{Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;
const STATE: &str = "migration-pending-definitions.json";
const BIRTH: &str = ".migration-pending-definitions.birth.json";
const LOCK: &str = ".migration-pending-definitions.lock";
const MAX_STATE: u64 = 64 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Birth {
    version: u32,
    instance: String,
    profile_identity: String,
    parent_identity: String,
    directory_identity: String,
    lock: PortableLeaseIdentity,
    ready: bool,
}
pub(super) struct Storage {
    profile: PathBuf,
    directory: PrivateDirectory,
    profile_identity: String,
    parent_identity: String,
    directory_identity: String,
}
impl Storage {
    fn open(profile: &Path, create: bool) -> Result<Self> {
        let root = PrivateDirectory::open_existing(profile)?;
        root.verify_trusted_config_directory()?;
        let parent = root.open_child(OsStr::new("migrations"), false)?;
        parent.verify_private_directory()?;
        let directory = parent.open_child(OsStr::new("pending-definitions"), create)?;
        directory.verify_private_directory()?;
        Ok(Self {
            profile: profile.canonicalize()?,
            profile_identity: root.directory_identity()?,
            parent_identity: parent.directory_identity()?,
            directory_identity: directory.directory_identity()?,
            directory,
        })
    }
    pub(super) fn initialize(profile: &Path) -> Result<(Self, StoreBinding)> {
        let this = Self::open(profile, true)?;
        let before = this.bytes(BIRTH, 16 * 1024)?;
        let (mut birth, _lease) = if let Some(bytes) = &before {
            let birth: Birth = decode(bytes)?;
            ensure!(
                birth.version == 1
                    && birth.profile_identity == this.profile_identity
                    && birth.parent_identity == this.parent_identity
                    && birth.directory_identity == this.directory_identity,
                "migration_definition_store_changed"
            );
            let lease = this
                .directory
                .try_existing_portable_lock(
                    OsStr::new(LOCK),
                    &birth.lock,
                    PrivateLeaseMode::Exclusive,
                )?
                .ok_or_else(|| anyhow::anyhow!("migration_definition_store_busy"))?;
            (birth, Hold::Existing(lease))
        } else {
            ensure!(
                this.bytes(STATE, MAX_STATE)?.is_none(),
                "migration_definition_store_recovery_required"
            );
            let lease = this
                .directory
                .try_exclusive_lock(OsStr::new(LOCK))?
                .ok_or_else(|| anyhow::anyhow!("migration_definition_store_busy"))?;
            ensure!(
                this.bytes(BIRTH, 16 * 1024)?.is_none() && this.bytes(STATE, MAX_STATE)?.is_none(),
                "migration_definition_store_changed"
            );
            let birth = Birth {
                version: 1,
                instance: uuid::Uuid::new_v4().to_string(),
                profile_identity: this.profile_identity.clone(),
                parent_identity: this.parent_identity.clone(),
                directory_identity: this.directory_identity.clone(),
                lock: this.directory.portable_regular_handle_identity(&lease)?,
                ready: false,
            };
            this.write(BIRTH, &serde_json::to_vec(&birth)?, None, &birth.lock)?;
            (birth, Hold::New(lease))
        };
        if !birth.ready {
            if let Some(bytes) = this.bytes(STATE, MAX_STATE)? {
                let state: State = decode(&bytes)?;
                ensure!(
                    state.version == 1
                        && state.instance == birth.instance
                        && state.profile_identity == birth.profile_identity
                        && state.records.is_empty()
                        && state.receipts.is_empty(),
                    "migration_definition_store_recovery_required"
                );
            } else {
                this.write(
                    STATE,
                    &serde_json::to_vec(&State::empty(
                        birth.instance.clone(),
                        birth.profile_identity.clone(),
                    ))?,
                    None,
                    &birth.lock,
                )?;
            }
            let previous = this
                .bytes(BIRTH, 16 * 1024)?
                .ok_or_else(|| anyhow::anyhow!("migration_definition_store_changed"))?;
            let digest = sha(&previous);
            let previous: Birth = decode(&previous)?;
            ensure!(
                !previous.ready
                    && previous.instance == birth.instance
                    && previous.lock == birth.lock,
                "migration_definition_store_changed"
            );
            birth.ready = true;
            this.write(
                BIRTH,
                &serde_json::to_vec(&birth)?,
                Some(digest),
                &birth.lock,
            )?;
        }
        let binding = StoreBinding {
            instance: birth.instance,
            profile_identity: birth.profile_identity,
            parent_identity: birth.parent_identity,
            directory_identity: birth.directory_identity,
            birth: this
                .directory
                .portable_regular_identity(OsStr::new(BIRTH))?,
            lock: birth.lock,
        };
        this.state(&binding)?;
        drop(_lease);
        Ok((this, binding))
    }
    pub(super) fn existing(profile: &Path, binding: &StoreBinding) -> Result<Self> {
        let this = Self::open(profile, false)?;
        this.verify(binding)?;
        Ok(this)
    }
    fn verify(&self, binding: &StoreBinding) -> Result<()> {
        let current = Self::open(&self.profile, false)?;
        ensure!(
            current.profile_identity == binding.profile_identity
                && current.parent_identity == binding.parent_identity
                && current.directory_identity == binding.directory_identity
                && self.directory.directory_identity()? == binding.directory_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(BIRTH))?
                    == binding.birth
                && self.directory.portable_regular_identity(OsStr::new(LOCK))? == binding.lock,
            "migration_definition_store_changed"
        );
        let birth: Birth = decode(
            &self
                .bytes(BIRTH, 16 * 1024)?
                .ok_or_else(|| anyhow::anyhow!("migration_definition_store_changed"))?,
        )?;
        ensure!(
            birth.version == 1
                && birth.ready
                && birth.instance == binding.instance
                && birth.profile_identity == binding.profile_identity
                && birth.parent_identity == binding.parent_identity
                && birth.directory_identity == binding.directory_identity
                && birth.lock == binding.lock,
            "migration_definition_store_changed"
        );
        Ok(())
    }
    fn state(&self, binding: &StoreBinding) -> Result<(State, String)> {
        self.verify(binding)?;
        let bytes = self
            .bytes(STATE, MAX_STATE)?
            .ok_or_else(|| anyhow::anyhow!("migration_definition_store_missing"))?;
        let digest = sha(&bytes);
        let state: State = decode(&bytes)?;
        ensure!(
            state.instance == binding.instance
                && state.profile_identity == binding.profile_identity,
            "migration_definition_store_changed"
        );
        state.validate()?;
        self.verify(binding)?;
        Ok((state, digest))
    }
    pub(super) fn read<T>(
        &self,
        binding: &StoreBinding,
        read: impl FnOnce(&State) -> Result<T>,
    ) -> Result<T> {
        self.verify(binding)?;
        let _lease = self
            .directory
            .try_existing_portable_lock(OsStr::new(LOCK), &binding.lock, PrivateLeaseMode::Shared)?
            .ok_or_else(|| anyhow::anyhow!("migration_definition_store_busy"))?;
        let (state, _) = self.state(binding)?;
        let result = read(&state)?;
        self.verify(binding)?;
        Ok(result)
    }
    pub(super) fn update(
        &self,
        binding: &StoreBinding,
        update: impl FnOnce(&mut State) -> Result<bool>,
    ) -> Result<()> {
        self.verify(binding)?;
        let _lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &binding.lock,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or_else(|| anyhow::anyhow!("migration_definition_store_busy"))?;
        let (mut state, digest) = self.state(binding)?;
        if update(&mut state)? {
            state.validate()?;
            let bytes = Zeroizing::new(serde_json::to_vec(&state)?);
            ensure!(
                bytes.len() as u64 <= MAX_STATE,
                "migration_definition_store_budget_exceeded"
            );
            self.verify(binding)?;
            self.write(STATE, &bytes, Some(digest), &binding.lock)?;
        }
        Ok(())
    }
    fn bytes(&self, name: &str, max: u64) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let file = match self
            .directory
            .open_single_link_regular_file(OsStr::new(name))
        {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(_) => anyhow::bail!("migration_definition_store_unavailable"),
        };
        let mut bytes = Zeroizing::new(Vec::new());
        file.take(max + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= max,
            "migration_definition_store_budget_exceeded"
        );
        Ok(Some(bytes))
    }
    fn write(
        &self,
        name: &str,
        bytes: &[u8],
        expected: Option<String>,
        lock: &PortableLeaseIdentity,
    ) -> Result<()> {
        self.directory
            .atomic_publish_from_reader(
                OsStr::new(name),
                &mut Cursor::new(bytes),
                expected.is_some(),
                || {
                    let current = Self::open(&self.profile, false)?;
                    ensure!(
                        current.profile_identity == self.profile_identity
                            && current.parent_identity == self.parent_identity
                            && current.directory_identity == self.directory_identity
                            && self.directory.portable_regular_identity(OsStr::new(LOCK))? == *lock,
                        "migration_definition_store_changed"
                    );
                    ensure!(
                        self.bytes(name, if name == STATE { MAX_STATE } else { 16 * 1024 })?
                            .map(|bytes| sha(&bytes))
                            == expected,
                        "migration_definition_store_changed"
                    );
                    Ok(None)
                },
            )
            .map(|_| ())
            .map_err(|_| anyhow::anyhow!("migration_definition_store_changed"))
    }
}
enum Hold {
    New(std::fs::File),
    Existing(VerifiedPrivateLease),
}
impl Drop for Hold {
    fn drop(&mut self) {
        match self {
            Self::New(file) => {
                let _ = file;
            }
            Self::Existing(lease) => {
                let _ = lease;
            }
        }
    }
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("migration_definition_store_invalid"))
}
