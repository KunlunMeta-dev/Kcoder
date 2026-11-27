//! Read-only target resolution for ReadSession. Unlike discovery, a saved conversation
//! of another workspace is classified rather than hidden, so the target owner's read
//! policy can decide. The result is a held history identity, never an access grant.
use super::*;
use kcoder_config::PortableLeaseIdentity;

pub(crate) enum ReadLookup {
    /// No saved history with this ID in the host's held roots.
    Missing,
    /// Saved, but outside the visible set (deleted, sub-agent, channel or non-default).
    Hidden,
    Found(Box<ReadTarget>),
}

pub(crate) struct ReadTarget {
    pub(crate) session: BoundPeerSession,
    pub(crate) same_workspace: bool,
}

fn stored_metadata(
    scope: &DirectoryScope,
    id: &str,
    workspace: &Path,
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
        if let Some(metadata) = observation::client_metadata_in(&child, id, workspace)? {
            ensure!(found.is_none(), "session_directory_metadata_ambiguous");
            found = Some(metadata);
        }
    }
    Ok(found)
}

impl SessionDirectory {
    /// Resolve one saved conversation in the held roots of the host's account profile.
    pub(crate) fn lookup_read_view(view: &DirectorySourceView<'_>, id: &str) -> Result<ReadLookup> {
        view.verify()?;
        ensure!(
            kcoder_types::cross_session_messages::valid_agent_message_id(id)
                && kcoder_workspace_resources::managed_worktrees::validate_thread_id(id).is_ok(),
            "session_directory_invalid_target"
        );
        let scope = DirectoryScope::capture_view(view)?;
        ensure!(scope.incomplete == 0, "session_directory_lookup_incomplete");
        let filename = format!("{id}.jsonl");
        let mut candidates = BTreeMap::new();
        let mut ambiguous = HashSet::new();
        let mut issues = 0;
        for root in &scope.roots {
            root.verify()?;
            match root
                .directory
                .open_single_link_regular_file(OsStr::new(&filename))
            {
                Ok(_) => insert_candidate(
                    &mut candidates,
                    &mut ambiguous,
                    Candidate {
                        id: id.to_owned(),
                        root: root.clone(),
                        nested: false,
                    },
                    &mut issues,
                ),
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            }
        }
        for root in &scope.artifacts {
            root.verify()?;
            let child = match root.directory.open_child(OsStr::new(id), false) {
                Ok(child) => child,
                Err(error) if missing(&error) => continue,
                Err(error) => return Err(error),
            };
            child.verify_trusted_config_directory()?;
            match child.open_single_link_regular_file(OsStr::new(&filename)) {
                Ok(_) => insert_candidate(
                    &mut candidates,
                    &mut ambiguous,
                    Candidate {
                        id: id.to_owned(),
                        root: root.clone(),
                        nested: true,
                    },
                    &mut issues,
                ),
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            }
        }
        ensure!(
            issues == 0 && ambiguous.is_empty(),
            "session_directory_target_ambiguous"
        );
        let Some(candidate) = candidates.remove(id) else {
            return Ok(ReadLookup::Missing);
        };
        let scope = Arc::new(scope);
        let parent = candidate.parent()?;
        let history = parent.open_single_link_regular_file(OsStr::new(&filename))?;
        let identity = PortableLeaseIdentity::from_regular_handle(&history)?;
        let prepared = observation::metadata(&candidate, &parent)?;
        let Some(base) = prepared
            .base_cwd()
            .and_then(|base| dunce::canonicalize(base).ok())
        else {
            return Ok(ReadLookup::Hidden);
        };
        let same_workspace = base == scope.workspace;
        if kcoder_state::read_session_history_deletion(&candidate.path(), &base)?.is_some()
            || prepared.session_mode() != kcoder_state::SessionMode::Default
            || prepared.has_native_subagent_outbox()
            || prepared.channel_task_source().is_some()
        {
            return Ok(ReadLookup::Hidden);
        }
        let stored = stored_metadata(&scope, id, &base)?;
        if history.metadata()?.len() == 0
            && stored
                .as_ref()
                .is_none_or(|value| !value.fields.contains_key("permissionModeAtCreation"))
        {
            return Ok(ReadLookup::Hidden);
        }
        let field = |name: &str| {
            stored
                .as_ref()
                .and_then(|value| value.fields.get(name))
                .cloned()
                .flatten()
                .map(|value| {
                    value
                        .chars()
                        .filter(|character| !character.is_control())
                        .take(200)
                        .collect::<String>()
                })
        };
        candidate.verify_parent(&parent)?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(
                &parent.open_single_link_regular_file(OsStr::new(&filename))?
            )? == identity,
            "session_directory_history_changed"
        );
        let row = AgentMessageTarget {
            address: None,
            thread_id: id.to_owned(),
            title: field("title"),
            status: ThreadStatus::Unknown,
            active_turn_id: None,
            presence: AgentMessageTargetPresence::Unknown,
            run_summary: None,
            last_turn: None,
            archived_at: field("archivedAt"),
            last_history_update_at_ms: prepared.updated_at_ms(),
            allowed_modes: Vec::new(),
        };
        let session = BoundPeerSession::capture(scope, candidate, row)?;
        session.verify(view)?;
        Ok(ReadLookup::Found(Box::new(ReadTarget {
            session,
            same_workspace,
        })))
    }
}
