use super::*;
use kcoder_types::integrations::core::IntegrationNullable;
use kcoder_types::integrations::knowledge::{MemoryOrigin, MemoryProvenance};
fn fixture_root() -> Result<tempfile::TempDir> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    Ok(root)
}
fn scope(account: &str) -> IntegrationScope {
    IntegrationScope {
        account_id: account.into(),
        target_id: "local".into(),
        workspace_id: IntegrationNullable::Value("project-a".into()),
        identity_generation: "identity-1".into(),
        target_revision: "target-1".into(),
        organization_id: None,
    }
}
fn proposal(origin: MemoryOrigin) -> MemoryProposal {
    MemoryProposal {
        title: "报告格式".into(),
        content: "报告先给结论，再列来源。".into(),
        category: "preference".into(),
        origin,
        provenance: vec![MemoryProvenance {
            kind: "explicit_user_message".into(),
            source_id: "message-1".into(),
            source_revision: "revision-1".into(),
            description: "Synthetic audit input".into(),
        }],
        valid_until_ms: None,
    }
}
#[test]
fn held_parent_creation_never_reopens_a_replaced_profile_path() -> Result<()> {
    let root = fixture_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let profile = parent.create_private_child(OsStr::new("profile"))?;
    std::fs::rename(root.path().join("profile"), root.path().join("old-profile"))?;
    parent.create_private_child(OsStr::new("profile"))?;
    MemoryReviewStore::create_in(&profile, OsStr::new("private"), &scope("alice"))?;
    assert!(root.path().join("old-profile/private").is_dir());
    assert!(!root.path().join("profile/private").exists());
    assert!(
        MemoryReviewStore::open_in(&profile, OsStr::new("private"), &scope("alice"))?
            .list(None, true)?
            .items
            .is_empty()
    );
    Ok(())
}

#[test]
fn held_parent_open_is_read_only_and_rejects_path_escape() -> Result<()> {
    let root = fixture_root()?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    assert!(MemoryReviewStore::open_in(&parent, OsStr::new("missing"), &scope("alice")).is_err());
    assert!(
        MemoryReviewStore::create_in(&parent, OsStr::new("../escape"), &scope("alice")).is_err()
    );
    assert_eq!(std::fs::read_dir(root.path())?.count(), 0);
    Ok(())
}

