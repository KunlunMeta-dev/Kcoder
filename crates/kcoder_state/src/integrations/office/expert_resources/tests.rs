use super::*;
use serde_json::json;

fn installed() -> Result<(tempfile::TempDir, OfficeStore, OfficeAssistantDraft)> {
    let root = tempfile::tempdir()?;
    let owner = serde_json::from_value(
        json!({"accountId":"test-owner","targetId":"test-target","workspaceId":null}),
    )?;
    let store = OfficeStore::create(&root.path().join("data"), owner)?;
    let definition: OfficeAssistantDefinition = serde_json::from_value(json!({
        "schemaVersion":1,"id":"resource-test","scope":"personal","title":"Resource expert","description":"Fixture",
        "language":"en","inputSchema":{"type":"object"},"instructions":"Expert identity",
        "modelSelection":{"kind":"inherit_current"},"outputKinds":["document"],"acceptanceCriteria":["Review"],"externalSend":"deny"
    }))?;
    let draft = store.save_draft("create", definition, None, 1)?;
    let content = "---\nname: original\ndescription: Read routing\n---\nRead references/routing.md when needed.";
    let files = vec![
        ("SKILL.md".into(), content.as_bytes().to_vec()),
        (
            "references/routing.md".into(),
            b"ORIGINAL_REFERENCE".to_vec(),
        ),
        ("scripts/ignored.sh".into(), b"exit 99".to_vec()),
    ];
    let draft = store.install_expert_skill(
        "install",
        &draft.definition.id,
        draft.revision,
        OfficeExpertSkillInstallation {
            skill: OfficeAssistantSkill {
                slug: "original".into(),
                title: "Original".into(),
                description: "Read routing".into(),
                content: content.into(),
                enabled: false,
                allowed_tools: None,
            },
            archive_sha256: &"a".repeat(64),
            files: &files,
        },
        2,
    )?;
    let mut definition = draft.definition;
    definition.skills[0].enabled = true;
    let draft = store.save_draft("enable", definition, Some(draft.revision), 3)?;
    Ok((root, store, draft))
}

#[test]
fn expert_resources_are_complete_rebuildable_and_pinned_after_draft_changes() -> Result<()> {
    let (root, store, draft) = installed()?;
    let snapshot = store.capture_expert_resources(&draft.definition, Some(draft.revision))?;
    assert_eq!(snapshot.skills["original"].len(), 3);
    snapshot.validate_definition(&draft.definition)?;
    let cache = store.materialize_expert_resources(&snapshot, &root.path().join("data"))?;
    let reference = cache.join("original/references/routing.md");
    assert_eq!(std::fs::read_to_string(&reference)?, "ORIGINAL_REFERENCE");
    assert!(std::fs::metadata(&reference)?.permissions().readonly());
    assert!(cache.join("original/scripts/ignored.sh").is_file());

    let mut next = draft.definition.clone();
    next.skills[0].content.push_str("\nNEW_ENTRY_VERSION");
    let saved = store.save_draft("edit", next, Some(draft.revision), 4)?;
    assert!(
        store
            .capture_expert_resources(&draft.definition, Some(draft.revision))
            .is_err()
    );
    let newer = store.capture_expert_resources(&saved.definition, Some(saved.revision))?;
    assert_ne!(snapshot.sha256()?, newer.sha256()?);
    let newer_cache = store.materialize_expert_resources(&newer, &root.path().join("data"))?;
    assert_ne!(cache, newer_cache);
    assert!(
        !std::fs::read_to_string(cache.join("original/SKILL.md"))?.contains("NEW_ENTRY_VERSION")
    );
    assert!(
        std::fs::read_to_string(newer_cache.join("original/SKILL.md"))?
            .contains("NEW_ENTRY_VERSION")
    );
    let encoded = serde_json::to_vec(&snapshot)?;
    drop(store);
    let reopened =
        OfficeStore::open_existing(&root.path().join("data"), snapshot.owner.clone())?.unwrap();
    let restored: OfficeExpertResourceSnapshot = serde_json::from_slice(&encoded)?;
    assert_eq!(
        reopened.materialize_expert_resources(&restored, &root.path().join("data"))?,
        cache
    );
    // A missing derived file is rebuilt from the exact pinned blob, without reading a newer draft.
    std::fs::remove_file(&reference)?;
    reopened.materialize_expert_resources(&restored, &root.path().join("data"))?;
    assert_eq!(std::fs::read_to_string(&reference)?, "ORIGINAL_REFERENCE");
    Ok(())
}

#[test]
fn expert_resources_reject_wrong_owner_paths_missing_blobs_and_modified_cache() -> Result<()> {
    let (root, store, draft) = installed()?;
    let snapshot = store.capture_expert_resources(&draft.definition, Some(draft.revision))?;
    let mut foreign = snapshot.clone();
    foreign.owner.account_id = "another-owner".into();
    assert!(
        store
            .materialize_expert_resources(&foreign, &root.path().join("data"))
            .is_err()
    );
    let mut escaping = snapshot.clone();
    escaping.skills.get_mut("original").unwrap()[0].path = "../outside.md".into();
    assert!(escaping.validate().is_err());
    let mut missing = snapshot.clone();
    missing.skills.get_mut("original").unwrap()[0].sha256 = "f".repeat(64);
    assert!(
        store
            .materialize_expert_resources(&missing, &root.path().join("data"))
            .is_err()
    );
    let cache = store.materialize_expert_resources(&snapshot, &root.path().join("data"))?;
    let directory = PrivateDirectory::open_existing(&cache.join("original/references"))?;
    directory.atomic_replace(OsStr::new("routing.md"), b"MODIFIED_REFERENCE")?;
    assert!(
        store
            .materialize_expert_resources(&snapshot, &root.path().join("data"))
            .is_err()
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn expert_resources_never_follow_a_replaced_reference_directory() -> Result<()> {
    let (root, store, draft) = installed()?;
    let snapshot = store.capture_expert_resources(&draft.definition, Some(draft.revision))?;
    let cache = store.materialize_expert_resources(&snapshot, &root.path().join("data"))?;
    let references = cache.join("original/references");
    std::fs::rename(&references, cache.join("original/retained-references"))?;
    let external = root.path().join("external");
    std::fs::create_dir(&external)?;
    std::fs::write(external.join("routing.md"), "PRIVATE_EXTERNAL")?;
    std::os::unix::fs::symlink(&external, references)?;
    assert!(
        store
            .materialize_expert_resources(&snapshot, &root.path().join("data"))
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(external.join("routing.md"))?,
        "PRIVATE_EXTERNAL"
    );
    Ok(())
}
