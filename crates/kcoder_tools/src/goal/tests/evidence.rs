use super::*;

#[test]
fn machine_gate_rejects_pass_without_verifier_test() {
    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &verifier_run(vec![]))
        .expect("test-less PASS must be rejected");

    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(rejection.1.contains("without running any target test"));
}

#[test]
fn machine_gate_accepts_external_container_test_without_git_provenance() {
    let command = "docker exec task bash -lc 'cd /tests && python -m pytest test_outputs.py -v'";
    let mut execution = tool_execution(command, 0, "2 passed in 0.12s");
    execution.test_origin = None;
    execution.verifier_relative_workdir = None;
    let mut run = verifier_run(vec![execution]);
    run.environment_isolated = false;
    run.dependency_mutation_blocked = false;
    run.workspace_snapshot_verified = false;
    run.workspace_unchanged = false;

    assert!(
        verifier_evidence_rejection(&strict_external_artifact_goal(), &run).is_none(),
        "an explicitly unisolated external-artifact policy must accept its own raw container test"
    );
}

#[test]
fn machine_gate_still_rejects_unprovenanced_test_for_bounded_workspace() {
    let mut execution = tool_execution("python -m pytest tests", 0, "2 passed");
    execution.test_origin = None;
    execution.verifier_relative_workdir = None;
    let rejection =
        verifier_evidence_rejection(&strict_artifact_goal(), &verifier_run(vec![execution]))
            .expect("bounded source verification must retain Candidate/Baseline provenance");

    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(
        rejection
            .1
            .contains("without authenticated Candidate/Baseline")
    );
}

#[test]
fn machine_gate_rejects_nonexecuting_or_zero_test_evidence() {
    for (command, output) in [
        (
            "python -m pytest tests --collect-only",
            "collected 12 items",
        ),
        ("python -m pytest --version tests", "pytest 8.3.0"),
        ("python -m pytest --help tests", "usage: pytest [options]"),
        ("python -m pytest --setup-only tests", "SETUP S test_case"),
        ("cargo test --no-run", "Finished test profile"),
        ("cargo test -- --list", "test_case: test"),
        (
            "./gradlew test --dry-run",
            ":test SKIPPED\nBUILD SUCCESSFUL",
        ),
        ("mvn test -DskipTests=true", "Tests are skipped."),
        (
            "python -m pytest tests",
            "collected 0 items\n\nno tests ran",
        ),
        ("python -m unittest discover", "Ran 0 tests in 0.000s\n\nOK"),
        (
            "cargo test",
            "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored",
        ),
    ] {
        let run = verifier_run(vec![tool_execution(command, 0, output)]);
        let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run);
        assert!(
            rejection.is_some(),
            "command `{command}` with output `{output}` must not count as successful test evidence"
        );
    }
}

#[test]
fn machine_gate_accepts_cargo_workspace_with_a_nonzero_test_suite() {
    let run = verifier_run(vec![tool_execution(
        "cargo test",
        0,
        "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored\n\nrunning 2 tests\n..\ntest result: ok. 2 passed; 0 failed; 0 ignored",
    )]);

    assert!(
        verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none(),
        "zero-test targets must not hide another target that actually ran tests"
    );
}

#[test]
fn machine_gate_accepts_nonzero_unittest_suite() {
    let run = verifier_run(vec![tool_execution(
        "python -m unittest discover -s tests",
        0,
        "...\n----------------------------------------------------------------------\nRan 3 tests in 0.012s\n\nOK",
    )]);

    assert!(
        verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none(),
        "a successful non-empty unittest suite must count as target-test evidence"
    );
}

#[test]
fn behavior_delta_gate_rejects_successful_target_suite_without_delta() {
    let run = verifier_run(vec![tool_execution(
        "python -m pytest tests/validators -q",
        0,
        "12 passed",
    )]);

    let rejection =
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run)
            .expect("target-suite success alone must not prove changed behavior");
    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(rejection.1.contains("behavior delta"), "{}", rejection.1);
}

