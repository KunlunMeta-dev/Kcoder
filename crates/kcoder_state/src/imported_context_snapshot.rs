//! Immutable context payloads stay out of the bounded session metadata sidecar.
use crate::*;
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::imported_context_snapshot::{
    ImportedContextSnapshot, ImportedContextSnapshotSource,
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Cursor, Read},
    path::Path,
};

const FILE: &str = "imported-context.v1";
// Source records retain their original 16 MiB budget. JSON escaping can expand
// their already-approved Runtime representation; this is an encoding bound.
const MAX_BODY: usize = 128 * 1024 * 1024;
const MAX_HEADER: usize = 4096;
#[cfg(test)]
mod tests;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SnapshotReference {
    version: u32,
    session_id: String,
    profile_identity: String,
    source: ImportedContextSnapshotSource,
    has_content: bool,
    content_bytes: u64,
    content_sha256: String,
}

impl std::fmt::Debug for SnapshotReference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnapshotReference")
            .field("version", &self.version)
            .field("source", &self.source)
            .field("has_content", &self.has_content)
            .finish_non_exhaustive()
    }
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn is_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
pub(super) fn validate(snapshot: &ImportedContextSnapshot) -> Result<()> {
    ensure!(
        (snapshot.version == 1 && snapshot.instructions.is_none()
            || snapshot.version == 2 && snapshot.instructions.is_some())
            && is_sha(&snapshot.profile_identity)
            && snapshot
                .content
                .as_ref()
                .is_none_or(|text| text.len() <= MAX_BODY && !text.contains('\0'))
            && (snapshot.source != ImportedContextSnapshotSource::LegacyUnobserved
                || snapshot.content.is_none() && snapshot.instructions.is_none()),
        "imported_context_snapshot_invalid"
    );
    if let Some(instructions) = &snapshot.instructions {
        ensure!(
            instructions.version == 1 && instructions.deferred.len() <= 128,
            "imported_context_snapshot_invalid"
        );
        let text_valid = |text: &str| text.len() <= MAX_BODY && !text.contains('\0');
        ensure!(
            instructions
                .before_native
                .as_deref()
                .is_none_or(&text_valid)
                && instructions
                    .native_context
                    .as_deref()
                    .is_none_or(&text_valid),
            "imported_context_snapshot_invalid"
        );
        for record in &instructions.deferred {
            ensure!(
                text_valid(&record.content)
                    && is_sha(&record.activation_id)
                    && record.scope_root.is_absolute()
                    && record.provenance.version == 1
                    && record.provenance.trigger
                        == kcoder_types::imported_instructions::ImportedInstructionTrigger::OnRead,
                "imported_context_snapshot_invalid"
            );
        }
    }
    try_payload(snapshot, MAX_BODY)?;
    Ok(())
}
fn payload(snapshot: &ImportedContextSnapshot) -> Vec<u8> {
    try_payload(snapshot, MAX_BODY)
        .expect("private Native snapshots are validated before references are built")
}
fn try_payload(snapshot: &ImportedContextSnapshot, limit: usize) -> Result<Vec<u8>> {
    if snapshot.instructions.is_none() {
        let bytes = snapshot.content.as_deref().unwrap_or("").as_bytes();
        ensure!(bytes.len() <= limit, "imported_context_snapshot_invalid");
        return Ok(bytes.to_vec());
    }
    let mut writer = BoundedPayload {
        bytes: Vec::new(),
        limit,
    };
    serde_json::to_writer(&mut writer, snapshot)
        .map_err(|_| anyhow::anyhow!("imported_context_snapshot_invalid"))?;
    Ok(writer.bytes)
}
struct BoundedPayload {
    bytes: Vec<u8>,
    limit: usize,
}
impl std::io::Write for BoundedPayload {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "private snapshot encoding budget exceeded",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl SnapshotReference {
    pub(super) fn new(snapshot: &ImportedContextSnapshot, session: &str) -> Self {
        let bytes = payload(snapshot);
        Self {
            version: snapshot.version,
            session_id: session.into(),
            profile_identity: snapshot.profile_identity.clone(),
            source: snapshot.source,
            has_content: snapshot.content.is_some(),
            content_bytes: bytes.len() as u64,
            content_sha256: sha(&bytes),
        }
    }
    pub(super) fn for_session(&self, session: &str) -> Self {
        let mut reference = self.clone();
        reference.session_id = session.into();
        reference
    }
    pub(super) fn session_id(&self) -> &str {
        &self.session_id
    }
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            (self.version == 1 || self.version == 2)
                && !self.session_id.is_empty()
                && self.session_id.len() <= 1024
                && !self.session_id.chars().any(char::is_control)
                && is_sha(&self.profile_identity)
                && is_sha(&self.content_sha256)
                && self.content_bytes <= MAX_BODY as u64
                && (self.version == 2
                    || self.has_content
                    || self.content_bytes == 0 && self.content_sha256 == sha(&[]))
                && (self.source != ImportedContextSnapshotSource::LegacyUnobserved
                    || self.version == 1 && !self.has_content),
            "imported_context_snapshot_invalid"
        );
        Ok(())
    }
}
pub(super) fn session_for(inner: &AppStateInner) -> String {
    inner
        .history_path
        .as_deref()
        .and_then(|path| session_id_from_history_path(path).ok())
        .unwrap_or_else(|| inner.session_id.clone())
}
fn directory(path: &Path, create: bool) -> Result<PrivateDirectory> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("imported_context_snapshot_unavailable"))?;
    let root = parent
        .parent()
        .ok_or_else(|| anyhow::anyhow!("imported_context_snapshot_unavailable"))?;
    let directory = PrivateDirectory::open_existing(root)?;
    directory.verify_trusted_config_directory()?;
    let leaf = parent
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("imported_context_snapshot_unavailable"))?;
    let directory = directory.open_child(leaf, create)?;
    directory.verify_trusted_config_directory()?;
    Ok(directory)
}

