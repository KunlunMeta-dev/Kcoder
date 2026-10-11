//! Human edits are explicit RPC operations, separate from model proposals.
use crate::{KnowledgeCatalog, KnowledgeScope, PageRevisionRef, objects::digest};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageVersion {
    pub revision_id: String,
    pub sequence: u64,
    pub title: String,
    pub author: String,
    pub restored_from: Option<String>,
}

impl KnowledgeCatalog {
    #[allow(clippy::too_many_arguments)]
    pub fn edit_page(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        page: &str,
        expected: &str,
        key: &str,
        title: &str,
        markdown: &str,
    ) -> Result<PageRevisionRef> {
        self.human_revision(scope, library, page, expected, key, title, markdown, None)
    }
    pub fn restore_page(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        page: &str,
        expected: &str,
        from: &str,
        key: &str,
    ) -> Result<PageRevisionRef> {
        let revision = self.read_page(scope, library, page, Some(from))?;
        self.human_revision(
            scope,
            library,
            page,
            expected,
            key,
            &revision.draft.title,
            &revision.draft.markdown,
            Some(from),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn human_revision(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        page: &str,
        expected: &str,
        key: &str,
        title: &str,
        markdown: &str,
        restored_from: Option<&str>,
    ) -> Result<PageRevisionRef> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let result = human_revision_in_transaction(
            &tx,
            &self.objects,
            library,
            page,
            expected,
            key,
            title,
            markdown,
            restored_from,
        )?;
        tx.commit()?;
        Ok(result)
    }
    pub fn page_history(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        page: &str,
        before_sequence: Option<u64>,
        limit: usize,
    ) -> Result<Vec<WikiPageVersion>> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "history limit must be 1..100");
        let before = before_sequence
            .unwrap_or(i64::MAX as u64)
            .min(i64::MAX as u64) as i64;
        let mut statement=self.connection.prepare("SELECT revision_id,revision_sequence,title,author,restored_from FROM knowledge_page_revisions WHERE library_id=?1 AND page_id=?2 AND revision_sequence<?3 ORDER BY revision_sequence DESC LIMIT ?4")?;
        Ok(statement
            .query_map(params![library, page, before, limit as i64], |r| {
                Ok(WikiPageVersion {
                    revision_id: r.get(0)?,
                    sequence: r.get::<_, i64>(1)? as u64,
                    title: r.get(2)?,
                    author: r.get(3)?,
                    restored_from: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// Shared human-edit transaction used by atomic external-edit batches.
#[allow(clippy::too_many_arguments)]
pub(crate) fn human_revision_in_transaction(
    tx: &rusqlite::Connection,
    objects: &crate::objects::ObjectStore,
    library: &str,
    page: &str,
    expected: &str,
    key: &str,
    title: &str,
    markdown: &str,
    restored_from: Option<&str>,
) -> Result<PageRevisionRef> {
    ensure!(
        !key.trim().is_empty() && key.len() <= 100,
        "invalid edit request key"
    );
    ensure!(
        !title.trim().is_empty() && title.chars().count() <= 240,
        "invalid page title"
    );
    ensure!(
        !markdown.trim().is_empty() && markdown.len() <= crate::WIKI_MAX_PAGE_BYTES,
        "invalid page content size"
    );
    let request_key = format!("human-edit:{key}");
    let payload_hash = digest(&serde_json::to_vec(
        &serde_json::json!({"page":page,"base":expected,"title":title,"markdown":markdown,"restore":restored_from}),
    )?);
    crate::pages::require_active(tx, library)?;
    let prior:Option<(String,String)>=tx.query_row("SELECT payload_hash,result_json FROM knowledge_commits WHERE library_id=?1 AND request_key=?2",params![library,request_key],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((hash, result)) = prior {
        ensure!(hash == payload_hash, "idempotency conflict");
        return Ok(serde_json::from_str(&result)?);
    }
    let current: String = tx
        .query_row(
            "SELECT current_revision FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",
            params![library, page],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("knowledge page not found"))?;
    ensure!(current == expected, "revision conflict");
    let metadata_revision = restored_from.unwrap_or(&current);
    let (kind,citations,related):(String,String,String)=tx.query_row("SELECT kind,citations_json,related_json FROM knowledge_page_revisions WHERE library_id=?1 AND page_id=?2 AND revision_id=?3",params![library,page,metadata_revision],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let sequence:i64=tx.query_row("SELECT COALESCE(MAX(revision_sequence),0)+1 FROM knowledge_page_revisions WHERE library_id=?1 AND page_id=?2",params![library,page],|r|r.get(0))?;
    let result = PageRevisionRef {
        page_id: page.into(),
        revision_id: uuid::Uuid::new_v4().to_string(),
    };
    let hash = objects.put(library, markdown)?;
    tx.execute("INSERT INTO knowledge_page_revisions(library_id,page_id,revision_id,base_revision,title,kind,body_hash,citations_json,related_json,revision_sequence,author,restored_from) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'human',?11)",params![library,page,result.revision_id,current,title,kind,hash,citations,related,sequence,restored_from])?;
    tx.execute("UPDATE knowledge_pages SET current_revision=?3,human_edited=1 WHERE library_id=?1 AND page_id=?2",params![library,page,result.revision_id])?;
    crate::search::replace_index(tx, library, page, &result.revision_id, title, markdown)?;
    tx.execute("INSERT INTO knowledge_commits(library_id,request_key,payload_hash,result_json) VALUES(?1,?2,?3,?4)",params![library,request_key,payload_hash,serde_json::to_string(&result)?])?;
    Ok(result)
}
