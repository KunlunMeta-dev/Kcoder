use super::*;
use crate::integrations::knowledge::CatalogReadLimits;
use kcoder_config::PrivateDirectory;
use tokio_util::sync::CancellationToken;

#[test]
fn old_catalog_without_row_lookup_reads_purely_and_explicit_rebuild_preserves_fixed_body()
-> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let path = root.path().join("old.sqlite");
    let mut writer = KnowledgeCatalog::open(&path)?;
    let actor = scope("owned-index-reader");
    let native = KnowledgeScope::from_authenticated_host("owned-index-reader", "local")?;
    let access = policy();
    let draft = seed(&mut writer, &native)?;
    let published =
        writer.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &access, 100)?;
    writer
        .connection
        .execute_batch("DROP TABLE integration_publication_index_rows;")?;
    let before = database_observation(&writer)?;
    let reader = KnowledgeCatalog::open_existing_native(
        &path,
        &CancellationToken::new(),
        CatalogReadLimits::default(),
    )?;
    let (retrieval, proof) = reader.with_catalog(|reader| {
        reader.retrieve_publication(
            &actor,
            &published.owner,
            &draft.publication_id,
            1,
            "报销",
            10,
            &access,
            101,
        )
    })?;
    assert_eq!(retrieval.outcome, KnowledgeRetrievalOutcome::Matched);
    assert_eq!(proof.source_write_attempts, 0);
    assert_eq!(database_observation(&writer)?, before);
    assert!(!super::super::index_rows::exists(&writer.connection)?);
    let rebuilt = writer.rebuild_publication_index(
        &actor,
        &published.owner,
        &draft.publication_id,
        1,
        "explicit-rebuild",
        &access,
        102,
    )?;
    assert!(rebuilt.ready);
    assert!(super::super::index_rows::exists(&writer.connection)?);
    assert_eq!(
        writer.resolve_publication(
            &actor,
            &published.owner,
            &draft.publication_id,
            Some(1),
            &access,
            103
        )?,
        published
    );
    Ok(())
}

#[test]
fn wrong_or_missing_row_lookup_never_returns_no_match_or_repairs_during_read() -> Result<()> {
    for mode in ["missing-fts", "missing-map", "wrong-owner", "wrong-version"] {
        let root = tempfile::tempdir()?;
        PrivateDirectory::open_or_create(root.path())?;
        let path = root.path().join("stale.sqlite");
        let mut writer = KnowledgeCatalog::open(&path)?;
        let actor = scope("owned-index-reader");
        let native = KnowledgeScope::from_authenticated_host("owned-index-reader", "local")?;
        let access = policy();
        let draft = seed(&mut writer, &native)?;
        let publication =
            writer.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &access, 100)?;
        let sql = match mode {
            "missing-fts" => "DELETE FROM integration_publication_fts",
            "missing-map" => "DELETE FROM integration_publication_index_rows",
            "wrong-owner" => "UPDATE integration_publication_fts SET owner_key='different-owner'",
            _ => "UPDATE integration_publication_fts SET version=2",
        };
        writer.connection.execute_batch(sql)?;
        let before = database_observation(&writer)?;
        let reader = KnowledgeCatalog::open_existing_native(
            &path,
            &CancellationToken::new(),
            CatalogReadLimits::default(),
        )?;
        let error = reader
            .with_catalog(|reader| {
                reader.retrieve_publication(
                    &actor,
                    &publication.owner,
                    &draft.publication_id,
                    1,
                    "never-match",
                    10,
                    &access,
                    101,
                )
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "KNOWLEDGE_INDEX_STALE", "{mode}");
        assert_eq!(database_observation(&writer)?, before);
    }
    Ok(())
}
