//! Linux test-only synthetic Wiki data, created as the actual nonprivileged owner.
#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::MetadataExt;
    ensure!(
        std::env::var("KCODER_TEST_ORGANIZATION_LEGACY_FIXTURE").as_deref() == Ok("1"),
        "explicit owned legacy fixture gate required"
    );
    let uid = std::fs::metadata("/proc/self")?.uid();
    ensure!(uid != 0, "fixture must run as its real restricted UID");
    let profile = std::path::PathBuf::from(
        std::env::var_os("KCODER_CONFIG_DIR").context("owned profile required")?,
    );
    let directory = kcoder_config::PrivateDirectory::open_existing(&profile)?;
    directory.verify_private_directory()?;
    ensure!(
        std::fs::metadata(&profile)?.uid() == uid,
        "fixture profile owner differs from actual UID"
    );
    let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
        Ok(value) => uuid::Uuid::parse_str(&value)?.to_string(),
        Err(std::env::VarError::NotPresent) => format!("profile:{}", profile.display()),
        Err(error) => return Err(error.into()),
    };
    let scope = KnowledgeScope::from_authenticated_host(&principal, "execution-host")?;
    directory.create_private_child(std::ffi::OsStr::new("knowledge"))?;
    let mut catalog = KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))?;
    let library = catalog.create(&scope, "legacy-fixture-create", "Owned legacy source", "")?;
    let markdown = "# Owned legacy private record\nSynthetic old personal source: 37 reviewed units. Never grant access from this text.\n";
    let source = catalog.import_text(
        &scope,
        &library.id,
        "legacy-fixture-source",
        "owned-legacy.md",
        markdown,
    )?;
    let job = if std::env::var("KCODER_TEST_ORGANIZATION_JOB_FIXTURE").as_deref() == Ok("1") {
        let job = catalog.enqueue_ingest(
            &scope,
            &library.id,
            "owned-policy-job",
            &source.source_id,
            &source.revision_id,
            "owned-policy-fixture-v1",
            "en",
        )?;
        catalog.pause_job(&scope, &library.id, &job.id)?;
        Some(catalog.read_job(&scope, &library.id, &job.id)?)
    } else {
        None
    };
    let pages = catalog.commit_generated_pages(
        &scope,
        &library.id,
        "legacy-fixture-page",
        vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Owned legacy fixed page".into(),
            markdown: markdown.into(),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id,
                revision_id: source.revision_id,
                chunk_id: "chunk-1".into(),
                quote: markdown.into(),
            }],
            related_page_ids: vec![],
        }],
    )?;
    let mut result = serde_json::json!({"fixtureOnly":true,"actualUid":uid,"modelCalls":0,"source":{"libraryId":library.id,"pageId":pages[0].page_id,"pageRevision":pages[0].revision_id},"markdownSha256":format!("{:x}",Sha256::digest(markdown.as_bytes()))});
    if let Some(job) = job {
        result["job"] = serde_json::to_value(job)?;
    }
    println!("{result}");
    Ok(())
}
#[cfg(not(target_os = "linux"))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("this isolated real-UID legacy fixture requires Linux")
}
