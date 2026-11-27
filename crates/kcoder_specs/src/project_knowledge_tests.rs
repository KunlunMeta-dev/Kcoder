use super::*;
use std::fs;

const SOURCE: &str = ".kcoder/specs/specs/core/spec.md";
const SPEC: &str = "# Spec: core\n\n## Purpose\n\nProject contract.\n\n## Requirements\n\n### Requirement: Stable interface\nThe interface MUST return version one.\n\n#### Scenario: Read interface\n- WHEN a task reads it\n- THEN it sees version one\n";

struct Fixture {
    _root: tempfile::TempDir,
    workspace: PathBuf,
    profile: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        fs::create_dir_all(workspace.join(".kcoder/specs/specs/core")).unwrap();
        fs::create_dir(&profile).unwrap();
        fs::write(workspace.join(SOURCE), SPEC).unwrap();
        FolderTrustStore::load(&profile).trust(&workspace).unwrap();
        Self {
            _root: root,
            workspace,
            profile,
        }
    }
    fn access(&self, session: &str) -> ProjectKnowledgeAccess {
        ProjectKnowledgeAccess::open(&self.workspace, &self.profile, Some("account-a"), session)
            .unwrap()
    }
}

#[test]
fn sources_have_exact_revisions_and_separate_authority() {
    let fixture = Fixture::new();
    let paths = [
        SOURCE,
        ".kcoder/specs/changes/draft/specs/core/spec.md",
        ".kcoder/specs/changes/archive/old/proposal.md",
        "README.md",
    ];
    for path in &paths[1..] {
        fs::create_dir_all(fixture.workspace.join(path).parent().unwrap()).unwrap();
        fs::write(fixture.workspace.join(path), "unconfirmed document").unwrap();
    }
    let view = fixture
        .access("task")
        .read(&paths.map(str::to_owned), DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    assert_eq!(
        view.sources
            .iter()
            .map(|source| source.kind)
            .collect::<Vec<_>>(),
        vec![
            ProjectKnowledgeKind::AuthoritativeSpec,
            ProjectKnowledgeKind::CandidateSpec,
            ProjectKnowledgeKind::HistoricalChange,
            ProjectKnowledgeKind::ProjectDocument
        ]
    );
    assert_eq!(view.sources[0].revision, hash(SPEC.as_bytes()));
    assert_eq!(
        view.bytes_read,
        SPEC.len() + 3 * "unconfirmed document".len()
    );
    assert!(
        !fixture
            .workspace
            .join(".kcoder/specs/archive-transaction.lock")
            .exists()
    );
}

#[test]
fn preview_is_unsaved_and_stale_sources_cannot_be_reused() {
    let fixture = Fixture::new();
    let access = fixture.access("task");
    let view = access
        .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    let candidate = SPEC.replace("version one", "version two");
    let proposal = access
        .propose(
            &view,
            &view.scope,
            SOURCE,
            &view.sources[0].revision,
            &candidate,
        )
        .unwrap();
    assert_eq!(proposal.status, "candidate_update");
    assert!(proposal.diff.contains("version two"));
    assert!(proposal.delta.unwrap().contains("## MODIFIED Requirements"));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join(SOURCE)).unwrap(),
        SPEC
    );
    fs::write(
        fixture.workspace.join(SOURCE),
        SPEC.replace("version one", "newer user edit"),
    )
    .unwrap();
    let error = access
        .propose(
            &view,
            &view.scope,
            SOURCE,
            &view.sources[0].revision,
            &candidate,
        )
        .unwrap_err();
    assert!(error.to_string().contains("stale_revision"));
    assert!(
        fs::read_to_string(fixture.workspace.join(SOURCE))
            .unwrap()
            .contains("newer user edit")
    );
    fs::remove_file(fixture.workspace.join(SOURCE)).unwrap();
    assert!(
        access
            .propose(
                &view,
                &view.scope,
                SOURCE,
                &view.sources[0].revision,
                &candidate
            )
            .is_err()
    );
}

