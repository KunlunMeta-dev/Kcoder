//! Offline, session-owned address relocation. History and draft receipts stay byte-identical.
use super::*;
use anyhow::ensure;
use kcoder_config::storage::StoragePublishedComponent;
use kcoder_fs::{PortableLeaseIdentity, PrivateLeaseMode, VerifiedPrivateLease};
use kcoder_state::history_storage_relocation::{
    self as history_relocation, HistoryRelocationMetadata,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, ffi::OsStr};

const MAX_ENTRIES: usize = 16_384;
const MAX_RECEIPT_BYTES: u64 = 8 * 1024 * 1024;

#[cfg(test)]
std::thread_local! {
    static RECEIPT_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

mod profile;
pub use profile::ProfileAttachmentsRelocation;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileSnapshot {
    identity: PortableLeaseIdentity,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentRelocationSnapshot {
    thread_id: String,
    session: PathBuf,
    identity: String,
    directories: BTreeMap<PathBuf, PortableLeaseIdentity>,
    history_metadata: BTreeMap<PathBuf, HistoryRelocationMetadata>,
    files: BTreeMap<PathBuf, FileSnapshot>,
    previous_receipt_sha256: Option<String>,
    aliases: BTreeMap<PathBuf, PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelocationReceipt {
    version: u32,
    operation_id: String,
    thread_id: String,
    source_session: PathBuf,
    source_snapshot_sha256: String,
    target_session: PathBuf,
    target_identity: String,
    target_parent_identity: String,
    aliases: BTreeMap<PathBuf, PathBuf>,
    files: BTreeMap<PathBuf, FileSnapshot>,
}

fn valid_atom(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn absent(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn receipt_location(session: &Path) -> Result<(PrivateDirectory, String)> {
    let session = session.canonicalize()?;
    let parent = PrivateDirectory::open_existing(
        session
            .parent()
            .context("attachment session parent missing")?,
    )?;
    parent.verify_config_root_directory()?;
    let name = format!(
        ".attachments-relocation-v1-{}.json",
        hex_sha256(
            session
                .file_name()
                .context("attachment session name missing")?
                .as_encoded_bytes()
        )
    );
    Ok((parent, name))
}

fn receipt_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    let (directory, name) = receipt_location(path)?;
    let file = match directory.open_single_link_regular_file(OsStr::new(&name)) {
        Ok(file) => file,
        Err(error) if absent(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    PortableLeaseIdentity::from_private_regular_handle(&file)?;
    ensure!(
        file.metadata()?.len() <= MAX_RECEIPT_BYTES,
        "attachment relocation record exceeds bound"
    );
    let mut bytes = Vec::new();
    #[cfg(test)]
    RECEIPT_READS.set(RECEIPT_READS.get() + 1);
    file.take(MAX_RECEIPT_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_RECEIPT_BYTES,
        "attachment relocation record exceeds bound"
    );
    Ok(Some(bytes))
}

fn relative(path: &Path) -> Result<()> {
    ensure!(
        path.components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
            && path.components().count() >= 2
            && path.components().next().is_some_and(|part| matches!(
                part.as_os_str().to_str(),
                Some("attachments" | "draft-attachments")
            )),
        "attachment relocation path is outside its owner"
    );
    Ok(())
}

fn open_parent(session: &PrivateDirectory, path: &Path) -> Result<PrivateDirectory> {
    relative(path)?;
    let mut directory = session.open_child(path.components().next().unwrap().as_os_str(), false)?;
    for part in path
        .parent()
        .context("attachment parent missing")?
        .components()
        .skip(1)
    {
        directory = directory.open_child(part.as_os_str(), false)?;
    }
    directory.verify_private_directory()?;
    Ok(directory)
}

fn validate_receipt(
    session: &PrivateDirectory,
    path: &Path,
    receipt: &RelocationReceipt,
) -> Result<()> {
    session.verify_trusted_config_directory()?;
    ensure!(
        receipt.version == 1
            && valid_atom(&receipt.operation_id)
            && valid_atom(&receipt.thread_id)
            && receipt.target_session == path.canonicalize()?
            && receipt.target_identity == session.directory_identity()?
            && receipt.target_parent_identity == receipt_location(path)?.0.directory_identity()?
            && receipt.files.len() <= MAX_ENTRIES
            && receipt.aliases.len() <= MAX_ENTRIES * 8,
        "attachment relocation owner changed"
    );
    for (alias, destination) in &receipt.aliases {
        relative(destination)?;
        ensure!(
            alias.is_absolute() && receipt.files.contains_key(destination),
            "invalid attachment relocation alias"
        );
    }
    Ok(())
}

fn alias_destination<'a>(
    aliases: &'a BTreeMap<PathBuf, PathBuf>,
    path: &Path,
) -> Option<&'a PathBuf> {
    if let Some(destination) = aliases.get(path) {
        return Some(destination);
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        if !matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_)))
        {
            return None;
        }
        let path = kcoder_config::storage::node_storage_path(path).ok()?;
        // Only ordinary DOS names have the same meaning after adding the
        // canonical namespace prefix. Never open the historical source path.
        for part in path.components() {
            if let Component::Normal(name) = part {
                let name = name.to_str()?;
                let stem = name.split('.').next()?.trim_end_matches(' ');
                let reserved = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
                    .iter()
                    .any(|reserved| stem.eq_ignore_ascii_case(reserved))
                    || (stem.get(..3).is_some_and(|prefix| {
                        prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT")
                    }) && matches!(
                        stem.get(3..),
                        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
                    ));
                if reserved
                    || name.ends_with([' ', '.'])
                    || name
                        .chars()
                        .any(|c| c.is_control() || r#"<>:"/\|?*"#.contains(c))
                {
                    return None;
                }
            }
        }
        let mut canonical = std::ffi::OsString::from(r"\\?\");
        canonical.push(path);
        return aliases.get(Path::new(&canonical));
    }
    #[cfg(not(windows))]
    None
}

/// Resolve only a previously verified owned address. No source path is opened.
pub(super) fn resolve_session_path(session_path: &Path, path: &Path) -> Result<Option<PathBuf>> {
    let session = match PrivateDirectory::open_existing(session_path) {
        Ok(session) => session,
        Err(error) if absent(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let Some(bytes) = receipt_bytes(session_path)? else {
        return Ok(None);
    };
    let receipt: RelocationReceipt = serde_json::from_slice(&bytes)?;
    validate_receipt(&session, session_path, &receipt)?;
    let Some(relative) = alias_destination(&receipt.aliases, path) else {
        return Ok(None);
    };
    let binding = receipt
        .files
        .get(relative)
        .context("attachment relocation file missing")?;
    let parent = open_parent(&session, relative)?;
    let file =
        parent.portable_open_verified_regular(relative.file_name().unwrap(), &binding.identity)?;
    ensure!(
        file.file().metadata()?.len() == binding.size,
        "relocated attachment size changed"
    );
    Ok(Some(receipt.target_session.join(relative)))
}

fn scan(
    directory: &PrivateDirectory,
    path: &Path,
    snapshot: &mut AttachmentRelocationSnapshot,
    published: Option<(
        &StoragePublishedComponent,
        &BTreeMap<PathBuf, HistoryRelocationMetadata>,
    )>,
) -> Result<()> {
    ensure!(
        path.components().count() <= 16
            && snapshot.directories.len() + snapshot.files.len() < MAX_ENTRIES,
        "attachment relocation entry bound"
    );
    snapshot
        .directories
        .insert(path.into(), directory.portable_retention_identity()?);
    let metadata = match published {
        Some((proof, original)) => history_relocation::verify_relocation_metadata(
            proof,
            directory,
            original
                .get(path)
                .context("attachment source directory fact missing")?,
        )?,
        None => history_relocation::observe_relocation_metadata(directory)?,
    };
    for name in directory.entry_names_bounded(MAX_ENTRIES)? {
        if metadata.is_metadata_entry(directory, &name)? {
            continue;
        }
        let relative = path.join(&name);
        match directory.open_single_link_regular_file(&name) {
            Ok(mut file) => {
                ensure!(
                    snapshot.files.len() + snapshot.directories.len() < MAX_ENTRIES,
                    "attachment relocation entry bound"
                );
                let size = file.metadata()?.len();
                ensure!(
                    size <= MAX_ATTACHMENT_BYTES as u64,
                    "attachment relocation file exceeds bound"
                );
                let identity = directory.portable_retention_regular_handle_identity(&file)?;
                let mut bytes = Vec::new();
                Read::by_ref(&mut file).take(size).read_to_end(&mut bytes)?;
                ensure!(
                    bytes.len() as u64 == size && file.metadata()?.len() == size,
                    "attachment relocation file changed"
                );
                directory.portable_open_verified_regular(&name, &identity)?;
                snapshot.files.insert(
                    relative.clone(),
                    FileSnapshot {
                        identity,
                        size,
                        sha256: hex_sha256(&bytes),
                    },
                );
                snapshot
                    .aliases
                    .insert(snapshot.session.join(&relative), relative);
            }
            Err(file_error) => {
                let child = directory
                    .open_child(&name, false)
                    .with_context(|| format!("unsupported attachment entry: {file_error}"))?;
                scan(&child, &relative, snapshot, published)?;
            }
        }
    }
    snapshot.history_metadata.insert(path.into(), metadata);
    Ok(())
}

fn draft_leases(session: &PrivateDirectory, thread: &str) -> Result<Vec<VerifiedPrivateLease>> {
    let root = match session.open_child(OsStr::new("draft-attachments"), false) {
        Ok(root) => root,
        Err(error) if absent(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut leases = Vec::new();
    for name in root.entry_names_bounded(66)? {
        if name == OsStr::new("transaction.lock") {
            let identity = root.portable_regular_identity(&name)?;
            leases.push(
                root.try_existing_portable_lock(&name, &identity, PrivateLeaseMode::Exclusive)?
                    .context("attachment draft transaction is busy")?,
            );
        } else {
            ensure!(
                name.to_str()
                    .is_some_and(|name| name.starts_with("d-") && name.len() == 66),
                "attachment draft publication is incomplete"
            );
            let directory = root.open_child(&name, false)?;
            let record = drafts::read_record(&directory)?;
            ensure!(
                drafts::record_thread(&record) == thread,
                "attachment draft thread changed"
            );
            let identity = directory.portable_regular_identity(OsStr::new("owner.lock"))?;
            leases.push(
                directory
                    .try_existing_portable_lock(
                        OsStr::new("owner.lock"),
                        &identity,
                        PrivateLeaseMode::Exclusive,
                    )?
                    .context("attachment draft owner is busy")?,
            );
        }
    }
    Ok(leases)
}

/// Read-only offline inventory. It neither creates locks nor repairs permissions.
pub fn relocation_snapshot(
    session_path: &Path,
    thread_id: &str,
) -> Result<AttachmentRelocationSnapshot> {
    ensure!(
        valid_atom(thread_id),
        "invalid attachment relocation thread"
    );
    let session = PrivateDirectory::open_existing(session_path)?;
    session.verify_trusted_config_directory()?;
    let _leases = draft_leases(&session, thread_id)?;
    snapshot_locked(&session, session_path, thread_id)
}

fn snapshot_locked(
    session: &PrivateDirectory,
    path: &Path,
    thread_id: &str,
) -> Result<AttachmentRelocationSnapshot> {
    let prior = receipt_bytes(path)?;
    let mut snapshot = snapshot_locked_without_prior(session, path, thread_id, None)?;
    snapshot.previous_receipt_sha256 = prior.as_deref().map(hex_sha256);
    if let Some(bytes) = &prior {
        let receipt: RelocationReceipt = serde_json::from_slice(bytes)?;
        validate_receipt(session, path, &receipt)?;
        ensure!(
            receipt.thread_id == thread_id,
            "attachment relocation thread changed"
        );
        // Preserve birth addresses for existing files. Another move must not
        // append an intermediate root; only a new file needs a new address.
        let existing = receipt
            .aliases
            .values()
            .collect::<std::collections::BTreeSet<_>>();
        snapshot
            .aliases
            .retain(|_, relative| !existing.contains(relative));
        snapshot.aliases.extend(receipt.aliases);
    }
    snapshot
        .aliases
        .retain(|_, path| snapshot.files.contains_key(path));
    ensure!(
        snapshot.aliases.len() <= MAX_ENTRIES * 8,
        "attachment relocation alias bound"
    );
    Ok(snapshot)
}

/// The global stopped coordinator copies files; this owner publishes only address evidence.
pub fn relocate(
    source: &Path,
    target: &Path,
    operation_id: &str,
    expected: &AttachmentRelocationSnapshot,
    published: &StoragePublishedComponent,
) -> Result<()> {
    relocation_target(source, target, operation_id, expected, published, true)
}

/// Verify an exact final destination without changing history, receipts or leases.
pub fn verify_relocation(
    source: &Path,
    target: &Path,
    operation_id: &str,
    expected: &AttachmentRelocationSnapshot,
    published: &StoragePublishedComponent,
) -> Result<()> {
    relocation_target(source, target, operation_id, expected, published, false)
}

fn relocation_target(
    source: &Path,
    target: &Path,
    operation_id: &str,
    expected: &AttachmentRelocationSnapshot,
    published: &StoragePublishedComponent,
    publish: bool,
) -> Result<()> {
    verify_published(published, source, target, operation_id)?;
    ensure!(
        valid_atom(operation_id),
        "invalid attachment relocation operation"
    );
    let source_dir = PrivateDirectory::open_existing(source)?;
    let _source_leases = draft_leases(&source_dir, &expected.thread_id)?;
    ensure!(
        snapshot_locked(&source_dir, source, &expected.thread_id)? == *expected,
        "attachment relocation source changed"
    );
    let target_dir = PrivateDirectory::open_existing(target)?;
    let _target_leases = draft_leases(&target_dir, &expected.thread_id)?;
    ensure!(
        target_dir.directory_identity()? != expected.identity,
        "attachment relocation source aliases target"
    );
    let actual = snapshot_locked_without_prior(
        &target_dir,
        target,
        &expected.thread_id,
        Some((published, &expected.history_metadata)),
    )?;
    ensure!(
        actual.directories.keys().eq(expected.directories.keys())
            && actual.files.keys().eq(expected.files.keys()),
        "attachment relocation copy differs"
    );
    for (name, original) in &expected.files {
        let copy = &actual.files[name];
        ensure!(
            copy.size == original.size && copy.sha256 == original.sha256,
            "attachment relocation payload changed"
        );
    }
    let receipt = RelocationReceipt {
        version: 1,
        operation_id: operation_id.into(),
        thread_id: expected.thread_id.clone(),
        source_session: expected.session.clone(),
        source_snapshot_sha256: hex_sha256(&serde_json::to_vec(expected)?),
        target_session: target.canonicalize()?,
        target_identity: actual.identity,
        target_parent_identity: receipt_location(target)?.0.directory_identity()?,
        aliases: expected.aliases.clone(),
        files: actual.files,
    };
    let previous = receipt_bytes(target)?;
    let committed = previous
        .as_deref()
        .map(serde_json::from_slice::<RelocationReceipt>)
        .transpose()?
        .as_ref()
        == Some(&receipt);
    if !committed {
        ensure!(
            publish && previous.as_deref().map(hex_sha256) == expected.previous_receipt_sha256,
            "attachment relocation operation or target changed"
        );
        let bytes = serde_json::to_vec(&receipt)?;
        ensure!(
            bytes.len() as u64 <= MAX_RECEIPT_BYTES,
            "attachment relocation record exceeds bound"
        );
        let (parent, name) = receipt_location(target)?;
        parent.atomic_replace(OsStr::new(&name), &bytes)?;
    }
    let reloaded: RelocationReceipt = serde_json::from_slice(
        &receipt_bytes(target)?.context("attachment relocation receipt missing")?,
    )?;
    ensure!(
        reloaded == receipt,
        "attachment relocation publication is unknown"
    );
    validate_receipt(&target_dir, target, &reloaded)?;
    verify_published(published, source, target, operation_id)
}

fn verify_published(
    published: &StoragePublishedComponent,
    source: &Path,
    target: &Path,
    operation_id: &str,
) -> Result<()> {
    published.verify()?;
    ensure!(
        published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
            && published.operation_id() == operation_id
            && PrivateDirectory::open_existing(published.source_path())?.directory_identity()?
                == published.source_identity(),
        "attachment relocation publication differs"
    );
    ensure!(
        source
            .canonicalize()?
            .strip_prefix(published.source_path().canonicalize()?)?
            == target
                .canonicalize()?
                .strip_prefix(published.destination_path().canonicalize()?)?,
        "attachment relocation is outside the published component"
    );
    ensure!(
        target
            .canonicalize()?
            .parent()
            .context("attachment session parent missing")?
            .starts_with(published.destination_path().canonicalize()?),
        "attachment control sibling is outside the published component"
    );
    Ok(())
}

fn snapshot_locked_without_prior(
    session: &PrivateDirectory,
    path: &Path,
    thread_id: &str,
    published: Option<(
        &StoragePublishedComponent,
        &BTreeMap<PathBuf, HistoryRelocationMetadata>,
    )>,
) -> Result<AttachmentRelocationSnapshot> {
    let mut snapshot = AttachmentRelocationSnapshot {
        thread_id: thread_id.into(),
        session: path.canonicalize()?,
        identity: session.directory_identity()?,
        directories: BTreeMap::new(),
        history_metadata: BTreeMap::new(),
        files: BTreeMap::new(),
        previous_receipt_sha256: None,
        aliases: BTreeMap::new(),
    };
    for name in ["attachments", "draft-attachments"] {
        match session.open_child(OsStr::new(name), false) {
            Ok(directory) => scan(&directory, Path::new(name), &mut snapshot, published)?,
            Err(error) if absent(&error) => (),
            Err(error) => return Err(error),
        }
    }
    Ok(snapshot)
}

#[cfg(test)]
#[path = "relocation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "relocation_alias_tests.rs"]
mod relocation_alias_tests;
