use anyhow::Result;
use kcoder_knowledge::*;
use kcoder_types::knowledge::*;
#[test]
fn human_edits_restore_history_and_make_future_generated_updates_reviewable() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let wiki = store.create(&scope, "wiki", "Wiki", "")?;
    let renamed = store.update_library(&scope, &wiki.id, wiki.revision, "项目知识", "保留原文")?;
    assert_eq!(renamed.revision, 2);
    assert!(
        store
            .update_library(&scope, &wiki.id, 1, "stale", "")
            .is_err()
    );
    let source = store.import_text(&scope, &wiki.id, "source", "资料", "原始事实。")?;
    let page = KnowledgePageDraft {
        page_id: uuid::Uuid::new_v4().to_string(),
        expected_revision: None,
        kind: KnowledgePageKind::Concept,
        title: "主题".into(),
        markdown: "原始事实。".into(),
        citations: vec![KnowledgeCitation {
            source_id: source.source_id,
            revision_id: source.revision_id,
            chunk_id: "chunk-1".into(),
            quote: "原始事实。".into(),
        }],
        related_page_ids: vec![],
    };
    let initial = store.commit_generated_pages(&scope, &wiki.id, "initial", vec![page.clone()])?;
    let edited = store.edit_page(
        &scope,
        &wiki.id,
        &page.page_id,
        &initial[0].revision_id,
        "edit",
        "已编辑主题",
        "用户补充的经验。",
    )?;
    assert_eq!(
        edited,
        store.edit_page(
            &scope,
            &wiki.id,
            &page.page_id,
            &initial[0].revision_id,
            "edit",
            "已编辑主题",
            "用户补充的经验。"
        )?
    );
    assert!(
        store
            .edit_page(
                &scope,
                &wiki.id,
                &page.page_id,
                &initial[0].revision_id,
                "stale",
                "标题",
                "不能覆盖"
            )
            .is_err()
    );
    let current = store.read_page(&scope, &wiki.id, &page.page_id, None)?;
    assert!(current.human_edited);
    let mut generated = page.clone();
    generated.expected_revision = Some(edited.revision_id.clone());
    assert!(
        store
            .commit_generated_pages(&scope, &wiki.id, "generated", vec![generated])
            .unwrap_err()
            .is::<ReviewRequired>()
    );
    let restored = store.restore_page(
        &scope,
        &wiki.id,
        &page.page_id,
        &edited.revision_id,
        &initial[0].revision_id,
        "restore",
    )?;
    assert_ne!(restored.revision_id, initial[0].revision_id);
    assert_eq!(
        store
            .read_page(&scope, &wiki.id, &page.page_id, None)?
            .draft
            .markdown,
        "原始事实。"
    );
    assert_eq!(
        store
            .read_page(&scope, &wiki.id, &page.page_id, Some(&edited.revision_id))?
            .draft
            .markdown,
        "用户补充的经验。"
    );
    let history = store.page_history(&scope, &wiki.id, &page.page_id, None, 2)?;
    assert_eq!(
        history.iter().map(|v| v.sequence).collect::<Vec<_>>(),
        [3, 2]
    );
    assert_eq!(
        history[0].restored_from.as_deref(),
        Some(initial[0].revision_id.as_str())
    );
    assert_eq!(history[0].author, "human");
    assert_eq!(
        store.page_history(&scope, &wiki.id, &page.page_id, Some(2), 2)?[0].sequence,
        1
    );
    let bob = KnowledgeScope::from_authenticated_host("bob", "local")?;
    assert!(
        store
            .edit_page(
                &bob,
                &wiki.id,
                &page.page_id,
                &restored.revision_id,
                "attack",
                "bad",
                "bad"
            )
            .is_err()
    );
    Ok(())
}
