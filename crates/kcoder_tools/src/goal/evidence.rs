use super::*;

pub(super) fn verifier_evidence_rejection(
    goal: &Goal,
    run: &AgentRunResult,
) -> Option<(GoalVerificationVerdict, String)> {
    let policy = &goal.verifier_selection.verification;
    let requires_trace = policy.require_tests
        || policy.require_behavior_delta
        || policy.require_raw_exit_code
        || policy.isolate_environment
        || !policy.allow_dependency_changes
        || !policy.allow_workspace_changes;
    if requires_trace && !run.tool_trace_complete {
        return Some((
            GoalVerificationVerdict::InfrastructureError,
            "verifier runner did not provide an engine-authenticated tool trace".to_string(),
        ));
    }
    if policy.isolate_environment && !run.environment_isolated {
        return Some((
            GoalVerificationVerdict::InfrastructureError,
            "verifier runner did not apply the configured isolated environment".to_string(),
        ));
    }
    if !policy.allow_dependency_changes && !run.dependency_mutation_blocked {
        return Some((
            GoalVerificationVerdict::InfrastructureError,
            "verifier runner did not enforce the configured dependency-mutation guard".to_string(),
        ));
    }
    if policy.require_behavior_delta && !run.dependency_mutation_blocked {
        return Some((
            GoalVerificationVerdict::InfrastructureError,
            "behavior-delta verification requires the engine dependency-mutation guard".to_string(),
        ));
    }
    if !policy.allow_workspace_changes && !run.workspace_snapshot_verified {
        return Some((
            GoalVerificationVerdict::InfrastructureError,
            "verifier runner did not capture the configured workspace fingerprint".to_string(),
        ));
    }
    if policy.require_behavior_delta && !run.workspace_snapshot_verified {
        return Some((
            GoalVerificationVerdict::InfrastructureError,
            "behavior-delta verification requires an engine-authenticated workspace fingerprint"
                .to_string(),
        ));
    }
    if !policy.allow_workspace_changes && !run.workspace_unchanged {
        return Some((
            GoalVerificationVerdict::Flaky,
            "verifier infrastructure changed the isolated candidate or pristine baseline workspace; its PASS and test evidence were discarded"
                .to_string(),
        ));
    }
    if policy.require_behavior_delta && !run.workspace_unchanged {
        return Some((
            GoalVerificationVerdict::Flaky,
            "the verifier behavior probe changed an isolated workspace; its delta evidence was discarded"
                .to_string(),
        ));
    }
    if objective_forbids_test_changes(&goal.objective) {
        let changed_tests = run
            .candidate_changed_paths
            .iter()
            .filter(|path| candidate_test_path(path))
            .map(|path| preview(path, 100))
            .collect::<Vec<_>>();
        if !changed_tests.is_empty() {
            return Some((
                GoalVerificationVerdict::Fail,
                format!(
                    "the goal explicitly forbids test modifications, but the candidate changes test files: {}",
                    changed_tests.join(", ")
                ),
            ));
        }
    }
    if !policy.require_tests && !policy.require_behavior_delta {
        return None;
    }
    if let Some(reason) = native_build_evidence_rejection(run) {
        return Some((GoalVerificationVerdict::Flaky, reason));
    }

    let native_build_signatures = verifier_native_build_signatures(run);
    let requires_authenticated_workdir = !policy.allow_workspace_changes;
    if requires_authenticated_workdir
        && run.tool_executions.iter().any(|execution| {
            matches!(execution.name.as_str(), "bash" | "PowerShell")
                && execution
                    .input
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(crate::bash::test_like_command)
                && !execution
                    .output
                    .contains("Goal Pro verifier test guard rejected")
                && !execution
                    .output
                    .contains("Goal Pro verifier baseline guard rejected")
                && !execution
                    .output
                    .contains("Goal Pro verifier workdir guard rejected")
                && execution.test_origin.is_none()
        })
    {
        return Some((
            GoalVerificationVerdict::Flaky,
            "a verifier test ran without authenticated Candidate/Baseline workdir provenance; its result cannot be used as completion evidence"
                .to_string(),
        ));
    }
    let tests = run
        .tool_executions
        .iter()
        .enumerate()
        .filter_map(|(index, execution)| {
            if !matches!(execution.name.as_str(), "bash" | "PowerShell") {
                return None;
            }
            let command = execution.input.get("command")?.as_str()?;
            (crate::bash::test_like_command(command)
                && !execution
                    .output
                    .contains("Goal Pro verifier test guard rejected")
                && !execution
                    .output
                    .contains("Goal Pro verifier baseline guard rejected")
                && !execution
                    .output
                    .contains("Goal Pro verifier workdir guard rejected")
                && (native_build_signatures.is_empty()
                    || execution.test_origin.is_some_and(|origin| {
                        all_native_builds_succeeded_before(
                            run,
                            index,
                            origin,
                            &native_build_signatures,
                        )
                    })))
            .then_some((execution, command))
        })
        .collect::<Vec<_>>();
    if tests.is_empty() {
        return Some((
            GoalVerificationVerdict::Flaky,
            "verifier returned PASS without running any target test command in its own session"
                .to_string(),
        ));
    }

    let candidate_tests = tests
        .iter()
        .filter(|(execution, _)| {
            if requires_authenticated_workdir {
                execution.test_origin == Some(crate::VerifierTestOrigin::Candidate)
            } else {
                execution.test_origin != Some(crate::VerifierTestOrigin::Baseline)
            }
        })
        .copied()
        .collect::<Vec<_>>();
    let baseline_tests = tests
        .iter()
        .filter(|(execution, _)| execution.test_origin == Some(crate::VerifierTestOrigin::Baseline))
        .copied()
        .collect::<Vec<_>>();
    let mut blocking_failures = Vec::new();
    for (index, (execution, command)) in candidate_tests.iter().copied().enumerate() {
        if successful_test_execution(execution) {
            continue;
        }
        if policy.allow_network_only_failures && network_only_test_failure(&execution.output) {
            continue;
        }
        if baseline_tests.iter().any(|(baseline, baseline_command)| {
            tests_have_matching_baseline_failure(execution, command, baseline, baseline_command)
        }) {
            continue;
        }
        if corrected_missing_test_selector_failure(index, execution, command, &candidate_tests) {
            continue;
        }
        blocking_failures.push(preview(command, 120));
    }
    if !blocking_failures.is_empty() {
        return Some((
            GoalVerificationVerdict::Fail,
            format!(
                "verifier reported PASS despite failed or unavailable target tests: {}",
                blocking_failures.join("; ")
            ),
        ));
    }

    let successful = candidate_tests
        .iter()
        .filter(|(execution, _)| successful_test_execution(execution))
        .collect::<Vec<_>>();
    if successful.is_empty() {
        return Some((
            GoalVerificationVerdict::Flaky,
            "no target test completed successfully; network-only failures cannot substitute for a passing target test"
                .to_string(),
        ));
    }
    if policy.require_raw_exit_code
        && !successful
            .iter()
            .any(|(_, command)| crate::bash::test_command_preserves_raw_exit(command))
    {
        return Some((
            GoalVerificationVerdict::Flaky,
            "all successful test commands filtered output or masked the original exit status"
                .to_string(),
        ));
    }
    if (policy.minimum_test_scope == GoalProTestScope::TargetSuite || policy.require_behavior_delta)
        && !successful.iter().any(|(_, command)| {
            (!policy.require_raw_exit_code || crate::bash::test_command_preserves_raw_exit(command))
                && !crate::bash::test_command_has_narrow_scope(command)
        })
    {
        return Some((
            GoalVerificationVerdict::Flaky,
            "verifier ran only narrowly selected tests (-k, marker, node id, or test-name filter); at least one target-suite command is required"
                .to_string(),
        ));
    }
    if policy.require_behavior_delta && !run_has_verified_behavior_delta(run) {
        return Some((
            GoalVerificationVerdict::Flaky,
            "no engine-authenticated behavior delta was proven: run one direct read-only issue-specific `python -c` probe with the exact same command on candidate and pristine baseline; candidate must exit 0, while baseline must exit 1 with the terminal line `AssertionError: KCODER_BEHAVIOR_DELTA`; imports and setup must occur before the assertion so infrastructure failures cannot be converted into delta evidence"
                .to_string(),
        ));
    }
    None
}

