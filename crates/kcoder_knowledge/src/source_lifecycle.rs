//! Source lifecycle retains old bytes and citations; removal never erases evidence.
use crate::{KnowledgeCatalog, KnowledgeScope, SourceChunk, SourceRevision};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source_id: String,
    pub current_revision: String,
    pub removed: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAffectedPage {
    pub page_id: String,
    pub title: String,
    pub human_edited: bool,
}
impl KnowledgeCatalog {
    pub fn source_status(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
    ) -> Result<SourceStatus> {
        self.read(scope, library)?;
        self.connection.query_row("SELECT current_revision,removed FROM knowledge_source_lifecycle WHERE library_id=?1 AND source_id=?2",params![library,source],|row|Ok(SourceStatus {source_id:source.into(),current_revision:row.get(0)?,removed:row.get(1)?})).optional()?.ok_or_else(||anyhow::anyhow!("source not found"))
    }
    pub fn set_source_removed(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
        expected_revision: &str,
        removed: bool,
    ) -> Result<SourceStatus> {
        self.read(scope, library)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let changed=tx.execute("UPDATE knowledge_source_lifecycle SET removed=?4 WHERE library_id=?1 AND source_id=?2 AND current_revision=?3",params![library,source,expected_revision,removed])?;
        ensure!(changed == 1, "source revision conflict");
        if removed {
            tx.execute("UPDATE knowledge_jobs SET status='paused',error_code='source_removed',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND source_id=?2 AND status IN ('queued','running','awaiting_review')",params![library,source])?;
        } else {
            let title:String=tx.query_row("SELECT title FROM knowledge_sources WHERE library_id=?1 AND source_id=?2 AND revision_id=?3",params![library,source,expected_revision],|row|row.get(0))?;
            let mut statement=tx.prepare("SELECT chunk_id,text FROM knowledge_chunks WHERE library_id=?1 AND source_id=?2 AND revision_id=?3 ORDER BY ordinal")?;
            let rows = statement.query_map(params![library, source, expected_revision], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (chunk, text) = row?;
                crate::search::replace_index(
                    &tx,
                    library,
                    &format!("source:{source}:{chunk}"),
                    expected_revision,
                    &title,
                    &text,
                )?;
            }
        }
        tx.commit()?;
        self.source_status(scope, library, source)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn update_source(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
        expected_revision: &str,
        key: &str,
        title: &str,
        original: &[u8],
        format: &str,
        chunks: Vec<SourceChunk>,
    ) -> Result<SourceRevision> {
        self.import_source_revision(
            scope,
            library,
            key,
            title,
            original,
            format,
            chunks,
            Some((source, expected_revision)),
        )
    }
    pub fn affected_pages(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SourceAffectedPage>> {
        self.source_status(scope, library, source)?;
        ensure!(
            (1..=100).contains(&limit),
            "affected page limit must be 1..100"
        );
        let mut statement=self.connection.prepare("SELECT p.page_id,r.title,p.human_edited FROM knowledge_pages p JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision WHERE p.library_id=?1 AND p.page_id>?3 AND EXISTS(SELECT 1 FROM json_each(r.citations_json) j WHERE json_extract(j.value,'$.sourceId')=?2) ORDER BY p.page_id LIMIT ?4")?;
        Ok(statement
            .query_map(
                params![library, source, after.unwrap_or(""), limit as i64],
                |row| {
                    Ok(SourceAffectedPage {
                        page_id: row.get(0)?,
                        title: row.get(1)?,
                        human_edited: row.get(2)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
pub(crate) fn require_current_source(
    db: &Connection,
    library: &str,
    source: &str,
    revision: &str,
) -> Result<()> {
    let valid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_source_lifecycle WHERE library_id=?1 AND source_id=?2 AND current_revision=?3 AND removed=0)",params![library,source,revision],|row|row.get(0))?;
    ensure!(valid, "source is removed or its revision changed");
    Ok(())
}

impl KnowledgeCatalog {
    pub fn list_removed_sources(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SourceRevision>> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "source limit must be 1..100");
        let mut statement = self.connection.prepare("SELECT s.source_id,s.revision_id,s.title,s.body_hash FROM knowledge_sources s JOIN knowledge_source_lifecycle l ON l.library_id=s.library_id AND l.source_id=s.source_id AND l.current_revision=s.revision_id WHERE s.library_id=?1 AND l.removed=1 AND s.source_id>?2 ORDER BY s.source_id LIMIT ?3")?;
        Ok(statement
            .query_map(params![library, after.unwrap_or(""), limit as i64], |row| {
                Ok(SourceRevision {
                    removed: true,
                    source_id: row.get(0)?,
                    revision_id: row.get(1)?,
                    title: row.get(2)?,
                    body_hash: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
