//! Agent verification; state ownership is retained by the agent facade.

use super::*;

pub(super) fn bounded_verifier_tool_result(
    name: &str,
    output: ToolOutput,
) -> Option<(ToolOutput, usize)> {
    // Goal Pro needs only raw shell results. Orchestration also retains tools for
    // which the runtime issued process/artifact metadata and specialized tools that
    // produce structured evidence. Ordinary read/search text does not become trusted
    // evidence merely because it appears in the transcript.
    if !matches!(name, "bash" | "PowerShell" | "SpecValidate" | "WebFetch")
        && output.execution_metadata.is_empty()
    {
        return None;
    }
    let text = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    // exit_code/workdir are in the header while pytest/unittest failure summaries are usually at the tail; retain both ends.
    let text = kcoder_tools::truncate_text(
        &text,
        MAX_VERIFIER_TRUSTED_TOOL_RESULT_BYTES,
        if matches!(name, "bash" | "PowerShell") {
            64 * 1024
        } else {
            128 * 1024
        },
        if matches!(name, "bash" | "PowerShell") {
            192 * 1024
        } else {
            128 * 1024
        },
    )
    .text;
    let bytes = text.len();
    Some((
        ToolOutput {
            content: vec![ContentBlock::Text { text }],
            is_error: output.is_error,
            execution_metadata: output.execution_metadata,
            user_context: Vec::new(),
        },
        bytes,
    ))
}

impl VerifierRuntimeGuard {
    pub(super) fn role_system_prompt(&self, base: &str) -> String {
        let cwd = self
            .cwd_override
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<session cwd>".to_string());
        let workspace = self
            .workspace_root
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| cwd.clone());
        let baseline = self
            .baseline_root
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<unavailable>".to_string());
        if self.workspace_root.is_none() {
            return format!(
                "{base}\n\nGoal Pro external-artifact runtime boundary (authoritative):\n- Start directory: {cwd}\n- Candidate/Baseline git worktree isolation is disabled by the selected verification policy. Do not invent a repository diff or claim a pristine-baseline comparison.\n- Verify the artifact in the external environment named by the objective. For container tasks, run the concrete target command through one direct `docker exec` or `podman exec` Bash call and preserve the container process's raw exit code; do not pipe, filter, append commands after the test, or mask failures.\n- Inspect the requested deliverables and every stated constraint. A main-agent report is context, never proof by itself.\n- Do not modify the deliverable while verifying. If the external environment or required verification command is unavailable, vote flaky rather than pass.\n- Apply this verdict order exactly: PASS only with current executable evidence and a complete artifact audit; FAIL for a concrete correctness gap or failing target check; FLAKY only when the required external verification cannot be obtained.\n- The final response's first non-empty line must be exactly PASS, FAIL, or FLAKY."
            );
        }
        let behavior_delta = if self.require_behavior_delta {
            "\n- Behavior-delta gate is active. In addition to a successful target suite, run one issue-specific direct `python -c` probe first in the candidate, then rerun the exact same command with Bash `workdir` set to the pristine baseline. The command must contain the assertion message `KCODER_BEHAVIOR_DELTA`: candidate exits 0; baseline exits exactly 1 with terminal line `AssertionError: KCODER_BEHAVIOR_DELTA`. Put imports and environment setup before that assertion. If the old target behavior raises an expected business exception, catch only that concrete exception and convert it with `raise AssertionError(\"KCODER_BEHAVIOR_DELTA\") from None`; never catch ImportError, timeout, crash, or arbitrary Exception as delta. The probe must call the affected runtime API, leave the workspace unchanged, and avoid pipes/redirection/failure masking. A baseline exit 0 means the behavior already existed at unmodified HEAD and is regression evidence only, never credit for this diff. Inspect callers, early interception branches, and error remapping before attributing the behavior to the changed code."
        } else {
            ""
        };
        format!(
            "{base}\n\nGoal Pro runtime boundary (authoritative):\n- Isolated candidate repository: {workspace}\n- Start directory: {cwd}\n- Pristine baseline repository (read-only comparison): {baseline}\n- Run `pwd` first, then use this isolated repository and relative paths for every diff, search, import, and test. Absolute source paths copied from the parent transcript or recent evidence are stale/read-only context and MUST NOT be used for validation.\n- Read `issue.md` at the isolated repository root when present, then inspect the complete diff and search the entire repository for every removed/replaced API name, option key, literal, and related symbol. Inspect all relevant hits and sibling consumers such as clients, serializers, constants, adapters, and backends. A minimal reproduction or a suite in which the affected tests were skipped is insufficient.\n- Distinguish root-cause coverage from symptom coverage: state the invariant being repaired and test at least one adjacent/alternate path. Treat test collection import errors and missing candidate symbols as candidate failures unless evidence proves they are baseline-only.\n- If a candidate target suite fails and you suspect a pre-existing environment failure, rerun the exact same command once with Bash `workdir` set to the pristine baseline path above. Do not put `cd` or the baseline path inside the command: the candidate and baseline command strings must be identical. The machine gate accepts the failure only when both commands have matching raw exit codes and normalized failure evidence; do not create another baseline, stash, archive, copy, or worktree yourself.{behavior_delta}\n- If importing the source tree requires a native extension build, the only writable preparation recipe is direct `python setup.py build_ext --inplace` with optional bounded parallelism. Run the exact same recipe separately in candidate and baseline using Bash `workdir`; both builds must succeed before their test/probe evidence. Never copy a binary from the parent or between worktrees. The baseline becomes read-only again immediately after that one command.\n- Apply this verdict order exactly. PASS when the candidate has at least one successful focused functional check demonstrating the requested repair, the diff/root-cause audit finds no gap, and every nonzero broader check is proven baseline-only by the exact same command, raw exit code, and normalized failure evidence. A proven baseline-only failure is not a reason for FAIL or FLAKY. FAIL when the candidate introduces a failure absent from the baseline, adds candidate-only failure evidence, or the implementation/audit exposes a real correctness gap. FLAKY only when required tests or dependencies are unavailable, an exact candidate/baseline comparison cannot be obtained or paired, or no successful candidate-side functional check demonstrates the repair.\n- Run test commands directly. The runtime rejects pipelines, trailing commands, failure masking, shell-level directory changes, absolute test selectors, and narrower selectors than the configured policy before execution; correct the command once instead of retrying variants.\n- Do not spend repeated turns repairing the shared environment. Diagnose an unavailable dependency once and return FLAKY. Aim to finish the audit within 12 internal turns unless one already-started target suite is still running.\n- The final response's first non-empty line must be exactly PASS, FAIL, or FLAKY."
        )
    }
}

