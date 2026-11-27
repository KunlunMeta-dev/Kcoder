//! Private service intent/observation storage. Records and locks grant no execution permission.
mod app_server_host;
mod gateway_fences;
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
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
};

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
    parent: PrivateDirectory,
    name: OsString,
    directory: PrivateDirectory,
    header: Header,
    header_bytes: Vec<u8>,
    header_anchor: File,
    writer_anchor: File,
    slot_anchors: std::sync::Mutex<BTreeMap<String, File>>,
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
        let header_bytes = serde_json::to_vec(&header)?;
        directory.atomic_replace(OsStr::new("owner.json"), &header_bytes)?;
        let header_anchor = directory.open_single_link_regular_file(OsStr::new("owner.json"))?;
        let store = Self {
            parent: parent.duplicate_handle()?,
            name: name.into(),
            directory,
            header,
            header_bytes,
            header_anchor,
            writer_anchor,
            slot_anchors: std::sync::Mutex::new(BTreeMap::new()),
            host_journal: std::sync::Mutex::new(None),
        };
        store.verify()?;
        Ok(store)
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
        let header_anchor = directory.open_single_link_regular_file(OsStr::new("owner.json"))?;
        let header_bytes = read_file(header_anchor.try_clone()?)?;
        let header: Header = serde_json::from_slice(&header_bytes)?;
        ensure!(
            header.owner == IntegrationOwner::from(scope),
            "SERVICE_LEASE_OWNER_MISMATCH"
        );
        let writer_anchor = directory.open_single_link_regular_file(OsStr::new("writer.lock"))?;
        let store = Self {
            parent: parent.duplicate_handle()?,
            name: name.into(),
            directory,
            header,
            header_bytes,
            header_anchor,
            writer_anchor,
            slot_anchors: std::sync::Mutex::new(BTreeMap::new()),
            host_journal: std::sync::Mutex::new(None),
        };
        store.verify()?;
        // Retain live fences as well as checking their authoritative placement
        // pins. A fresh open must not adopt a renamed live owner's replacement.
        store.directory.visit_entry_names_bounded(1024, |name| {
            let Some(name) = name.to_str() else {
                return Ok(());
            };
            if name == scope_host::HOST_SLOT
                || name
                    .strip_prefix("native-code-")
                    .and_then(|name| name.strip_suffix(".owner.lock"))
                    .is_some_and(|id| {
                        id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
            {
                store.capture_slot(name, None)?;
            }
            Ok(())
        })?;
        store.gateway_app_server_slot_identity()?;
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
        let current = self
            .directory
            .open_single_link_regular_file(OsStr::new("owner.json"))?;
        let writer_identity = self
            .directory
            .portable_regular_handle_identity(&self.writer_anchor)?;
        ensure!(
            read_file(current.try_clone()?)? == self.header_bytes
                && self.header.schema_version == 1
                && historical_directory_identity(&self.header.directory_identity)
                && writer_identity == self.header.writer_identity
                && self
                    .parent
                    .open_entry_handle(&self.name)?
                    .open_child_directory()?
                    .directory_identity()?
                    == self.directory.directory_identity()?
                && self.directory.portable_regular_handle_identity(&current)?
                    == self
                        .directory
                        .portable_regular_handle_identity(&self.header_anchor)?
                && self
                    .directory
                    .portable_regular_identity(OsStr::new("writer.lock"))?
                    == writer_identity,
            "SERVICE_LEASE_STORE_CHANGED"
        );
        Ok(())
    }

    /// Only live handles prevent a fence from being replaced during this open.
    /// Missing fences are never recreated by observation or lock acquisition.
    fn capture_slot(&self, name: &str, created: Option<&File>) -> Result<PortableLeaseIdentity> {
        let mut anchors = self
            .slot_anchors
            .lock()
            .map_err(|_| anyhow::anyhow!("SERVICE_LEASE_ANCHORS_UNAVAILABLE"))?;
        if !anchors.contains_key(name) {
            ensure!(anchors.len() < MAX_LEASES + 1, "SERVICE_LEASE_CAPACITY");
            let anchor = match created {
                Some(file) => file.try_clone()?,
                None => self
                    .directory
                    .open_single_link_regular_file(OsStr::new(name))?,
            };
            anchors.insert(name.into(), anchor);
        }
        let identity = self
            .directory
            .portable_regular_handle_identity(&anchors[name])?;
        ensure!(
            self.directory.portable_regular_identity(OsStr::new(name))? == identity
                && created
                    .map(|file| self.directory.portable_regular_handle_identity(file))
                    .transpose()?
                    .is_none_or(|created| created == identity),
            "SERVICE_LEASE_ORIGINAL_SLOT_CHANGED"
        );
        Ok(identity)
    }
}

fn historical_directory_identity(identity: &str) -> bool {
    !identity.is_empty() && identity.len() <= 256 && !identity.chars().any(char::is_control)
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

#[cfg(test)]
mod tests;
