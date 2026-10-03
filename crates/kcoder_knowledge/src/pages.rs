//! Versioned Wiki commits. All base revisions and evidence are checked under one
//! SQLite write transaction; immutable Markdown is persisted before publication.
use crate::{
    EvidenceChunk, ExistingPage, KnowledgeCatalog, KnowledgeScope, objects::digest,
    validate_generated_changes,
};
use anyhow::{Result, ensure};
use kcoder_types::knowledge::KnowledgePageDraft;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRevisionRef {
    pub page_id: String,
    pub revision_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPage {
    pub revision_id: String,
    pub human_edited: bool,
    pub draft: KnowledgePageDraft,
}

impl KnowledgeCatalog {
    pub fn commit_generated_pages(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        request_key: &str,
        pages: Vec<KnowledgePageDraft>,
    ) -> Result<Vec<PageRevisionRef>> {
        self.commit_pages(scope, library, request_key, pages, None)
    }

    pub(crate) fn commit_pages(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        request_key: &str,
        pages: Vec<KnowledgePageDraft>,
        lease: Option<&crate::WikiJobLease>,
    ) -> Result<Vec<PageRevisionRef>> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let result = commit_in_transaction(&tx, &self.objects, library, request_key, pages, lease)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn read_page(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        page: &str,
        revision: Option<&str>,
    ) -> Result<StoredPage> {
        self.read(scope, library)?;
        let (current,human_edited):(String,bool)=self.connection.query_row("SELECT current_revision,human_edited FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",params![library,page],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or_else(||anyhow::anyhow!("knowledge page not found"))?;
        let revision = revision.unwrap_or(&current);
        let (base,title,kind,hash,citations,related):(Option<String>,String,String,String,String,String)=self.connection.query_row("SELECT base_revision,title,kind,body_hash,citations_json,related_json FROM knowledge_page_revisions WHERE library_id=?1 AND page_id=?2 AND revision_id=?3",params![library,page,revision],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?.ok_or_else(||anyhow::anyhow!("knowledge page revision not found"))?;
        Ok(StoredPage {
            revision_id: revision.into(),
            human_edited,
            draft: KnowledgePageDraft {
                page_id: page.into(),
                expected_revision: base,
                title,
                kind: serde_json::from_str(&kind)?,
                markdown: self.objects.read(library, &hash)?,
                citations: serde_json::from_str(&citations)?,
                related_page_ids: serde_json::from_str(&related)?,
            },
        })
    }
}

impl KnowledgeCatalog {
    pub fn list_pages(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<kcoder_types::knowledge::KnowledgePageSummary>> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "page limit must be 1..100");
        let mut statement=self.connection.prepare("SELECT p.page_id,p.current_revision,r.title,r.kind,p.human_edited FROM knowledge_pages p JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision WHERE p.library_id=?1 AND p.page_id>?2 ORDER BY p.page_id LIMIT ?3")?;
        let rows = statement.query_map(
            params![library, after_id.unwrap_or(""), limit as i64],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, bool>(4)?,
                ))
            },
        )?;
        rows.map(|row| {
            let (id, revision, title, kind, human) = row?;
            Ok(kcoder_types::knowledge::KnowledgePageSummary {
                page_id: id,
                revision_id: revision,
                title,
                kind: serde_json::from_str(&kind)?,
                human_edited: human,
            })
        })
        .collect()
    }
}