pub(super) fn run_has_verified_behavior_delta(run: &AgentRunResult) -> bool {
    const BEHAVIOR_DELTA_SENTINEL: &str = "KCODER_BEHAVIOR_DELTA";
    let has_native_build = !verifier_native_build_signatures(run).is_empty();
    let eligible = run
        .tool_executions
        .iter()
        .enumerate()
        .filter_map(|(index, execution)| {
            if execution.name != "bash"
                || execution
                    .output
                    .contains("Goal Pro verifier test guard rejected")
                || execution
                    .output
                    .contains("Goal Pro verifier baseline guard rejected")
                || execution
                    .output
                    .contains("Goal Pro verifier dependency guard")
                || execution
                    .output
                    .contains("Goal Pro verifier workdir guard rejected")
            {
                return None;
            }
            let command = execution.input.get("command")?.as_str()?;
            let signature = crate::bash::behavior_probe_command_signature(command)?;
            if !signature.contains(BEHAVIOR_DELTA_SENTINEL) {
                return None;
            }
            Some((index, execution, signature))
        })
        .collect::<Vec<_>>();

    eligible
        .iter()
        .any(|(candidate_index, candidate, candidate_signature)| {
            candidate.test_origin == Some(crate::VerifierTestOrigin::Candidate)
                && candidate.is_error == Some(false)
                && test_exit_code(&candidate.output) == Some(0)
                && eligible
                    .iter()
                    .any(|(baseline_index, baseline, baseline_signature)| {
                        baseline.test_origin == Some(crate::VerifierTestOrigin::Baseline)
                            && baseline.verifier_relative_workdir
                                == candidate.verifier_relative_workdir
                            && baseline.is_error == Some(true)
                            && test_exit_code(&baseline.output) == Some(1)
                            && baseline_signature == candidate_signature
                            && behavior_probe_has_authenticated_assertion_failure(&baseline.output)
                            && (!has_native_build
                                || paired_native_build_before(
                                    run,
                                    *candidate_index,
                                    *baseline_index,
                                ))
                    })
        })
}

