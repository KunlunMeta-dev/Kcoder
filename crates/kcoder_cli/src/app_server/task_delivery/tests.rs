use super::*;

async fn fixture_git(cwd: &Path, args: &[&str]) {
    let result = run_git_command(cwd, args, 4096, Duration::from_secs(10))
        .await
        .unwrap();
    assert!(result.success, "git {args:?}: {}", result.stderr);
}
async fn fixture() -> (tempfile::TempDir, tempfile::TempDir) {
    let workspace = tempfile::tempdir().unwrap();
    let session = tempfile::tempdir().unwrap();
    let cwd = workspace.path();
    fixture_git(cwd, &["init", "-b", "main"]).await;
    fixture_git(cwd, &["config", "user.name", "Delivery Fixture"]).await;
    fixture_git(cwd, &["config", "user.email", "delivery@example.invalid"]).await;
    fixture_git(
        cwd,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/owned-test.git",
        ],
    )
    .await;
    std::fs::write(cwd.join("readme.txt"), "baseline\n").unwrap();
    fixture_git(cwd, &["add", "readme.txt"]).await;
    fixture_git(
        cwd,
        &["-c", "commit.gpgsign=false", "commit", "-m", "baseline"],
    )
    .await;
    fixture_git(cwd, &["checkout", "-b", "delivery-fixture"]).await;
    std::fs::write(cwd.join("readme.txt"), "actual branch change\n").unwrap();
    fixture_git(cwd, &["add", "readme.txt"]).await;
    fixture_git(
        cwd,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "Implement actual branch change",
        ],
    )
    .await;
    (workspace, session)
}
fn recipient() -> p::TaskDeliveryRecipient {
    p::TaskDeliveryRecipient {
        task_id: "delivery-task".into(),
        thread_id: "delivery-source-thread".into(),
        device_id: "delivery-target".into(),
    }
}
fn owner_address() -> p::TaskDeliveryRecipient {
    p::TaskDeliveryRecipient {
        task_id: "delivery-owner-task".into(),
        thread_id: "delivery-thread".into(),
        device_id: "delivery-target".into(),
    }
}
fn prepare_params() -> p::TaskDeliveryPrepareParams {
    p::TaskDeliveryPrepareParams {
        thread_id: "delivery-thread".into(),
        owner: owner_address(),
        base_branch: "main".into(),
        comparison_id: None,
    }
}

