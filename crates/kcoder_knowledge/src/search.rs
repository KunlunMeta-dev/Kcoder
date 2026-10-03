//! Deterministic lexical retrieval. No embedding service or model is required.
use crate::{KnowledgeCatalog, KnowledgeScope};
use anyhow::{Result, ensure};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone)]
pub struct IndexedDocument {
    pub id: String,
    pub revision_id: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHit {
    pub document_id: String,
    pub revision_id: String,
    pub title: String,
    pub excerpt: String,
    /// SQLite BM25: lower is better. Do not add unrelated positive scores.
    pub bm25: f64,
}

impl KnowledgeCatalog {
    /// An index record is derived data; callers must persist the source revision first.
    pub fn index_document(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        document: &IndexedDocument,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            !document.id.is_empty() && document.id.len() <= 128,
            "invalid document id"
        );
        ensure!(
            !document.revision_id.is_empty() && document.revision_id.len() <= 128,
            "invalid revision id"
        );
        ensure!(
            document.title.len() <= 4096 && document.body.len() <= 256 * 1024,
            "index chunk too large"
        );
        let title_terms = tokenize(&document.title).join(" ");
        let body_terms = tokenize(&document.body).join(" ");
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM knowledge_fts WHERE library_id=?1 AND document_id=?2",
            params![library, document.id],
        )?;
        transaction.execute(
            "INSERT INTO knowledge_fts(library_id,document_id,revision_id,display_title,original_body,title_terms,body_terms) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![library, document.id, document.revision_id, document.title, document.body, title_terms, body_terms],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn search(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<KnowledgeHit>> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        ensure!((1..=50).contains(&limit), "search limit must be 1..50");
        ensure!(query.len() <= 4096, "search query too large");
        let terms: BTreeSet<_> = tokenize(query).into_iter().collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        // Never pass model/user FTS syntax through. Bound expression complexity.
        let expression = terms
            .into_iter()
            .take(64)
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut statement = self.connection.prepare(
            "SELECT document_id,revision_id,display_title,original_body,bm25(knowledge_fts,0,0,0,0,0,5,1)
             FROM knowledge_fts WHERE knowledge_fts MATCH ?1 AND library_id=?2 AND (document_id NOT LIKE 'source:%' OR EXISTS(SELECT 1 FROM knowledge_source_lifecycle l WHERE l.library_id=knowledge_fts.library_id AND l.removed=0 AND l.current_revision=knowledge_fts.revision_id AND l.source_id=substr(knowledge_fts.document_id,8,36) AND substr(knowledge_fts.document_id,44,1)=':'))
             ORDER BY bm25(knowledge_fts,0,0,0,0,0,5,1),document_id LIMIT ?3"
        )?;
        let rows = statement.query_map(params![expression, library, limit as i64], |row| {
            let body: String = row.get(3)?;
            Ok(KnowledgeHit {
                document_id: row.get(0)?,
                revision_id: row.get(1)?,
                title: row.get(2)?,
                excerpt: excerpt(&body, query),
                bm25: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

// Version 1: CJK unigrams + overlapping bigrams, Latin identifiers preserved.
// This is an initial deterministic candidate generator, not semantic search.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut latin = String::new();
    let mut previous_cjk = None;
    for ch in text.chars() {
        let cjk = matches!(ch as u32, 0x3400..=0x9fff | 0x3040..=0x30ff | 0xac00..=0xd7af | 0x20000..=0x2fa1f);
        if cjk {
            if !latin.is_empty() {
                out.push(std::mem::take(&mut latin));
            }
            out.push(ch.to_string());
            if let Some(previous) = previous_cjk {
                out.push(format!("{previous}{ch}"));
            }
            previous_cjk = Some(ch);
        } else {
            previous_cjk = None;
            if ch.is_alphanumeric() || ch == '_' {
                latin.extend(ch.to_lowercase());
            } else if !latin.is_empty() {
                out.push(std::mem::take(&mut latin));
            }
        }
    }
    if !latin.is_empty() {
        out.push(latin);
    }
    out
}

fn excerpt(body: &str, query: &str) -> String {
    let terms = tokenize(query);
    let offset = terms
        .iter()
        .filter_map(|term| body.find(term))
        .min()
        .unwrap_or(0);
    let before = body[..offset].chars().count();
    body.chars()
        .skip(before.saturating_sub(80))
        .take(320)
        .collect()
}

pub(crate) fn replace_index(
    db: &Connection,
    library: &str,
    id: &str,
    revision: &str,
    title: &str,
    body: &str,
) -> Result<()> {
    db.execute(
        "DELETE FROM knowledge_fts WHERE library_id=?1 AND document_id=?2",
        params![library, id],
    )?;
    db.execute("INSERT INTO knowledge_fts(library_id,document_id,revision_id,display_title,original_body,title_terms,body_terms) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![library,id,revision,title,body,tokenize(title).join(" "),tokenize(body).join(" ")])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chinese_english_and_identity_scoped_search_without_models() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("knowledge.sqlite"))?;
        let alice = KnowledgeScope::from_authenticated_host("alice", "ssh")?;
        let bob = KnowledgeScope::from_authenticated_host("bob", "ssh")?;
        let wiki = store.create(&alice, "create", "Wiki", "")?;
        store.index_document(
            &alice,
            &wiki.id,
            &IndexedDocument {
                id: "source-1".into(),
                revision_id: "r1".into(),
                title: "知识库整理".into(),
                body: "资料保留来源，使用 SQLite FTS5 和 API_key。".into(),
            },
        )?;
        for query in ["知识库", "来源", "SQLite", "FTS5", "API_key", "知"] {
            let hits = store.search(&alice, &wiki.id, query, 10)?;
            assert_eq!(hits.len(), 1, "{query}");
            assert_eq!(hits[0].revision_id, "r1");
        }
        assert!(store.search(&alice, &wiki.id, "unrelated", 10)?.is_empty());
        assert!(store.search(&bob, &wiki.id, "知识", 10).is_err());
        assert!(store.search(&alice, &wiki.id, "\" OR * NOT :", 10).is_ok());
        store.index_document(
            &alice,
            &wiki.id,
            &IndexedDocument {
                id: "source-1".into(),
                revision_id: "r2".into(),
                title: "更新".into(),
                body: "revised".into(),
            },
        )?;
        assert!(store.search(&alice, &wiki.id, "SQLite", 10)?.is_empty());
        assert_eq!(
            store.search(&alice, &wiki.id, "revised", 10)?[0].revision_id,
            "r2"
        );
        Ok(())
    }
}