#[test]
fn viewing_task_preparation_never_captures_or_rewrites_the_frozen_snapshot() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    let before = std::fs::read(path.join(FILE))?;
    assert!(store.read_task_snapshot("task")?.is_none());
    assert_eq!(std::fs::read(path.join(FILE))?, before);
    let candidate = store.propose("propose", proposal(MemoryOrigin::Manual), 1)?;
    let reviewed = store.review(
        "accept",
        &candidate.id,
        candidate.revision,
        MemoryReview::Accept {
            edited_content: None,
        },
        2,
    )?;
    let frozen = store.capture_task_snapshot("task", 3)?;
    store.remove("remove", &reviewed.id, reviewed.revision, 4)?;
    assert_eq!(store.read_task_snapshot("task")?, Some(frozen.clone()));
    let store = MemoryReviewStore::open(&path, &scope("alice"))?;
    assert_eq!(store.read_task_snapshot("task")?, Some(frozen));
    assert!(store.read_task_snapshot("another-task")?.is_none());
    Ok(())
}
#[test]
fn review_is_durable_and_imports_never_become_source_verified() -> Result<()> {
    let tmp = fixture_root()?;
    let path = tmp.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    let candidate = store.propose("proposal-1", proposal(MemoryOrigin::Imported), 100)?;
    assert_eq!(candidate.review_status, MemoryReviewStatus::Candidate);
    assert!(!candidate.enabled);
    assert!(
        store
            .set_enabled("enable-before-review", &candidate.id, 1, true, 101)
            .is_err()
    );
    let accepted = store.review(
        "review-1",
        &candidate.id,
        1,
        MemoryReview::Accept {
            edited_content: None,
        },
        102,
    )?;
    assert!(accepted.enabled);
    assert!(!accepted.source_verified);
    assert_eq!(accepted.proposal.origin, MemoryOrigin::Imported);
    let snapshot = store.capture_task_snapshot("task-1", 103)?;
    let edited = store.edit("edit-1", &candidate.id, 2, "报告保留来源表。".into(), 104)?;
    assert_eq!(edited.revision, 3);
    assert_eq!(store.capture_task_snapshot("task-1", 105)?, snapshot);
    drop(store);
    let reopened = MemoryReviewStore::open(&path, &scope("alice"))?;
    assert_eq!(reopened.read(&candidate.id)?, edited);
    assert_eq!(
        reopened.propose("proposal-1", proposal(MemoryOrigin::Imported), 106)?,
        candidate
    );
    assert!(
        reopened
            .propose("proposal-1", proposal(MemoryOrigin::Manual), 106)
            .is_err()
    );
    Ok(())
}
#[test]
fn stale_revision_cannot_overwrite_a_human_edit() -> Result<()> {
    let tmp = fixture_root()?;
    let path = tmp.path().join("private");
    let first = MemoryReviewStore::create(&path, &scope("alice"))?;
    let second = MemoryReviewStore::open(&path, &scope("alice"))?;
    let record = first.propose("p", proposal(MemoryOrigin::Observer), 1)?;
    first.edit("manual", &record.id, 1, "保留人工编辑。".into(), 2)?;
    let error = second
        .edit("observer", &record.id, 1, "旧的自动草稿。".into(), 3)
        .unwrap_err();
    assert!(error.to_string().contains("REVISION_CONFLICT"));
    assert_eq!(second.read(&record.id)?.proposal.content, "保留人工编辑。");
    let _held = first
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &first.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    assert!(
        second
            .list(None, true)
            .unwrap_err()
            .to_string()
            .contains("MEMORY_BUSY")
    );
    Ok(())
}
#[test]
fn scope_expiry_disabled_delete_and_paging_are_real_storage_facts() -> Result<()> {
    let tmp = fixture_root()?;
    let path = tmp.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    for i in 0..12 {
        let mut p = proposal(MemoryOrigin::Manual);
        p.valid_until_ms = Some(10);
        let m = store.propose(&format!("p{i}"), p, 1)?;
        store.review(
            &format!("r{i}"),
            &m.id,
            1,
            MemoryReview::Accept {
                edited_content: None,
            },
            2,
        )?;
    }
    let page = store.list(None, false)?;
    assert_eq!(page.items.len(), 10);
    assert_eq!(
        store.list(page.next_cursor.as_deref(), false)?.items.len(),
        2
    );
    assert!(
        store
            .capture_task_snapshot("expired", 11)?
            .memories
            .is_empty()
    );
    let m = &page.items[0];
    let disabled = store.set_enabled("disable", &m.id, m.revision, false, 3)?;
    assert!(!disabled.enabled);
    store.remove("remove", &m.id, disabled.revision, 4)?;
    assert!(store.read(&m.id).is_err());
    let mut renewed = scope("alice");
    renewed.identity_generation = "identity-2".into();
    assert!(MemoryReviewStore::open(&path, &renewed).is_ok());
    assert!(MemoryReviewStore::open(&path, &scope("bob")).is_err());
    Ok(())
}
#[test]
fn invalid_source_sensitive_content_and_corruption_do_not_create_facts() -> Result<()> {
    let tmp = fixture_root()?;
    let path = tmp.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    let mut p = proposal(MemoryOrigin::Observer);
    p.provenance.clear();
    assert!(store.propose("no-source", p, 1).is_err());
    let mut p = proposal(MemoryOrigin::Manual);
    p.content = "Authorization: Bearer audit-synthetic-only".into();
    assert!(store.propose("secret", p, 1).is_err());
    assert!(store.list(None, true)?.items.is_empty());
    store
        .directory
        .atomic_replace(OsStr::new(FILE), b"{not-json")?;
    assert!(store.list(None, true).is_err());
    assert!(MemoryReviewStore::open(&path, &scope("alice")).is_err());
    Ok(())
}
#[cfg(unix)]
#[test]
fn link_replacements_are_rejected_without_touching_the_target() -> Result<()> {
    let tmp = fixture_root()?;
    let victim = tmp.path().join("victim.json");
    std::fs::write(&victim, b"audit-owned-victim")?;
    let path = tmp.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    std::fs::remove_file(path.join(FILE))?;
    std::os::unix::fs::symlink(&victim, path.join(FILE))?;
    assert!(store.list(None, true).is_err());
    std::fs::remove_file(path.join(FILE))?;
    std::fs::hard_link(&victim, path.join(FILE))?;
    assert!(store.list(None, true).is_err());
    assert_eq!(std::fs::read(victim)?, b"audit-owned-victim");
    Ok(())
}

