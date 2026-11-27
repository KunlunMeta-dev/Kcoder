//! Offline namespace continuity for existing migration-history jobs.
//! The instance must already be stopped by the root migration coordinator.
use super::*;
use kcoder_config::{PortableLeaseIdentity, storage::StoragePublishedComponent};
use std::{collections::BTreeSet, io::Write, path::PathBuf};

const RECORD: &str = ".history-jobs-storage-relocation-v1";
const MAX_RECORD: u64 = 64 * 1024;
mod binding;
pub(super) use binding::Binding;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileSnapshot {
    name: String,
    identity: PortableLeaseIdentity,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistorySnapshot {
    directory: String,
    owner: String,
    archives_scope: String,
    jobs: Vec<String>,
    files: Vec<FileSnapshot>,
    absent: Vec<String>,
    prior_record: Option<(PortableLeaseIdentity, String)>,
}

/// Existing owner metadata captured without creating files or acquiring job authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryJobStorageRelocationSnapshot {
    version: u8,
    profile_path: PathBuf,
    profile: String,
    history: Option<HistorySnapshot>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    operation: String,
    source_path: PathBuf,
    source_profile: String,
    source_directory: String,
    source_snapshot_sha256: String,
    target_path: PathBuf,
    target_profile: String,
    target_directory: String,
    owner: String,
    archives_scope: String,
    identity: Option<PortableLeaseIdentity>,
}

pub struct HistoryJobStorageRelocation;
impl HistoryJobStorageRelocation {
    /// Reads only existing metadata. No catalogue, control or execution leaf is created.
    pub fn snapshot(profile: &Path) -> Result<HistoryJobStorageRelocationSnapshot> {
        capture(profile)
    }

    /// Bind the copied namespace only to the original operation's opaque publication.
    /// Original job, selection, execution and retirement metadata remain unchanged.
    pub fn relocate(
        source: &Path,
        target: &Path,
        operation: &str,
        expected: &HistoryJobStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        relocate_target(source, target, operation, expected, published, true)
    }

    /// Verification is read-only and never reconciles or resumes an unknown job.
    pub fn verify_relocation(
        source: &Path,
        target: &Path,
        operation: &str,
        expected: &HistoryJobStorageRelocationSnapshot,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        relocate_target(source, target, operation, expected, published, false)
    }
}

fn optional_child(directory: &PrivateDirectory, name: &str) -> Result<Option<PrivateDirectory>> {
    match directory.open_child(OsStr::new(name), false) {
        Ok(directory) => {
            directory.verify_private_directory()?;
            Ok(Some(directory))
        }
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn history_directory(root: &PrivateDirectory) -> Result<Option<PrivateDirectory>> {
    let Some(migrations) = optional_child(root, "migrations")? else {
        return Ok(None);
    };
    optional_child(&migrations, "history")
}

// These independent owners still contain physical consumer bindings. A copied
// directory is preserved by the root copier, but does not prove cold-read support.
fn preflight(root: &PrivateDirectory) -> Result<()> {
    let Some(migrations) = optional_child(root, "migrations")? else {
        return Ok(());
    };
    for (name, code) in [
        (
            "source-transfer",
            "history_job_relocation_source_transfer_unconfirmed",
        ),
        (
            "history-attachments",
            "history_job_relocation_attachments_unconfirmed",
        ),
    ] {
        if let Some(directory) = optional_child(&migrations, name)? {
            directory.visit_entry_names_bounded(MAX_JOB_ENTRIES, |_| anyhow::bail!(code))?;
        }
    }
    Ok(())
}

fn job_ids(directory: &PrivateDirectory) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    directory.visit_entry_names_bounded(MAX_JOB_ENTRIES, |name| {
        if let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json"))
            && valid_id(id).is_ok()
        {
            ensure!(ids.len() < MAX_JOBS, "history_job_count_budget_exceeded");
            ids.push(id.into());
        }
        Ok(())
    })?;
    ids.sort();
    Ok(ids)
}

fn names(ids: &[String]) -> BTreeSet<String> {
    let mut names = BTreeSet::from(["catalog.lock".into(), "control.lock".into()]);
    for id in ids {
        for suffix in [
            "json",
            "cancel.json",
            "run.lock",
            "execution.lock",
            "execution.birth",
            "resource.birth",
        ] {
            names.insert(format!("{id}.{suffix}"));
        }
    }
    names
}

fn read_file(
    directory: &PrivateDirectory,
    name: &str,
    maximum: u64,
) -> Result<Option<(Vec<u8>, PortableLeaseIdentity)>> {
    let mut file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let before = file.metadata()?;
    let identity = directory.portable_regular_handle_identity(&file)?;
    ensure!(
        before.len() <= maximum,
        "history_job_relocation_metadata_limit"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        bytes.len() as u64 == before.len()
            && before.len() == after.len()
            && before.modified().ok() == after.modified().ok()
            && directory.portable_regular_identity(OsStr::new(name))? == identity,
        "history_job_relocation_source_changed"
    );
    Ok(Some((bytes, identity)))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fingerprint_file(directory: &PrivateDirectory, name: &str) -> Result<Option<FileSnapshot>> {
    let mut file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let before = file.metadata()?;
    let identity = directory.portable_regular_handle_identity(&file)?;
    let mut digest = Sha256::new();
    let mut remaining = before.len();
    let mut buffer = [0; 64 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..limit])?;
        ensure!(count > 0, "history_job_relocation_source_changed");
        digest.update(&buffer[..count]);
        remaining -= count as u64;
    }
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len()
            && before.modified().ok() == after.modified().ok()
            && directory.portable_regular_identity(OsStr::new(name))? == identity,
        "history_job_relocation_source_changed"
    );
    Ok(Some(FileSnapshot {
        name: name.into(),
        identity,
        bytes: before.len(),
        sha256: format!("{:x}", digest.finalize()),
    }))
}

