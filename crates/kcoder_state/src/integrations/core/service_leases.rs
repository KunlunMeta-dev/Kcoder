//! Private service intent/observation storage. Records and locks grant no execution permission.
mod app_server_host;
mod native_code;
mod scope_host;
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use kcoder_types::integrations::core::{
    IntegrationOwner, IntegrationScope, NativeCodeServiceState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs::File, io::Read};

const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_LEASES: usize = 64;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    schema_version: u32,
    owner: IntegrationOwner,
    directory_identity: String,
    writer_identity: PortableLeaseIdentity,
}
pub struct IntegrationServiceLeaseStore {
    directory: PrivateDirectory,
    header: Header,
    writer_anchor: File,
    host_journal: std::sync::Mutex<Option<(Vec<u8>, app_server_host::Journal)>>,
}
impl IntegrationServiceLeaseStore {
    /// Call only within the native host's explicitly authorized new namespace.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent.create_private_child(name)?;
        let writer_anchor = directory.open_read_write_file(OsStr::new("writer.lock"), true)?;
        let header = Header {
            schema_version: 1,
            owner: IntegrationOwner::from(scope),
            directory_identity: directory.directory_identity()?,
            writer_identity: directory.portable_regular_handle_identity(&writer_anchor)?,
        };
        directory.atomic_replace(OsStr::new("owner.json"), &serde_json::to_vec(&header)?)?;
        Ok(Self {
            directory,
            header,
            writer_anchor,
            host_journal: std::sync::Mutex::new(None),
        })
    }

    /// Missing and partial stores remain unavailable; readers never initialize.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent.open_entry_handle(name)?.open_child_directory()?;
        let header: Header = serde_json::from_slice(&read(&directory, "owner.json")?)?;
        ensure!(
            header.owner == IntegrationOwner::from(scope),
            "SERVICE_LEASE_OWNER_MISMATCH"
        );
        let writer_anchor = directory.open_single_link_regular_file(OsStr::new("writer.lock"))?;
        let store = Self {
            directory,
            header,
            writer_anchor,
            host_journal: std::sync::Mutex::new(None),
        };
        store.verify()?;
        Ok(store)
    }

    pub fn directory_identity(&self) -> Result<String> {
        self.verify()?;
        self.directory.directory_identity()
    }

    fn writer(&self) -> Result<VerifiedPrivateLease> {
        self.verify()?;
        self.directory
            .try_existing_portable_lock(
                OsStr::new("writer.lock"),
                &self.header.writer_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("SERVICE_LEASE_STORE_BUSY")
    }
    fn verify(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        let current: Header = serde_json::from_slice(&read(&self.directory, "owner.json")?)?;
        ensure!(
            current == self.header
                && self.header.schema_version == 1
                && self.directory.directory_identity()? == self.header.directory_identity
                && self
                    .directory
                    .portable_regular_handle_identity(&self.writer_anchor)?
                    == self.header.writer_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new("writer.lock"))?
                    == self.header.writer_identity,
            "SERVICE_LEASE_STORE_CHANGED"
        );
        Ok(())
    }
}

fn read(directory: &PrivateDirectory, name: &str) -> Result<Vec<u8>> {
    read_file(directory.open_single_link_regular_file(OsStr::new(name))?)
}
fn read_file(file: File) -> Result<Vec<u8>> {
    let mut bytes = vec![];
    file.take((MAX_RECORD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_RECORD_BYTES,
        "SERVICE_LEASE_RECORD_TOO_LARGE"
    );
    Ok(bytes)
}
fn names(id: &str) -> Result<(String, String)> {
    ensure!(
        !id.is_empty() && id.chars().count() <= 256 && !id.chars().any(char::is_control),
        "SERVICE_LEASE_ID_INVALID"
    );
    let digest = format!("{:x}", Sha256::digest(id.as_bytes()));
    Ok((
        format!("lease-{digest}.json"),
        format!("lease-{digest}.owner.lock"),
    ))
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}