pub(super) fn native_build_evidence_rejection(run: &AgentRunResult) -> Option<String> {
    let builds = run
        .tool_executions
        .iter()
        .filter_map(|execution| {
            if execution.name != "bash"
                || execution
                    .output
                    .contains("Goal Pro verifier native build guard rejected")
                || execution
                    .output
                    .contains("Goal Pro verifier workdir guard rejected")
                || execution.verifier_relative_workdir.as_deref() != Some(Path::new(""))
            {
                return None;
            }
            let command = execution.input.get("command")?.as_str()?;
            let signature = crate::bash::verifier_native_build_command_signature(command)?;
            Some((execution, signature))
        })
        .collect::<Vec<_>>();
    if builds.is_empty() {
        return None;
    }
    let signatures = builds
        .iter()
        .map(|(_, signature)| signature.as_str())
        .collect::<HashSet<_>>();
    let complete = signatures.iter().all(|signature| {
        [
            crate::VerifierTestOrigin::Candidate,
            crate::VerifierTestOrigin::Baseline,
        ]
        .into_iter()
        .all(|origin| {
            builds.iter().any(|(execution, candidate_signature)| {
                candidate_signature == signature
                    && execution.test_origin == Some(origin)
                    && execution.is_error == Some(false)
                    && test_exit_code(&execution.output) == Some(0)
            })
        })
    });
    (!complete).then(|| {
        "native build evidence is incomplete: every typed build recipe must finish successfully with the exact same command in both the isolated candidate and pristine baseline before its tests or behavior probes can be trusted"
            .to_string()
    })
}

pub(super) fn paired_native_build_before(
    run: &AgentRunResult,
    candidate_index: usize,
    baseline_index: usize,
) -> bool {
    let signatures = verifier_native_build_signatures(run);
    !signatures.is_empty()
        && all_native_builds_succeeded_before(
            run,
            candidate_index,
            crate::VerifierTestOrigin::Candidate,
            &signatures,
        )
        && all_native_builds_succeeded_before(
            run,
            baseline_index,
            crate::VerifierTestOrigin::Baseline,
            &signatures,
        )
}

pub(super) fn verifier_native_build_signatures(run: &AgentRunResult) -> HashSet<String> {
    run.tool_executions
        .iter()
        .filter_map(|execution| {
            if execution.name != "bash"
                || execution
                    .output
                    .contains("Goal Pro verifier native build guard rejected")
                || execution
                    .output
                    .contains("Goal Pro verifier workdir guard rejected")
                || execution.verifier_relative_workdir.as_deref() != Some(Path::new(""))
            {
                return None;
            }
            let command = execution.input.get("command")?.as_str()?;
            crate::bash::verifier_native_build_command_signature(command)
        })
        .collect()
}

