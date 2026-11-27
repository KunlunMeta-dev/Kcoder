//! Offline relocation of State's directory-bound historical evidence.
//!
//! The host owns shutdown, copy and final publication. This owner only authenticates
//! its existing binding graph and records the real destination identities. Neither
//! a snapshot nor a relocation record grants execution, replay or deletion rights.
use anyhow::{Context, Result, ensure};
use kcoder_config::storage::StoragePublishedComponent;
use kcoder_config::{
    PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::path::PathBuf;
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Write},
    path::Path,
};

mod binding;
pub(crate) mod graph;
mod journal;
mod metadata;
pub(crate) use binding::HistoryDirectoryBinding;
pub use journal::{
    RegisteredProfileSession, RegisteredProfileSessionState, registered_profile_sessions,
};
pub use metadata::{
    HistoryRelocationMetadata, observe_relocation_metadata, verify_relocation_metadata,
};

pub(crate) const RECORD: &str = ".history-storage-relocation.json";
const MAX_RECORD: u64 = 8 * 1024 * 1024;
const MAX_DIRECTORIES: usize = 65_536;
const MAX_FILES: usize = 8192;
const MAX_ALIASES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileSnapshot {
    name: String,
    identity: PortableLeaseIdentity,
    aliases: Vec<PortableLeaseIdentity>,
    string_aliases: Vec<String>,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectorySnapshot {
    path: Vec<String>,
    identity: String,
    directory_aliases: Vec<String>,
    owner_seed: String,
    owner_profile: String,
    scope_path: String,
    retention_identity: PortableLeaseIdentity,
    retention_aliases: Vec<PortableLeaseIdentity>,
    files: Vec<FileSnapshot>,
    children: Vec<ChildSnapshot>,
    prior_record: Option<(PortableLeaseIdentity, String)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildSnapshot {
    name: String,
    identity: PortableLeaseIdentity,
    aliases: Vec<PortableLeaseIdentity>,
    directory_aliases: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildBinding {
    name: String,
    recorded: Vec<PortableLeaseIdentity>,
    recorded_strings: Vec<String>,
    target: PortableLeaseIdentity,
}

/// Immutable source evidence for an already stopped owner. It is not a shutdown
/// capability and cannot be used to adopt an unrelated target with equal bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryStorageRelocationSnapshot {
    version: u8,
    profile: String,
    directories: Vec<DirectorySnapshot>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileBinding {
    name: String,
    recorded: Vec<PortableLeaseIdentity>,
    recorded_strings: Vec<String>,
    target: PortableLeaseIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    operation: String,
    source_profile: String,
    target_profile: String,
    source: DirectorySnapshot,
    target_directory: String,
    target_retention: PortableLeaseIdentity,
    record_identity: PortableLeaseIdentity,
    files: Vec<FileBinding>,
    children: Vec<ChildBinding>,
}

struct HeldRecord {
    value: Record,
    bytes: Vec<u8>,
    _file: File,
}

struct HeldDirectory {
    directory: PrivateDirectory,
    // Runtime-only leases are checked without publishing persistent mappings.
    mapping_required: bool,
    snapshot: DirectorySnapshot,
    _locks: Vec<VerifiedPrivateLease>,
    _record: Option<HeldRecord>,
    _absent: Vec<String>,
}

/// The explicit owner adapter. Ordinary reads never call this API or scan a tree.
pub struct HistoryStorageRelocation;

impl HistoryStorageRelocation {
    pub fn snapshot(source_profile: &Path) -> Result<HistoryStorageRelocationSnapshot> {
        let profile = PrivateDirectory::open_existing(source_profile)?;
        profile.verify_config_root_directory()?;
        let directories = graph::collect(&profile, source_profile)?;
        Ok(HistoryStorageRelocationSnapshot {
            version: 1,
            profile: profile.directory_identity()?,
            directories: directories
                .into_iter()
                .map(|entry| entry.snapshot)
                .collect(),
        })
    }

    /// The copy must already have been published at its final location. Only this
    /// operation's original copy or its already-bound destination is accepted.
    pub fn relocate(
        source_profile: &Path,
        final_target_profile: &Path,
        operation: &str,
        expected: &HistoryStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        Self::target(
            source_profile,
            final_target_profile,
            operation,
            expected,
            published,
            true,
        )
    }

    /// Read-only reconciliation. It never publishes a missing record, opens a
    /// normal session, settles an unknown receipt, or starts a model/tool.
    pub fn verify_relocation(
        source_profile: &Path,
        final_target_profile: &Path,
        operation: &str,
        expected: &HistoryStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        Self::target(
            source_profile,
            final_target_profile,
            operation,
            expected,
            published,
            false,
        )
    }

    fn target(
        source_profile: &Path,
        target_profile: &Path,
        operation: &str,
        expected: &HistoryStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
        publish: bool,
    ) -> Result<()> {
        ensure!(
            valid_operation(operation),
            "HISTORY_RELOCATION_OPERATION_INVALID"
        );
        ensure!(
            expected.version == 1,
            "HISTORY_RELOCATION_VERSION_UNSUPPORTED"
        );
        let source = PrivateDirectory::open_existing(source_profile)?;
        source.verify_config_root_directory()?;
        published.verify()?;
        ensure!(
            published.operation_id() == operation
                && published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
                && published.source_identity() == expected.profile
                && dunce::canonicalize(published.source_path())?
                    == dunce::canonicalize(source_profile)?
                && dunce::canonicalize(published.destination_path())?
                    == dunce::canonicalize(target_profile)?,
            "HISTORY_RELOCATION_PUBLISHED_COMPONENT_MISMATCH"
        );
        let held = graph::collect(&source, source_profile)?;
        ensure!(
            source.directory_identity()? == expected.profile
                && held
                    .iter()
                    .map(|entry| &entry.snapshot)
                    .eq(expected.directories.iter()),
            "HISTORY_RELOCATION_SOURCE_CHANGED"
        );
        let target = PrivateDirectory::open_existing(target_profile)?;
        target.verify_config_root_directory()?;
        let target_identity = target.directory_identity()?;
        ensure!(
            published.directory().directory_identity()? == target_identity,
            "HISTORY_RELOCATION_PUBLISHED_COMPONENT_MISMATCH"
        );
        ensure!(
            target_identity != expected.profile,
            "HISTORY_RELOCATION_SAME_PROFILE"
        );
        let mut target_locks = Vec::new();
        for entry in &held {
            published.verify()?;
            ensure!(
                open_relative(&source, &entry.snapshot.path)?.directory_identity()?
                    == entry.snapshot.identity,
                "HISTORY_RELOCATION_SOURCE_CHANGED"
            );
            let destination = open_relative(&target, &entry.snapshot.path)?;
            destination.verify_config_root_directory()?;
            ensure!(
                destination.directory_identity()? != entry.snapshot.identity,
                "HISTORY_RELOCATION_SAME_DIRECTORY"
            );
            for file in &entry.snapshot.files {
                if file.name.ends_with(".lock") || file.name.ends_with(".lease") {
                    let name = OsStr::new(&file.name);
                    let identity = observed_regular_identity(&destination, name)?;
                    target_locks.push(
                        destination
                            .try_existing_config_root_lock(
                                name,
                                &identity,
                                PrivateLeaseMode::Exclusive,
                            )?
                            .context("HISTORY_RELOCATION_OWNER_BUSY")?,
                    );
                }
            }
            verify_absent(&destination, &entry._absent)?;
            if !entry.mapping_required {
                verify_files(&destination, &entry.snapshot.files, false)?;
                ensure!(
                    entry.snapshot.prior_record.is_none()
                        && optional_bytes(&destination, RECORD, MAX_RECORD)?.is_none(),
                    "HISTORY_RELOCATION_FOREIGN_RECORD"
                );
                continue;
            }
            let existing = optional_bytes(&destination, RECORD, MAX_RECORD)?;
            let prior = entry
                .snapshot
                .prior_record
                .as_ref()
                .map(|(_, digest)| digest);
            let committed = read_record(&destination).ok().flatten();
            if let Some(record) = committed {
                verify_files(&destination, &entry.snapshot.files, false)?;
                ensure!(
                    record.value.operation == operation
                        && record.value.source_profile == expected.profile
                        && record.value.target_profile == target_identity
                        && record.value.source == entry.snapshot,
                    "HISTORY_RELOCATION_OPERATION_CONFLICT"
                );
                verify_target_bindings(&destination, &record.value)?;
                continue;
            }
            ensure!(
                match (&existing, prior) {
                    (None, None) => true,
                    (Some(bytes), Some(digest)) => hash(bytes) == *digest,
                    _ => false,
                },
                "HISTORY_RELOCATION_FOREIGN_RECORD"
            );
            ensure!(publish, "HISTORY_RELOCATION_UNCONFIRMED");
            publish_record(
                &destination,
                &target_identity,
                expected,
                entry,
                operation,
                existing.as_deref(),
            )?;
        }
        for entry in &held {
            verify_files(&entry.directory, &entry.snapshot.files, true)?;
            verify_absent(&entry.directory, &entry._absent)?;
            ensure!(
                read_record(&entry.directory)?
                    .as_ref()
                    .map(|record| (record.value.record_identity.clone(), hash(&record.bytes)))
                    == entry.snapshot.prior_record,
                "HISTORY_RELOCATION_SOURCE_CHANGED"
            );
            ensure!(
                entry.directory.directory_identity()? == entry.snapshot.identity
                    && open_relative(&source, &entry.snapshot.path)?.directory_identity()?
                        == entry.snapshot.identity,
                "HISTORY_RELOCATION_SOURCE_CHANGED"
            );
            let destination = open_relative(&target, &entry.snapshot.path)?;
            if !entry.mapping_required {
                continue;
            }
            let record = read_record(&destination)?.context("HISTORY_RELOCATION_UNCONFIRMED")?;
            ensure!(
                record.value.operation == operation
                    && record.value.source == entry.snapshot
                    && record.value.target_profile == target_identity,
                "HISTORY_RELOCATION_TARGET_CHANGED"
            );
            verify_target_bindings(&destination, &record.value)?;
            verify_absent(&destination, &entry._absent)?;
        }
        journal::verify_target(&target, &held)?;
        ensure!(
            PrivateDirectory::open_existing(source_profile)?.directory_identity()?
                == expected.profile
                && PrivateDirectory::open_existing(target_profile)?.directory_identity()?
                    == target_identity,
            "HISTORY_RELOCATION_ROOT_CHANGED"
        );
        published.verify()?;
        drop(target_locks);
        Ok(())
    }
}

fn valid_operation(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn observed_regular_identity(
    directory: &PrivateDirectory,
    name: &OsStr,
) -> Result<PortableLeaseIdentity> {
    PortableLeaseIdentity::from_regular_handle(&directory.open_single_link_regular_file(name)?)
}

fn observed_directory_identity(directory: &PrivateDirectory) -> Result<PortableLeaseIdentity> {
    directory.portable_directory_handle_identity()
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn optional_bytes(directory: &PrivateDirectory, name: &str, limit: u64) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    ensure!(
        file.metadata()?.len() <= limit,
        "HISTORY_RELOCATION_METADATA_LIMIT"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "HISTORY_RELOCATION_METADATA_LIMIT"
    );
    Ok(Some(bytes))
}

fn read_record(directory: &PrivateDirectory) -> Result<Option<HeldRecord>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(RECORD)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let bytes = optional_bytes(directory, RECORD, MAX_RECORD)?
        .context("HISTORY_RELOCATION_RECORD_MISSING")?;
    let value: Record =
        serde_json::from_slice(&bytes).context("HISTORY_RELOCATION_RECORD_INVALID")?;
    ensure!(
        value.version == 1
            && valid_operation(&value.operation)
            && !value.source_profile.is_empty()
            && !value.target_profile.is_empty()
            && value.source.files.len() <= MAX_FILES
            && value.files.len() == value.source.files.len()
            && value.children.len() == value.source.children.len()
            && value.children.len() <= MAX_DIRECTORIES
            && value.source.directory_aliases.len() <= MAX_ALIASES
            && value
                .source
                .directory_aliases
                .contains(&value.source.owner_seed)
            && value.source.retention_aliases.len() <= MAX_ALIASES
            && value.target_directory == directory.directory_identity()?
            && value.target_retention == observed_directory_identity(directory)?
            && value.record_identity == PortableLeaseIdentity::from_private_regular_handle(&file)?
            && value.record_identity == observed_regular_identity(directory, OsStr::new(RECORD))?
            && value
                .files
                .iter()
                .zip(&value.source.files)
                .all(|(target, source)| target.name == source.name
                    && target.recorded == source.aliases
                    && target.recorded_strings == source.string_aliases
                    && target.recorded.len() <= MAX_ALIASES
                    && target.recorded_strings.len() <= MAX_ALIASES)
            && value
                .children
                .iter()
                .zip(&value.source.children)
                .all(|(target, source)| target.name == source.name
                    && target.recorded == source.aliases
                    && target.recorded_strings == source.directory_aliases
                    && target.recorded.len() <= MAX_ALIASES
                    && target.recorded_strings.len() <= MAX_ALIASES),
        "HISTORY_RELOCATION_BINDING_CHANGED"
    );
    Ok(Some(HeldRecord {
        value,
        bytes,
        _file: file,
    }))
}

fn open_relative(profile: &PrivateDirectory, path: &[String]) -> Result<PrivateDirectory> {
    ensure!(
        !path.is_empty() && path.len() <= 32,
        "HISTORY_RELOCATION_PATH_INVALID"
    );
    let mut directory = profile.duplicate_handle()?;
    for name in path {
        ensure!(
            !name.is_empty()
                && name.len() <= 256
                && !matches!(name.as_str(), "." | "..")
                && !name.contains(['/', '\\']),
            "HISTORY_RELOCATION_PATH_INVALID"
        );
        directory = directory.open_child(OsStr::new(name), false)?;
    }
    Ok(directory)
}

fn fingerprint(
    directory: &PrivateDirectory,
    name: &str,
) -> Result<(PortableLeaseIdentity, u64, String)> {
    let mut file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let identity = PortableLeaseIdentity::from_regular_handle(&file)?;
    let bytes = file.metadata()?.len();
    let mut digest = Sha256::new();
    let mut length = 0u64;
    let mut buffer = [0; 64 * 1024];
    while length < bytes {
        let count = file.read(&mut buffer)?;
        ensure!(count != 0, "HISTORY_RELOCATION_CONTENT_CHANGED");
        length = length
            .checked_add(count as u64)
            .context("HISTORY_RELOCATION_BYTE_LIMIT")?;
        ensure!(length <= bytes, "HISTORY_RELOCATION_CONTENT_CHANGED");
        digest.update(&buffer[..count]);
    }
    ensure!(
        file.metadata()?.len() == bytes
            && observed_regular_identity(directory, OsStr::new(name))? == identity,
        "HISTORY_RELOCATION_CONTENT_CHANGED"
    );
    #[cfg(test)]
    tests::record_fingerprint_read(directory, name, bytes)?;
    Ok((identity, bytes, format!("{:x}", digest.finalize())))
}

fn verify_files(directory: &PrivateDirectory, files: &[FileSnapshot], source: bool) -> Result<()> {
    for expected in files {
        let (identity, bytes, sha256) = fingerprint(directory, &expected.name)?;
        ensure!(
            (!source || identity == expected.identity)
                && bytes == expected.bytes
                && sha256 == expected.sha256,
            "HISTORY_RELOCATION_CONTENT_CHANGED"
        );
    }
    Ok(())
}

fn verify_source_file_bindings(directory: &PrivateDirectory, files: &[FileSnapshot]) -> Result<()> {
    for expected in files {
        let name = OsStr::new(&expected.name);
        let file = directory.open_single_link_regular_file(name)?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&file)? == expected.identity
                && file.metadata()?.len() == expected.bytes
                && observed_regular_identity(directory, name)? == expected.identity,
            "HISTORY_RELOCATION_SOURCE_CHANGED"
        );
    }
    Ok(())
}

fn verify_absent(directory: &PrivateDirectory, names: &[String]) -> Result<()> {
    for name in names {
        match directory.open_single_link_regular_file(OsStr::new(name)) {
            Err(error) if missing(&error) => (),
            Ok(_) => anyhow::bail!("HISTORY_RELOCATION_ABSENCE_CHANGED"),
            Err(error) => return Err(error).context("HISTORY_RELOCATION_ABSENCE_CHANGED"),
        }
    }
    Ok(())
}

fn verify_target_bindings(directory: &PrivateDirectory, record: &Record) -> Result<()> {
    for expected in &record.files {
        ensure!(
            observed_regular_identity(directory, OsStr::new(&expected.name))? == expected.target,
            "HISTORY_RELOCATION_TARGET_CHANGED"
        );
    }
    for expected in &record.children {
        ensure!(
            observed_directory_identity(&directory.open_child(OsStr::new(&expected.name), false)?)?
                == expected.target,
            "HISTORY_RELOCATION_TARGET_CHANGED"
        );
    }
    Ok(())
}

fn publish_record(
    directory: &PrivateDirectory,
    target_profile: &str,
    expected: &HistoryStorageRelocationSnapshot,
    source: &HeldDirectory,
    operation: &str,
    prior: Option<&[u8]>,
) -> Result<()> {
    let temporary = format!(
        ".history-relocation-{}.prepared",
        hash(&serde_json::to_vec(&(
            operation,
            &expected.profile,
            directory.directory_identity()?,
        ))?)
    );
    let mut record = Record {
        version: 1,
        operation: operation.into(),
        source_profile: expected.profile.clone(),
        target_profile: target_profile.into(),
        source: source.snapshot.clone(),
        target_directory: directory.directory_identity()?,
        target_retention: observed_directory_identity(directory)?,
        record_identity: source.snapshot.retention_identity.clone(),
        files: source
            .snapshot
            .files
            .iter()
            .map(|file| {
                Ok(FileBinding {
                    name: file.name.clone(),
                    recorded: file.aliases.clone(),
                    recorded_strings: file.string_aliases.clone(),
                    target: observed_regular_identity(directory, OsStr::new(&file.name))?,
                })
            })
            .collect::<Result<_>>()?,
        children: source
            .snapshot
            .children
            .iter()
            .map(|child| {
                Ok(ChildBinding {
                    name: child.name.clone(),
                    recorded: child.aliases.clone(),
                    recorded_strings: child.directory_aliases.clone(),
                    target: observed_directory_identity(
                        &directory.open_child(OsStr::new(&child.name), false)?,
                    )?,
                })
            })
            .collect::<Result<_>>()?,
    };
    let temporary_file = match directory.open_read_write_file(OsStr::new(&temporary), true) {
        Ok(mut file) => {
            record.record_identity = PortableLeaseIdentity::from_private_regular_handle(&file)?;
            let bytes = serde_json::to_vec(&record)?;
            ensure!(
                bytes.len() as u64 <= MAX_RECORD,
                "HISTORY_RELOCATION_METADATA_LIMIT"
            );
            file.write_all(&bytes)?;
            file.sync_all()?;
            file
        }
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
            }) =>
        {
            let file = directory.open_read_write_file(OsStr::new(&temporary), false)?;
            record.record_identity = PortableLeaseIdentity::from_private_regular_handle(&file)?;
            ensure!(
                optional_bytes(directory, &temporary, MAX_RECORD)?
                    == Some(serde_json::to_vec(&record)?),
                "HISTORY_RELOCATION_UNCONFIRMED"
            );
            file
        }
        Err(error) => return Err(error),
    };
    // graph::collect just authenticated these source bytes under the held owner
    // locks. Check the actual source names here; target() rehashes the source
    // before returning. Only this sidecar is changed between those boundaries.
    verify_source_file_bindings(&source.directory, &source.snapshot.files)?;
    verify_files(directory, &source.snapshot.files, false)?;
    ensure!(
        optional_bytes(directory, RECORD, MAX_RECORD)?.as_deref() == prior,
        "HISTORY_RELOCATION_OPERATION_CONFLICT"
    );
    verify_target_bindings(directory, &record)?;
    if prior.is_some() {
        directory.publish_prepared(
            OsStr::new(&temporary),
            OsStr::new(RECORD),
            &PrivateDirectory::identity_of_file(&temporary_file)?,
        )?;
    } else {
        directory.rename_no_replace(OsStr::new(&temporary), OsStr::new(RECORD))?;
    }
    let committed = read_record(directory)?.context("HISTORY_RELOCATION_UNCONFIRMED")?;
    ensure!(committed.value == record, "HISTORY_RELOCATION_UNCONFIRMED");
    Ok(())
}

#[cfg(test)]
mod tests;
