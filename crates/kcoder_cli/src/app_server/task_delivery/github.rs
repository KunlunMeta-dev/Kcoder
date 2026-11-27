use super::*;
use kcoder_process_supervisor::owned_process;
use tokio::process::Command;

/// Only credential-free github.com remotes are accepted; self-hosted forges stay explicit.
pub(super) fn repository(remote: &str) -> Option<String> {
    let path = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    (parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && ![".", ".."].contains(part)
                && part.len() <= 100
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        }))
    .then(|| path.to_owned())
}
fn segment(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
async fn gh(cwd: &Path, args: &[&str]) -> Result<Value> {
    let mut command = Command::new("gh");
    command
        .current_dir(cwd)
        .args(args)
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat");
    // Owned process groups, bounded drains and cancellation cleanup are shared with tools.
    let output = owned_process::output(
        &mut command,
        None,
        256 * 1024,
        4096,
        Duration::from_secs(12),
        None,
    )
    .await
    .context("githubCliUnavailable")?;
    ensure!(output.status.success(), "githubQueryFailed");
    serde_json::from_slice(&output.stdout).context("githubInvalidResponse")
}
fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}
fn check_state(status: &str, conclusion: &str) -> p::TaskDeliveryCiState {
    use p::TaskDeliveryCiState as C;
    if status != "completed" {
        return C::Waiting;
    }
    match conclusion {
        "success" => C::Passed,
        "neutral" => C::Neutral,
        "skipped" => C::Skipped,
        "failure" | "cancelled" | "timed_out" | "action_required" | "startup_failure" => C::Failed,
        _ => C::Unknown,
    }
}
fn safe_url(value: Option<String>) -> Option<String> {
    value.filter(|url| {
        url.len() <= 2048 && url.starts_with("https://") && !url.chars().any(char::is_control)
    })
}
/// A canonical PR link may change repository-name casing, but no other URL identity.
pub(super) fn valid_pull_request_url(url: &str, expected_repository: &str, number: u64) -> bool {
    if number == 0 || url.len() > 2048 || url.chars().any(char::is_control) {
        return false;
    }
    if repository(&format!("https://github.com/{expected_repository}.git")).as_deref()
        != Some(expected_repository)
    {
        return false;
    }
    let Some((expected_owner, expected_repo)) = expected_repository.split_once('/') else {
        return false;
    };
    let Some(path) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    let mut parts = path.split('/');
    let number = number.to_string();
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(owner), Some(repo), Some("pull"), Some(id), None)
            if owner.eq_ignore_ascii_case(expected_owner)
                && repo.eq_ignore_ascii_case(expected_repo)
                && id == number.as_str()
    )
}