pub(super) fn all_native_builds_succeeded_before(
    run: &AgentRunResult,
    limit: usize,
    origin: crate::VerifierTestOrigin,
    required: &HashSet<String>,
) -> bool {
    let successful = run
        .tool_executions
        .iter()
        .take(limit)
        .filter_map(|execution| {
            if execution.name != "bash"
                || execution.test_origin != Some(origin)
                || execution.is_error != Some(false)
                || test_exit_code(&execution.output) != Some(0)
                || execution.verifier_relative_workdir.as_deref() != Some(Path::new(""))
            {
                return None;
            }
            let command = execution.input.get("command")?.as_str()?;
            crate::bash::verifier_native_build_command_signature(command)
        })
        .collect::<HashSet<_>>();
    required.is_subset(&successful)
}

pub(super) fn behavior_probe_has_authenticated_assertion_failure(output: &str) -> bool {
    let terminal_is_sentinel = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        == Some("AssertionError: KCODER_BEHAVIOR_DELTA");
    if !terminal_is_sentinel {
        return false;
    }
    let lower = output.to_ascii_lowercase();
    ![
        "importerror:",
        "modulenotfounderror:",
        "oserror:",
        "permissionerror:",
        "timeouterror:",
        "fatal python error",
        "segmentation fault",
        "symbol lookup error",
        "undefined symbol",
        "aborted (core dumped)",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

pub(super) fn tests_have_matching_baseline_failure(
    candidate: &crate::AgentToolExecution,
    candidate_command: &str,
    baseline: &crate::AgentToolExecution,
    baseline_command: &str,
) -> bool {
    if candidate.verifier_relative_workdir != baseline.verifier_relative_workdir {
        return false;
    }
    if successful_test_execution(candidate) || successful_test_execution(baseline) {
        return false;
    }
    if crate::bash::test_command_signature(candidate_command)
        != crate::bash::test_command_signature(baseline_command)
    {
        return false;
    }
    if test_exit_code(&candidate.output) != test_exit_code(&baseline.output) {
        return false;
    }
    let candidate_failure = normalized_test_failure(&candidate.output);
    let baseline_failure = normalized_test_failure(&baseline.output);
    !candidate_failure.is_empty() && candidate_failure == baseline_failure
}

pub(super) fn corrected_missing_test_selector_failure(
    failure_index: usize,
    failure: &crate::AgentToolExecution,
    failed_command: &str,
    candidate_tests: &[(&crate::AgentToolExecution, &str)],
) -> bool {
    if !missing_test_selector_failure(failed_command, &failure.output) {
        return false;
    }

    let failed_scopes = test_selector_scopes(failed_command);
    if failed_scopes.is_empty() {
        return false;
    }

    candidate_tests
        .iter()
        .skip(failure_index + 1)
        .any(|(execution, command)| {
            if !successful_test_execution(execution) {
                return false;
            }
            let successful_scopes = test_selector_scopes(command);
            successful_scopes.iter().any(|successful_scope| {
                failed_scopes
                    .iter()
                    .any(|failed_scope| strict_test_scope_parent(successful_scope, failed_scope))
            })
        })
}

pub(super) fn missing_test_selector_failure(command: &str, output: &str) -> bool {
    let command = command.to_ascii_lowercase();
    let output = output.to_ascii_lowercase();
    if output.contains("importerror:") || output.contains("modulenotfounderror:") {
        return false;
    }

    let unittest_missing_selector = output.contains("unittest.loader._failedtest")
        && output.contains("attributeerror:")
        && output.contains(" has no attribute ");
    let pytest_missing_selector = command.contains("pytest")
        && (output.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("error: not found:")
                || line.starts_with("error: file or directory not found:")
        }))
        && (output.contains("no tests ran")
            || output.contains("no tests collected")
            || output.contains("collected 0 items"));

    unittest_missing_selector || pytest_missing_selector
}

