use super::*;

const DIFF_BYTES: usize = 24 * 1024;
const STATUS_BYTES: usize = 8 * 1024;

fn clipped(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}
async fn command(path: &Path, args: &[&str], limit: usize) -> Result<(String, bool)> {
    let output =
        git::run_git_observation_command(path, args, limit, Duration::from_secs(15)).await?;
    let truncated = output.stderr.contains("git command output was truncated");
    ensure!(
        output.success || truncated,
        "comparison Git observation is unavailable: {}",
        clipped(&output.stderr, 512)
    );
    Ok((
        output
            .stdout
            .as_str()
            .context("invalid Git observation")?
            .to_owned(),
        truncated,
    ))
}

pub(super) async fn git_identity(
    store: &ClientWorktreeStore,
    record: &ClientManagedWorktree,
) -> Result<GitIdentity> {
    ensure!(
        record.state == "active",
        "comparison worktree is unavailable"
    );
    let path = dunce::canonicalize(&record.path)?;
    ensure!(
        path == Path::new(&record.path),
        "comparison worktree path changed"
    );
    let root_identity =
        kcoder_config::PrivateDirectory::open_existing(&path)?.directory_identity()?;
    let lease = store.open_workspace_runtime_lease(&path)?;
    fs2::FileExt::try_lock_shared(&lease).context("comparison worktree is being archived")?;
    let (top, _) = command(&path, &["rev-parse", "--show-toplevel"], 4096).await?;
    ensure!(
        dunce::canonicalize(top.trim())? == path,
        "comparison path is not a worktree root"
    );
    let (common, _) = command(
        &path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        4096,
    )
    .await?;
    let source = Path::new(
        record
            .source_path
            .as_deref()
            .context("missing comparison source")?,
    );
    let (source_common, _) = command(
        source,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        4096,
    )
    .await?;
    ensure!(
        dunce::canonicalize(common.trim())? == dunce::canonicalize(source_common.trim())?,
        "comparison repository identity changed"
    );
    let (head, _) = command(&path, &["rev-parse", "--verify", "HEAD"], 4096).await?;
    let head = head.trim().to_owned();
    ensure!(valid_git_object_id(&head), "invalid comparison HEAD");
    let (branch, _) = command(&path, &["branch", "--show-current"], 4096).await?;
    let branch = (!branch.trim().is_empty()).then(|| branch.trim().to_owned());
    let base = record
        .base_commit
        .as_deref()
        .context("comparison baseline is unknown")?;
    let ancestry = git::run_git_observation_command(
        &path,
        &["merge-base", "--is-ancestor", base, "HEAD"],
        4096,
        Duration::from_secs(15),
    )
    .await?;
    ensure!(
        ancestry.success,
        "comparison baseline is no longer an ancestor"
    );
    let (final_branch, _) = command(&path, &["branch", "--show-current"], 4096).await?;
    let (final_common, _) = command(
        &path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        4096,
    )
    .await?;
    let (final_top, _) = command(&path, &["rev-parse", "--show-toplevel"], 4096).await?;
    ensure!(
        dunce::canonicalize(final_common.trim())? == dunce::canonicalize(common.trim())?
            && dunce::canonicalize(final_top.trim())? == path
            && branch.as_deref().unwrap_or("") == final_branch.trim()
            && kcoder_config::PrivateDirectory::open_existing(&path)?.directory_identity()?
                == root_identity,
        "comparison worktree identity changed during association"
    );
    Ok(GitIdentity {
        path,
        head_commit: head,
        branch,
        _lease: lease,
    })
}

/// Association proves repository identity; working content is observed separately.
pub(super) struct GitIdentity {
    path: PathBuf,
    head_commit: String,
    pub(super) branch: Option<String>,
    _lease: std::fs::File,
}

