//! Read-only native initialization and immutable Node-ready receipt observation.
use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use kcoder_types::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, fs::File};

pub const INIT: &str = "channel-host-initialization.json";
pub const LOG: &str = "channel-host-bootstrap.jsonl";
pub const DATA: &str = "data";
pub const MAX_CONTROL: u64 = 32768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Initialization {
    pub version: u32,
    pub owner: IntegrationOwner,
    pub initialization_id: String,
    pub lock_identity: PortableLeaseIdentity,
    pub log_identity: PortableLeaseIdentity,
    pub data_directory_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
pub enum BootstrapEntry {
    Seed {
        #[serde(rename = "initializationIdentity")]
        initialization_identity: PortableLeaseIdentity,
    },
    Issued {
        #[serde(rename = "initializationId")]
        initialization_id: String,
        #[serde(rename = "initializationIdentity")]
        initialization_identity: PortableLeaseIdentity,
    },
    Ready {
        #[serde(rename = "namespaceId")]
        namespace_id: String,
        #[serde(rename = "bindingHash")]
        binding_hash: String,
        files: BTreeMap<String, PortableLeaseIdentity>,
    },
    MediaReady {
        #[serde(rename = "namespaceId")]
        namespace_id: String,
        #[serde(rename = "directoryIdentity")]
        directory_identity: String,
        #[serde(rename = "filesIdentity")]
        files_identity: String,
        #[serde(rename = "journalIdentity")]
        journal_identity: PortableLeaseIdentity,
        #[serde(rename = "directoryBirthNs")]
        directory_birth_ns: u64,
        #[serde(rename = "filesBirthNs")]
        files_birth_ns: u64,
        #[serde(rename = "journalBirthNs")]
        journal_birth_ns: u64,
    },
}

pub fn read_initialization(file: &File) -> Result<Initialization> {
    let bytes = read_bytes(file)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn read_log(
    file: &File,
    initial: &Initialization,
    init_identity: &PortableLeaseIdentity,
) -> Result<Vec<BootstrapEntry>> {
    let bytes = read_bytes(file)?;
    ensure!(!bytes.is_empty(), "CONNECTIVITY_INITIALIZATION_UNCONFIRMED");
    ensure!(
        bytes.last() == Some(&b'\n'),
        "CONNECTIVITY_INITIALIZATION_UNCONFIRMED"
    );
    let entries = bytes[..bytes.len() - 1]
        .split(|byte| *byte == b'\n')
        .map(serde_json::from_slice)
        .collect::<std::result::Result<Vec<BootstrapEntry>, _>>()?;
    ensure!(
        matches!(
            entries.as_slice(),
            [BootstrapEntry::Seed { .. }]
                | [BootstrapEntry::Seed { .. }, BootstrapEntry::Issued { .. }]
                | [
                    BootstrapEntry::Seed { .. },
                    BootstrapEntry::Issued { .. },
                    BootstrapEntry::Ready { .. }
                ]
                | [
                    BootstrapEntry::Seed { .. },
                    BootstrapEntry::Issued { .. },
                    BootstrapEntry::Ready { .. },
                    BootstrapEntry::MediaReady { .. }
                ]
        ),
        "CONNECTIVITY_BOOTSTRAP_LOG_INVALID"
    );
    if let BootstrapEntry::Seed {
        initialization_identity,
    } = &entries[0]
    {
        ensure!(
            initialization_identity == init_identity,
            "CONNECTIVITY_INITIALIZATION_IDENTITY_CHANGED"
        );
    }
    if let Some(BootstrapEntry::Issued {
        initialization_id,
        initialization_identity,
    }) = entries.get(1)
    {
        ensure!(
            initialization_id == &initial.initialization_id
                && initialization_identity == init_identity,
            "CONNECTIVITY_INITIALIZATION_IDENTITY_CHANGED"
        );
    }
    Ok(entries)
}

pub fn data_directory(
    directory: &PrivateDirectory,
    initial: &Initialization,
) -> Result<PrivateDirectory> {
    let entry = directory.open_entry_handle(OsStr::new(DATA))?;
    let data = entry.open_child_directory()?;
    data.verify_private_directory()?;
    ensure!(
        data.directory_identity()? == initial.data_directory_identity,
        "CONNECTIVITY_DATA_DIRECTORY_CHANGED"
    );
    Ok(data)
}

pub fn verify_node_store(
    directory: &PrivateDirectory,
    data: &PrivateDirectory,
    namespace: &str,
    initial: &Initialization,
) -> Result<BootstrapEntry> {
    let binding_file = directory.open_single_link_regular_file(OsStr::new("data.binding.json"))?;
    let binding: Value = serde_json::from_slice(&read_bytes(&binding_file)?)?;
    ensure!(
        binding["version"] == 1
            && binding["schemaVersion"] == "4"
            && binding["namespaceId"] == namespace
            && binding["initializationId"] == initial.initialization_id,
        "CONNECTIVITY_NODE_BINDING_MISMATCH"
    );
    let schema_hash = binding["schemaHash"]
        .as_str()
        .context("CONNECTIVITY_NODE_SCHEMA_UNCONFIRMED")?;
    ensure!(
        valid_digest(schema_hash),
        "CONNECTIVITY_NODE_SCHEMA_UNCONFIRMED"
    );
    let ready_file = data.open_single_link_regular_file(OsStr::new("connectivity.ready.json"))?;
    let ready: Value = serde_json::from_slice(&read_bytes(&ready_file)?)?;
    let binding_hash = hash_json(&binding)?;
    ensure!(
        ready["version"] == 1
            && ready["namespaceId"] == namespace
            && ready["bindingHash"] == binding_hash,
        "CONNECTIVITY_NODE_READY_UNCONFIRMED"
    );
    let mut files = BTreeMap::new();
    files.insert(
        "binding".into(),
        directory.portable_regular_handle_identity(&binding_file)?,
    );
    files.insert(
        "ready".into(),
        data.portable_regular_handle_identity(&ready_file)?,
    );
    for (key, name) in [
        ("database", "connectivity.sqlite3"),
        ("lock", "connectivity.lock"),
    ] {
        let file = data.open_single_link_regular_file(OsStr::new(name))?;
        files.insert(key.into(), data.portable_regular_handle_identity(&file)?);
    }
    Ok(BootstrapEntry::Ready {
        namespace_id: namespace.into(),
        binding_hash,
        files,
    })
}

pub fn read_bytes(file: &File) -> Result<Vec<u8>> {
    let size = file.metadata()?.len();
    ensure!(size <= MAX_CONTROL, "CONNECTIVITY_CONTROL_TOO_LARGE");
    let mut bytes = vec![0; size as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        #[cfg(unix)]
        let count = {
            use std::os::unix::fs::FileExt;
            file.read_at(&mut bytes[offset..], offset as u64)?
        };
        #[cfg(windows)]
        let count = {
            use std::os::windows::fs::FileExt;
            file.seek_read(&mut bytes[offset..], offset as u64)?
        };
        #[cfg(not(any(unix, windows)))]
        let count: usize = anyhow::bail!("CONNECTIVITY_PRIVATE_READ_UNAVAILABLE");
        ensure!(count > 0, "CONNECTIVITY_CONTROL_CHANGED");
        offset += count;
    }
    ensure!(
        file.metadata()?.len() == size,
        "CONNECTIVITY_CONTROL_CHANGED"
    );
    Ok(bytes)
}

pub fn hash_json(value: &Value) -> Result<String> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&sorted(value))?)
    ))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