#[tokio::test]
async fn actual_git_preparation_and_lost_intent_receipt_do_not_publish() {
    let (workspace, session) = fixture().await;
    let result = prepare(
        workspace.path(),
        session.path(),
        &prepare_params(),
        &[],
        &recipient(),
    )
    .await
    .unwrap();
    assert_eq!(result.source.repository, "fixture/owned-test");
    assert_eq!(result.source.branch, "delivery-fixture");
    assert_eq!(result.draft.title, "Implement actual branch change");
    assert!(result.draft.body.contains("readme.txt"));
    assert!(result.draft.body.contains(&result.source.head_commit));
    assert!(!result.source.dirty);
    assert!(result.request.is_none());
    assert_eq!(result.status.push_state, "unknown");
    assert_eq!(result.status.ci_state, p::TaskDeliveryCiState::Unknown);
    assert_eq!(
        prepare(
            workspace.path(),
            session.path(),
            &prepare_params(),
            &[],
            &recipient()
        )
        .await
        .unwrap()
        .delivery_id,
        result.delivery_id
    );
    let mut params = p::TaskDeliveryRequestParams {
        thread_id: result.thread_id.clone(),
        owner: owner_address(),
        delivery_id: result.delivery_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        title: "User-edited title".into(),
        body: "User-edited body".into(),
    };
    let original = request(workspace.path(), session.path(), &params, &recipient())
        .await
        .unwrap();
    let replay = request(workspace.path(), session.path(), &params, &recipient())
        .await
        .unwrap();
    assert_eq!(
        original.request.as_ref().unwrap().prompt,
        replay.request.as_ref().unwrap().prompt
    );
    let retained = store::Store::open(session.path())
        .unwrap()
        .load(&params.thread_id, &params.delivery_id)
        .unwrap();
    assert_eq!(
        retained.result.request.unwrap().request_id,
        params.request_id
    );
    assert!(
        original
            .request
            .unwrap()
            .prompt
            .contains("normal target/tool permissions")
    );
    params.request_id = uuid::Uuid::new_v4().to_string();
    assert!(
        request(workspace.path(), session.path(), &params, &recipient())
            .await
            .unwrap_err()
            .to_string()
            .contains("delivery_request_unresolved")
    );
    assert!(
        git(
            workspace.path(),
            &["rev-parse", "--verify", "@{upstream}"],
            1024
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn changed_head_or_dirty_worktree_cannot_reuse_a_prepared_request_or_green_ci() {
    let (workspace, session) = fixture().await;
    let result = prepare(
        workspace.path(),
        session.path(),
        &prepare_params(),
        &[],
        &recipient(),
    )
    .await
    .unwrap();
    std::fs::write(
        workspace.path().join("readme.txt"),
        "new uncommitted change\n",
    )
    .unwrap();
    let params = p::TaskDeliveryRequestParams {
        thread_id: result.thread_id.clone(),
        owner: owner_address(),
        delivery_id: result.delivery_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        title: "title".into(),
        body: "body".into(),
    };
    assert!(
        request(workspace.path(), session.path(), &params, &recipient())
            .await
            .is_err()
    );
    let stale = read(
        workspace.path(),
        session.path(),
        &p::TaskDeliveryReadParams {
            thread_id: result.thread_id.clone(),
            owner: owner_address(),
            delivery_id: result.delivery_id.clone(),
        },
        &recipient(),
    )
    .await
    .unwrap();
    assert!(stale.status.source_changed);
    assert_eq!(stale.status.ci_state, p::TaskDeliveryCiState::Unknown);
    assert!(stale.status.checks.is_empty());
    fixture_git(workspace.path(), &["add", "readme.txt"]).await;
    fixture_git(
        workspace.path(),
        &["-c", "commit.gpgsign=false", "commit", "-m", "new commit"],
    )
    .await;
    assert!(
        request(workspace.path(), session.path(), &params, &recipient())
            .await
            .is_err()
    );
    let new = prepare(
        workspace.path(),
        session.path(),
        &prepare_params(),
        &[],
        &recipient(),
    )
    .await
    .unwrap();
    assert_ne!(new.delivery_id, result.delivery_id);
    assert_ne!(new.source.head_commit, result.source.head_commit);
    assert_eq!(new.status.ci_state, p::TaskDeliveryCiState::Unknown);
}

#[tokio::test]
async fn native_store_rejects_wrong_thread_and_conflicting_edited_intent() {
    let (workspace, session) = fixture().await;
    let result = prepare(
        workspace.path(),
        session.path(),
        &prepare_params(),
        &[],
        &recipient(),
    )
    .await
    .unwrap();
    assert!(
        store::Store::open(session.path())
            .unwrap()
            .load("another-thread", &result.delivery_id)
            .is_err()
    );
    let mut params = p::TaskDeliveryRequestParams {
        thread_id: result.thread_id.clone(),
        owner: owner_address(),
        delivery_id: result.delivery_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        title: "title".into(),
        body: "body".into(),
    };
    request(workspace.path(), session.path(), &params, &recipient())
        .await
        .unwrap();
    params.body = "conflicting edit".into();
    assert!(
        request(workspace.path(), session.path(), &params, &recipient())
            .await
            .is_err()
    );
    params.delivery_id = "../outside".into();
    assert!(
        request(workspace.path(), session.path(), &params, &recipient())
            .await
            .is_err()
    );
}

#[test]
fn github_projection_is_bounded_and_commit_exact_without_contacting_github() {
    assert_eq!(
        github::repository("git@github.com:owner/repo.git"),
        Some("owner/repo".into())
    );
    for bad in [
        "https://token@github.com/owner/repo",
        "https://gitlab.com/owner/repo",
        "https://github.com/owner/repo?token=x",
        "https://github.com/../repo",
    ] {
        assert!(github::repository(bad).is_none());
    }
    let source = p::TaskDeliverySource {
        repository: "owner/repo".into(),
        branch: "branch".into(),
        head_commit: "a".repeat(40),
        base_branch: "main".into(),
        base_commit: "b".repeat(40),
        diff_sha256: "c".repeat(64),
        working_sha256: "d".repeat(64),
        dirty: false,
    };
    let runs = json!({"total_count":2,"check_runs":[{"id":123,"head_sha":source.head_commit,"name":"fixture-check","status":"completed","conclusion":"failure","html_url":"https://github.com/owner/repo/actions/runs/1"}]});
    let statuses = json!({"sha":source.head_commit,"total_count":0,"statuses":[]});
    let (checks, truncated) = github::project_checks(&source, &runs, &statuses).unwrap();
    assert!(truncated);
    assert_eq!(checks[0].state, p::TaskDeliveryCiState::Failed);
    assert_eq!(checks[0].check_id, "check:123");
    let mut wrong = runs;
    wrong["check_runs"][0]["head_sha"] = json!("e".repeat(40));
    assert!(github::project_checks(&source, &wrong, &statuses).is_err());
}

#[tokio::test]
async fn preparation_after_a_lost_request_receipt_recovers_the_original_identity() {
    let (workspace, session) = fixture().await;
    let original = prepare(
        workspace.path(),
        session.path(),
        &prepare_params(),
        &[],
        &recipient(),
    )
    .await
    .unwrap();
    request(
        workspace.path(),
        session.path(),
        &p::TaskDeliveryRequestParams {
            thread_id: original.thread_id.clone(),
            owner: owner_address(),
            delivery_id: original.delivery_id.clone(),
            request_id: uuid::Uuid::new_v4().to_string(),
            title: "title".into(),
            body: "body".into(),
        },
        &recipient(),
    )
    .await
    .unwrap();
    std::fs::write(workspace.path().join("readme.txt"), "another commit\n").unwrap();
    fixture_git(workspace.path(), &["add", "readme.txt"]).await;
    fixture_git(
        workspace.path(),
        &["-c", "commit.gpgsign=false", "commit", "-m", "new source"],
    )
    .await;
    let recovered = prepare(
        workspace.path(),
        session.path(),
        &prepare_params(),
        &[],
        &recipient(),
    )
    .await
    .unwrap();
    assert_eq!(recovered.delivery_id, original.delivery_id);
    assert!(recovered.status.source_changed);
    assert!(recovered.request.is_some());
    assert_eq!(recovered.status.ci_state, p::TaskDeliveryCiState::Unknown);
}

#[tokio::test]
async fn comparison_owner_cannot_supply_validation_evidence_for_the_selected_source_task() {
    let (workspace, session) = fixture().await;
    let source_thread = recipient().thread_id;
    let evidence = kcoder_app_protocol::TurnReviewEvidence {
        version: 1,
        evidence_id: hex_sha256(format!("review\0{source_thread}\0turn-b\0attempt-b").as_bytes()),
        thread_id: source_thread,
        turn_id: "turn-b".into(),
        attempt_id: "attempt-b".into(),
        state: kcoder_app_protocol::ReviewEvidenceState::Settled,
        observations: vec![],
        omitted_count: 0,
    };
    let mut forged_owner = evidence.clone();
    forged_owner.thread_id = prepare_params().thread_id;
    forged_owner.evidence_id = "invalid-owner-claim".into();
    let result = prepare(
        workspace.path(),
        session.path(),
        &prepare_params(),
        &[forged_owner, evidence.clone()],
        &recipient(),
    )
    .await
    .unwrap();
    assert_eq!(result.native_evidence_ids, vec![evidence.evidence_id]);
    assert_ne!(result.thread_id, result.recipient.thread_id);
    let wrong = p::TaskDeliveryRecipient {
        thread_id: result.thread_id.clone(),
        ..recipient()
    };
    let params = p::TaskDeliveryRequestParams {
        thread_id: result.thread_id.clone(),
        owner: owner_address(),
        delivery_id: result.delivery_id.clone(),
        request_id: uuid::Uuid::new_v4().to_string(),
        title: "title".into(),
        body: "body".into(),
    };
    assert!(
        request(workspace.path(), session.path(), &params, &wrong)
            .await
            .is_err()
    );
}

#[test]
fn skipped_and_neutral_checks_never_count_as_a_green_ci_result() {
    use p::TaskDeliveryCiState as C;
    let mut check = p::TaskDeliveryCheck {
        check_id: "check:1".into(),
        name: "fixture".into(),
        head_commit: "a".repeat(40),
        state: C::Skipped,
        details_url: None,
    };
    assert_eq!(github::ci(&[check.clone()], false), C::Unknown);
    check.state = C::Neutral;
    assert_eq!(github::ci(&[check.clone()], false), C::Unknown);
    check.state = C::Passed;
    assert_eq!(github::ci(&[check.clone()], false), C::Passed);
    assert_eq!(github::ci(&[check], true), C::Unknown);
}

#[test]
fn github_pull_request_links_allow_only_owner_and_repository_case_variants() {
    for (repository, url) in [
        ("owner/repo", "https://github.com/Owner/Repo/pull/42"),
        ("Owner/Repo", "https://github.com/owner/repo/pull/42"),
        (
            "owner/repo.git",
            "https://github.com/Owner/Repo.git/pull/42",
        ),
    ] {
        assert!(
            github::valid_pull_request_url(url, repository, 42),
            "canonical link rejected: {url}"
        );
    }
}

#[test]
fn github_pull_request_links_reject_other_url_and_number_identities() {
    for url in [
        "https://github.com.evil.example/Owner/Repo/pull/42",
        "https://github.com@evil.example/Owner/Repo/pull/42",
        "https://user:secret@github.com/Owner/Repo/pull/42",
        "https://github.com:443/Owner/Repo/pull/42",
        "https://GITHUB.COM/Owner/Repo/pull/42",
        "http://github.com/Owner/Repo/pull/42",
        "https://github.com/OwnerExtra/Repo/pull/42",
        "https://github.com/Owner/RepoExtra/pull/42",
        "https://github.com/Owner/Repo.git/pull/42",
        "https://github.com/Owner/Repo/Pull/42",
        "https://github.com/Owner/Repo/pull/43",
        "https://github.com/Owner/Repo/pull/042",
        "https://github.com/Owner/Repo/pull/+42",
        "https://github.com/Owner/Repo/pull/42/",
        "https://github.com/Owner/Repo/pull/42/files",
        "https://github.com/Owner/Repo/pull/42?diff=unified",
        "https://github.com/Owner/Repo/pull/42#discussion",
        "https://github.com/Owner/%52epo/pull/42",
        "https://github.com/Owner/Repo/pull/41/../42",
        "https://github.com/Owner/Repo/pull/42\n",
    ] {
        assert!(
            !github::valid_pull_request_url(url, "owner/repo", 42),
            "unbound link accepted: {url:?}"
        );
    }
    assert!(!github::valid_pull_request_url(
        "https://github.com/owner/repo/pull/0",
        "owner/repo",
        0
    ));
    assert!(!github::valid_pull_request_url(
        "https://github.com/owner/repo/pull/42",
        "owner/repo/extra",
        42
    ));
}

#[test]
fn github_pr_source_binding_rejects_wrong_base_with_identical_head_and_request_marker() {
    let source = p::TaskDeliverySource {
        repository: "owner/repo".into(),
        branch: "Feature".into(),
        head_commit: "a".repeat(40),
        base_branch: "main".into(),
        base_commit: "b".repeat(40),
        diff_sha256: "c".repeat(64),
        working_sha256: "d".repeat(64),
        dirty: false,
    };
    let right = json!({"headRepositoryOwner":{"login":"Owner"},"headRepository":{"name":"Repo"},
        "headRefName":"Feature","baseRefName":"main","headRefOid":source.head_commit,
        "body":"<!-- kcoder-delivery:same-request -->"});
    assert!(github::pull_request_matches_source(&source, &right));
    let mut wrong = right.clone();
    wrong["baseRefName"] = json!("release");
    assert_eq!(wrong["headRefOid"], right["headRefOid"]);
    assert_eq!(wrong["body"], right["body"]);
    assert!(!github::pull_request_matches_source(&source, &wrong));
    wrong["baseRefName"] = json!("Main");
    assert!(!github::pull_request_matches_source(&source, &wrong));
    wrong["baseRefName"] = json!("main");
    wrong["headRefName"] = json!("feature");
    assert!(!github::pull_request_matches_source(&source, &wrong));
    wrong["headRefName"] = json!("Feature");
    wrong["headRefOid"] = json!("e".repeat(40));
    assert!(!github::pull_request_matches_source(&source, &wrong));
    wrong["headRefOid"] = json!(source.head_commit);
    wrong.as_object_mut().unwrap().remove("baseRefName");
    assert!(!github::pull_request_matches_source(&source, &wrong));
}
