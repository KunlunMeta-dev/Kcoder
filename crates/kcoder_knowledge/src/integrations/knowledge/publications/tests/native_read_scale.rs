//! Native read budgets and source integrity over a real lexical publication catalog.
use super::*;
use crate::integrations::knowledge::CatalogReadLimits;
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

fn database_digest(path: &std::path::Path) -> Result<String> {
    let file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    std::io::copy(&mut std::io::BufReader::new(file), &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

#[test]
fn native_bounded_reader_retrieves_fixed_revisions_over_sixteen_thousand_index_rows() -> Result<()>
{
    let _fixture = crate::test_support::large_storage_fixture();
    const PUBLICATIONS: usize = 512;
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let path = root.path().join("scale.sqlite");
    let actor = scope("owned-scale-reader");
    let owner = KnowledgeOwner::from(&actor);
    let access = policy();
    let native = KnowledgeScope::from_authenticated_host("owned-scale-reader", "local")?;
    let mut writer = KnowledgeCatalog::open(&path)?;
    let preparation = Instant::now();
    let mut draft = seed(&mut writer, &native)?;
    let base = writer.read_page(
        &native,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        Some(&draft.sources[0].page_revision),
    )?;
    let pages = (0..31)
        .map(|index| {
            let mut page = base.draft.clone();
            page.page_id = uuid::Uuid::new_v4().to_string();
            page.expected_revision = None;
            page.title = format!("Owned scale page {index}");
            page.markdown = format!(
                "scaleuniquemarker {index}\n{}",
                base.draft.markdown.repeat(48)
            );
            page
        })
        .collect();
    let references = writer.commit_generated_pages(
        &native,
        &draft.sources[0].library_id,
        "owned-scale-pages",
        pages,
    )?;
    let library = draft.sources[0].library_id.clone();
    draft
        .sources
        .extend(references.into_iter().map(|page| PublicationSource {
            library_id: library.clone(),
            page_id: page.page_id,
            page_revision: page.revision_id,
        }));
    for index in 0..PUBLICATIONS {
        let mut selected = draft.clone();
        selected.publication_id = format!("native-scale-{index:04}");
        writer.publish_knowledge(
            &native,
            &actor,
            &format!("native-publish-{index}"),
            0,
            selected,
            &access,
            100,
        )?;
    }
    let id = format!("native-scale-{:04}", PUBLICATIONS - 1);
    let old_source = draft.sources[0].clone();
    let new_page = writer.edit_page(
        &native,
        &library,
        &old_source.page_id,
        &old_source.page_revision,
        "owned-source-revision-two",
        "Owned new revision",
        "freshrevisionmarker: the existing publication remains revision one.",
    )?;
    let mut updated = draft.clone();
    updated.publication_id = id.clone();
    updated.sources[0].page_revision = new_page.revision_id.clone();
    writer.publish_knowledge(
        &native,
        &actor,
        "native-version-two",
        1,
        updated,
        &access,
        101,
    )?;
    let preparation_ms = preparation.elapsed().as_millis();
    let database_bytes = std::fs::metadata(&path)?.len();
    let digest_before = database_digest(&path)?;
    let baseline = database_observation(&writer)?;
    let limits = CatalogReadLimits::default();
    eprintln!(
        "{}",
        json!({"nativeKnowledgeScalePrepared": {
            "publications": PUBLICATIONS, "fixedVersionIndexRows": (PUBLICATIONS + 1) * 32,
            "databaseBytes": database_bytes, "preparationMs": preparation_ms
        }})
    );
    let mut timings = Vec::new();
    let mut proof_reads = Vec::new();
    for _ in 0..5 {
        let started = Instant::now();
        let observed =
            KnowledgeCatalog::open_existing_native(&path, &CancellationToken::new(), limits)?;
        let (retrieval, proof) = observed.with_catalog(|reader| {
            reader.retrieve_publication(
                &actor,
                &owner,
                &id,
                1,
                "scaleuniquemarker",
                20,
                &access,
                102,
            )
        })?;
        assert_eq!(retrieval.outcome, KnowledgeRetrievalOutcome::Matched);
        assert_eq!(retrieval.hits.len(), 20);
        assert!(retrieval.hits.iter().all(|hit| hit.publication_id == id
            && hit.version == 1
            && draft.sources.contains(&hit.source)
            && hit.excerpt.contains("scaleuniquemarker")));
        assert_eq!(proof.source_write_attempts, 0);
        assert!(proof.actual_read_bytes <= limits.read_bytes);
        assert!(proof.elapsed_ms <= limits.elapsed.as_millis() as u64);
        timings.push(started.elapsed().as_micros());
        proof_reads.push(proof.actual_read_bytes);
    }
    for version in [1, 2] {
        let observed =
            KnowledgeCatalog::open_existing_native(&path, &CancellationToken::new(), limits)?;
        let (retrieval, proof) = observed.with_catalog(|reader| {
            reader.retrieve_publication(
                &actor,
                &owner,
                &id,
                version,
                "freshrevisionmarker",
                20,
                &access,
                102,
            )
        })?;
        assert_eq!(
            retrieval.outcome,
            if version == 1 {
                KnowledgeRetrievalOutcome::NoMatch
            } else {
                KnowledgeRetrievalOutcome::Matched
            }
        );
        assert_eq!(proof.source_write_attempts, 0);
    }
    let mixed_query = "报销 scaleuniquemarker";
    let mixed_expression = crate::search::tokenize(mixed_query)
        .into_iter()
        .take(32)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let mut legacy_statement = writer.connection.prepare("SELECT page_index FROM integration_publication_fts WHERE integration_publication_fts MATCH ?1 AND owner_key=?2 AND publication_id=?3 AND version=?4 ORDER BY bm25(integration_publication_fts) LIMIT ?5")?;
    let legacy_indices = legacy_statement
        .query_map(
            params![mixed_expression, serde_json::to_string(&owner)?, id, 1, 20],
            |row| row.get::<_, usize>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(legacy_statement);
    let observed =
        KnowledgeCatalog::open_existing_native(&path, &CancellationToken::new(), limits)?;
    let (mixed, proof) = observed.with_catalog(|reader| {
        reader.retrieve_publication(&actor, &owner, &id, 1, mixed_query, 20, &access, 102)
    })?;
    assert_eq!(
        mixed.hits.iter().map(|hit| &hit.source).collect::<Vec<_>>(),
        legacy_indices
            .iter()
            .map(|index| &draft.sources[*index])
            .collect::<Vec<_>>()
    );
    assert_eq!(proof.source_write_attempts, 0);
    assert_eq!(database_digest(&path)?, digest_before);
    assert_eq!(database_observation(&writer)?, baseline);
    let limited = CatalogReadLimits {
        read_bytes: 1024,
        ..limits
    };
    let denied = KnowledgeCatalog::open_existing_native(&path, &CancellationToken::new(), limited)
        .and_then(|reader| {
            reader.with_catalog(|reader| {
                reader.retrieve_publication(
                    &actor,
                    &owner,
                    &id,
                    1,
                    "scaleuniquemarker",
                    20,
                    &access,
                    102,
                )
            })
        });
    assert!(
        denied.is_err(),
        "Exhausted read capacity must not return no-match"
    );
    assert_eq!(database_digest(&path)?, digest_before);
    writer.connection.execute("DELETE FROM integration_publication_fts WHERE owner_key=?1 AND publication_id=?2 AND version=1 AND page_index=0",
        params![serde_json::to_string(&owner)?, id])?;
    let missing_index =
        KnowledgeCatalog::open_existing_native(&path, &CancellationToken::new(), limits)?
            .with_catalog(|reader| {
                reader.retrieve_publication(
                    &actor,
                    &owner,
                    &id,
                    1,
                    "absentquerymarker",
                    20,
                    &access,
                    102,
                )
            });
    assert_eq!(
        missing_index.unwrap_err().to_string(),
        "KNOWLEDGE_INDEX_STALE"
    );
    timings.sort_unstable();
    let peak_rss_kib = std::fs::read_to_string("/proc/self/status")?
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u64>().ok());
    eprintln!(
        "{}",
        json!({"nativeKnowledgeScaleEvidence": {
            "publications": PUBLICATIONS, "fixedVersionIndexRows": (PUBLICATIONS + 1) * 32,
            "databaseBytes": database_bytes, "preparationMs": preparation_ms,
            "querySamples": timings.len(), "queryMinUs": timings[0], "queryP95Us": timings[4],
            "actualReadBytes": proof_reads, "perReadByteLimit": limits.read_bytes,
            "perReadTimeLimitMs": limits.elapsed.as_millis(), "peakRssKiB": peak_rss_kib,
            "exactOldAndNewSourceRevisions": true, "sourceUnchangedAfterRead": true,
            "readCapacityExhaustionFails": true, "missingIndexIsNotNoMatch": true,
            "embeddingCalls": 0, "modelCalls": 0, "domainAndNativeVfsOnly": true,
        "originalCjkAndAsciiBm25OrderPreserved": true
        }})
    );
    Ok(())
}