/// Goal Pro verifier tool surface: a read-only role surface plus a session-local
/// VerifierVote. A Goal Pro verifier always uses read-only role tools; Arrangement
/// cannot add edit/write back. VerifierVote belongs to no base registry and is
/// attached only after role filtering, so primary agents and other roles never receive it.
pub(super) fn verifier_session_tools(base_tools: &ToolRegistry) -> ToolRegistry {
    filter_tools_for_agent_kind(base_tools, AgentKind::Verifier, true)
        .register(kcoder_tools::VerifierVoteTool)
}

pub(super) fn orchestrate_role_prompt(agent_kind: AgentKind, persona: Option<&str>) -> String {
    if let Some(persona) = persona {
        let prompt = match persona {
            "junior" => include_str!("../../prompts/orchestrate/junior.md"),
            "oracle" => include_str!("../../prompts/orchestrate/oracle.md"),
            "librarian" => include_str!("../../prompts/orchestrate/librarian.md"),
            "critic" => include_str!("../../prompts/orchestrate/critic.md"),
            _ => agent_kind.system_prompt(),
        };
        return format!(
            "{}\n\nBase-role security boundary (authoritative): {}",
            prompt.trim(),
            agent_kind.system_prompt()
        );
    }
    match agent_kind {
        AgentKind::Plan => format!(
            "{}\n\nOrchestrate plan contract:\n{}",
            agent_kind.system_prompt(),
            include_str!("../../prompts/orchestrate/plan_addendum.md").trim()
        ),
        AgentKind::Verifier => format!(
            "{}\n\nOrchestrate verifier contract:\n{}",
            agent_kind.system_prompt(),
            include_str!("../../prompts/orchestrate/verifier_addendum.md").trim()
        ),
        _ => agent_kind.system_prompt().to_string(),
    }
}

pub(super) fn resolved_profile_fingerprint(input: ProfileFingerprintInput<'_>) -> String {
    let mut tool_names = input.tools.names();
    tool_names.sort();
    let payload = serde_json::json!({
        "roster_name": input.persona,
        "base_role": input.agent_kind.as_str(),
        "prompt_sha256": format!("{:x}", Sha256::digest(input.role_prompt.as_bytes())),
        "effective_tools": tool_names,
        "runtime_provider": input.runtime_provider,
        "runtime_model": input.runtime_model,
        "runtime_profile": input.runtime_selection.and_then(|selection| selection.profile.as_deref()),
        "runtime_provider_override": input.runtime_selection.and_then(|selection| selection.provider.as_deref()),
        "runtime_model_override": input.runtime_selection.and_then(|selection| selection.model.as_deref()),
        "context_mode": input.context_mode,
        "context_turns": input.context_turns,
        "work_id": input.work_id,
        "parent_session_id": input.parent_session_id,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default())
    )
}