pub(super) async fn git(
    store: &ClientWorktreeStore,
    record: &ClientManagedWorktree,
) -> Result<p::TaskComparisonGit> {
    let GitIdentity {
        path,
        head_commit: head,
        branch,
        _lease,
    } = git_identity(store, record).await?;
    let base = record
        .base_commit
        .as_deref()
        .context("comparison baseline is unknown")?;
    let revision = worktree_capture::observe_workspace_revision(&path).await?;
    let content_token = hex_sha256(format!("{head}\0{revision}").as_bytes());
    let (diff_preview, diff_truncated) = command(
        &path,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--submodule=short",
            base,
            "--",
        ],
        DIFF_BYTES,
    )
    .await?;
    let (status, status_truncated) = command(
        &path,
        &["status", "--porcelain=v1", "--untracked-files=normal", "-z"],
        STATUS_BYTES,
    )
    .await?;
    let (final_head, _) = command(&path, &["rev-parse", "--verify", "HEAD"], 4096).await?;
    let (final_branch, _) = command(&path, &["branch", "--show-current"], 4096).await?;
    let final_revision = worktree_capture::observe_workspace_revision(&path).await?;
    let final_token = hex_sha256(format!("{head}\0{final_revision}").as_bytes());
    ensure!(
        head == final_head.trim()
            && branch.as_deref().unwrap_or("") == final_branch.trim()
            && content_token == final_token,
        "comparison changed during observation; refresh it"
    );
    Ok(p::TaskComparisonGit {
        head_commit: head,
        branch,
        content_token,
        dirty: !status.is_empty(),
        diff_preview,
        status_preview: status.replace('\0', "\n"),
        truncated: diff_truncated || status_truncated,
    })
}

fn check_outcome(entry: &p::ReviewToolExecution) -> p::TaskComparisonCheckOutcome {
    use p::{ReviewToolOutcome as O, TaskComparisonCheckOutcome as C};
    match entry.outcome {
        O::Denied => C::Denied,
        O::Recorded
            if entry.tool_failed == Some(true)
                || entry.process.as_ref().is_some_and(|p| {
                    p.signal.is_some() || p.exit_code.is_some_and(|code| code != 0)
                }) =>
        {
            C::Failed
        }
        O::Recorded
            if entry.tool_failed == Some(false)
                && entry
                    .process
                    .as_ref()
                    .is_some_and(|p| p.exit_code == Some(0) && p.signal.is_none()) =>
        {
            C::Passed
        }
        _ => C::Unknown,
    }
}