#[test]
fn candidate_guards_cover_edits_before_change_creation_and_after_review() {
    let fixture = Fixture::new();
    crate::init(&fixture.workspace).unwrap();
    let access = fixture.access("task");
    let view = access
        .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    let replacement = SPEC.replace("version one", "candidate version");
    let preview = access
        .propose(
            &view,
            &view.scope,
            SOURCE,
            &view.sources[0].revision,
            &replacement,
        )
        .unwrap();
    let base = preview.change_base.as_ref().unwrap();
    let user_version = SPEC.replace("version one", "newer user version");
    fs::write(fixture.workspace.join(SOURCE), &user_version).unwrap();
    assert!(
        access
            .new_change("too-late", None, base)
            .unwrap_err()
            .to_string()
            .contains("stale_revision")
    );
    assert!(
        !fixture
            .workspace
            .join(".kcoder/specs/changes/too-late")
            .exists()
    );

    fs::write(fixture.workspace.join(SOURCE), SPEC).unwrap();
    let change = access.new_change("guarded", None, base).unwrap();
    fs::write(change.join("specs/core/spec.md"), preview.delta.unwrap()).unwrap();
    fs::write(change.join("tasks.md"), "- [x] Reviewed candidate\n").unwrap();
    crate::sync(&fixture.workspace, "guarded").unwrap();
    let retained = crate::fingerprint::load_base_snapshot(&change).unwrap();
    assert_eq!(retained.knowledge_sources, base.sources);
    let base_before = fs::read(change.join(".base.json")).unwrap();
    fs::write(fixture.workspace.join(SOURCE), &user_version).unwrap();
    let errors = crate::check_change(&crate::specs_dir_for(&fixture.workspace), &change).unwrap();
    assert!(errors.iter().any(|error| error.contains("stale_revision")));
    assert!(
        !crate::apply_preflight(&fixture.workspace, "guarded")
            .unwrap()
            .ok
    );
    assert!(
        crate::sync(&fixture.workspace, "guarded")
            .unwrap_err()
            .to_string()
            .contains("stale_revision")
    );
    assert_eq!(fs::read(change.join(".base.json")).unwrap(), base_before);
    assert!(crate::archive(&fixture.workspace, "guarded").is_err());
    assert_eq!(
        fs::read_to_string(fixture.workspace.join(SOURCE)).unwrap(),
        user_version
    );
}

#[test]
fn publication_guards_bind_the_exact_base_and_source_bytes_until_commit() {
    let fixture = Fixture::new();
    crate::init(&fixture.workspace).unwrap();
    let access = fixture.access("task");
    let view = access
        .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    let replacement = SPEC.replace("version one", "candidate version");
    let preview = access
        .propose(
            &view,
            &view.scope,
            SOURCE,
            &view.sources[0].revision,
            &replacement,
        )
        .unwrap();
    let change = access
        .new_change(
            "publication-guard",
            None,
            preview.change_base.as_ref().unwrap(),
        )
        .unwrap();
    fs::write(change.join("specs/core/spec.md"), preview.delta.unwrap()).unwrap();
    let root = crate::specs_dir_for(&fixture.workspace);
    let prepared = crate::merge::prepare_change(&root, &change).unwrap();
    let base = fs::read(change.join(".base.json")).unwrap();
    let mut edited_base = base.clone();
    edited_base.push(b'\n');
    fs::write(change.join(".base.json"), edited_base).unwrap();
    assert!(crate::archive_transaction::commit(&root, prepared, None).is_err());
    assert_eq!(
        fs::read_to_string(fixture.workspace.join(SOURCE)).unwrap(),
        SPEC
    );
    fs::write(change.join(".base.json"), base).unwrap();
    let prepared = crate::merge::prepare_change(&root, &change).unwrap();
    let user_version = SPEC.replace("version one", "newer user version");
    fs::write(fixture.workspace.join(SOURCE), &user_version).unwrap();
    assert!(crate::archive_transaction::commit(&root, prepared, None).is_err());
    assert!(
        crate::merge::prepare_change(&root, &change)
            .unwrap_err()
            .to_string()
            .contains("stale_revision")
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace.join(SOURCE)).unwrap(),
        user_version
    );
}

#[test]
fn delta_candidates_do_not_silently_drop_existing_purpose_changes() {
    let fixture = Fixture::new();
    let access = fixture.access("task");
    let view = access
        .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    let replacement = SPEC.replace("Project contract.", "Different established purpose.");
    assert!(
        access
            .propose(
                &view,
                &view.scope,
                SOURCE,
                &view.sources[0].revision,
                &replacement
            )
            .unwrap_err()
            .to_string()
            .contains("purpose_requires_manual_reconciliation")
    );
    assert_eq!(
        fs::read_to_string(fixture.workspace.join(SOURCE)).unwrap(),
        SPEC
    );
    let initial = SPEC.replace("Project contract.", "");
    let delta = proposed_delta(&initial, SPEC).unwrap();
    assert_eq!(
        crate::parse_delta(&delta).unwrap().purpose.as_deref(),
        Some("Project contract.")
    );
}

#[test]
fn scope_changes_and_trust_revocation_reject_old_candidates() {
    let fixture = Fixture::new();
    let old = fixture.access("task-one");
    let view = old
        .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    for access in [
        fixture.access("task-two"),
        ProjectKnowledgeAccess::open(
            &fixture.workspace,
            &fixture.profile,
            Some("account-b"),
            "task-one",
        )
        .unwrap(),
    ] {
        assert!(
            access
                .propose(&view, &view.scope, SOURCE, &view.sources[0].revision, SPEC)
                .unwrap_err()
                .to_string()
                .contains("scope_changed")
        );
    }
    let other_profile = fixture._root.path().join("other-profile");
    fs::create_dir(&other_profile).unwrap();
    FolderTrustStore::load(&other_profile)
        .trust(&fixture.workspace)
        .unwrap();
    let other = ProjectKnowledgeAccess::open(
        &fixture.workspace,
        &other_profile,
        Some("account-a"),
        "task-one",
    )
    .unwrap();
    assert!(
        other
            .propose(&view, &view.scope, SOURCE, &view.sources[0].revision, SPEC)
            .is_err()
    );
    FolderTrustStore::load(&fixture.profile)
        .never(&fixture.workspace)
        .unwrap();
    if !FolderTrustStore::trust_all_from_environment() {
        assert!(
            old.read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
                .unwrap_err()
                .to_string()
                .contains("untrusted")
        );
    }
}