#[test]
fn behavior_delta_gate_accepts_same_probe_candidate_zero_baseline_nonzero() {
    let probe = "python -c 'from app.validators import validate; assert validate(\"fixed\") is True, \"KCODER_BEHAVIOR_DELTA\"'";
    let run = verifier_run(vec![
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(
            probe,
            1,
            "Traceback (most recent call last):\nAssertionError: KCODER_BEHAVIOR_DELTA",
        ),
    ]);

    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run,)
            .is_none()
    );
}

#[test]
fn behavior_delta_gate_rejects_baseline_import_infrastructure_failure() {
    let probe = "python -c 'from app.validators import validate; assert validate(\"fixed\") is True, \"KCODER_BEHAVIOR_DELTA\"'";
    let run = verifier_run(vec![
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(
            probe,
            1,
            "Traceback (most recent call last):\nModuleNotFoundError: No module named 'app._native'",
        ),
    ]);

    let rejection =
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run)
            .expect("a missing baseline dependency must not prove the issue behavior changed");
    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(rejection.1.contains("behavior delta"), "{}", rejection.1);

    let converted = verifier_run(vec![
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(
            probe,
            1,
            "Traceback (most recent call last):\nModuleNotFoundError: No module named 'app._native'\nDuring handling of the above exception, another exception occurred:\nAssertionError: KCODER_BEHAVIOR_DELTA",
        ),
    ]);
    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &converted,)
            .is_some(),
        "an infrastructure exception chain must not be converted into sentinel evidence"
    );
}

#[test]
fn behavior_delta_gate_rejects_timeout_crash_and_abi_failures() {
    let probe = "python -c 'from app.validators import validate; assert validate(\"fixed\") is True, \"KCODER_BEHAVIOR_DELTA\"'";
    for (exit_code, output) in [
        (124, "command timed out"),
        (139, "Segmentation fault (core dumped)"),
        (
            1,
            "ValueError: numpy.dtype size changed, may indicate binary incompatibility",
        ),
        (
            1,
            "AssertionError: KCODER_BEHAVIOR_DELTA\nPermission denied",
        ),
    ] {
        let run = verifier_run(vec![
            tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
            tool_execution(probe, 0, "candidate behavior fixed"),
            baseline_tool_execution(probe, exit_code, output),
        ]);
        let rejection =
            verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run)
                .expect("infrastructure failure must not become behavior delta evidence");
        assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    }
}

#[test]
fn behavior_delta_gate_requires_successful_paired_native_builds_before_probes() {
    let build = "python setup.py build_ext --inplace -j 4";
    let probe = "python -c 'from app.validators import validate; assert validate(\"fixed\") is True, \"KCODER_BEHAVIOR_DELTA\"'";
    let paired = verifier_run(vec![
        tool_execution(build, 0, "candidate native build complete"),
        baseline_tool_execution(build, 0, "baseline native build complete"),
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(
            probe,
            1,
            "Traceback (most recent call last):\nAssertionError: KCODER_BEHAVIOR_DELTA",
        ),
    ]);
    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &paired,)
            .is_none()
    );

    let unpaired = verifier_run(vec![
        tool_execution(build, 0, "candidate native build complete"),
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(
            probe,
            1,
            "Traceback (most recent call last):\nAssertionError: KCODER_BEHAVIOR_DELTA",
        ),
    ]);
    let rejection =
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &unpaired)
            .expect("a candidate-only native build must not prove a pristine baseline delta");
    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(rejection.1.contains("native build"), "{}", rejection.1);

    let mut rejected_build = tool_execution(
        build,
        1,
        "Goal Pro verifier native build guard rejected background execution",
    );
    rejected_build.input["run_in_background"] = serde_json::json!(true);
    let guard_recovered = verifier_run(vec![
        rejected_build,
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(probe, 1, "AssertionError: KCODER_BEHAVIOR_DELTA"),
    ]);
    assert!(
        verifier_evidence_rejection(
            &strict_artifact_goal_requiring_behavior_delta(),
            &guard_recovered,
        )
        .is_none(),
        "a rejected build attempt must not activate the paired-build requirement"
    );

    let build_after_test = verifier_run(vec![
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(build, 0, "candidate native build complete"),
        baseline_tool_execution(build, 0, "baseline native build complete"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(probe, 1, "AssertionError: KCODER_BEHAVIOR_DELTA"),
    ]);
    let rejection = verifier_evidence_rejection(
        &strict_artifact_goal_requiring_behavior_delta(),
        &build_after_test,
    )
    .expect("a target suite run before native preparation is not trusted");
    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);

    let failed_baseline_build = verifier_run(vec![
        tool_execution(build, 0, "candidate native build complete"),
        baseline_tool_execution(build, 1, "compiler unavailable"),
        tool_execution("python -m pytest tests/validators -q", 0, "12 passed"),
        tool_execution(probe, 0, "candidate behavior fixed"),
        baseline_tool_execution(probe, 1, "AssertionError: KCODER_BEHAVIOR_DELTA"),
    ]);
    let rejection = verifier_evidence_rejection(
        &strict_artifact_goal_requiring_behavior_delta(),
        &failed_baseline_build,
    )
    .expect("a failed baseline build must invalidate native evidence");
    assert!(rejection.1.contains("native build"), "{}", rejection.1);
}