pub(crate) fn commit_in_transaction(
    transaction: &rusqlite::Connection,
    objects: &crate::objects::ObjectStore,
    library: &str,
    request_key: &str,
    pages: Vec<KnowledgePageDraft>,
    lease: Option<&crate::WikiJobLease>,
) -> Result<Vec<PageRevisionRef>> {
    require_active(transaction, library)?;
    ensure!(
        !request_key.is_empty() && request_key.len() <= 128,
        "invalid request key"
    );
    ensure!(
        !pages.is_empty() && pages.len() <= 32,
        "invalid changeset size"
    );
    let payload = serde_json::to_vec(&pages)?;
    ensure!(
        payload.len() <= crate::ingest::WIKI_MAX_PROPOSAL_BYTES,
        "changeset too large"
    );
    let payload_hash = digest(&payload);
    if let Some(lease) = lease {
        crate::jobs::require_lease(transaction, library, lease)?;
    }
    let prior:Option<(String,String)>=transaction.query_row("SELECT payload_hash,result_json FROM knowledge_commits WHERE library_id=?1 AND request_key=?2",params![library,request_key],|r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((hash, result)) = prior {
        ensure!(hash == payload_hash, "idempotency conflict");
        return Ok(serde_json::from_str(&result)?);
    }
    let mut existing = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for page in &pages {
        ids.insert(page.page_id.as_str());
        ids.extend(page.related_page_ids.iter().map(String::as_str));
    }
    for id in ids {
        let found=transaction.query_row("SELECT current_revision,human_edited FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",params![library,id],|row| Ok(ExistingPage {revision:row.get(0)?,human_edited:row.get(1)?})).optional()?;
        if let Some(found) = found {
            existing.insert(id.to_owned(), found);
        }
    }
    let mut evidence = Vec::new();
    let mut evidence_keys = BTreeSet::new();
    for page in &pages {
        for citation in &page.citations {
            let key = (
                &citation.source_id,
                &citation.revision_id,
                &citation.chunk_id,
            );
            if !evidence_keys.insert(key) {
                continue;
            }
            let text:Option<String>=transaction.query_row("SELECT text FROM knowledge_chunks WHERE library_id=?1 AND source_id=?2 AND revision_id=?3 AND chunk_id=?4",params![library,key.0,key.1,key.2],|r|r.get(0)).optional()?;
            if let Some(text) = text {
                evidence.push(EvidenceChunk {
                    source_id: key.0.clone(),
                    revision_id: key.1.clone(),
                    chunk_id: key.2.clone(),
                    text,
                });
            }
        }
    }
    let validated = validate_generated_changes(pages, &existing, &evidence)?;
    if validated.requires_review() {
        let approved:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_review_receipts WHERE library_id=?1 AND commit_key=?2 AND payload_hash=?3 AND accepted=1)",params![library,request_key,payload_hash],|r|r.get(0))?;
        if !approved {
            return Err(crate::reviews::ReviewRequired.into());
        }
    }
    let mut result = Vec::new();
    for page in validated.pages() {
        let revision_id = uuid::Uuid::new_v4().to_string();
        let hash = objects.put(library, &page.markdown)?;
        let sequence:i64=transaction.query_row("SELECT COALESCE(MAX(revision_sequence),0)+1 FROM knowledge_page_revisions WHERE library_id=?1 AND page_id=?2",params![library,page.page_id],|r|r.get(0))?;
        transaction.execute("INSERT INTO knowledge_page_revisions(library_id,page_id,revision_id,base_revision,title,kind,body_hash,citations_json,related_json,revision_sequence) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![library,page.page_id,revision_id,page.expected_revision,page.title,serde_json::to_string(&page.kind)?,hash,serde_json::to_string(&page.citations)?,serde_json::to_string(&page.related_page_ids)?,sequence])?;
        transaction.execute("INSERT INTO knowledge_pages(library_id,page_id,current_revision,human_edited) VALUES(?1,?2,?3,0) ON CONFLICT(library_id,page_id) DO UPDATE SET current_revision=excluded.current_revision",params![library,page.page_id,revision_id])?;
        crate::search::replace_index(
            transaction,
            library,
            &page.page_id,
            &revision_id,
            &page.title,
            &page.markdown,
        )?;
        result.push(PageRevisionRef {
            page_id: page.page_id.clone(),
            revision_id,
        });
    }
    transaction.execute("INSERT INTO knowledge_commits(library_id,request_key,payload_hash,result_json) VALUES(?1,?2,?3,?4)",params![library,request_key,payload_hash,serde_json::to_string(&result)?])?;
    Ok(result)
}

pub(crate) fn require_active(connection: &rusqlite::Connection, library: &str) -> Result<()> {
    let archived: bool = connection.query_row(
        "SELECT archived FROM libraries WHERE id=?1",
        [library],
        |row| row.get(0),
    )?;
    ensure!(!archived, "knowledge library is archived");
    Ok(())
}
