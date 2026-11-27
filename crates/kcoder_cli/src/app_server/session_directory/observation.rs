//! Read minimal current sidecars and recorded terminal facts; never load conversation bodies.
use super::*;
use fs2::FileExt;
use kcoder_app_protocol::TurnStatus;
use kcoder_state::{PreparedSessionMetadata, turn_attempt_store::TurnAttemptStore};
use std::io::Read;

const MAX_STATE_BYTES: usize = 1024 * 1024;
const MAX_METADATA_BYTES: usize = 64 * 1024;

#[cfg(test)]
thread_local! {
    static OBSERVATION_COUNTS: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

#[cfg(test)]
pub(crate) fn take_observation_counts() -> (usize, usize) {
    OBSERVATION_COUNTS.with(|counts| counts.replace((0, 0)))
}

fn bytes(parent: &PrivateDirectory, name: &OsStr, limit: usize) -> Result<Vec<u8>> {
    let file = parent.open_single_link_regular_file(name)?;
    ensure!(
        file.metadata()?.len() <= limit as u64,
        "session_directory_metadata_too_large"
    );
    let mut result = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut result)?;
    ensure!(
        result.len() <= limit,
        "session_directory_metadata_too_large"
    );
    Ok(result)
}
pub(super) fn metadata(
    candidate: &Candidate,
    parent: &PrivateDirectory,
) -> Result<PreparedSessionMetadata> {
    let state_path = kcoder_state::session_state_path(
        candidate
            .path()
            .parent()
            .context("history parent unavailable")?,
        &candidate.id,
    );
    let component = state_path
        .parent()
        .and_then(Path::file_name)
        .context("sidecar owner unavailable")?;
    let primary = parent.open_child(component, false).and_then(|directory| {
        directory.verify_trusted_config_directory()?;
        bytes(&directory, OsStr::new("state.json"), MAX_STATE_BYTES)
    });
    let (path, raw) = match primary {
        Ok(raw) => (state_path, raw),
        Err(error) if missing(&error) => {
            let name = format!("{}.state.json", candidate.id);
            (
                candidate.path().with_extension("state.json"),
                bytes(parent, OsStr::new(&name), MAX_STATE_BYTES)?,
            )
        }
        Err(error) => return Err(error),
    };
    PreparedSessionMetadata::from_sidecar_bytes(&candidate.path(), &path, &raw)
}
pub(super) fn client_metadata(
    scope: &DirectoryScope,
    id: &str,
) -> Result<Option<kcoder_thread_metadata::ThreadClientMetadata>> {
    let mut found = None;
    for root in &scope.artifacts {
        root.verify()?;
        let child = match root.directory.open_child(OsStr::new(id), false) {
            Ok(child) => child,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        child.verify_trusted_config_directory()?;
        let raw = match bytes(
            &child,
            OsStr::new(kcoder_thread_metadata::THREAD_METADATA_FILE),
            MAX_METADATA_BYTES,
        ) {
            Ok(raw) => raw,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let metadata: kcoder_thread_metadata::ThreadClientMetadata = serde_json::from_slice(&raw)?;
        ensure!(
            metadata.version == 1 && metadata.thread_id == id,
            "session_directory_metadata_identity_changed"
        );
        ensure!(
            kcoder_thread_metadata::same_workspace_form(
                &metadata.workspace,
                &scope.workspace.to_string_lossy()
            ),
            "session_directory_metadata_workspace_changed"
        );
        ensure!(found.is_none(), "session_directory_metadata_ambiguous");
        found = Some(metadata);
    }
    Ok(found)
}
pub(crate) fn client_metadata_in(
    child: &PrivateDirectory,
    id: &str,
    workspace: &Path,
) -> Result<Option<kcoder_thread_metadata::ThreadClientMetadata>> {
    let raw = match bytes(
        child,
        OsStr::new(kcoder_thread_metadata::THREAD_METADATA_FILE),
        MAX_METADATA_BYTES,
    ) {
        Ok(raw) => raw,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let metadata: kcoder_thread_metadata::ThreadClientMetadata = serde_json::from_slice(&raw)?;
    ensure!(
        metadata.version == 1
            && metadata.thread_id == id
            && kcoder_thread_metadata::same_workspace_form(
                &metadata.workspace,
                &workspace.to_string_lossy()
            ),
        "session_directory_metadata_identity_changed"
    );
    Ok(Some(metadata))
}
fn presence(parent: &PrivateDirectory, id: &str) -> Result<AgentMessageTargetPresence> {
    let name = format!("{id}.lease");
    let file = match parent.open_single_link_regular_file(OsStr::new(&name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(AgentMessageTargetPresence::Unknown),
        Err(error) => return Err(error),
    };
    match FileExt::try_lock_shared(&file) {
        Ok(()) => {
            FileExt::unlock(&file)?;
            Ok(AgentMessageTargetPresence::NotResident)
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || matches!(error.raw_os_error(), Some(32 | 33)) =>
        {
            Ok(AgentMessageTargetPresence::Unknown)
        }
        Err(error) => Err(error.into()),
    }
}
pub(super) fn observe(
    scope: &DirectoryScope,
    candidate: &Candidate,
) -> Result<Option<AgentMessageTarget>> {
    observe_inner(scope, candidate, true)
}

pub(super) fn observe_metadata(
    scope: &DirectoryScope,
    candidate: &Candidate,
) -> Result<Option<AgentMessageTarget>> {
    observe_inner(scope, candidate, false)
}

/// Only a negative filter: a match still needs the current history, lease and host checks.
pub(super) fn title_matches(
    scope: &DirectoryScope,
    id: &str,
    title_query: &SessionDiscoveryQuery,
) -> Result<bool> {
    let stored = client_metadata(scope, id)?;
    let title = stored
        .as_ref()
        .and_then(|value| value.fields.get("title"))
        .and_then(Option::as_ref)
        .map(|value| sanitize(value, 200));
    Ok(title_query.matches_metadata(
        title.as_deref(),
        id,
        None,
        &ThreadStatus::Unknown,
        &AgentMessageTargetPresence::Unknown,
    ))
}

fn observe_inner(
    scope: &DirectoryScope,
    candidate: &Candidate,
    include_last_turn: bool,
) -> Result<Option<AgentMessageTarget>> {
    #[cfg(test)]
    OBSERVATION_COUNTS.with(|counts| {
        let (history, attempts) = counts.get();
        counts.set((history + 1, attempts));
    });
    let parent = candidate.parent()?;
    let filename = format!("{}.jsonl", candidate.id);
    let history = parent.open_single_link_regular_file(OsStr::new(&filename))?;
    let identity = kcoder_config::PortableLeaseIdentity::from_regular_handle(&history)?;
    let prepared = metadata(candidate, &parent)?;
    let Some(base) = prepared.base_cwd() else {
        anyhow::bail!("session_directory_workspace_unobserved");
    };
    if dunce::canonicalize(base)? != scope.workspace {
        return Ok(None);
    }
    if kcoder_state::read_session_history_deletion(&candidate.path(), &scope.workspace)?.is_some() {
        return Ok(None);
    }
    if prepared.session_mode() != kcoder_state::SessionMode::Default {
        return Ok(None);
    }
    ensure!(
        !prepared.has_native_subagent_outbox() && prepared.channel_task_source().is_none(),
        "session_directory_controlled_source_unavailable"
    );
    let stored = client_metadata(scope, &candidate.id)?;
    if history.metadata()?.len() == 0
        && stored
            .as_ref()
            .is_none_or(|value| !value.fields.contains_key("permissionModeAtCreation"))
    {
        return Ok(None);
    }
    let title = stored
        .as_ref()
        .and_then(|value| value.fields.get("title"))
        .and_then(Option::as_ref)
        .map(|value| sanitize(value, 200));
    let archived_at = stored
        .as_ref()
        .and_then(|value| value.fields.get("archivedAt"))
        .cloned()
        .flatten()
        .map(|value| sanitize(&value, 128));
    let presence = presence(&parent, &candidate.id)?;
    let last_turn = if include_last_turn {
        last_turn(scope, &candidate.id)?
    } else {
        None
    };
    candidate.verify_parent(&parent)?;
    ensure!(
        kcoder_config::PortableLeaseIdentity::from_regular_handle(
            &parent.open_single_link_regular_file(OsStr::new(&filename))?
        )? == identity,
        "session_directory_history_changed"
    );
    Ok(Some(AgentMessageTarget {
        address: None,
        thread_id: candidate.id.clone(),
        title,
        status: ThreadStatus::Unknown,
        active_turn_id: None,
        presence,
        run_summary: None,
        last_turn,
        archived_at,
        last_history_update_at_ms: prepared.updated_at_ms(),
        allowed_modes: Vec::new(),
    }))
}
fn sanitize(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect()
}

/// At most 256 bounded attempt records per target; archive/model snapshots are not opened or hashed.
/// Incomplete inventories, unsettled attempts or multiple unordered records leave lastTurn unobserved.
pub(super) fn last_turn(scope: &DirectoryScope, id: &str) -> Result<Option<AgentMessageLastTurn>> {
    #[cfg(test)]
    OBSERVATION_COUNTS.with(|counts| {
        let (history, attempts) = counts.get();
        counts.set((history, attempts + 1));
    });
    let mut found = None;
    let mut seen = HashSet::new();
    let mut source_seen = false;
    let mut unobserved = false;
    for root in scope.artifacts.iter().chain(scope.roots.iter()) {
        if !seen.insert(root.path.clone()) {
            continue;
        }
        root.verify()?;
        let child = match root.directory.open_child(OsStr::new(id), false) {
            Ok(child) => Arc::new(child),
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let identity = child.directory_identity()?;
        let Some(store) = TurnAttemptStore::open_existing_in(child.clone(), id)? else {
            continue;
        };
        ensure!(!source_seen, "session_directory_attempt_source_ambiguous");
        source_seen = true;
        let records = match store.list_with_budget(MAX_STATUS_ATTEMPTS, MAX_STATUS_ATTEMPT_BYTES) {
            Ok(records) => records,
            Err(error) if TurnAttemptStore::is_observation_budget_exhausted(&error) => {
                root.verify()?;
                ensure!(
                    root.directory
                        .open_child(OsStr::new(id), false)?
                        .directory_identity()?
                        == identity,
                    "session_directory_attempt_child_changed"
                );
                store.verify_binding()?;
                unobserved = true;
                Vec::new()
            }
            Err(error) => return Err(error),
        };
        ensure!(
            root.directory
                .open_child(OsStr::new(id), false)?
                .directory_identity()?
                == identity,
            "session_directory_attempt_child_changed"
        );
        store.verify_binding()?;
        if records.len() > 1
            || records
                .iter()
                .any(|record| !record.status.is_terminal() || record.completion.is_none())
        {
            unobserved = true;
        }
        if let [record] = records.as_slice()
            && let Some(completion) = record.completion.as_ref()
        {
            let status = match completion.status {
                kcoder_types::TurnAttemptStatus::Completed => Some(TurnStatus::Completed),
                kcoder_types::TurnAttemptStatus::Failed => Some(TurnStatus::Failed),
                kcoder_types::TurnAttemptStatus::Interrupted => Some(TurnStatus::Interrupted),
                _ => None,
            };
            if let Some(status) = status {
                found = Some(AgentMessageLastTurn {
                    status,
                    turn_id: Some(record.identity.turn_id.clone()),
                    ended_at_ms: Some(completion.finished_at_ms),
                });
            }
        }
        root.verify()?;
    }
    Ok(if unobserved { None } else { found })
}