#[test]
fn behavior_delta_gate_accepts_in_memory_pickle_round_trip() {
    let probe = "python -c 'import pickle; from app import value; blob = pickle.dumps(value()); assert pickle.loads(blob) == value(), \"KCODER_BEHAVIOR_DELTA\"'";
    let run = verifier_run(vec![
        tool_execution("python -m pytest tests/serialization -q", 0, "9 passed"),
        tool_execution(probe, 0, "candidate round trip passed"),
        baseline_tool_execution(
            probe,
            1,
            "Traceback (most recent call last):\nAssertionError: KCODER_BEHAVIOR_DELTA",
        ),
    ]);

    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run,)
            .is_none()
    );
}

#[test]
fn behavior_delta_gate_rejects_baseline_that_also_passes() {
    let probe = "python -c 'from app import behavior; assert behavior()'";
    let run = verifier_run(vec![
        tool_execution("python -m pytest tests/behavior -q", 0, "8 passed"),
        tool_execution(probe, 0, "candidate already works"),
        baseline_tool_execution(probe, 0, "baseline already works"),
    ]);

    let rejection =
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run)
            .expect("behavior already present at HEAD cannot be credited to the diff");
    assert!(rejection.1.contains("behavior delta"), "{}", rejection.1);
}

#[test]
fn behavior_delta_gate_rejects_different_or_filtered_probe_signatures() {
    let mismatched = verifier_run(vec![
        tool_execution("python -m pytest tests/behavior -q", 0, "8 passed"),
        tool_execution("python -c 'assert behavior(1)'", 0, "fixed"),
        baseline_tool_execution("python -c 'assert behavior(2)'", 1, "AssertionError"),
    ]);
    assert!(
        verifier_evidence_rejection(
            &strict_artifact_goal_requiring_behavior_delta(),
            &mismatched,
        )
        .is_some()
    );

    let filtered_probe = "python -c 'assert behavior(1)' | tail -1";
    let filtered = verifier_run(vec![
        tool_execution("python -m pytest tests/behavior -q", 0, "8 passed"),
        tool_execution(filtered_probe, 0, "fixed"),
        baseline_tool_execution(filtered_probe, 1, "AssertionError"),
    ]);
    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &filtered,)
            .is_some()
    );

    let probe = "python -c 'assert behavior(1), \"KCODER_BEHAVIOR_DELTA\"'";
    let mut different_workdir =
        baseline_tool_execution(probe, 1, "AssertionError: KCODER_BEHAVIOR_DELTA");
    different_workdir.verifier_relative_workdir = Some(PathBuf::from("other-package"));
    let mismatched_workdir = verifier_run(vec![
        tool_execution("python -m pytest tests/behavior -q", 0, "8 passed"),
        tool_execution(probe, 0, "fixed"),
        different_workdir,
    ]);
    assert!(
        verifier_evidence_rejection(
            &strict_artifact_goal_requiring_behavior_delta(),
            &mismatched_workdir,
        )
        .is_some(),
        "candidate and baseline evidence from different relative workdirs must not pair"
    );
}