pub(super) fn project_checks(
    source: &p::TaskDeliverySource,
    runs: &Value,
    statuses: &Value,
) -> Result<(Vec<p::TaskDeliveryCheck>, bool)> {
    let rows = runs
        .get("check_runs")
        .and_then(Value::as_array)
        .context("githubInvalidChecks")?;
    let old = statuses
        .get("statuses")
        .and_then(Value::as_array)
        .context("githubInvalidStatuses")?;
    let mut checks = Vec::new();
    for row in rows.iter().take(50) {
        ensure!(
            row.get("head_sha").and_then(Value::as_str) == Some(&source.head_commit),
            "github check commit mismatch"
        );
        let id = row
            .get("id")
            .and_then(Value::as_u64)
            .context("githubInvalidCheckId")?;
        checks.push(p::TaskDeliveryCheck {
            check_id: format!("check:{id}"),
            name: bounded(
                row.get("name").and_then(Value::as_str).unwrap_or("check"),
                240,
            ),
            head_commit: source.head_commit.clone(),
            state: check_state(
                row.get("status").and_then(Value::as_str).unwrap_or(""),
                row.get("conclusion").and_then(Value::as_str).unwrap_or(""),
            ),
            details_url: safe_url(string(row, "html_url")),
        });
    }
    ensure!(
        statuses.get("sha").and_then(Value::as_str) == Some(&source.head_commit),
        "github status commit mismatch"
    );
    // Combined status already contains the newest entry per context.
    for row in old.iter().take(50) {
        let id = row
            .get("id")
            .and_then(Value::as_u64)
            .context("githubInvalidStatusId")?;
        let state = match row.get("state").and_then(Value::as_str) {
            Some("success") => p::TaskDeliveryCiState::Passed,
            Some("failure" | "error") => p::TaskDeliveryCiState::Failed,
            Some("pending") => p::TaskDeliveryCiState::Waiting,
            _ => p::TaskDeliveryCiState::Unknown,
        };
        checks.push(p::TaskDeliveryCheck {
            check_id: format!("status:{id}"),
            name: bounded(
                row.get("context")
                    .and_then(Value::as_str)
                    .unwrap_or("status"),
                240,
            ),
            head_commit: source.head_commit.clone(),
            state,
            details_url: safe_url(string(row, "target_url")),
        });
    }
    let truncated = runs
        .get("total_count")
        .and_then(Value::as_u64)
        .is_none_or(|n| n > rows.len() as u64)
        || statuses
            .get("total_count")
            .and_then(Value::as_u64)
            .is_none_or(|n| n > old.len() as u64)
        || checks.len() > 50;
    checks.truncate(50);
    Ok((checks, truncated))
}
pub(super) fn ci(checks: &[p::TaskDeliveryCheck], truncated: bool) -> p::TaskDeliveryCiState {
    use p::TaskDeliveryCiState as C;
    if checks.iter().any(|c| c.state == C::Failed) {
        C::Failed
    } else if checks.iter().any(|c| c.state == C::Waiting) {
        C::Waiting
    } else if truncated
        || checks
            .iter()
            .any(|c| matches!(c.state, C::Unknown | C::Skipped | C::Neutral))
    {
        C::Unknown
    } else if checks.is_empty() {
        C::None
    } else {
        C::Passed
    }
}
/// Repository names follow GitHub casing rules; branch refs and the selected commit remain exact.
pub(super) fn pull_request_matches_source(source: &p::TaskDeliverySource, row: &Value) -> bool {
    let owner = row
        .pointer("/headRepositoryOwner/login")
        .and_then(Value::as_str)
        .unwrap_or("");
    let name = row
        .pointer("/headRepository/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    format!("{owner}/{name}").eq_ignore_ascii_case(&source.repository)
        && row.get("headRefName").and_then(Value::as_str) == Some(source.branch.as_str())
        && row.get("baseRefName").and_then(Value::as_str) == Some(source.base_branch.as_str())
        && row.get("headRefOid").and_then(Value::as_str) == Some(source.head_commit.as_str())
}

pub(super) async fn status(cwd: &Path, result: &p::TaskDeliveryResult) -> p::TaskDeliveryStatus {
    let mut state = initial_status();
    let source = &result.source;
    let response = async {
        let branch_endpoint = format!("repos/{}/git/matching-refs/heads/{}", source.repository, segment(&source.branch));
        let branches = gh(cwd, &["api", &branch_endpoint]).await?;
        let rows = branches.as_array().context("githubInvalidRefs")?;
        let wanted_ref = format!("refs/heads/{}", source.branch);
        let actual = rows.iter().find(|row| row.get("ref").and_then(Value::as_str) == Some(&wanted_ref))
            .and_then(|row| row.pointer("/object/sha")).and_then(Value::as_str);
        state.push_state = if actual == Some(&source.head_commit) { "pushed" }
            else { "notPushed" }.into();
        let pulls = gh(cwd, &["pr", "list", "--repo", &source.repository, "--head", &source.branch,
            "--state", "all", "--limit", "20", "--json", "number,url,state,headRefOid,headRefName,baseRefName,headRepositoryOwner,headRepository,body,reviewDecision"]).await?;
        let pulls = pulls.as_array().context("githubInvalidPulls")?;
        if let Some(pr) = pulls.iter().find(|pr| pull_request_matches_source(source, pr)) {
            let number = pr.get("number").and_then(Value::as_u64).context("githubInvalidPullNumber")?;
            let url = safe_url(string(pr, "url")).context("githubInvalidPullUrl")?;
            ensure!(valid_pull_request_url(&url, &source.repository, number), "github PR repository or number mismatch");
            state.pull_request = Some(p::TaskDeliveryPullRequest {
                number, url,
                state: string(pr, "state").unwrap_or_else(|| "UNKNOWN".into()),
                head_commit: source.head_commit.clone(),
                review_state: string(pr, "reviewDecision").filter(|v| !v.is_empty()).unwrap_or_else(|| "UNKNOWN".into()),
                matches_request: result.request.as_ref().is_some_and(|r| pr.get("body").and_then(Value::as_str)
                    .is_some_and(|body| body.contains(&format!("<!-- kcoder-delivery:{} -->", r.request_id)))) });
        }
        let endpoint = format!("repos/{}/commits/{}/check-runs?per_page=50", source.repository, source.head_commit);
        let runs = gh(cwd, &["api", &endpoint]).await?;
        let endpoint = format!("repos/{}/commits/{}/status?per_page=50", source.repository, source.head_commit);
        let statuses = gh(cwd, &["api", &endpoint]).await?;
        let (checks, truncated) = project_checks(source, &runs, &statuses)?;
        state.ci_state = ci(&checks, truncated); state.checks = checks; state.checks_truncated = truncated;
        state.limitation = truncated.then(|| "checksTruncated".into());
        Ok::<(), anyhow::Error>(())
    }.await;
    if response.is_err() {
        state.limitation = Some("githubUnavailable".into());
    }
    state
}

pub(super) async fn failure(
    cwd: &Path,
    source: &p::TaskDeliverySource,
    check: &p::TaskDeliveryCheck,
) -> Result<String> {
    let raw = if let Some(id) = check.check_id.strip_prefix("check:") {
        ensure!(
            !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()),
            "invalid check id"
        );
        let endpoint = format!("repos/{}/check-runs/{id}", source.repository);
        let raw = gh(cwd, &["api", &endpoint, "--jq", "{id,head_sha,name,status,conclusion,html_url,output:{title:.output.title,summary:(.output.summary // \"\" | .[0:8192]),text:(.output.text // \"\" | .[0:8192])}}"]).await?;
        ensure!(
            raw.get("head_sha").and_then(Value::as_str) == Some(&source.head_commit),
            "failed check commit changed"
        );
        ensure!(
            check_state(
                raw.get("status").and_then(Value::as_str).unwrap_or(""),
                raw.get("conclusion").and_then(Value::as_str).unwrap_or("")
            ) == p::TaskDeliveryCiState::Failed,
            "check no longer failed"
        );
        raw
    } else if let Some(id) = check.check_id.strip_prefix("status:") {
        let endpoint = format!(
            "repos/{}/commits/{}/status?per_page=50",
            source.repository, source.head_commit
        );
        let raw = gh(cwd, &["api", &endpoint]).await?;
        ensure!(
            raw.get("sha").and_then(Value::as_str) == Some(&source.head_commit),
            "failed status commit changed"
        );
        raw.get("statuses")
            .and_then(Value::as_array)
            .and_then(|rows| {
                rows.iter().find(|r| {
                    r.get("id")
                        .and_then(Value::as_u64)
                        .is_some_and(|n| n.to_string() == id)
                        && matches!(
                            r.get("state").and_then(Value::as_str),
                            Some("failure" | "error")
                        )
                })
            })
            .cloned()
            .context("failed status unavailable")?
    } else {
        anyhow::bail!("invalid failed check identity")
    };
    Ok(serde_json::to_string_pretty(&raw)?)
}