fn read_at(
    directory: &PrivateDirectory,
    expected: &SnapshotReference,
) -> Result<ImportedContextSnapshot> {
    expected.validate()?;
    let mut file = directory.open_single_link_regular_file(OsStr::new(FILE))?;
    ensure!(
        file.metadata()?.len() <= MAX_BODY as u64 + MAX_HEADER as u64,
        "imported_context_snapshot_invalid"
    );
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        ensure!(
            header.len() < MAX_HEADER,
            "imported_context_snapshot_invalid"
        );
        ensure!(
            file.read(&mut byte)? == 1,
            "imported_context_snapshot_invalid"
        );
        if byte[0] == b'\n' {
            break;
        }
        header.push(byte[0]);
    }
    let actual: SnapshotReference = serde_json::from_slice(&header)
        .map_err(|_| anyhow::anyhow!("imported_context_snapshot_invalid"))?;
    ensure!(
        &actual == expected,
        "imported_context_snapshot_binding_changed"
    );
    let mut bytes = Vec::new();
    file.take(expected.content_bytes + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == expected.content_bytes && sha(&bytes) == expected.content_sha256,
        "imported_context_snapshot_changed"
    );
    if expected.version == 2 {
        let snapshot: ImportedContextSnapshot = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("imported_context_snapshot_invalid"))?;
        validate(&snapshot)?;
        ensure!(
            SnapshotReference::new(&snapshot, &expected.session_id) == *expected,
            "imported_context_snapshot_binding_changed"
        );
        return Ok(snapshot);
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("imported_context_snapshot_invalid"))?;
    let snapshot = ImportedContextSnapshot {
        version: 1,
        profile_identity: expected.profile_identity.clone(),
        source: expected.source,
        content: expected.has_content.then_some(text),
        instructions: None,
    };
    validate(&snapshot)?;
    Ok(snapshot)
}
pub(super) fn load(
    path: &Path,
    session: &str,
    reference: &SnapshotReference,
) -> Result<ImportedContextSnapshot> {
    ensure!(
        reference.session_id == session,
        "imported_context_snapshot_binding_changed"
    );
    read_at(&directory(path, false)?, reference)
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

/// An immutable payload can precede the metadata receipt. Reading it does not
/// claim that a model request occurred; an explicit writer reconciles the intent.
fn pending(path: &Path, session: &str) -> Result<Option<ImportedContextSnapshot>> {
    let directory = match directory(path, false) {
        Ok(value) => value,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut file = match directory.open_single_link_regular_file(OsStr::new(FILE)) {
        Ok(value) => value,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    let mut byte = [0; 1];
    loop {
        ensure!(
            bytes.len() < MAX_HEADER && file.read(&mut byte)? == 1,
            "imported_context_snapshot_invalid"
        );
        if byte[0] == b'\n' {
            break;
        }
        bytes.push(byte[0]);
    }
    let reference: SnapshotReference = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("imported_context_snapshot_invalid"))?;
    reference.validate()?;
    ensure!(
        reference.session_id == session,
        "imported_context_snapshot_binding_changed"
    );
    read_at(&directory, &reference).map(Some)
}
pub(super) fn publish(
    path: &Path,
    session: &str,
    snapshot: &ImportedContextSnapshot,
) -> Result<()> {
    validate(snapshot)?;
    let reference = SnapshotReference::new(snapshot, session);
    reference.validate()?;
    let directory = directory(path, true)?;
    match directory.open_single_link_regular_file(OsStr::new(FILE)) {
        Ok(_) => {
            ensure!(
                read_at(&directory, &reference)? == *snapshot,
                "imported_context_snapshot_binding_changed"
            );
            return Ok(());
        }
        Err(error)
            if error.chain().any(|v| {
                v.downcast_ref::<std::io::Error>()
                    .is_some_and(|v| v.kind() == std::io::ErrorKind::NotFound)
            }) => {}
        Err(_) => anyhow::bail!("imported_context_snapshot_unavailable"),
    }
    let mut header = serde_json::to_vec(&reference)?;
    ensure!(
        header.len() < MAX_HEADER,
        "imported_context_snapshot_invalid"
    );
    header.push(b'\n');
    let mut reader = Cursor::new(header).chain(Cursor::new(payload(snapshot)));
    directory.atomic_publish_from_reader(OsStr::new(FILE), &mut reader, false, || Ok(None))?;
    ensure!(
        read_at(&directory, &reference)? == *snapshot,
        "imported_context_snapshot_changed"
    );
    Ok(())
}

impl AppState {
    /// Native readers borrow the frozen payload without copying every deferred instruction body.
    pub fn imported_context_snapshot_shared(&self) -> Option<Arc<ImportedContextSnapshot>> {
        self.read_inner().imported_context_snapshot.clone()
    }
    pub fn imported_context_snapshot(&self) -> Option<ImportedContextSnapshot> {
        self.read_inner()
            .imported_context_snapshot
            .as_deref()
            .cloned()
    }
    pub fn imported_context_is_legacy_unobserved(&self) -> bool {
        self.read_inner().imported_context_legacy_unobserved
    }

    /// Called only for an explicit turn/fork, never by list/read observation.
    pub fn reconcile_imported_context_snapshot(
        &self,
        profile_identity: &str,
    ) -> Result<Option<ImportedContextSnapshot>> {
        let observed = {
            let inner = self.read_inner();
            if let Some(snapshot) = &inner.imported_context_snapshot {
                ensure!(
                    snapshot.profile_identity == profile_identity,
                    "imported_context_snapshot_wrong_profile"
                );
                if inner.session_state_path.is_none()
                    || inner.imported_context_persisted_at == inner.session_state_path
                {
                    return Ok(Some(snapshot.as_ref().clone()));
                }
                Some(snapshot.as_ref().clone())
            } else {
                match inner.session_state_path.as_deref() {
                    Some(path) => pending(path, &session_for(&inner))?,
                    None => None,
                }
            }
        };
        let Some(snapshot) = observed else {
            return Ok(None);
        };
        ensure!(
            snapshot.profile_identity == profile_identity,
            "imported_context_snapshot_wrong_profile"
        );
        self.freeze_imported_context_snapshot(snapshot).map(Some)
    }

    /// The existing source writer owns publication. A second caller receives the
    /// authoritative original snapshot, never a refreshed profile interpretation.
    pub fn freeze_imported_context_snapshot(
        &self,
        candidate: ImportedContextSnapshot,
    ) -> Result<ImportedContextSnapshot> {
        validate(&candidate)?;
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        if let Some(snapshot) = &inner.imported_context_snapshot {
            ensure!(
                snapshot.profile_identity == candidate.profile_identity,
                "imported_context_snapshot_wrong_profile"
            );
        }
        if let Some(snapshot) = &inner.imported_context_snapshot
            && (inner.session_state_path.is_none()
                || inner.imported_context_persisted_at == inner.session_state_path)
        {
            return Ok(snapshot.as_ref().clone());
        }
        let mut chosen = inner
            .imported_context_snapshot
            .as_deref()
            .cloned()
            .unwrap_or(candidate);
        if let Some(path) = inner.session_state_path.clone() {
            let source = require_history_source(&inner)?.clone();
            let session = session_for(&inner);
            let baseline = PersistedSessionState::from_inner(&inner);
            let result = source.write_metadata(&path, || {
                let mut authority = load_session_state(&path)?;
                if let Some(reference) = &authority.imported_context_snapshot {
                    chosen = load(&path, &session, reference)?;
                } else {
                    if let Some(original) = pending(&path, &session)? {
                        ensure!(
                            original.profile_identity == chosen.profile_identity,
                            "imported_context_snapshot_wrong_profile"
                        );
                        chosen = original;
                    }
                    publish(&path, &session, &chosen)?;
                    if authority.created_at_ms.is_none() && authority.cwd.is_none() {
                        authority = baseline;
                    }
                    authority.imported_context_snapshot =
                        Some(SnapshotReference::new(&chosen, &session));
                }
                prepare_legacy_session_state_write(&path, authority)
            });
            if let Err(error) = result {
                if crate::history_store::is_uncertain_mutation(&error) {
                    inner.history_write_fault = Some(format!("{error:#}"));
                }
                return Err(error);
            }
        }
        inner.imported_context_reference =
            Some(SnapshotReference::new(&chosen, &session_for(&inner)));
        inner.imported_context_persisted_at = inner.session_state_path.clone();
        inner.imported_context_snapshot = Some(Arc::new(chosen.clone()));
        inner.imported_context_legacy_unobserved =
            chosen.source == ImportedContextSnapshotSource::LegacyUnobserved;
        Ok(chosen)
    }
    pub fn inherit_imported_context_snapshot(&self, parent: &AppState) -> Result<()> {
        if let Some(snapshot) = parent.imported_context_snapshot() {
            ensure!(
                self.freeze_imported_context_snapshot(snapshot.clone())? == snapshot,
                "imported_context_snapshot_binding_changed"
            );
        }
        Ok(())
    }
}
