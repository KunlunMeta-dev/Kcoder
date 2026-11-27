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
            document.title.len() <= 4096 && document.body.len() <= crate::WIKI_MAX_PAGE_BYTES,
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
        let terms = query_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        // Version-1 index already contains identifiers and CJK bigrams. Query
        // only those when available: common single characters cannot fill a
        // multi-character query's evidence threshold. No reindex or model call.
        let expression = |join: &str| {
            terms
                .iter()
                .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(join)
        };
        let mut hits = self.search_candidates(library, &expression(" AND "), query, &terms)?;
        rank_candidates(&mut hits);
        let mut selected = Vec::new();
        let mut groups = BTreeSet::new();
        select_unique(hits, &mut groups, &mut selected, limit);
        if selected.len() < limit && terms.len() > 1 {
            // Broad retrieval is only attempted after strict unique results are
            // insufficient. It still requires >=60% identifier/bigram evidence
            // (at least two), so weak overlap does not imply an answer.
            let mut broad = self.search_candidates(library, &expression(" OR "), query, &terms)?;
            let minimum = (terms.len() * 3).div_ceil(5).max(2);
            broad.retain(|candidate| {
                candidate.matched >= minimum
                    || (candidate.contained_title && candidate.matched >= terms.len().div_ceil(2))
            });
            rank_candidates(&mut broad);
            select_unique(broad, &mut groups, &mut selected, limit);
        }
        Ok(selected)
    }

    fn search_candidates(
        &self,
        library: &str,
        expression: &str,
        query: &str,
        terms: &[String],
    ) -> Result<Vec<Candidate>> {
        // Rank metadata first, keeping at most three chunks per logical source
        // before the 256-body candidate bound. A large source cannot occupy the
        // entire candidate window and hide unrelated pages or other sources.
        // Lifecycle filtering happens in SQL before LIMIT; historical references
        // remain available through resolve_citation, never through broad search.
        let mut statement = self.connection.prepare(
            "WITH scored AS MATERIALIZED (
                SELECT rowid,document_id,bm25(knowledge_fts,0,0,0,0,0,8,1) AS score
                FROM knowledge_fts WHERE knowledge_fts MATCH ?1 AND library_id=?2
                AND (document_id NOT LIKE 'source:%' OR EXISTS(
                    SELECT 1 FROM knowledge_source_lifecycle l
                    WHERE l.library_id=knowledge_fts.library_id AND l.removed=0
                    AND l.current_revision=knowledge_fts.revision_id
                    AND l.source_id=substr(knowledge_fts.document_id,8,36)
                    AND substr(knowledge_fts.document_id,44,1)=':'))
             ), grouped AS (
                SELECT rowid,document_id,score,ROW_NUMBER() OVER (
                    PARTITION BY CASE WHEN document_id LIKE 'source:%'
                        THEN substr(document_id,1,43) ELSE document_id END
                    ORDER BY score,document_id,rowid) AS group_rank FROM scored
             ), candidates AS (
                SELECT rowid,score FROM grouped WHERE group_rank<=3
                ORDER BY score,document_id,rowid LIMIT 256
             )
             SELECT f.document_id,f.revision_id,f.display_title,f.original_body,c.score
             FROM candidates c JOIN knowledge_fts f ON f.rowid=c.rowid
             ORDER BY c.score,f.document_id",
        )?;
        let rows = statement.query_map(params![expression, library], |row| {
            let title: String = row.get(2)?;
            let body: String = row.get(3)?;
            let lower_title = title.to_lowercase();
            let lower_body = body.to_lowercase();
            let matched = terms
                .iter()
                .filter(|term| term_matches(&lower_title, term) || term_matches(&lower_body, term))
                .count();
            let title_matches = terms
                .iter()
                .filter(|term| term_matches(&lower_title, term))
                .count();
            let normalized = query.trim().to_lowercase();
            let phrase = usize::from(lower_body.contains(&normalized))
                + 2 * usize::from(lower_title.contains(&normalized));
            let contained_title = title.chars().count() >= 4 && normalized.contains(&lower_title);
            Ok(Candidate {
                contained_title,
                matched,
                title_matches,
                phrase,
                hit: KnowledgeHit {
                    document_id: row.get(0)?,
                    revision_id: row.get(1)?,
                    title,
                    excerpt: excerpt(&body, query),
                    bm25: row.get(4)?,
                },
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
        let cjk = is_cjk(ch);
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

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32, 0x3400..=0x9fff | 0x3040..=0x30ff | 0xac00..=0xd7af | 0x20000..=0x2fa1f)
}

// Match the version-1 token boundaries without allocating every body token for
// every candidate. Latin identifiers must be complete (v1 never matches v10).
fn term_matches(normalized: &str, term: &str) -> bool {
    if term.chars().all(is_cjk) {
        return normalized.contains(term);
    }
    let identifier_char = |ch: char| !is_cjk(ch) && (ch.is_alphanumeric() || ch == '_');
    normalized.match_indices(term).any(|(offset, _)| {
        normalized[..offset]
            .chars()
            .next_back()
            .is_none_or(|ch| !identifier_char(ch))
            && normalized[offset + term.len()..]
                .chars()
                .next()
                .is_none_or(|ch| !identifier_char(ch))
    })
}

struct Candidate {
    hit: KnowledgeHit,
    contained_title: bool,
    matched: usize,
    title_matches: usize,
    phrase: usize,
}

fn query_terms(query: &str) -> Vec<String> {
    let tokens: BTreeSet<_> = tokenize(query).into_iter().collect();
    let strong: Vec<_> = tokens
        .iter()
        .filter(|term| term.chars().count() > 1)
        .take(64)
        .cloned()
        .collect();
    if !strong.is_empty() {
        return strong;
    }
    // Explicit single-character lookup is retained, except grammatical particles.
    tokens
        .into_iter()
        .filter(|term| !"的了是在和与及或吗呢".contains(term.as_str()))
        .take(64)
        .collect()
}

fn rank_candidates(candidates: &mut [Candidate]) {
    candidates.sort_by(|a, b| {
        b.phrase
            .cmp(&a.phrase)
            .then_with(|| b.title_matches.cmp(&a.title_matches))
            .then_with(|| b.matched.cmp(&a.matched))
            .then_with(|| a.hit.bm25.total_cmp(&b.hit.bm25))
            .then_with(|| a.hit.document_id.cmp(&b.hit.document_id))
    });
}

fn document_group(document: &str) -> &str {
    if let Some(source) = document.strip_prefix("source:")
        && let Some(end) = source.find(':')
    {
        return &document[..end + 7];
    }
    document
}

fn select_unique(
    candidates: Vec<Candidate>,
    groups: &mut BTreeSet<String>,
    hits: &mut Vec<KnowledgeHit>,
    limit: usize,
) {
    for candidate in candidates {
        if hits.len() >= limit {
            break;
        }
        if groups.insert(document_group(&candidate.hit.document_id).to_string()) {
            hits.push(candidate.hit);
        }
    }
}

fn excerpt(body: &str, query: &str) -> String {
    let lower = body.to_lowercase();
    // Locate the complete phrase first, then the longest actual identifier or
    // bigram. Never center a long query's snippet on a shared grammatical letter.
    let mut terms = query_terms(query);
    terms.sort_by_key(|term| std::cmp::Reverse(term.chars().count()));
    let offset = lower
        .find(&query.trim().to_lowercase())
        .or_else(|| terms.iter().find_map(|term| lower.find(term)))
        .unwrap_or(0);
    // Lowercasing can change UTF-8 length (İ -> i + combining dot). Offsets into
    // the normalized string are converted to character positions, never used to
    // slice the original body's UTF-8 bytes.
    let mut normalized_bytes = 0;
    let before = body
        .chars()
        .take_while(|ch| {
            if normalized_bytes >= offset {
                return false;
            }
            normalized_bytes += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
            true
        })
        .count();
    let start = before.saturating_sub(80);
    let snippet: String = body.chars().skip(start).take(320).collect();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        snippet,
        if body.chars().count() > start + 320 {
            "…"
        } else {
            ""
        }
    )
}

pub(crate) fn replace_index(
    db: &Connection,
    library: &str,
    id: &str,
    revision: &str,
    title: &str,
    body: &str,
) -> Result<()> {
    ensure!(
        title.len() <= 4096 && body.len() <= crate::WIKI_MAX_PAGE_BYTES,
        "index page too large"
    );
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

    #[test]
    fn strict_title_phrase_precedes_broad_and_common_characters_do_not_answer() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("search.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let library = store.create(&scope, "search", "Wiki", "")?;
        for (id, title, body) in [
            ("phrase", "数据库事务", "数据库事务支持原子提交"),
            ("body", "笔记", "数据库事务支持原子提交"),
            ("broad", "数据库", "数据库资料"),
            ("common", "量变", "我们有的知识和常用字符"),
        ] {
            store.index_document(
                &scope,
                &library.id,
                &IndexedDocument {
                    id: id.into(),
                    revision_id: "r1".into(),
                    title: title.into(),
                    body: body.into(),
                },
            )?;
        }
        let hits = store.search(&scope, &library.id, "数据库事务", 5)?;
        assert_eq!(hits[0].document_id, "phrase");
        assert_eq!(hits[1].document_id, "body");
        assert!(!hits.iter().any(|hit| hit.document_id == "common"));
        for query in [
            "量子退火知识库配置",
            "海豚语音翻译插件",
            "的",
            "不存在的代号xxyy",
        ] {
            assert!(
                store.search(&scope, &library.id, query, 5)?.is_empty(),
                "{query}"
            );
        }
        // Incomplete lexical evidence can be offered after strict results.
        assert!(
            store
                .search(&scope, &library.id, "数据库事务异常", 5)?
                .iter()
                .any(|hit| hit.document_id == "phrase")
        );
        Ok(())
    }

    #[test]
    fn excerpts_locate_real_phrase_case_and_unicode_without_false_early_unigrams() {
        let body = format!(
            "{}{}SQLite migration 真正匹配的数据库事务{}",
            "的资料".repeat(160),
            "İ".repeat(100),
            "尾".repeat(400)
        );
        let hit = excerpt(&body, "SQLite migration");
        assert!(hit.contains("SQLite migration"));
        assert!(hit.starts_with('…'));
        assert!(hit.ends_with('…'));
        assert!(excerpt(&body, "数据库事务").contains("数据库事务"));
        assert!(excerpt("ABC_key evidence", "abc_KEY").contains("ABC_key"));
    }

    #[test]
    fn repeated_source_chunks_group_without_losing_page_or_historical_citation() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("search.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let library = store.create(&scope, "search", "Wiki", "")?;
        let chunks = (1..=300)
            .map(|ordinal| crate::SourceChunk {
                page: Some(ordinal as u32),
                ordinal,
                chunk_id: format!("chunk-{ordinal}"),
                first_line: ordinal,
                last_line: ordinal,
                text: "数据库事务证据".into(),
            })
            .collect();
        let source = store.import_extracted(
            &scope,
            &library.id,
            "source",
            "数据库事务",
            b"raw",
            "pdf",
            chunks,
        )?;
        store.index_document(
            &scope,
            &library.id,
            &IndexedDocument {
                id: "page".into(),
                revision_id: "r1".into(),
                title: "笔记".into(),
                body: format!("数据库事务引用{}", " unrelated".repeat(100)),
            },
        )?;
        let hits = store.search(&scope, &library.id, "数据库事务", 5)?;
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits.iter()
                .filter(|hit| hit.document_id.starts_with("source:"))
                .count(),
            1
        );
        let (_, historical) = store.resolve_citation(
            &scope,
            &library.id,
            &source.source_id,
            &source.revision_id,
            "chunk-6",
        )?;
        assert_eq!(historical.page, Some(6));
        store.set_source_removed(
            &scope,
            &library.id,
            &source.source_id,
            &source.revision_id,
            true,
        )?;
        for query in ["数据库事务", "数据库事务异常"] {
            let hits = store.search(&scope, &library.id, query, 5)?;
            assert_eq!(hits.len(), 1, "{query}");
            assert_eq!(hits[0].document_id, "page");
        }
        assert!(
            store
                .resolve_citation(
                    &scope,
                    &library.id,
                    &source.source_id,
                    &source.revision_id,
                    "chunk-6"
                )?
                .0
                .removed
        );
        Ok(())
    }
    #[test]
    fn identifiers_filenames_and_same_title_pages_keep_precise_boundaries() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("files.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let library = store.create(&scope, "files", "Wiki", "")?;
        for (id, body) in [
            ("one", "wiki_search_bench.rs v1 API_key"),
            ("two", "wiki_search_other.rs v10 API_keys"),
        ] {
            store.index_document(
                &scope,
                &library.id,
                &IndexedDocument {
                    id: id.into(),
                    revision_id: "r1".into(),
                    title: "同名页面".into(),
                    body: body.into(),
                },
            )?;
        }
        assert_eq!(store.search(&scope, &library.id, "同名页面", 5)?.len(), 2);
        for query in ["wiki_search_bench.rs", "v1", "API_key"] {
            let hits = store.search(&scope, &library.id, query, 5)?;
            assert_eq!(hits.len(), 1, "{query}");
            assert_eq!(hits[0].document_id, "one");
        }
        assert!(!term_matches("v10 API_keys", "v1"));
        assert!(term_matches("库sqlite资料", "sqlite"));
        Ok(())
    }
    #[test]
    fn full_supported_page_tail_is_indexed_and_oversize_write_preserves_old_row() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&dir.path().join("large.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let library = store.create(&scope, "large", "Wiki", "")?;
        let body = format!("{}tail_boundary_marker", "x ".repeat(256 * 1024));
        let mut document = IndexedDocument {
            id: "large".into(),
            revision_id: "r1".into(),
            title: "大页面".into(),
            body,
        };
        store.index_document(&scope, &library.id, &document)?;
        assert!(
            store.search(&scope, &library.id, "tail_boundary_marker", 5)?[0]
                .excerpt
                .contains("tail_boundary_marker")
        );
        document.body = "x".repeat(crate::WIKI_MAX_PAGE_BYTES + 1);
        document.revision_id = "r2".into();
        assert!(
            store
                .index_document(&scope, &library.id, &document)
                .is_err()
        );
        assert_eq!(
            store.search(&scope, &library.id, "tail_boundary_marker", 5)?[0].revision_id,
            "r1"
        );
        Ok(())
    }
}
