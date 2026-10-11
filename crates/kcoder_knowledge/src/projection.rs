//! Explicit Markdown export/reimport boundary. Host clients may package these
//! fixed flat names as ZIP entries; this domain layer never interprets a path.
use crate::{KnowledgeCatalog, KnowledgeScope, PageRevisionRef, objects::digest};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAGES: usize = 1000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiMarkdownBundle {
    pub format: String,
    pub version: u32,
    pub library_id: String,
    pub pages: Vec<WikiMarkdownPage>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiMarkdownPage {
    pub page_id: String,
    pub base_revision: String,
    /// Exactly <pageId>.md; never a user-supplied filesystem path.
    pub name: String,
    pub title: String,
    pub body: String,
}

impl KnowledgeCatalog {
    pub fn export_markdown_bundle(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
    ) -> Result<Vec<u8>> {
        let tx = self.connection.transaction()?;
        let owned: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM libraries WHERE id=?1 AND principal=?2 AND target=?3)",
            params![library, scope.principal, scope.target],
            |row| row.get(0),
        )?;
        ensure!(owned, "knowledge library not found");
        let mut pages = Vec::new();
        let mut size = 256;
        {
            let mut statement=tx.prepare("SELECT p.page_id,p.current_revision,r.title,r.body_hash FROM knowledge_pages p JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision WHERE p.library_id=?1 ORDER BY p.page_id LIMIT 1001")?;
            let mut rows = statement.query([library])?;
            while let Some(row) = rows.next()? {
                ensure!(
                    pages.len() < MAX_PAGES,
                    "Markdown export exceeds 1000 pages"
                );
                let page_id: String = row.get(0)?;
                let page = WikiMarkdownPage {
                    name: format!("{page_id}.md"),
                    page_id,
                    base_revision: row.get(1)?,
                    title: row.get(2)?,
                    body: self.objects.read(library, &row.get::<_, String>(3)?)?,
                };
                size += serde_json::to_vec(&page)?.len() + 128;
                ensure!(size <= MAX_BYTES, "Markdown export exceeds 16 MiB");
                pages.push(page);
            }
            let expected: usize = tx.query_row(
                "SELECT COUNT(*) FROM knowledge_pages WHERE library_id=?1",
                [library],
                |row| row.get(0),
            )?;
            ensure!(expected == pages.len(), "current page revision is missing");
        }
        ensure!(!pages.is_empty(), "Wiki has no pages to export");
        let bundle = WikiMarkdownBundle {
            format: "kcoder-wiki-markdown".into(),
            version: 1,
            library_id: library.into(),
            pages,
        };
        let bytes = serde_json::to_vec(&bundle)?;
        ensure!(bytes.len() <= MAX_BYTES, "Markdown export exceeds 16 MiB");
        tx.commit()?;
        Ok(bytes)
    }

    /// Explicit user-requested rescan/reimport, not a watcher or model action.
    /// Missing entries do not delete pages. One stale page rejects the entire
    /// batch; unchanged bodies/title create no revisions. Receipts are batch-wide.
    pub fn import_markdown_bundle(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        key: &str,
        bytes: &[u8],
    ) -> Result<Vec<PageRevisionRef>> {
        self.read(scope, library)?;
        ensure!(
            !key.trim().is_empty() && key.len() <= 100,
            "invalid Markdown import key"
        );
        ensure!(bytes.len() <= MAX_BYTES, "Markdown import exceeds 16 MiB");
        let bundle: WikiMarkdownBundle = serde_json::from_slice(bytes)?;
        ensure!(
            bundle.format == "kcoder-wiki-markdown" && bundle.version == 1,
            "unsupported Markdown bundle format"
        );
        ensure!(
            bundle.library_id == library,
            "Markdown bundle belongs to a different Wiki"
        );
        ensure!(
            !bundle.pages.is_empty() && bundle.pages.len() <= MAX_PAGES,
            "invalid Markdown page count"
        );
        let mut ids = BTreeSet::new();
        for page in &bundle.pages {
            ensure!(
                uuid::Uuid::parse_str(&page.page_id)?.to_string() == page.page_id
                    && uuid::Uuid::parse_str(&page.base_revision)?.to_string()
                        == page.base_revision,
                "invalid Markdown page identity"
            );
            ensure!(ids.insert(&page.page_id), "duplicate Markdown page");
            ensure!(
                page.name == format!("{}.md", page.page_id),
                "invalid Markdown entry name"
            );
            ensure!(
                !page.title.trim().is_empty() && page.title.chars().count() <= 240,
                "invalid page title"
            );
            ensure!(
                !page.body.trim().is_empty() && page.body.len() <= crate::WIKI_MAX_PAGE_BYTES,
                "invalid page content size"
            );
        }
        let payload_hash = digest(&serde_json::to_vec(&bundle)?);
        let request_key = format!("markdown-import:{key}");
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let previous:Option<(String,String)>=tx.query_row("SELECT payload_hash,result_json FROM knowledge_commits WHERE library_id=?1 AND request_key=?2",params![library,request_key],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        if let Some((hash, result)) = previous {
            ensure!(hash == payload_hash, "idempotency conflict");
            return Ok(serde_json::from_str(&result)?);
        }
        let mut changed = Vec::new();
        // Preflight every expected revision while holding the write transaction,
        // before writing even one immutable object or page revision.
        for page in &bundle.pages {
            let current:Option<(String,String,String)>=tx.query_row("SELECT p.current_revision,r.title,r.body_hash FROM knowledge_pages p JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision WHERE p.library_id=?1 AND p.page_id=?2",params![library,page.page_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
            let (revision, title, body_hash) =
                current.ok_or_else(|| anyhow::anyhow!("knowledge page not found"))?;
            ensure!(revision == page.base_revision, "revision conflict");
            if title != page.title || body_hash != digest(page.body.as_bytes()) {
                changed.push(page);
            }
        }
        let mut result = Vec::new();
        for page in changed {
            let child_key = format!(
                "projection:{}",
                digest(format!("{request_key}:{}:{payload_hash}", page.page_id).as_bytes())
            );
            result.push(crate::page_edit::human_revision_in_transaction(
                &tx,
                &self.objects,
                library,
                &page.page_id,
                &page.base_revision,
                &child_key,
                &page.title,
                &page.body,
                None,
            )?);
        }
        tx.execute("INSERT INTO knowledge_commits(library_id,request_key,payload_hash,result_json) VALUES(?1,?2,?3,?4)",params![library,request_key,payload_hash,serde_json::to_string(&result)?])?;
        tx.commit()?;
        Ok(result)
    }
}