#[test]
fn behavior_delta_gate_rejects_guard_output_or_textual_claim() {
    let probe = "python -c 'assert behavior()'";
    let guarded = verifier_run(vec![
        tool_execution("python -m pytest tests/behavior -q", 0, "8 passed"),
        tool_execution(probe, 0, "fixed"),
        baseline_tool_execution(
            probe,
            1,
            "Goal Pro verifier baseline guard rejected this command",
        ),
    ]);
    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &guarded,)
            .is_some()
    );

    let mut text_only = verifier_run(vec![tool_execution(
        "python -m pytest tests/behavior -q",
        0,
        "8 passed",
    )]);
    text_only.output = "PASS\nThe same probe exited 0 on candidate and 1 on baseline.".to_string();
    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &text_only,)
            .is_some()
    );
}

#[test]
fn behavior_delta_gate_rejects_environment_or_source_fingerprint_probe() {
    for probe in [
        "python -c 'import os; assert \"baseline\" not in os.getcwd()'",
        "python -c 'from pathlib import Path; assert \"fixed\" in Path(\"app.py\").read_text()'",
    ] {
        let run = verifier_run(vec![
            tool_execution("python -m pytest tests/behavior -q", 0, "8 passed"),
            tool_execution(probe, 0, "candidate fingerprint matched"),
            baseline_tool_execution(probe, 1, "AssertionError"),
        ]);

        assert!(
            verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run,)
                .is_some(),
            "unsafe probe must not prove behavior delta: {probe}"
        );
    }
}

#[test]
fn behavior_delta_gate_django_regression_shape_does_not_credit_baseline_passing_suite() {
    let suite = "python tests/runtests.py validators --parallel 1";
    let probe = "python -c 'from django.core.exceptions import ValidationError; from django.core.validators import URLValidator\ntry:\n URLValidator()(\"file://server/share\")\nexcept ValidationError:\n raise AssertionError(\"KCODER_BEHAVIOR_DELTA\") from None'";
    let run = verifier_run(vec![
        tool_execution(suite, 0, "candidate suite passed"),
        baseline_tool_execution(suite, 0, "baseline suite also passed"),
        tool_execution(probe, 0, "candidate accepts the issue case"),
        baseline_tool_execution(
            probe,
            1,
            "Traceback (most recent call last):\nAssertionError: KCODER_BEHAVIOR_DELTA",
        ),
    ]);

    assert!(
        verifier_evidence_rejection(&strict_artifact_goal_requiring_behavior_delta(), &run,)
            .is_none(),
        "only the issue-specific failing baseline probe, not the passing suite, proves delta"
    );
}

#[test]
fn machine_gate_ignores_rejected_absolute_baseline_test_invocation() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest /tmp/goal/kcoder-goal-baseline-a/workspace/tests/test_widget.py -q",
            1,
            "Goal Pro verifier baseline guard rejected a redundant shell-level baseline path. Set the Bash `workdir` field to the pristine baseline and run the exact same test command used for the candidate.",
        ),
        tool_execution("python -m pytest tests/test_widget.py -q", 0, "12 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_rejects_filtered_or_narrow_only_tests() {
    let filtered = verifier_run(vec![tool_execution(
        "pytest tests | tail -20",
        0,
        "1 passed",
    )]);
    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &filtered).unwrap();
    assert!(rejection.1.contains("filtered output"), "{}", rejection.1);

    let narrow = verifier_run(vec![tool_execution(
        "pytest tests -k regression",
        0,
        "1 passed",
    )]);
    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &narrow).unwrap();
    assert!(rejection.1.contains("narrowly selected"), "{}", rejection.1);
}