pub(super) fn test_selector_scopes(command: &str) -> Vec<String> {
    command
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|character: char| matches!(character, '\'' | '"' | ';' | '(' | ')'))
        })
        .filter(|word| {
            !word.is_empty()
                && !word.starts_with('-')
                && !word.contains('=')
                && (word.contains("::")
                    || word.ends_with(".py")
                    || word == &"tests"
                    || word.starts_with("tests/")
                    || word.contains("/tests/")
                    || word.split('.').any(|component| {
                        component == "tests"
                            || component == "test"
                            || component.starts_with("test_")
                    }))
        })
        .map(|word| {
            word.trim_start_matches("./")
                .trim_end_matches('/')
                .to_string()
        })
        .filter(|word| !word.is_empty() && !word.ends_with("runtests.py"))
        .collect()
}

pub(super) fn strict_test_scope_parent(parent: &str, child: &str) -> bool {
    if parent.is_empty() || child.len() <= parent.len() || !child.starts_with(parent) {
        return false;
    }
    matches!(child[parent.len()..].chars().next(), Some('.' | '/' | ':'))
}

pub(super) fn test_exit_code(output: &str) -> Option<i32> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("exit_code:")?
            .trim()
            .parse::<i32>()
            .ok()
    })
}

pub(super) fn normalized_test_failure(output: &str) -> Vec<String> {
    let normalized_lines = output
        .lines()
        .map(normalize_failure_line)
        .collect::<Vec<_>>();
    let mut evidence = normalized_lines
        .iter()
        .filter(|line| failure_evidence_line(line))
        .cloned()
        .collect::<Vec<_>>();
    let has_fatal_crash = normalized_lines
        .iter()
        .any(|line| fatal_crash_marker(line).is_some());
    if has_fatal_crash {
        evidence.extend(
            normalized_lines
                .iter()
                .filter_map(|line| fatal_crash_marker(line)),
        );
        evidence.extend(
            normalized_lines
                .iter()
                .filter_map(|line| fatal_python_stack_frame(line)),
        );
    }
    evidence.sort();
    evidence.dedup();
    evidence
}

pub(super) fn fatal_crash_marker(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if let Some(detail) = trimmed.strip_prefix("Fatal Python error:") {
        let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
        return (!detail.is_empty())
            .then(|| format!("fatal-python:{}", detail.to_ascii_lowercase()));
    }

    let lower = trimmed.to_ascii_lowercase();
    let has_signal_context = lower.contains("(core dumped)")
        || lower.contains("terminated by signal")
        || lower.contains("signal:");
    if !has_signal_context {
        return None;
    }

    [
        (["sigabrt", "aborted"], "sigabrt"),
        (["sigsegv", "segmentation fault"], "sigsegv"),
        (["sigbus", "bus error"], "sigbus"),
        (["sigill", "illegal instruction"], "sigill"),
        (["sigfpe", "floating point exception"], "sigfpe"),
    ]
    .into_iter()
    .find_map(|(aliases, canonical)| {
        aliases
            .iter()
            .any(|alias| lower.contains(alias))
            .then(|| format!("process-signal:{canonical}"))
    })
}

pub(super) fn fatal_python_stack_frame(line: &str) -> Option<String> {
    let trimmed = line.trim();
    trimmed
        .starts_with("File \"")
        .then(|| format!("fatal-python-frame:{trimmed}"))
}

pub(super) fn normalize_failure_line(line: &str) -> String {
    let mut normalized = line.trim().replace('\\', "/");
    for prefix in ["/kcoder-goal-worktree-", "/kcoder-goal-baseline-"] {
        while let Some(component_start) = normalized.find(prefix) {
            let path_start = normalized[..component_start]
                .char_indices()
                .rev()
                .find_map(|(index, character)| {
                    (character.is_whitespace()
                        || matches!(character, '\'' | '"' | '=' | '(' | '[' | '{'))
                    .then_some(index + character.len_utf8())
                })
                .unwrap_or(0);
            let suffix = &normalized[component_start..];
            let end = suffix
                .find("/workspace")
                .map(|offset| component_start + offset + "/workspace".len())
                .unwrap_or_else(|| {
                    suffix
                        .find(char::is_whitespace)
                        .map_or(normalized.len(), |offset| component_start + offset)
                });
            normalized.replace_range(path_start..end, "<verifier-worktree>");
        }
    }
    normalized
}