/// Validate before consumption: the vote must come from an actually executed
/// VerifierVote call in this session transcript, and every referenced tool ID must
/// belong to the engine-authenticated set. Discard invalid votes and let the caller
/// fall back to text-verdict parsing.
pub(super) fn validated_verifier_vote(
    channel: &kcoder_tools::VerifierVoteChannel,
    messages: &[Message],
) -> Option<kcoder_tools::VerifierVoteRecord> {
    let vote = channel.recorded_vote()?;
    let mut vote_tool_use_seen = false;
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            if let ContentBlock::ToolUse { id, name, .. } = block
                && name == kcoder_tools::VERIFIER_VOTE_TOOL_NAME
                && *id == vote.tool_use_id
            {
                vote_tool_use_seen = true;
            }
        }
    }
    if !vote_tool_use_seen {
        warn!(
            tool_use_id = %vote.tool_use_id,
            "discarding verifier vote: its tool_use id is missing from the verifier transcript"
        );
        return None;
    }
    if let Some(ids) = vote.input.verified_tool_use_ids.as_ref() {
        let unknown = ids
            .iter()
            .filter(|id| !channel.is_authenticated_tool_use(id))
            .cloned()
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            warn!(
                unknown_ids = ?unknown,
                "discarding verifier vote: verified_tool_use_ids left the engine-authenticated set"
            );
            return None;
        }
    }
    Some(vote)
}

pub(super) async fn verifier_workspace_fingerprint(cwd: &Path) -> Result<String, AgentError> {
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        verifier_workspace_fingerprint_inner(cwd),
    )
    .await
    .map_err(|_| AgentError::Execution("verifier workspace fingerprint timed out".to_string()))?
}

async fn verifier_workspace_fingerprint_inner(cwd: &std::path::Path) -> Result<String, AgentError> {
    let top_level_output = verifier_git_output(cwd, &["rev-parse", "--show-toplevel"]).await?;
    let top_level = PathBuf::from(
        String::from_utf8(top_level_output)
            .map_err(|_| {
                AgentError::Execution("git workspace root is not valid UTF-8".to_string())
            })?
            .trim(),
    );
    let diff = verifier_git_output(
        &top_level,
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder",
            ":(exclude).kcoder/**",
        ],
    )
    .await?;
    if diff.len() > MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES {
        return Err(AgentError::Execution(
            "verifier workspace diff exceeds the 64 MiB snapshot limit".to_string(),
        ));
    }
    let untracked = verifier_git_output(
        &top_level,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
    )
    .await?;
    let mut hasher = Sha256::new();
    hasher.update(b"tracked-diff\0");
    hasher.update(&diff);
    let mut total_bytes = diff.len();
    for raw_path in untracked.split(|byte| *byte == 0) {
        if raw_path.is_empty() {
            continue;
        }
        let relative = String::from_utf8_lossy(raw_path);
        if verifier_ignores_untracked_path(&relative) {
            continue;
        }
        let path = top_level.join(relative.as_ref());
        let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|error| {
            AgentError::Execution(format!(
                "failed to inspect untracked verifier file `{}`: {error}",
                path.display()
            ))
        })?;
        hasher.update(b"untracked\0");
        hasher.update(raw_path);
        hasher.update(b"\0");
        if metadata.file_type().is_symlink() {
            let target = tokio::fs::read_link(&path).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to inspect untracked verifier symlink `{}`: {error}",
                    path.display()
                ))
            })?;
            hasher.update(target.as_os_str().to_string_lossy().as_bytes());
        } else if metadata.is_file() {
            let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
            total_bytes = total_bytes.saturating_add(size);
            if total_bytes > MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES {
                return Err(AgentError::Execution(
                    "verifier workspace snapshot exceeds the 64 MiB limit".to_string(),
                ));
            }
            let remaining =
                MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES.saturating_sub(total_bytes - size);
            let file = tokio::fs::File::open(&path)
                .await
                .map_err(|error| AgentError::Execution(error.to_string()))?;
            let bytes = kcoder_tools::owned_process::read_bounded(file, remaining)
                .await
                .map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to read untracked verifier file `{}`: {error}",
                        path.display()
                    ))
                })?;
            total_bytes = total_bytes - size + bytes.len();
            hasher.update(bytes);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(super) fn bash_result_workdir(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("workdir: "))
        .map(PathBuf::from)
}

pub(super) fn bash_execution_workdir(
    execution: &kcoder_tools::AgentToolExecution,
) -> Option<PathBuf> {
    bash_result_workdir(&execution.output).or_else(|| {
        execution
            .input
            .get("workdir")
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from)
    })
}

pub(super) fn verifier_test_provenance(
    workdir: &Path,
    candidate_root: &Path,
    baseline_root: &Path,
) -> Option<(kcoder_tools::VerifierTestOrigin, PathBuf)> {
    let canonical_workdir = std::fs::canonicalize(workdir).ok()?;
    let canonical_candidate = std::fs::canonicalize(candidate_root).ok()?;
    let canonical_baseline = std::fs::canonicalize(baseline_root).ok()?;
    if canonical_workdir.starts_with(&canonical_baseline) {
        Some((
            kcoder_tools::VerifierTestOrigin::Baseline,
            canonical_workdir
                .strip_prefix(&canonical_baseline)
                .ok()?
                .to_path_buf(),
        ))
    } else if canonical_workdir.starts_with(&canonical_candidate) {
        Some((
            kcoder_tools::VerifierTestOrigin::Candidate,
            canonical_workdir
                .strip_prefix(&canonical_candidate)
                .ok()?
                .to_path_buf(),
        ))
    } else {
        None
    }
}