#[test]
fn machine_gate_requires_successful_target_test_before_network_waiver() {
    let network_failure = tool_execution(
        "pytest tests",
        1,
        "Network is unreachable while fetching image",
    );
    let rejection = verifier_evidence_rejection(
        &strict_artifact_goal(),
        &verifier_run(vec![network_failure.clone()]),
    )
    .unwrap();
    assert!(
        rejection
            .1
            .contains("no target test completed successfully")
    );

    let run = verifier_run(vec![
        tool_execution("pytest tests/target", 0, "3 passed"),
        network_failure,
    ]);
    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_allows_exact_candidate_failure_reproduced_on_pristine_baseline() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            1,
            "workdir: /tmp/kcoder-goal-worktree-a/workspace\nFAILED tests/test_a.py::test_x\n1 failed",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            1,
            "workdir: /tmp/kcoder-goal-baseline-b/workspace\nFAILED tests/test_a.py::test_x\n1 failed",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_allows_corrected_unittest_selector_after_parent_module_passes() {
    let run = verifier_run(vec![
        tool_execution(
            "python tests/runtests.py forms_tests.tests.test_error_messages.ErrorMessagesTest.test_urlfield -v2 --parallel=1",
            1,
            "ErrorMessagesTest (unittest.loader._FailedTest) ... ERROR\nAttributeError: module 'forms_tests.tests.test_error_messages' has no attribute 'ErrorMessagesTest'\nFAILED (errors=1)",
        ),
        tool_execution(
            "python tests/runtests.py forms_tests.tests.test_error_messages.FormsErrorMessagesTestCase.test_urlfield -v2 --parallel=1",
            0,
            "Ran 1 test\nOK",
        ),
        tool_execution(
            "python tests/runtests.py forms_tests.tests.test_error_messages --parallel=1",
            0,
            "Ran 21 tests\nOK",
        ),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_requires_later_successful_parent_for_bad_unittest_selector() {
    let missing_selector = tool_execution(
        "python tests/runtests.py forms_tests.tests.test_error_messages.ErrorMessagesTest.test_urlfield -v2 --parallel=1",
        1,
        "ErrorMessagesTest (unittest.loader._FailedTest) ... ERROR\nAttributeError: module 'forms_tests.tests.test_error_messages' has no attribute 'ErrorMessagesTest'",
    );
    let sibling_only = verifier_run(vec![
        missing_selector.clone(),
        tool_execution(
            "python tests/runtests.py forms_tests.tests.test_error_messages.FormsErrorMessagesTestCase.test_urlfield -v2 --parallel=1",
            0,
            "Ran 1 test\nOK",
        ),
    ]);
    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &sibling_only).unwrap();
    assert!(rejection.1.contains("failed or unavailable target tests"));

    let parent_before_failure = verifier_run(vec![
        tool_execution(
            "python tests/runtests.py forms_tests.tests.test_error_messages --parallel=1",
            0,
            "Ran 21 tests\nOK",
        ),
        missing_selector,
    ]);
    let rejection =
        verifier_evidence_rejection(&strict_artifact_goal(), &parent_before_failure).unwrap();
    assert!(rejection.1.contains("failed or unavailable target tests"));
}

#[test]
fn machine_gate_allows_corrected_pytest_node_after_module_passes() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/test_widget.py::TestWidget::test_typo -q",
            4,
            "ERROR: not found: tests/test_widget.py::TestWidget::test_typo\n(no match in any of [<UnitTestCase TestWidget>])\nno tests ran",
        ),
        tool_execution("python -m pytest tests/test_widget.py -q", 0, "12 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_does_not_clear_real_collection_or_assertion_failures() {
    for output in [
        "unittest.loader._FailedTest ... ERROR\nImportError: cannot import name 'CandidateSymbol' from 'package'",
        "FAILED tests/test_widget.py::test_widget - AssertionError\n1 failed",
    ] {
        let run = verifier_run(vec![
            tool_execution(
                "python -m pytest tests/test_widget.py::test_widget -q",
                1,
                output,
            ),
            tool_execution("python -m pytest tests/test_widget.py -q", 0, "12 passed"),
        ]);

        let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run).unwrap();
        assert!(rejection.1.contains("failed or unavailable target tests"));
    }
}

#[test]
fn machine_gate_allows_matching_fatal_crash_reproduced_on_pristine_baseline() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            134,
            "workdir: /tmp/kcoder-goal-worktree-a/workspace\nFatal Python error: Aborted\n  File \"/tmp/kcoder-goal-worktree-a/workspace/src/math.py\", line 42 in solve\nkcoder-shell: line 11: 12345 Aborted (core dumped) python -m pytest tests/target -q",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            134,
            "workdir: /tmp/kcoder-goal-baseline-b/workspace\nFatal Python error: Aborted\n  File \"/tmp/kcoder-goal-baseline-b/workspace/src/math.py\", line 42 in solve\nkcoder-shell: line 11: 67890 Aborted (core dumped) python -m pytest tests/target -q",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_matching_fatal_crash_still_requires_a_successful_target_test() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            134,
            "Fatal Python error: Aborted\nAborted (core dumped)",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            134,
            "Fatal Python error: Aborted\nAborted (core dumped)",
        ),
    ]);

    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run).unwrap();
    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(
        rejection
            .1
            .contains("no target test completed successfully")
    );
}