pub(super) fn transcript(
    entries: &[kcoder_state::HistoryEntry],
    thread: &str,
) -> (Option<String>, p::TaskComparisonUsage) {
    let mut usage = p::TaskComparisonUsage::default();
    let mut result = None;
    for entry in entries.iter().filter(|entry| entry.session_id == thread) {
        if let kcoder_types::Message::Assistant {
            content,
            usage: reported,
        } = &entry.message
        {
            usage.assistant_messages = usage.assistant_messages.saturating_add(1);
            if let Some(reported) = reported {
                usage.usage_samples = usage.usage_samples.saturating_add(1);
                usage.input_tokens = Some(
                    usage
                        .input_tokens
                        .unwrap_or(0)
                        .saturating_add(reported.input_tokens as u64),
                );
                usage.output_tokens = Some(
                    usage
                        .output_tokens
                        .unwrap_or(0)
                        .saturating_add(reported.output_tokens as u64),
                );
            }
            let text = content
                .iter()
                .filter_map(|block| match block {
                    kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                result = Some(clipped(&text, 4096));
            }
        }
    }
    (result, usage)
}

pub(super) async fn candidate(
    engine: &QueryEngine,
    store: &ClientWorktreeStore,
    record: &ClientManagedWorktree,
) -> p::TaskComparisonCandidate {
    let binding = record.comparison.as_ref().unwrap().clone();
    let mut candidate = p::TaskComparisonCandidate {
        worktree_id: record.worktree_id.clone(),
        path: record.path.clone(),
        source_path: record.source_path.clone().unwrap_or_default(),
        revision: record.revision,
        state: record.state.clone(),
        binding,
        git: None,
        result_preview: None,
        checks: Vec::new(),
        artifacts: Vec::new(),
        evidence_partial: true,
        usage: Default::default(),
        unavailable: Vec::new(),
    };
    match git(store, record).await {
        Ok(observed) => {
            if observed.branch.as_deref() != Some(&candidate.binding.branch) {
                candidate.unavailable.push("branch_changed".into());
            }
            if candidate.binding.selection.as_ref().is_some_and(|s| {
                s.head_commit != observed.head_commit || s.content_token != observed.content_token
            }) {
                candidate.unavailable.push("selection_changed".into());
            }
            candidate.git = Some(observed);
        }
        Err(_) => candidate.unavailable.push("git_unavailable".into()),
    }
    let thread = &candidate.binding.thread_id;
    let history = validate_task_link(record, &candidate.binding)
        .and_then(|()| comparison_task_storage(engine, thread, Path::new(&record.path)));
    let storage = match history {
        Ok(storage) => storage,
        Err(_) => {
            candidate.unavailable.extend([
                "transcript_unavailable".into(),
                "evidence_unavailable".into(),
            ]);
            return candidate;
        }
    };
    match kcoder_state::load_transcript_history_bounded(
        &storage.history_path,
        2 * 1024 * 1024,
        256 * 1024,
        10_000,
    ) {
        Ok(entries) => {
            (candidate.result_preview, candidate.usage) = transcript(&entries, thread);
        }
        Err(_) => candidate.unavailable.push("transcript_unavailable".into()),
    }
    match load_task_reviews(&storage.artifact_root, thread) {
        Ok(records) => {
            let mut records: Vec<_> = records.into_values().collect();
            records.sort_by(|a, b| a.attempt_id.cmp(&b.attempt_id));
            candidate.evidence_partial = records.is_empty();
            for evidence in records {
                candidate.evidence_partial |=
                    evidence.omitted_count > 0 || evidence.state != p::ReviewEvidenceState::Settled;
                for entry in evidence.observations {
                    candidate.evidence_partial |= entry.details_truncated;
                    for artifact in &entry.artifacts {
                        if candidate.artifacts.len() < 16 {
                            candidate.artifacts.push(artifact.clone());
                        } else {
                            candidate.evidence_partial = true;
                        }
                    }
                    if entry.command.is_none() && entry.process.is_none() {
                        continue;
                    }
                    if candidate.checks.len() >= 16 {
                        candidate.evidence_partial = true;
                        continue;
                    }
                    let outcome = check_outcome(&entry);
                    candidate.checks.push(p::TaskComparisonCheck {
                        evidence_id: evidence.evidence_id.clone(),
                        turn_id: evidence.turn_id.clone(),
                        attempt_id: evidence.attempt_id.clone(),
                        ordinal: entry.ordinal,
                        command: entry.command,
                        cwd: entry.process.as_ref().map(|p| p.cwd.clone()),
                        outcome,
                        exit_code: entry.process.as_ref().and_then(|p| p.exit_code),
                        output_preview: entry.output_preview,
                        details_truncated: entry.details_truncated,
                    });
                }
            }
        }
        Err(_) => candidate.unavailable.push("evidence_unavailable".into()),
    }
    candidate
}

/// Uses the existing trusted decoder and limits at the resolved task's actual storage root.
pub(super) fn load_task_reviews(
    artifact_root: &Path,
    thread: &str,
) -> Result<HashMap<String, p::TurnReviewEvidence>> {
    use std::io::Read;
    validate_thread_id(thread)?;
    let path = artifact_root.join("turn-review-evidence");
    let directory = match kcoder_config::PrivateDirectory::open_existing(&path) {
        Ok(directory) => directory,
        Err(error) if error_is_not_found(&error) => return Ok(HashMap::new()),
        Err(error) => return Err(error),
    };
    let mut records = HashMap::new();
    let mut total = 0usize;
    directory.visit_entry_names_bounded(10_000, |name| {
        if !name.to_str().is_some_and(|name| name.ends_with(".json")) {
            return Ok(());
        }
        let mut bytes = Vec::new();
        directory
            .open_single_link_regular_file(name)?
            .take(turn_review_evidence::MAX_REVIEW_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        total = total
            .checked_add(bytes.len())
            .context("comparison evidence budget overflow")?;
        ensure!(
            total <= turn_observation_storage::MAX_OBSERVATION_FAMILY_BYTES,
            "comparison evidence exceeds budget"
        );
        let record = turn_review_evidence::decode_review(&bytes, thread, name)?;
        ensure!(
            records.insert(record.attempt_id.clone(), record).is_none(),
            "duplicate comparison review attempt"
        );
        Ok(())
    })?;
    Ok(records)
}