fn capture(profile: &Path) -> Result<HistoryJobStorageRelocationSnapshot> {
    let root = PrivateDirectory::open_existing(profile)?;
    root.verify_config_root_directory()?;
    preflight(&root)?;
    let profile_path = std::fs::canonicalize(profile)?;
    let profile_identity = root.directory_identity()?;
    let history = if let Some(store) = HistoryJobStore::open_existing(profile)? {
        let jobs = job_ids(&store.directory)?;
        let mut files = Vec::new();
        let mut absent = Vec::new();
        // Job payloads remain opaque: relocating bytes does not validate or
        // repair their business state, ownership claims or unknown receipts.
        for name in names(&jobs) {
            match fingerprint_file(&store.directory, &name)? {
                Some(file) => files.push(file),
                None => absent.push(name),
            }
        }
        Some(HistorySnapshot {
            directory: store.directory.directory_identity()?,
            owner: store.owner,
            archives_scope: store.archives.scope_fingerprint()?,
            jobs,
            files,
            absent,
            prior_record: store.relocation.record_fingerprint(),
        })
    } else {
        None
    };
    ensure!(
        PrivateDirectory::open_existing(&profile_path)?.directory_identity()? == profile_identity,
        "history_job_relocation_source_changed"
    );
    Ok(HistoryJobStorageRelocationSnapshot {
        version: 1,
        profile_path,
        profile: profile_identity,
        history,
    })
}