#[test]
fn machine_gate_rejects_different_fatal_crash_fingerprints() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            134,
            "Fatal Python error: Aborted\n  File \"/tmp/kcoder-goal-worktree-a/workspace/src/math.py\", line 42 in solve\nAborted (core dumped)",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            134,
            "Fatal Python error: Aborted\n  File \"/tmp/kcoder-goal-baseline-b/workspace/src/fft.py\", line 9 in transform\nAborted (core dumped)",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run).unwrap();
    assert_eq!(rejection.0, GoalVerificationVerdict::Fail);
    assert!(rejection.1.contains("failed or unavailable target tests"));
}

#[test]
fn machine_gate_rejects_matching_fatal_crash_with_different_exit_codes() {
    let crash = "Fatal Python error: Aborted\n  File \"/tmp/kcoder-goal-worktree-a/workspace/src/math.py\", line 42 in solve\nAborted (core dumped)";
    let baseline_crash = crash.replace("/kcoder-goal-worktree-a/", "/kcoder-goal-baseline-b/");
    let run = verifier_run(vec![
        tool_execution("python -m pytest tests/target -q", 134, crash),
        baseline_tool_execution("python -m pytest tests/target -q", 139, &baseline_crash),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run).unwrap();
    assert_eq!(rejection.0, GoalVerificationVerdict::Fail);
    assert!(rejection.1.contains("failed or unavailable target tests"));
}

#[test]
fn machine_gate_allows_read_only_pytest_retry_to_match_baseline_failure() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            1,
            "FAILED tests/test_a.py::test_x - AssertionError\n1 failed",
        ),
        baseline_tool_execution(
            "PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider tests/target -q",
            1,
            "FAILED tests/test_a.py::test_x - AssertionError\n1 failed",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_ignores_worktree_paths_and_timings_in_matching_baseline_failure() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            1,
            "workdir: /tmp/kcoder-goal-worktree-a/workspace\n/tmp/kcoder-goal-worktree-a/workspace/tests/test_a.py:9: AssertionError\nFAILED tests/test_a.py::test_x - AssertionError\n1 failed in 7.35s",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            1,
            "workdir: /tmp/kcoder-goal-baseline-b/workspace\n/tmp/kcoder-goal-baseline-b/workspace/tests/test_a.py:9: AssertionError\nFAILED tests/test_a.py::test_x - AssertionError\n1 failed in 8.42s",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_normalizes_goal_worktrees_nested_below_harness_tmpdir() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            1,
            "workdir: /tmp/kcoder-swebench/run-a/runtime/kcoder-goal-worktree-a/workspace\nE   AssertionError: /tmp/kcoder-swebench/run-a/runtime/kcoder-goal-worktree-a/workspace/output.json differs\nFAILED tests/test_a.py::test_x - AssertionError\n1 failed in 7.35s",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            1,
            "workdir: /tmp/kcoder-swebench/run-a/runtime/kcoder-goal-baseline-b/workspace\nE   AssertionError: /tmp/kcoder-swebench/run-a/runtime/kcoder-goal-baseline-b/workspace/output.json differs\nFAILED tests/test_a.py::test_x - AssertionError\n1 failed in 8.42s",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_rejects_matching_text_with_different_exit_codes() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            2,
            "FAILED tests/test_a.py::test_x - AssertionError",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            1,
            "FAILED tests/test_a.py::test_x - AssertionError",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run).unwrap();
    assert!(rejection.1.contains("failed or unavailable target tests"));
}

