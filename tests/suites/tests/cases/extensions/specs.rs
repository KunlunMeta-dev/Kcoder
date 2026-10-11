use kcoder_specs::{
    SpecReviewWritebackRecord, SpecVerificationRecord, apply_preflight, archive,
    config::config_set, init, list_changes, new_change, record_verification, review_writeback,
    status, validate, verify,
};
use kcoder_test_harness::{WorkspaceFixture, workspace_root};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

fn fixture_root(name: &str) -> PathBuf {
    workspace_root()
        .expect("应解析当前 KCoder 工作区")
        .join("tests/fixtures")
        .join(name)
}

#[test]
fn superpowers_change_runs_full_public_lifecycle_and_archives_requirement() {
    let temporary = tempfile::tempdir().expect("应创建临时项目");
    let project = temporary.path();
    let specs_dir = init(project).expect("应初始化 specs 子系统");
    config_set(&specs_dir, "schema", "spec-driven-superpowers").expect("应设置 superpowers schema");
    let change = new_change(project, "answer-contract", Some("回答契约".to_string()))
        .expect("应创建 change");

    fs::write(
        change.join("specs/core/spec.md"),
        r#"# Delta: core

## ADDED Requirements

### Requirement: deterministic answer

The library MUST return the deterministic answer.

#### Scenario: returns the answer

- **WHEN** the caller requests the answer
- **THEN** the library returns 42
"#,
    )
    .expect("应写入合法 delta");
    fs::write(
        change.join("tasks.md"),
        "# Tasks\n\n- [ ] 1.1 Implement deterministic answer\n- [x] 2.1 Design complete\n- [x] 3.1 Tests prepared\n- [x] 4.1 Verification planned\n",
    )
    .expect("应写入 tasks");
    fs::write(
        change.join("plan.md"),
        "# Plan\n\n## Covers\n\n- 1.1\n\n## Validation Per Step\n\n1. Run deterministic answer tests.\n\n## Completion Verification\n\nRetain the exact command and passing evidence.\n",
    )
    .expect("应写入 plan");
    fs::write(
        change.join("review.md"),
        "# Review\n\n## Readiness Decision\n\nready\n\n## Verification Mode\n\nretained-required\n\n## Review Status\n\nrequested\n\n## Blocked By\n\nnone\n\n## Validation Focus\n\n- Run deterministic answer tests.\n",
    )
    .expect("应写入 ready review");

    assert_eq!(
        validate(project, Some("answer-contract")).expect("validate 应执行"),
        Vec::<String>::new()
    );
    let preflight = apply_preflight(project, "answer-contract").expect("preflight 应执行");
    assert!(
        preflight.ok,
        "unexpected blockers: {:?}",
        preflight.blockers
    );
    assert_eq!(preflight.task_coverage.open_task_ids, ["1.1"]);
    assert!(preflight.task_coverage.uncovered_task_ids.is_empty());

    let writeback = review_writeback(
        project,
        "answer-contract",
        SpecReviewWritebackRecord {
            review_status: "findings-received".to_string(),
            findings_summary: vec!["accepted: retain explicit command evidence".to_string()],
            accepted_followups: vec!["Retain explicit command evidence".to_string()],
            verification_notes: vec!["Record the exact cargo test command".to_string()],
        },
    )
    .expect("review finding 应写回 canonical artifacts");
    assert!(writeback.tasks_updated);
    assert!(writeback.plan_updated);
    assert!(writeback.verification_updated);
    let tasks_path = change.join("tasks.md");
    let tasks = fs::read_to_string(&tasks_path).expect("应读取写回 tasks");
    assert!(tasks.contains("- [ ] 5.1 Retain explicit command evidence"));
    let plan = fs::read_to_string(change.join("plan.md")).expect("应读取写回 plan");
    assert!(plan.contains("## Review Follow-Up"));
    assert!(plan.contains("Retain explicit command evidence"));
    let verification =
        fs::read_to_string(change.join("verification.md")).expect("应读取写回 verification");
    assert!(verification.contains("Record the exact cargo test command"));

    fs::write(
        &tasks_path,
        tasks
            .replace("- [ ] 1.1", "- [x] 1.1")
            .replace("- [ ] 5.1", "- [x] 5.1"),
    )
    .expect("应完成原任务和 review follow-up");
    record_verification(
        project,
        "answer-contract",
        SpecVerificationRecord {
            completion_decision: "complete".to_string(),
            commands_run: vec!["cargo test -p fixture_rust_project: passed".to_string()],
            manual_checks: vec!["SpecStatus 无 blocker".to_string()],
            evidence: vec!["returns_the_answer passed".to_string()],
            residual_risks: vec!["none".to_string()],
        },
    )
    .expect("应记录完成证据");

    let summary = status(project, "answer-contract").expect("应读取 change 状态");
    assert!(summary.tasks_complete);
    assert!(summary.drift_errors.is_empty());
    assert!(summary.apply_blockers.is_empty());
    assert!(summary.completion_blockers.is_empty());
    assert_eq!(
        summary.verification.completion_decision.as_deref(),
        Some("complete")
    );

    let archived = archive(project, "answer-contract").expect("无 blocker 的 change 应归档");
    assert!(
        !list_changes(project)
            .expect("应列出 active changes")
            .contains(&"answer-contract".to_string())
    );
    let metadata = fs::read_to_string(archived.join(".spec.yaml")).expect("应读取归档 metadata");
    assert!(metadata.contains("status: archived"));
    let authoritative = fs::read_to_string(specs_dir.join("specs/core/spec.md"))
        .expect("应读取 authoritative core spec");
    assert!(authoritative.contains("### Requirement: deterministic answer"));
    assert!(authoritative.contains("#### Scenario: returns the answer"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn verify_matches_real_cargo_test_listing_from_materialized_fixture() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let temporary = tempfile::tempdir().expect("应创建临时 fixture 根");
        let fixture = WorkspaceFixture::open(fixture_root("rust-project"))
            .expect("rust-project fixture 应合法");
        assert_eq!(fixture.metadata().version, "2");
        let materialized = fixture
            .materialize(temporary.path().join("workspace"))
            .expect("应物化 rust fixture");
        let project = materialized.root;
        let specs_dir = init(&project).expect("应初始化物化项目 specs");
        fs::write(
            specs_dir.join("specs/core/spec.md"),
            r#"# Spec: core

## Purpose

Define the fixture answer contract.

## Requirements

### Requirement: deterministic answer

The library MUST return the answer.

#### Scenario: returns the answer

- **WHEN** the answer function is called
- **THEN** it returns 42
"#,
        )
        .expect("应写入 authoritative scenario");

        let report = tokio::task::spawn_blocking(move || verify(&project))
            .await
            .expect("verify blocking task 不应 panic")
            .expect("公开 verify 应执行成功");
        assert_eq!(report.covered, ["specs/core: returns the answer"]);
        assert!(report.gaps.is_empty(), "unexpected gaps: {:?}", report.gaps);
    })
    .await
    .expect("真实 cargo test listing 验证总时限为 60 秒");
}