fn relocate_target(
    source: &Path,
    target: &Path,
    operation: &str,
    expected: &HistoryJobStorageRelocationSnapshot,
    published: &StoragePublishedComponent,
    publish: bool,
) -> Result<()> {
    ensure!(
        !operation.is_empty()
            && operation.len() <= 128
            && operation
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "history_job_relocation_operation_invalid"
    );
    ensure!(
        capture(source)? == *expected,
        "history_job_relocation_source_changed"
    );
    published.verify()?;
    let target_path = std::fs::canonicalize(target)?;
    let root = PrivateDirectory::open_existing(target)?;
    root.verify_config_root_directory()?;
    preflight(&root)?;
    let target_profile = root.directory_identity()?;
    ensure!(
        expected.version == 1
            && expected.profile_path == std::fs::canonicalize(source)?
            && published.operation_id() == operation
            && published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
            && published.source_identity() == expected.profile
            && std::fs::canonicalize(published.source_path())? == expected.profile_path
            && std::fs::canonicalize(published.destination_path())? == target_path
            && published.directory().directory_identity()? == target_profile
            && target_profile != expected.profile,
        "history_job_relocation_published_component_mismatch"
    );
    let directory = history_directory(&root)?;
    let Some(history) = &expected.history else {
        ensure!(directory.is_none(), "history_job_relocation_target_changed");
        return Ok(());
    };
    let directory = directory.context("history_job_relocation_target_changed")?;
    let archives = ExternalHistoryStore::open_existing(target)?
        .context("history_job_archive_store_missing")?;
    ensure!(
        archives.scope_fingerprint()? == history.archives_scope,
        "history_job_relocation_archive_scope_changed"
    );
    ensure!(
        job_ids(&directory)? == history.jobs,
        "history_job_relocation_target_changed"
    );
    for file in &history.files {
        let actual = fingerprint_file(&directory, &file.name)?
            .context("history_job_relocation_target_changed")?;
        ensure!(
            actual.bytes == file.bytes && actual.sha256 == file.sha256,
            "history_job_relocation_target_changed"
        );
    }
    for name in &history.absent {
        ensure!(
            fingerprint_file(&directory, name)?.is_none(),
            "history_job_relocation_target_changed"
        );
    }
    let mut record = Record {
        version: 1,
        operation: operation.into(),
        source_path: expected.profile_path.clone(),
        source_profile: expected.profile.clone(),
        source_directory: history.directory.clone(),
        source_snapshot_sha256: digest(&serde_json::to_vec(expected)?),
        target_path,
        target_profile,
        target_directory: directory.directory_identity()?,
        owner: history.owner.clone(),
        archives_scope: history.archives_scope.clone(),
        identity: None,
    };
    let existing = read_file(&directory, RECORD, MAX_RECORD)?;
    if let Some((bytes, identity)) = &existing
        && let Ok(current) = serde_json::from_slice::<Record>(bytes)
        && current.target_profile == record.target_profile
    {
        record.identity = Some(identity.clone());
        ensure!(
            current == record,
            "history_job_relocation_operation_conflict"
        );
        binding::validate_record(&directory, &root, target, &archives, &current, identity)?;
    } else {
        ensure!(
            existing.as_ref().map(|(bytes, _)| digest(bytes))
                == history.prior_record.as_ref().map(|(_, sha)| sha.clone()),
            "history_job_relocation_target_changed"
        );
        ensure!(publish, "history_job_relocation_unconfirmed");
        publish_record(
            &directory,
            &mut record,
            existing.as_ref().map(|(bytes, _)| bytes.as_slice()),
        )?;
    }
    let cold =
        HistoryJobStore::open_existing(target)?.context("history_job_relocation_unconfirmed")?;
    ensure!(
        cold.owner == history.owner,
        "history_job_relocation_unconfirmed"
    );
    published.verify()?;
    ensure!(
        capture(source)? == *expected,
        "history_job_relocation_source_changed"
    );
    Ok(())
}

fn publish_record(
    directory: &PrivateDirectory,
    record: &mut Record,
    prior: Option<&[u8]>,
) -> Result<()> {
    let temporary = format!(
        ".history-jobs-relocation-{}.prepared",
        digest(record.operation.as_bytes())
    );
    let mut file = match directory.open_read_write_file(OsStr::new(&temporary), true) {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists)
            }) =>
        {
            directory.open_read_write_file(OsStr::new(&temporary), false)?
        }
        Err(error) => return Err(error),
    };
    record.identity = Some(directory.portable_regular_handle_identity(&file)?);
    let bytes = serde_json::to_vec(record)?;
    ensure!(
        bytes.len() as u64 <= MAX_RECORD,
        "history_job_relocation_metadata_limit"
    );
    if file.metadata()?.len() == 0 {
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    ensure!(
        read_file(directory, &temporary, MAX_RECORD)?.is_some_and(|(actual, _)| actual == bytes),
        "history_job_relocation_unconfirmed"
    );
    ensure!(
        read_file(directory, RECORD, MAX_RECORD)?
            .as_ref()
            .map(|(bytes, _)| bytes.as_slice())
            == prior,
        "history_job_relocation_operation_conflict"
    );
    if prior.is_some() {
        directory.publish_prepared(
            OsStr::new(&temporary),
            OsStr::new(RECORD),
            &PrivateDirectory::identity_of_file(&file)?,
        )?;
    } else {
        directory.rename_no_replace(OsStr::new(&temporary), OsStr::new(RECORD))?;
    }
    ensure!(
        read_file(directory, RECORD, MAX_RECORD)?
            .is_some_and(|(actual, identity)| actual == bytes && Some(identity) == record.identity),
        "history_job_relocation_unconfirmed"
    );
    Ok(())
}
