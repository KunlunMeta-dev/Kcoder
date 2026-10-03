//! Bounded current-page navigation metadata; no Markdown object is read here.
use crate::{KnowledgeCatalog, KnowledgeScope};
use anyhow::{Result, ensure};
use rusqlite::params;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageLink {
    pub page_id: String,
    pub title: String,
    pub human_edited: bool,
    pub revision_id: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiPageLinks {
    pub outgoing: Vec<WikiPageLink>,
    pub incoming: Vec<WikiPageLink>,
    pub outgoing_truncated: bool,
    pub incoming_truncated: bool,
}

impl KnowledgeCatalog {
    pub fn page_links(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        page: &str,
        limit: usize,
    ) -> Result<WikiPageLinks> {
        self.read(scope, library)?;
        ensure!((1..=20).contains(&limit), "page link limit must be 1..20");
        // One SQL statement keeps origin existence and both link directions on
        // the same database snapshot. The sentinel distinguishes an empty page's
        // navigation from a missing page without reading its body object.
        let mut statement = self.connection.prepare(
            "WITH origin AS (
                SELECT p.page_id,r.related_json FROM knowledge_pages p
                JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision
                WHERE p.library_id=?1 AND p.page_id=?2
            ), outgoing AS (
                SELECT DISTINCT p.page_id,r.title,p.human_edited,p.current_revision
                FROM origin o JOIN json_each(o.related_json) j
                JOIN knowledge_pages p ON p.library_id=?1 AND p.page_id=j.value AND p.page_id<>?2
                JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision
                ORDER BY p.page_id LIMIT ?3
            ), incoming AS (
                SELECT p.page_id,r.title,p.human_edited,p.current_revision
                FROM knowledge_pages p
                JOIN knowledge_page_revisions r ON r.library_id=p.library_id AND r.page_id=p.page_id AND r.revision_id=p.current_revision
                WHERE p.library_id=?1 AND p.page_id<>?2
                AND EXISTS(SELECT 1 FROM origin)
                AND EXISTS(SELECT 1 FROM json_each(r.related_json) j WHERE j.value=?2)
                ORDER BY p.page_id LIMIT ?3
            )
            SELECT 0,'','',0,'' FROM origin
            UNION ALL SELECT 1,page_id,title,human_edited,current_revision FROM outgoing
            UNION ALL SELECT 2,page_id,title,human_edited,current_revision FROM incoming"
        )?;
        let mut rows = statement.query(params![library, page, (limit + 1) as i64])?;
        let mut exists = false;
        let mut result = WikiPageLinks {
            outgoing: Vec::new(),
            incoming: Vec::new(),
            outgoing_truncated: false,
            incoming_truncated: false,
        };
        while let Some(row) = rows.next()? {
            let direction: i64 = row.get(0)?;
            if direction == 0 {
                exists = true;
                continue;
            }
            let link = WikiPageLink {
                page_id: row.get(1)?,
                title: row.get(2)?,
                human_edited: row.get(3)?,
                revision_id: row.get(4)?,
            };
            if direction == 1 {
                result.outgoing.push(link);
            } else {
                result.incoming.push(link);
            }
        }
        ensure!(exists, "knowledge page not found");
        result.outgoing_truncated = result.outgoing.len() > limit;
        result.incoming_truncated = result.incoming.len() > limit;
        result.outgoing.truncate(limit);
        result.incoming.truncate(limit);
        Ok(result)
    }
}
