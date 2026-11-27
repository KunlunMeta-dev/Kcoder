//! Compose only State-registered session attachments and the explicit retention namespace.
use super::*;
use kcoder_attachment_retention::relocation::{self as retention, RetentionRelocationSnapshot};

const VERSION: u32 = 1;
const MAX_PROFILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SESSIONS: usize = 65_536;
const MAX_PROFILE_ENTRIES: usize = 131_072;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionSource {
    thread_id: String,
    directory: PathBuf,
    snapshot: Option<AttachmentRelocationSnapshot>,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    version: u32,
    operation_id: String,
    source_profile: PathBuf,
    source_identity: String,
    sessions: Vec<SessionSource>,
    retention: Option<RetentionRelocationSnapshot>,
}

/// Small evidence binding for the global operation. The collection itself stays
/// in this domain's bounded source snapshot, outside both movable roots.
/// Deserializing this binding grants no storage or publication capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileAttachmentsRelocation {
    version: u32,
    operation_id: String,
    source_profile: PathBuf,
    source_identity: String,
    evidence_identity: String,
    file_identity: PortableLeaseIdentity,
    snapshot_sha256: String,
}

struct BoundedBytes(Vec<u8>);
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self
            .0
            .len()
            .checked_add(bytes.len())
            .is_none_or(|size| size > MAX_PROFILE_BYTES)
        {
            return Err(std::io::Error::other(
                "profile attachment snapshot exceeds bound",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn bounded_bytes(value: &impl Serialize) -> Result<Vec<u8>> {
    let mut output = BoundedBytes(Vec::new());
    serde_json::to_writer(&mut output, value)?;
    Ok(output.0)
}

fn child(directory: &PrivateDirectory, name: &str) -> Result<Option<PrivateDirectory>> {
    match directory.open_child(OsStr::new(name), false) {
        Ok(child) => Ok(Some(child)),
        Err(error) if absent(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
fn has_attachments(session: &PrivateDirectory) -> Result<bool> {
    Ok(child(session, "attachments")?.is_some() || child(session, "draft-attachments")?.is_some())
}
fn evidence_directory(
    path: &Path,
    source: &Path,
    target: Option<&Path>,
) -> Result<PrivateDirectory> {
    let path = path.canonicalize()?;
    for root in std::iter::once(source).chain(target) {
        let root = root.canonicalize()?;
        ensure!(
            !path.starts_with(&root) && !root.starts_with(&path),
            "attachment evidence overlaps a movable profile"
        );
    }
    let directory = PrivateDirectory::open_existing(&path)?;
    directory.verify_private_directory()?;
    Ok(directory)
}

/// State authenticates registration. Attachment code never discovers thread IDs
/// from arbitrary child names, derives project cwd, or initializes a namespace.
fn registered_sessions(profile: &Path) -> Result<Vec<(String, PathBuf, bool)>> {
    let mut locations = BTreeMap::new();
    for session in kcoder_state::history_storage_relocation::registered_profile_sessions(profile)? {
        ensure!(
            locations.len() < MAX_SESSIONS && valid_atom(&session.thread_id),
            "profile attachment session bound"
        );
        let path = session.session_directory.canonicalize()?;
        let relative = path.strip_prefix(profile)?.to_path_buf();
        ensure!(
            !relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_))),
            "registered attachment session is outside its profile"
        );
        let directory = PrivateDirectory::open_existing(&path)?;
        ensure!(
            locations
                .insert(relative, (session.thread_id, has_attachments(&directory)?))
                .is_none(),
            "duplicate registered attachment session"
        );
    }
    Ok(locations
        .into_iter()
        .map(|(path, (thread, present))| (thread, path, present))
        .collect())
}

fn collect(profile: &Path, operation: &str) -> Result<Snapshot> {
    let profile = profile.canonicalize()?;
    let directory = PrivateDirectory::open_existing(&profile)?;
    directory.verify_config_root_directory()?;
    let identity = directory.directory_identity()?;
    let mut sessions = Vec::new();
    let mut artifact_parents = Vec::new();
    let mut entries = 0usize;
    let mut metadata_bytes = 0usize;
    let registered = registered_sessions(&profile)?;
    let sealed = registered
        .iter()
        .map(|(_, path, _)| profile.join(path))
        .collect::<std::collections::BTreeSet<_>>();
    for (_, relative, _) in &registered {
        let path = profile.join(relative);
        let (_, name) = receipt_location(&path)?;
        let control = path
            .parent()
            .context("attachment session parent missing")?
            .join(name);
        ensure!(
            control
                .ancestors()
                .all(|ancestor| !sealed.contains(ancestor))
                && !profile.join("attachment-retention-v1").starts_with(&path),
            "attachment control metadata overlaps a registered session"
        );
    }
    for (thread_id, relative, present) in registered {
        let source = profile.join(&relative);
        let snapshot = if present {
            let snapshot = super::relocation_snapshot(&source, &thread_id)?;
            entries += snapshot.directories.len() + snapshot.files.len();
            ensure!(
                entries <= MAX_PROFILE_ENTRIES,
                "profile attachment entry bound"
            );
            let session = PrivateDirectory::open_existing(&source)?;
            if child(&session, "attachments")?.is_some() {
                artifact_parents.push(source.join("attachments"));
            }
            Some(snapshot)
        } else {
            None
        };
        let session = SessionSource {
            thread_id,
            directory: relative,
            snapshot,
        };
        metadata_bytes += bounded_bytes(&session)?.len();
        ensure!(
            metadata_bytes <= MAX_PROFILE_BYTES,
            "profile attachment snapshot exceeds bound"
        );
        sessions.push(session);
    }
    let retention = if child(&directory, "attachment-retention-v1")?.is_some() {
        Some(retention::relocation_snapshot_registered(
            &profile,
            &artifact_parents,
        )?)
    } else {
        None
    };
    ensure!(
        PrivateDirectory::open_existing(&profile)?.directory_identity()? == identity,
        "profile attachment source changed"
    );
    let snapshot = Snapshot {
        version: VERSION,
        operation_id: operation.into(),
        source_profile: profile,
        source_identity: identity,
        sessions,
        retention,
    };
    Ok(snapshot)
}

impl ProfileAttachmentsRelocation {
    /// Call after the global stopped fence. Source collection is read-only;
    /// only this operation's evidence directory receives a bounded source file.
    pub fn snapshot(
        source_profile: &Path,
        operation_id: &str,
        owner_evidence_directory: &Path,
    ) -> Result<Self> {
        ensure!(
            valid_atom(operation_id),
            "invalid profile attachment operation"
        );
        let snapshot = collect(source_profile, operation_id)?;
        let evidence = evidence_directory(owner_evidence_directory, source_profile, None)?;
        let bytes = bounded_bytes(&snapshot)?;
        let name = snapshot_name(operation_id);
        match evidence.open_single_link_regular_file(OsStr::new(&name)) {
            Ok(file) => ensure!(
                read_snapshot_file(file)? == bytes,
                "profile attachment source snapshot changed"
            ),
            Err(error) if absent(&error) => {
                evidence.atomic_publish_from_reader(
                    OsStr::new(&name),
                    &mut std::io::Cursor::new(&bytes),
                    false,
                    || Ok(()),
                )?;
            }
            Err(error) => return Err(error),
        }
        let result = Self {
            version: VERSION,
            operation_id: operation_id.into(),
            source_profile: snapshot.source_profile,
            source_identity: snapshot.source_identity,
            evidence_identity: evidence.directory_identity()?,
            file_identity: evidence.portable_regular_identity(OsStr::new(&name))?,
            snapshot_sha256: hex_sha256(&bytes),
        };
        result.load(owner_evidence_directory, source_profile, None)?;
        Ok(result)
    }

    pub fn relocate(
        &self,
        source_profile: &Path,
        target_profile: &Path,
        owner_evidence_directory: &Path,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        self.target(
            source_profile,
            target_profile,
            owner_evidence_directory,
            published,
            true,
        )
    }
    pub fn verify_relocation(
        &self,
        source_profile: &Path,
        target_profile: &Path,
        owner_evidence_directory: &Path,
        published: &StoragePublishedComponent,
    ) -> Result<()> {
        self.target(
            source_profile,
            target_profile,
            owner_evidence_directory,
            published,
            false,
        )
    }
    fn load(&self, evidence: &Path, source: &Path, target: Option<&Path>) -> Result<Snapshot> {
        ensure!(
            self.version == VERSION
                && valid_atom(&self.operation_id)
                && source.canonicalize()? == self.source_profile,
            "profile attachment snapshot binding changed"
        );
        let directory = evidence_directory(evidence, source, target)?;
        ensure!(
            directory.directory_identity()? == self.evidence_identity,
            "profile attachment evidence directory changed"
        );
        let file = directory.portable_open_verified_regular(
            OsStr::new(&snapshot_name(&self.operation_id)),
            &self.file_identity,
        )?;
        let bytes = read_snapshot_file(file.file().try_clone()?)?;
        ensure!(
            directory.portable_regular_identity(OsStr::new(&snapshot_name(&self.operation_id)))?
                == self.file_identity,
            "profile attachment snapshot file changed"
        );
        ensure!(
            hex_sha256(&bytes) == self.snapshot_sha256,
            "profile attachment snapshot bytes changed"
        );
        let snapshot: Snapshot = serde_json::from_slice(&bytes)?;
        ensure!(
            snapshot.version == VERSION
                && snapshot.operation_id == self.operation_id
                && snapshot.source_profile == self.source_profile
                && snapshot.source_identity == self.source_identity,
            "profile attachment snapshot owner changed"
        );
        Ok(snapshot)
    }
    fn target(
        &self,
        source: &Path,
        target: &Path,
        evidence: &Path,
        published: &StoragePublishedComponent,
        publish: bool,
    ) -> Result<()> {
        let snapshot = self.load(evidence, source, Some(target))?;
        published.verify()?;
        ensure!(
            published.operation_id() == self.operation_id
                && published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
                && published.source_identity() == self.source_identity
                && published.source_path().canonicalize()? == source.canonicalize()?
                && published.destination_path().canonicalize()? == target.canonicalize()?
                && PrivateDirectory::open_existing(source)?.directory_identity()?
                    == self.source_identity,
            "profile attachment publication differs"
        );
        let expected = snapshot
            .sessions
            .iter()
            .map(|entry| {
                (
                    entry.thread_id.clone(),
                    entry.directory.clone(),
                    entry.snapshot.is_some(),
                )
            })
            .collect::<Vec<_>>();
        ensure!(
            registered_sessions(&snapshot.source_profile)? == expected,
            "profile attachment registrations changed"
        );
        let source_root = PrivateDirectory::open_existing(source)?;
        let target_root = PrivateDirectory::open_existing(target)?;
        ensure!(
            child(&source_root, "attachment-retention-v1")?.is_some()
                == snapshot.retention.is_some(),
            "profile retention source presence changed"
        );
        if snapshot.retention.is_none() {
            ensure!(
                child(&target_root, "attachment-retention-v1")?.is_none(),
                "unexpected retention namespace"
            );
        }
        for entry in &snapshot.sessions {
            let old = source.join(&entry.directory);
            let new = target.join(&entry.directory);
            if let Some(expected) = &entry.snapshot {
                if publish {
                    super::relocate(&old, &new, &self.operation_id, expected, published)?;
                } else {
                    super::verify_relocation(&old, &new, &self.operation_id, expected, published)?;
                }
            } else {
                ensure!(
                    !has_attachments(&PrivateDirectory::open_existing(&new)?)?,
                    "unexpected target attachment owner"
                );
            }
        }
        if let Some(expected) = &snapshot.retention {
            let targets = expected
                .artifact_parents()
                .map(|old| {
                    Ok((
                        old.to_path_buf(),
                        target.join(old.strip_prefix(&snapshot.source_profile)?),
                    ))
                })
                .collect::<Result<BTreeMap<_, _>>>()?;
            if publish {
                retention::relocate(
                    source,
                    target,
                    &self.operation_id,
                    expected,
                    &targets,
                    published,
                )?;
            } else {
                retention::verify_relocation(
                    source,
                    target,
                    &self.operation_id,
                    expected,
                    &targets,
                    published,
                )?;
            }
        }
        published.verify()
    }
}

fn snapshot_name(operation: &str) -> String {
    format!(
        "attachments-source-v1-{}.json",
        hex_sha256(operation.as_bytes())
    )
}
fn read_snapshot_file(file: std::fs::File) -> Result<Vec<u8>> {
    ensure!(
        file.metadata()?.len() as usize <= MAX_PROFILE_BYTES,
        "profile attachment snapshot exceeds bound"
    );
    let mut bytes = Vec::new();
    file.take(MAX_PROFILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_PROFILE_BYTES,
        "profile attachment snapshot exceeds bound"
    );
    Ok(bytes)
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