#[test]
fn budgets_paths_and_cancellation_never_return_partial_facts() {
    let fixture = Fixture::new();
    let access = fixture.access("task");
    for path in [
        "../README.md",
        "/tmp/README.md",
        "docs/../README.md",
        "docs\\README.md",
        ".kcoder/settings.md",
        "secret.json",
        "docs//README.md",
    ] {
        assert!(
            access
                .read(&[path.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
                .is_err(),
            "{path}"
        );
    }
    assert!(access.read(&[SOURCE.into()], 1, || true).is_err());
    assert!(
        access
            .read(&[SOURCE.into()], MAX_KNOWLEDGE_BYTES + 1, || true)
            .is_err()
    );
    assert!(
        access
            .read(&vec![SOURCE.into(); 9], MAX_KNOWLEDGE_BYTES, || true)
            .is_err()
    );
    assert!(
        access
            .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || false)
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn linked_files_and_directory_aliases_are_not_knowledge_authority() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture._root.path().join("outside.md");
    fs::write(&outside, "outside secret").unwrap();
    symlink(&outside, fixture.workspace.join("linked.md")).unwrap();
    fs::hard_link(&outside, fixture.workspace.join("hard.md")).unwrap();
    symlink(fixture._root.path(), fixture.workspace.join("alias")).unwrap();
    let access = fixture.access("task");
    for path in ["linked.md", "hard.md", "alias/outside.md"] {
        assert!(
            access
                .read(&[path.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
                .is_err()
        );
    }
}

#[test]
fn existing_change_review_and_archive_publish_the_next_tasks_current_knowledge() {
    let fixture = Fixture::new();
    crate::init(&fixture.workspace).unwrap();
    crate::config::config_set(
        &crate::specs_dir_for(&fixture.workspace),
        "schema",
        "spec-driven-superpowers",
    )
    .unwrap();
    let access = fixture.access("first-task");
    let before = access
        .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    let replacement = SPEC.replace("version one", "version two");
    let preview = access
        .propose(
            &before,
            &before.scope,
            SOURCE,
            &before.sources[0].revision,
            &replacement,
        )
        .unwrap();
    let change = access
        .new_change(
            "knowledge-update",
            Some("Reviewed interface update".into()),
            preview.change_base.as_ref().unwrap(),
        )
        .unwrap();
    fs::write(change.join("specs/core/spec.md"), preview.delta.unwrap()).unwrap();
    fs::write(
        change.join("tasks.md"),
        "- [x] 1.1 Confirm interface and update its owning spec\n",
    )
    .unwrap();
    fs::write(change.join("plan.md"), "# Plan\n\n## Covers\n\n- 1.1\n").unwrap();
    fs::write(
        change.join("review.md"),
        "# Review\n\n## Readiness Decision\n\nready\n\n## Blocked By\n\nnone\n",
    )
    .unwrap();
    assert!(
        crate::validate(&fixture.workspace, Some("knowledge-update"))
            .unwrap()
            .is_empty()
    );
    let review = crate::review(&fixture.workspace, "knowledge-update", Some("HEAD")).unwrap();
    assert!(review.deltas[0].1.contains("version two"));
    crate::review_writeback(
        &fixture.workspace,
        "knowledge-update",
        crate::SpecReviewWritebackRecord {
            review_status: "approved".into(),
            findings_summary: vec!["User confirmed the candidate interface contract.".into()],
            ..Default::default()
        },
    )
    .unwrap();
    crate::record_verification(
        &fixture.workspace,
        "knowledge-update",
        crate::SpecVerificationRecord {
            completion_decision: "complete".into(),
            evidence: vec!["offline contract fixture".into()],
            ..Default::default()
        },
    )
    .unwrap();
    crate::archive(&fixture.workspace, "knowledge-update").unwrap();
    let next = fixture
        .access("next-task")
        .read(&[SOURCE.into()], DEFAULT_KNOWLEDGE_BYTES, || true)
        .unwrap();
    assert_eq!(
        next.sources[0].kind,
        ProjectKnowledgeKind::AuthoritativeSpec
    );
    assert!(next.sources[0].content.contains("version two"));
    assert_ne!(before.sources[0].revision, next.sources[0].revision);
    assert!(
        access
            .propose(
                &before,
                &before.scope,
                SOURCE,
                &before.sources[0].revision,
                &replacement
            )
            .unwrap_err()
            .to_string()
            .contains("stale_revision")
    );
}
