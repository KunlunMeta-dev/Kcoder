//! Scoped maintenance never rewrites source/history data or revives paused work.
use crate::{KnowledgeCatalog, KnowledgeScope, Library};
use anyhow::{Result, ensure};
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiIndexReport {
    pub source_chunks: usize,
    pub current_pages: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiInspectionIssue {
    pub record_id: String,
    pub code: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiInspection {
    pub checked_records: usize,
    pub issues: Vec<WikiInspectionIssue>,
    pub omitted_issues: usize,
    pub next_cursor: Option<String>,
}
impl WikiInspection {
    fn issue(&mut self, record: &str, code: &'static str) {
        if self.issues.len() < 200 {
            self.issues.push(WikiInspectionIssue {
                record_id: record.into(),
                code,
            });
        } else {
            self.omitted_issues += 1;
        }
    }
}
impl KnowledgeCatalog {
    pub fn set_archived(
        &mut self,
        scope: &KnowledgeScope,
        id: &str,
        expected_revision: u64,
        archived: bool,
    ) -> Result<Library> {
        let current = self.read(scope, id)?;
        ensure!(
            expected_revision <= i64::MAX as u64,
            "invalid library revision"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let changed = tx.execute("UPDATE libraries SET archived=?4,metadata_revision=metadata_revision+1 WHERE id=?1 AND principal=?2 AND target=?3 AND metadata_revision=?5", params![id,scope.principal,scope.target,archived,expected_revision as i64])?;
        ensure!(changed == 1, "library revision conflict");
        if archived {
            tx.execute("UPDATE knowledge_jobs SET status='paused',error_code='library_archived',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND status IN ('queued','running')", [id])?;
            tx.execute(
                "DELETE FROM knowledge_defaults WHERE principal=?1 AND target=?2 AND library_id=?3",
                params![scope.principal, scope.target, id],
            )?;
        }
        tx.commit()?;
        Ok(Library {
            archived,
            revision: expected_revision + 1,
            ..current
        })
    }

    /// Replace derived rows atomically. Any missing/corrupt page object rolls back
    /// the entire rebuild; another library's index and all durable jobs survive.
    pub fn rebuild_index(&mut self, scope: &KnowledgeScope, id: &str) -> Result<WikiIndexReport> {
        self.read(scope, id)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("DELETE FROM knowledge_fts WHERE library_id=?1", [id])?;
        let mut report = WikiIndexReport {
            source_chunks: 0,
            current_pages: 0,
        };
        {
            let mut statement = tx.prepare("SELECT c.source_id,c.revision_id,c.chunk_id,s.title,c.text FROM knowledge_chunks c JOIN knowledge_sources s ON s.library_id=c.library_id AND s.source_id=c.source_id AND s.revision_id=c.revision_id WHERE c.library_id=?1 ORDER BY c.source_id,c.revision_id,c.ordinal")?;
            let mut rows = statement.query([id])?;
            while let Some(row) = rows.next()? {
                let source: String = row.get(0)?;
                let revision: String = row.get(1)?;
                let chunk: String = row.get(2)?;
                let title: String = row.get(3)?;
                let text: String = row.get(4)?;
                // Multiple immutable revisions can share a source/chunk ID.
                // After the scoped clear, insert each revision without deleting
                // rows belonging to its historical siblings.
                tx.execute("INSERT INTO knowledge_fts(library_id,document_id,revision_id,display_title,original_body,title_terms,body_terms) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,format!("source:{source}:{chunk}"),revision,title,text,crate::search::tokenize(&title).join(" "),crate::search::tokenize(&text).join(" ")])?;
                report.source_chunks += 1;
            }
        }
        {
            let mut statement = tx.prepare("SELECT p.page_id,p.current_revision,r.title,r.body_hash FROM knowledge_pages p JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision WHERE p.library_id=?1 ORDER BY p.page_id")?;
            let mut rows = statement.query([id])?;
            while let Some(row) = rows.next()? {
                let page: String = row.get(0)?;
                let revision: String = row.get(1)?;
                let title: String = row.get(2)?;
                let hash: String = row.get(3)?;
                let body = self.objects.read(id, &hash)?;
                crate::search::replace_index(&tx, id, &page, &revision, &title, &body)?;
                report.current_pages += 1;
            }
        }
        let expected_chunks: usize = tx.query_row(
            "SELECT COUNT(*) FROM knowledge_chunks WHERE library_id=?1",
            [id],
            |row| row.get(0),
        )?;
        ensure!(
            report.source_chunks == expected_chunks,
            "source chunk revision is missing"
        );
        let expected_pages: usize = tx.query_row(
            "SELECT COUNT(*) FROM knowledge_pages WHERE library_id=?1",
            [id],
            |row| row.get(0),
        )?;
        ensure!(
            report.current_pages == expected_pages,
            "current page revision is missing"
        );
        tx.commit()?;
        Ok(report)
    }

    /// Bounded, read-only integrity inspection. Cursors cover current Wiki pages,
    /// immutable source objects and retained raw documents. No host paths leak.
    pub fn inspect_library(
        &self,
        scope: &KnowledgeScope,
        id: &str,
        after: Option<&str>,
        limit: usize,
    ) -> Result<WikiInspection> {
        self.read(scope, id)?;
        ensure!((1..=50).contains(&limit), "inspection limit must be 1..50");
        ensure!(
            after.is_none_or(|cursor| cursor.len() <= 256),
            "invalid inspection cursor"
        );
        let mut statement = self.connection.prepare("SELECT cursor,record_id,hash,kind FROM (SELECT 'page:'||page_id AS cursor,page_id AS record_id,'' AS hash,'page' AS kind FROM knowledge_pages WHERE library_id=?1 UNION ALL SELECT 'source:'||source_id||':'||revision_id,source_id,body_hash,'source' FROM knowledge_sources WHERE library_id=?1 UNION ALL SELECT 'original:'||source_id||':'||revision_id,source_id,raw_hash,'original' FROM knowledge_originals WHERE library_id=?1) WHERE cursor>?2 ORDER BY cursor LIMIT ?3")?;
        let records = statement
            .query_map(
                params![id, after.unwrap_or(""), (limit + 1) as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut report = WikiInspection {
            checked_records: 0,
            issues: Vec::new(),
            omitted_issues: 0,
            next_cursor: None,
        };
        for (cursor, record, hash, kind) in records.iter().take(limit) {
            report.checked_records += 1;
            if records.len() > limit {
                report.next_cursor = Some(cursor.clone());
            }
            if kind != "page" {
                if self.objects.read_bytes(id, hash).is_err() {
                    report.issue(record, "source_object_unavailable");
                }
                continue;
            }
            let page = match self.read_page(scope, id, record, None) {
                Ok(page) => page,
                Err(_) => {
                    report.issue(record, "page_object_unavailable");
                    continue;
                }
            };
            for related in &page.draft.related_page_ids {
                let exists: bool = self.connection.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_pages WHERE library_id=?1 AND page_id=?2)",params![id,related], |row|row.get(0))?;
                if !exists {
                    report.issue(record, "broken_related_page");
                }
            }
            for citation in &page.draft.citations {
                match self.resolve_citation(
                    scope,
                    id,
                    &citation.source_id,
                    &citation.revision_id,
                    &citation.chunk_id,
                ) {
                    Ok((_, chunk))
                        if !citation.quote.is_empty() && chunk.text.contains(&citation.quote) => {}
                    _ => report.issue(record, "broken_source_citation"),
                }
            }
        }
        Ok(report)
    }
}