pub(super) fn failure_evidence_line(line: &str) -> bool {
    let trimmed = line.trim_start_matches(['E', 'F', ' ']).trim_start();
    line.starts_with("FAILED ")
        || line.starts_with("ERROR ")
        || line.starts_with("FAIL: ")
        || line.starts_with("ERROR: ")
        || line.starts_with("thread '") && line.contains("panicked")
        || trimmed.starts_with("AssertionError")
        || trimmed.starts_with("ImportError")
        || trimmed.starts_with("ModuleNotFoundError")
        || trimmed.starts_with("AttributeError")
        || trimmed.starts_with("TypeError")
        || trimmed.starts_with("ValueError")
        || trimmed.starts_with("RuntimeError")
        || trimmed.starts_with("OSError")
        || trimmed.starts_with("PermissionError")
}

pub(super) fn objective_forbids_test_changes(objective: &str) -> bool {
    let normalized = objective.to_ascii_lowercase();
    [
        "do not modify tests",
        "don't modify tests",
        "must not modify tests",
        "do not edit tests",
        "don't edit tests",
        "不得修改测试",
        "不要修改测试",
        "禁止修改测试",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
}

pub(super) fn candidate_test_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    normalized
        .split('/')
        .any(|component| matches!(component, "tests" | "__tests__"))
        || file_name.starts_with("test_")
        || file_name.contains(".test.")
        || file_name.contains(".spec.")
        || file_name
            .split_once('.')
            .is_some_and(|(stem, _)| stem.ends_with("_test"))
}

pub(super) fn test_output_reports_zero_tests(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    if [
        "collected 0 item",
        "0 tests collected",
        "no tests collected",
        "no tests ran",
        "ran 0 tests",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }

    let mut reported_counts = Vec::new();
    for line in lower.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("running ") {
            let mut fields = rest.split_whitespace();
            if let (Some(count), Some(test_word)) = (fields.next(), fields.next())
                && test_word.starts_with("test")
                && let Ok(count) = count.parse::<u64>()
            {
                reported_counts.push(count);
            }
        }

        if let Some(rest) = line.strip_prefix("test result: ok.") {
            let mut fields = rest.split_whitespace();
            if let (Some(count), Some("passed;" | "passed")) = (fields.next(), fields.next())
                && let Ok(count) = count.parse::<u64>()
            {
                reported_counts.push(count);
            }
        }
    }

    !reported_counts.is_empty() && reported_counts.iter().all(|count| *count == 0)
}

pub(super) fn successful_test_execution(execution: &crate::AgentToolExecution) -> bool {
    let command = execution
        .input
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();

    execution.is_error == Some(false)
        && execution
            .output
            .lines()
            .any(|line| line.trim() == "exit_code: 0")
        && !execution
            .input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && !crate::bash::test_command_skips_execution(command)
        && !test_output_reports_zero_tests(&execution.output)
}

pub(super) fn network_only_test_failure(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    let network_evidence = [
        "temporary failure in name resolution",
        "name or service not known",
        "could not resolve host",
        "network is unreachable",
        "connection timed out",
        "connection refused",
        "failed to establish a new connection",
        "nodename nor servname provided",
        "dns lookup failed",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let non_network_evidence = [
        "assertionerror",
        "assertion failed",
        "syntaxerror",
        "typeerror",
        "nameerror",
        "attributeerror",
        "segmentation fault",
        "panicked at",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    network_evidence && !non_network_evidence
}

/// Parse the verifier's sole explicit verdict. Malformed or conflicting explicit
/// verdicts return None, requiring the caller to fail closed as InfrastructureError or Flaky.
pub fn parse_verifier_verdict(report: &str) -> Option<GoalVerificationVerdict> {
    let mut parsed = None;
    let mut fenced_block = None;
    for raw_line in report.lines() {
        if let Some(active_fence) = fenced_block {
            if markdown_fence_closes(raw_line, active_fence) {
                fenced_block = None;
            }
            continue;
        }
        if let Some(opening_fence) = markdown_fence_opens(raw_line) {
            fenced_block = Some(opening_fence);
            continue;
        }
        // Markdown code indented by four spaces or a tab is not a verifier declaration.
        if markdown_indented_code_line(raw_line) {
            continue;
        }
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(verdict) = parse_verifier_verdict_line(line)? else {
            continue;
        };
        match parsed {
            Some(existing) if existing != verdict => return None,
            None => parsed = Some(verdict),
            _ => {}
        }
    }
    parsed
}