#[test]
fn missing_committed_data_is_not_reinitialized_or_replayed() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    assert!(MemoryReviewStore::open(&path, &scope("alice")).is_err());
    assert!(!path.exists());
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    let record = store.propose("original", proposal(MemoryOrigin::Manual), 1)?;
    std::fs::remove_file(path.join(FILE))?;
    assert!(store.read(&record.id).is_err());
    assert!(
        store
            .propose("original", proposal(MemoryOrigin::Manual), 2)
            .is_err()
    );
    assert!(MemoryReviewStore::open(&path, &scope("alice")).is_err());
    assert!(MemoryReviewStore::create(&path, &scope("alice")).is_err());
    assert!(!path.join(FILE).exists());
    Ok(())
}
#[test]
fn lock_and_binding_replacement_do_not_split_brain_or_repair_on_read() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    let record = store.propose("original", proposal(MemoryOrigin::Manual), 1)?;
    let bytes = std::fs::read(path.join(FILE))?;
    std::fs::remove_file(path.join(LOCK))?;
    assert!(store.list(None, true).is_err());
    assert!(!path.join(LOCK).exists());
    let _replacement = store
        .directory
        .open_read_write_file(OsStr::new(LOCK), true)?;
    assert!(
        store
            .edit("bad", &record.id, 1, "另一条事实".into(), 2)
            .is_err()
    );
    assert!(MemoryReviewStore::open(&path, &scope("alice")).is_err());
    assert_eq!(std::fs::read(path.join(FILE))?, bytes);
    let other = root.path().join("other");
    let store = MemoryReviewStore::create(&other, &scope("alice"))?;
    let original = std::fs::read(other.join("memory-binding.json"))?;
    store
        .directory
        .atomic_replace(OsStr::new("memory-binding.json"), &original)?;
    assert!(store.list(None, true).is_err());
    Ok(())
}
#[test]
fn a_lost_ack_after_publication_is_unknown_and_same_operation_reconciles() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    store
        .ack_loss
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let error = store
        .propose("stable-operation", proposal(MemoryOrigin::Manual), 1)
        .unwrap_err();
    assert_eq!(error.to_string(), "MEMORY_WRITE_UNCONFIRMED");
    let actual = store.list(None, true)?.items;
    assert_eq!(actual.len(), 1);
    assert_eq!(
        store.propose("stable-operation", proposal(MemoryOrigin::Manual), 2)?,
        actual[0]
    );
    Ok(())
}
#[test]
fn encoded_proposal_budget_prevents_control_character_expansion_past_transport_limit() -> Result<()>
{
    let root = fixture_root()?;
    let store = MemoryReviewStore::create(&root.path().join("private"), &scope("alice"))?;
    let mut input = proposal(MemoryOrigin::Manual);
    input.content = "\u{0001}".repeat(16000);
    assert!(input.content.len() < 32 * 1024);
    assert!(
        store
            .propose("oversized-json", input, 100)
            .unwrap_err()
            .to_string()
            .contains("PROPOSAL_TOO_LARGE")
    );
    assert!(store.list(None, true)?.items.is_empty());
    Ok(())
}
#[test]
fn operation_result_read_is_frozen_owner_checked_and_never_executes_or_repairs() -> Result<()> {
    let root = fixture_root()?;
    let path = root.path().join("private");
    let store = MemoryReviewStore::create(&path, &scope("alice"))?;
    assert!(store.read_operation_result("missing")?.is_none());
    let proposed = store.propose("original", proposal(MemoryOrigin::Manual), 100)?;
    let edited = store.edit("edit", &proposed.id, 1, "Later content".into(), 101)?;
    assert_eq!(store.read_operation_result("original")?, Some(proposed));
    assert_eq!(store.read_operation_result("edit")?, Some(edited));
    store.propose_candidates("batch", vec![proposal(MemoryOrigin::Observer)], 102)?;
    assert!(store.read_operation_result("batch")?.is_none());
    let before = std::fs::read(path.join(FILE))?;
    store.read_operation_result("original")?;
    assert_eq!(std::fs::read(path.join(FILE))?, before);
    std::fs::remove_file(path.join(FILE))?;
    assert!(store.read_operation_result("original").is_err());
    assert!(!path.join(FILE).exists());
    Ok(())
}
#[cfg(unix)]
#[test]
fn released_owner_lease_does_not_leave_store_busy_through_an_inherited_descriptor() -> Result<()> {
    let root = fixture_root()?;
    let store = MemoryReviewStore::create(&root.path().join("private"), &scope("alice"))?;
    let lease = store
        .directory
        .try_existing_portable_lock(
            OsStr::new(LOCK),
            &store.binding.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        .unwrap();
    // A fork can retain the same open-file description briefly before exec closes CLOEXEC fds.
    let inherited = lease.file().try_clone()?;
    drop(lease);
    let read = store.list(None, true);
    drop(inherited);
    assert!(
        read.is_ok(),
        "released owner lease still blocks the private store: {read:?}"
    );
    Ok(())
}