#[test]
fn machine_gate_rejects_nonmatching_baseline_failure() {
    let run = verifier_run(vec![
        tool_execution(
            "python -m pytest tests/target -q",
            1,
            "FAILED tests/test_a.py::test_x\n1 failed",
        ),
        baseline_tool_execution(
            "python -m pytest tests/target -q",
            1,
            "FAILED tests/test_other.py::test_y\n1 failed",
        ),
        tool_execution("python -m pytest tests/focused -q", 0, "3 passed"),
    ]);

    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run).unwrap();
    assert!(rejection.1.contains("failed or unavailable target tests"));
}

#[test]
fn machine_gate_rejects_verifier_workspace_mutation() {
    let mut run = verifier_run(vec![tool_execution(
        "sed -i 's/old/new/' tests/test_issue.py",
        0,
        "",
    )]);
    run.workspace_unchanged = false;
    let rejection = verifier_evidence_rejection(&strict_artifact_goal(), &run).unwrap();

    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(
        rejection
            .1
            .contains("changed the isolated candidate or pristine baseline workspace")
    );
}

#[test]
fn machine_gate_rejects_test_without_authenticated_origin() {
    let mut execution = tool_execution("python -m pytest tests -q", 0, "12 passed");
    execution.test_origin = None;
    let rejection =
        verifier_evidence_rejection(&strict_artifact_goal(), &verifier_run(vec![execution]))
            .expect("unknown workdir provenance must fail closed");

    assert_eq!(rejection.0, GoalVerificationVerdict::Flaky);
    assert!(rejection.1.contains("without authenticated"));
}

#[test]
fn machine_gate_uses_workspace_fingerprint_instead_of_shell_text_guessing() {
    let run = verifier_run(vec![
        tool_execution(
            "git log --all --oneline 2>/dev/null | head -10; git stash list",
            0,
            "abc123 baseline",
        ),
        tool_execution("pytest tests", 0, "3 passed"),
    ]);

    assert!(verifier_evidence_rejection(&strict_artifact_goal(), &run).is_none());
}

#[test]
fn machine_gate_enforces_an_explicit_no_test_edits_contract() {
    let mut goal = strict_artifact_goal();
    goal.objective =
        "Fix the production bug completely. Do not modify tests merely to satisfy it.".to_string();
    let mut run = verifier_run(vec![tool_execution("pytest tests", 0, "3 passed")]);
    run.candidate_changed_paths = vec![
        "sympy/core/add.py".to_string(),
        "sympy/core/tests/test_add.py".to_string(),
    ];

    let rejection = verifier_evidence_rejection(&goal, &run).unwrap();

    assert_eq!(rejection.0, GoalVerificationVerdict::Fail);
    assert!(
        rejection
            .1
            .contains("explicitly forbids test modifications")
    );
    assert!(rejection.1.contains("sympy/core/tests/test_add.py"));
}

#[test]
fn candidate_test_path_does_not_treat_production_test_helpers_as_test_files() {
    assert!(!candidate_test_path("django/test/runner.py"));
    assert!(!candidate_test_path(
        "pylint/testutils/checker_test_case.py"
    ));
    assert!(candidate_test_path("django/tests/backends/test_mysql.py"));
    assert!(candidate_test_path("src/parser.spec.ts"));
}
