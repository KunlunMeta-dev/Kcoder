//! Portable, path-free snapshots. Identity, credentials and jobs never leave the host.
use crate::{KnowledgeCatalog, KnowledgeScope, Library, objects::digest};
use anyhow::{Context, Result, ensure};
use rusqlite::{
    Connection, OptionalExtension, params,
    types::{Value as SqlValue, ValueRef},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const TABLES: &[(&str, &str)] = &[
    (
        "knowledge_sources",
        "source_id,revision_id,request_key,title,body_hash",
    ),
    (
        "knowledge_chunks",
        "source_id,revision_id,chunk_id,ordinal,first_line,last_line,text,page",
    ),
    (
        "knowledge_originals",
        "source_id,revision_id,raw_hash,format",
    ),
    ("knowledge_pages", "page_id,current_revision,human_edited"),
    (
        "knowledge_source_lifecycle",
        "source_id,current_revision,removed",
    ),
    (
        "knowledge_page_revisions",
        "page_id,revision_id,base_revision,title,kind,body_hash,citations_json,related_json,revision_sequence,author,restored_from",
    ),
];
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Archive {
    format: String,
    version: u32,
    name: String,
    purpose: String,
    archived: bool,
    records: BTreeMap<String, Vec<Vec<Value>>>,
    objects: BTreeMap<String, String>,
}
impl KnowledgeCatalog {
    pub fn export_archive(&mut self, scope: &KnowledgeScope, library: &str) -> Result<Vec<u8>> {
        // A read transaction makes the records a consistent snapshot even while
        // a different connection publishes a new immutable revision.
        let tx = self.connection.transaction()?;
        let metadata: (String, String, bool) = tx.query_row(
            "SELECT name,purpose,archived FROM libraries WHERE id=?1 AND principal=?2 AND target=?3",
            params![library, scope.principal, scope.target],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?.ok_or_else(|| anyhow::anyhow!("knowledge library not found"))?;
        let mut archive = Archive {
            format: "kcoder-wiki".into(),
            version: 2,
            name: metadata.0,
            purpose: metadata.1,
            archived: metadata.2,
            records: BTreeMap::new(),
            objects: BTreeMap::new(),
        };
        let mut budget = archive.name.len() + archive.purpose.len() + 1024;
        let mut count = 0;
        let mut hashes = BTreeSet::new();
        for (table, columns) in TABLES {
            let width = columns.split(',').count();
            let mut statement = tx.prepare(&format!(
                "SELECT {columns} FROM {table} WHERE library_id=?1 ORDER BY rowid"
            ))?;
            let mut rows = statement.query([library])?;
            let mut records = Vec::new();
            while let Some(row) = rows.next()? {
                count += 1;
                ensure!(count <= MAX_ROWS, "Wiki snapshot exceeds 100000 records");
                let values = (0..width)
                    .map(|index| -> Result<Value> {
                        Ok(match row.get_ref(index)? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(value) => value.into(),
                            ValueRef::Text(value) => std::str::from_utf8(value)?.into(),
                            _ => anyhow::bail!("unsupported Wiki record value"),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                budget += serde_json::to_vec(&values)?.len() + 1;
                ensure!(
                    budget <= MAX_BYTES,
                    "Wiki snapshot exceeds 64 MiB; export a smaller Wiki"
                );
                for (index, column) in columns.split(',').enumerate() {
                    if matches!(column, "body_hash" | "raw_hash") {
                        hashes.insert(string(&values, index)?.to_owned());
                    }
                }
                records.push(values);
            }
            archive.records.insert((*table).into(), records);
        }
        for hash in hashes {
            let bytes = self.objects.read_bytes(library, &hash)?;
            budget += bytes.len() * 2 + hash.len() + 8;
            ensure!(
                budget <= MAX_BYTES,
                "Wiki snapshot exceeds 64 MiB; export a smaller Wiki"
            );
            archive.objects.insert(hash, encode_hex(&bytes));
        }
        tx.commit()?;
        let bytes = serde_json::to_vec(&archive)?;
        ensure!(
            bytes.len() <= MAX_BYTES,
            "Wiki snapshot exceeds 64 MiB; export a smaller Wiki"
        );
        Ok(bytes)
    }

    pub fn import_archive(
        &mut self,
        scope: &KnowledgeScope,
        request_key: &str,
        bytes: &[u8],
    ) -> Result<Library> {
        ensure!(
            !request_key.trim().is_empty() && request_key.len() <= 128,
            "invalid request key"
        );
        ensure!(bytes.len() <= MAX_BYTES, "Wiki snapshot exceeds 64 MiB");
        let fingerprint = digest(bytes);
        let previous: Option<(String,String)> = self.connection.query_row("SELECT payload_hash,library_id FROM knowledge_archive_receipts WHERE principal=?1 AND target=?2 AND request_key=?3",params![scope.principal,scope.target,request_key],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        if let Some((hash, id)) = previous {
            ensure!(hash == fingerprint, "archive idempotency conflict");
            return self.read(scope, &id);
        }
        let mut archive: Archive =
            serde_json::from_slice(bytes).context("invalid Wiki snapshot JSON")?;
        if archive.version == 1 && !archive.records.contains_key("knowledge_source_lifecycle") {
            let mut current = BTreeMap::new();
            for row in archive
                .records
                .get("knowledge_sources")
                .ok_or_else(|| anyhow::anyhow!("source records missing"))?
            {
                current.insert(string(row, 0)?.to_owned(), string(row, 1)?.to_owned());
            }
            archive.records.insert(
                "knowledge_source_lifecycle".into(),
                current
                    .into_iter()
                    .map(|(source, revision)| vec![source.into(), revision.into(), 0.into()])
                    .collect(),
            );
            archive.version = 2;
        }
        let objects = validate_archive(&archive)?;
        let id = uuid::Uuid::new_v4().to_string();
        let publish = (|| -> Result<()> {
            let tx = self
                .connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            // Concurrent retries must not publish a second library.
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_archive_receipts WHERE principal=?1 AND target=?2 AND request_key=?3)",params![scope.principal,scope.target,request_key],|row|row.get(0))?;
            ensure!(
                !exists,
                "archive request completed concurrently; retry the same request"
            );
            tx.execute("INSERT INTO libraries(id,principal,target,name,purpose,archived,request_key,metadata_revision) VALUES(?1,?2,?3,?4,?5,?6,?7,1)",params![id,scope.principal,scope.target,archive.name,archive.purpose,archive.archived,format!("archive:{id}")])?;
            insert_records(&tx, &id, &archive)?;
            for (hash, content) in &objects {
                ensure!(
                    self.objects.put_bytes(&id, content)? == *hash,
                    "archive hash mismatch"
                );
            }
            tx.execute("INSERT INTO knowledge_archive_receipts(principal,target,request_key,payload_hash,library_id) VALUES(?1,?2,?3,?4,?5)",params![scope.principal,scope.target,request_key,fingerprint,id])?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = publish {
            return Err(self.failed_archive_publication(&id, error));
        }
        // Publication includes all authoritative data. Indexing is derived and
        // done in the same import transaction below, never in a second phase.
        self.read(scope, &id)
    }
}

fn string(row: &[Value], index: usize) -> Result<&str> {
    row.get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("invalid archive string"))
}
fn integer(row: &[Value], index: usize) -> Result<i64> {
    row.get(index)
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("invalid archive integer"))
}
fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 15) as usize] as char);
    }
    result
}
fn decode_hex(text: &str) -> Result<Vec<u8>> {
    ensure!(
        text.len().is_multiple_of(2) && text.len() <= 64 * 1024 * 1024,
        "invalid archive object size"
    );
    let nibble = |byte: u8| -> Result<u8> {
        match byte {
            b'0'..=b'9' => Ok(byte - b'0'),
            b'a'..=b'f' => Ok(byte - b'a' + 10),
            _ => anyhow::bail!("invalid archive object encoding"),
        }
    };
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok(nibble(pair[0])? * 16 + nibble(pair[1])?))
        .collect()
}

fn validate_archive(archive: &Archive) -> Result<BTreeMap<String, Vec<u8>>> {
    let objects = archive
        .objects
        .iter()
        .map(|(hash, encoded)| Ok((hash.clone(), decode_hex(encoded)?)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    validate_archive_with(archive, true, |hash| {
        objects
            .get(hash)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("archive object missing"))
    })?;
    Ok(objects)
}

fn validate_archive_with(
    archive: &Archive,
    verify_hashes: bool,
    mut read_object: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    ensure!(
        archive.format == "kcoder-wiki" && archive.version == 2,
        "unsupported Wiki snapshot version"
    );
    ensure!(
        !archive.name.trim().is_empty()
            && archive.name.chars().count() <= 120
            && archive.purpose.len() <= 32 * 1024,
        "invalid Wiki metadata"
    );
    ensure!(
        archive.records.len() == TABLES.len()
            && archive.records.values().map(Vec::len).sum::<usize>() <= MAX_ROWS,
        "invalid Wiki record count"
    );
    let mut referenced = BTreeSet::new();
    for (table, columns) in TABLES {
        let rows = archive
            .records
            .get(*table)
            .ok_or_else(|| anyhow::anyhow!("missing archive table"))?;
        for row in rows {
            ensure!(
                row.len() == columns.split(',').count(),
                "invalid archive record width"
            );
            for (index, column) in columns.split(',').enumerate() {
                if row[index].is_null()
                    && matches!(column, "base_revision" | "restored_from" | "page")
                {
                    continue;
                }
                if matches!(
                    column,
                    "ordinal"
                        | "first_line"
                        | "last_line"
                        | "revision_sequence"
                        | "page"
                        | "human_edited"
                        | "removed"
                ) {
                    let value = integer(row, index)?;
                    ensure!(
                        if matches!(column, "human_edited" | "removed") {
                            (0..=1).contains(&value)
                        } else {
                            value > 0
                        },
                        "invalid archive record number"
                    );
                } else {
                    let value = string(row, index)?;
                    let field_limit = if column == "citations_json" {
                        crate::ingest::WIKI_MAX_PROPOSAL_BYTES
                    } else {
                        256 * 1024
                    };
                    ensure!(value.len() <= field_limit, "archive field exceeds limit");
                    if matches!(
                        column,
                        "source_id"
                            | "revision_id"
                            | "page_id"
                            | "current_revision"
                            | "base_revision"
                            | "restored_from"
                    ) {
                        ensure!(
                            uuid::Uuid::parse_str(value)
                                .context("invalid archive record id")?
                                .to_string()
                                == value,
                            "archive record id must be canonical"
                        );
                    }
                    if matches!(column, "body_hash" | "raw_hash") {
                        referenced.insert(value.to_owned());
                    }
                }
            }
        }
    }
    ensure!(
        referenced.len() == archive.objects.len(),
        "unexpected or missing archive objects"
    );
    for hash in referenced {
        ensure!(
            archive.objects.contains_key(&hash),
            "archive object missing"
        );
        if verify_hashes {
            let content = read_object(&hash)?;
            ensure!(digest(&content) == hash, "archive object hash mismatch");
        }
    }
    let mut sources = BTreeSet::new();
    let mut requests = BTreeSet::new();
    for row in &archive.records["knowledge_sources"] {
        ensure!(
            sources.insert((string(row, 0)?, string(row, 1)?)) && requests.insert(string(row, 2)?),
            "duplicate source revision"
        );
        ensure!(
            !string(row, 3)?.trim().is_empty() && string(row, 3)?.chars().count() <= 240,
            "invalid source title"
        );
        ensure!(
            !string(row, 2)?.is_empty() && string(row, 2)?.len() <= 128,
            "invalid source request key"
        );
        std::str::from_utf8(&read_object(string(row, 4)?)?).context("invalid source UTF-8")?;
    }
    let mut lifecycle = BTreeSet::new();
    for row in &archive.records["knowledge_source_lifecycle"] {
        ensure!(
            sources.contains(&(string(row, 0)?, string(row, 1)?))
                && lifecycle.insert(string(row, 0)?),
            "invalid source lifecycle"
        );
    }
    ensure!(
        sources.iter().all(|(source, _)| lifecycle.contains(source)),
        "source lifecycle missing"
    );
    let mut chunks = BTreeMap::new();
    let mut ordinals = BTreeSet::new();
    let mut source_chunks: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for row in &archive.records["knowledge_chunks"] {
        let source = string(row, 0)?;
        let revision = string(row, 1)?;
        let chunk = string(row, 2)?;
        ensure!(
            row[7].is_null() || integer(row, 7)? <= u32::MAX as i64,
            "invalid PDF page number"
        );
        source_chunks
            .entry((source, revision))
            .or_default()
            .push((integer(row, 3)?, row));
        ensure!(
            sources.contains(&(source, revision)),
            "chunk source missing"
        );
        ensure!(
            chunks
                .insert((source, revision, chunk), string(row, 6)?)
                .is_none()
                && ordinals.insert((source, revision, integer(row, 3)?)),
            "duplicate source chunk"
        );
        ensure!(
            string(row, 6)?.len() <= 16 * 1024 && integer(row, 4)? <= integer(row, 5)?,
            "invalid source chunk"
        );
    }
    // Quotes are meaningful only if chunk text is actually derived from the
    // retained source object. Reject forged chunk tables even with valid hashes.
    for source in &archive.records["knowledge_sources"] {
        let identity = (string(source, 0)?, string(source, 1)?);
        let mut ordered = source_chunks.remove(&identity).unwrap_or_default();
        ordered.sort_by_key(|(ordinal, _)| *ordinal);
        ensure!(
            !ordered.is_empty() && ordered.len() <= 8192,
            "source chunk count out of range"
        );
        let source_bytes = read_object(string(source, 4)?)?;
        let mut remaining = std::str::from_utf8(&source_bytes)?;
        for (index, (ordinal, row)) in ordered.iter().enumerate() {
            ensure!(
                *ordinal == (index + 1) as i64 && string(row, 2)? == format!("chunk-{}", index + 1),
                "invalid chunk sequence"
            );
            remaining = remaining
                .strip_prefix(string(row, 6)?)
                .ok_or_else(|| anyhow::anyhow!("source chunks differ from original text"))?;
        }
        ensure!(remaining.is_empty(), "source chunks omit original text");
    }
    let mut originals = BTreeSet::new();
    for row in &archive.records["knowledge_originals"] {
        let key = (string(row, 0)?, string(row, 1)?);
        ensure!(
            sources.contains(&key) && originals.insert(key),
            "invalid original document reference"
        );
        ensure!(
            matches!(
                string(row, 3)?,
                "text" | "markdown" | "html" | "pdf" | "docx" | "xlsx" | "pptx" | "image"
            ),
            "invalid original document format"
        );
    }
    let mut pages = BTreeMap::new();
    for row in &archive.records["knowledge_pages"] {
        ensure!(
            pages.insert(string(row, 0)?, string(row, 1)?).is_none(),
            "duplicate current page"
        );
    }
    let mut revisions = BTreeSet::new();
    let mut sequences = BTreeSet::new();
    for row in &archive.records["knowledge_page_revisions"] {
        let page = string(row, 0)?;
        let revision = string(row, 1)?;
        ensure!(
            pages.contains_key(page)
                && revisions.insert((page, revision))
                && sequences.insert((page, integer(row, 8)?)),
            "invalid page revision identity"
        );
        ensure!(
            !string(row, 3)?.trim().is_empty() && string(row, 3)?.chars().count() <= 240,
            "invalid page title"
        );
        let _: kcoder_types::knowledge::KnowledgePageKind = serde_json::from_str(string(row, 4)?)?;
        let page_bytes = read_object(string(row, 5)?)?;
        let body = std::str::from_utf8(&page_bytes)?;
        ensure!(
            !body.trim().is_empty() && body.len() <= crate::WIKI_MAX_PAGE_BYTES,
            "invalid page body"
        );
        ensure!(
            matches!(string(row, 9)?, "model" | "human"),
            "invalid revision author"
        );
        let citations: Vec<kcoder_types::knowledge::KnowledgeCitation> =
            serde_json::from_str(string(row, 6)?)?;
        ensure!(
            !citations.is_empty() && citations.len() <= 128,
            "invalid page citation count"
        );
        for citation in citations {
            let text = chunks
                .get(&(
                    citation.source_id.as_str(),
                    citation.revision_id.as_str(),
                    citation.chunk_id.as_str(),
                ))
                .ok_or_else(|| anyhow::anyhow!("citation source missing"))?;
            ensure!(
                !citation.quote.trim().is_empty()
                    && citation.quote.len() <= 16 * 1024
                    && text.contains(&citation.quote),
                "invalid citation evidence"
            );
        }
        let links: Vec<String> = serde_json::from_str(string(row, 7)?)?;
        ensure!(
            links.len() <= 128
                && links
                    .iter()
                    .all(|id| pages.contains_key(id.as_str()) && id != page),
            "invalid related page reference"
        );
    }
    for (page, current) in pages {
        ensure!(
            revisions.contains(&(page, current)),
            "current page revision missing"
        );
    }
    for row in &archive.records["knowledge_page_revisions"] {
        for index in [2, 10] {
            if let Some(id) = row[index].as_str() {
                ensure!(
                    revisions.contains(&(string(row, 0)?, id)),
                    "historical page revision missing"
                );
            }
        }
    }
    Ok(())
}

fn insert_records(db: &Connection, library: &str, archive: &Archive) -> Result<()> {
    insert_records_with(db, library, archive, |hash| {
        decode_hex(&archive.objects[hash])
    })
}

fn insert_records_with(
    db: &Connection,
    library: &str,
    archive: &Archive,
    mut read_object: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    for (table, columns) in TABLES {
        for row in &archive.records[*table] {
            let mut values = vec![SqlValue::Text(library.into())];
            values.extend(row.iter().map(|value| match value {
                Value::Null => SqlValue::Null,
                Value::String(text) => SqlValue::Text(text.clone()),
                Value::Number(number) => {
                    SqlValue::Integer(number.as_i64().expect("validated integer"))
                }
                _ => unreachable!("validated archive scalar"),
            }));
            let placeholders = (1..=values.len())
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(",");
            db.execute(
                &format!("INSERT INTO {table}(library_id,{columns}) VALUES({placeholders})"),
                rusqlite::params_from_iter(values),
            )?;
        }
    }
    let titles: BTreeMap<_, _> = archive.records["knowledge_sources"]
        .iter()
        .map(|row| Ok(((string(row, 0)?, string(row, 1)?), string(row, 3)?)))
        .collect::<Result<_>>()?;
    for row in &archive.records["knowledge_chunks"] {
        let source = string(row, 0)?;
        let revision = string(row, 1)?;
        let chunk = string(row, 2)?;
        let body = string(row, 6)?;
        let title = titles[&(source, revision)];
        db.execute("INSERT INTO knowledge_fts(library_id,document_id,revision_id,display_title,original_body,title_terms,body_terms) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![library,format!("source:{source}:{chunk}"),revision,title,body,crate::search::tokenize(title).join(" "),crate::search::tokenize(body).join(" ")])?;
    }
    let current: BTreeMap<_, _> = archive.records["knowledge_pages"]
        .iter()
        .map(|row| Ok((string(row, 0)?, string(row, 1)?)))
        .collect::<Result<_>>()?;
    for row in &archive.records["knowledge_page_revisions"] {
        if current[string(row, 0)?] != string(row, 1)? {
            continue;
        }
        let bytes = read_object(string(row, 5)?)?;
        crate::search::replace_index(
            db,
            library,
            string(row, 0)?,
            string(row, 1)?,
            string(row, 3)?,
            std::str::from_utf8(&bytes)?,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};

    #[test]
    fn bounded_large_citation_metadata_survives_both_snapshot_formats() -> Result<()> {
        let root = tempfile::tempdir()?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
        let library = store.create(&scope, "create", "Citations", "")?;
        let quote = "evidence".repeat(1000);
        let source = store.import_text(&scope, &library.id, "source", "Source", &quote)?;
        let page = uuid::Uuid::new_v4().to_string();
        let citation = KnowledgeCitation {
            source_id: source.source_id,
            revision_id: source.revision_id,
            chunk_id: "chunk-1".into(),
            quote,
        };
        store.commit_generated_pages(
            &scope,
            &library.id,
            "commit",
            vec![KnowledgePageDraft {
                page_id: page.clone(),
                expected_revision: None,
                title: "Page".into(),
                kind: KnowledgePageKind::Concept,
                markdown: "Body".into(),
                citations: vec![citation; 128],
                related_page_ids: vec![],
            }],
        )?;
        let bytes = store.export_archive(&scope, &library.id)?;
        let imported = store.import_archive(&scope, "legacy-copy", &bytes)?;
        assert_eq!(
            store
                .read_page(&scope, &imported.id, &page, None)?
                .draft
                .citations
                .len(),
            128
        );
        let mut bytes = Vec::new();
        store.export_archive_stream(&scope, &library.id, &mut bytes, |_| Ok(()))?;
        let imported = store.import_archive_stream(
            &scope,
            "stream-copy",
            &mut std::io::Cursor::new(bytes),
            |_| Ok(()),
        )?;
        assert_eq!(
            store
                .read_page(&scope, &imported.id, &page, None)?
                .draft
                .citations
                .len(),
            128
        );
        Ok(())
    }

    // Model-independent persistence boundary: exact UTF-8 bytes, CAS and history.
    #[test]
    fn large_pages_roundtrip_snapshot_and_markdown_at_the_shared_byte_limit() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let mut catalog = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let library = catalog.create(&scope, "create", "Large pages", "")?;
        let source = catalog.import_text(&scope, &library.id, "source", "Source", "evidence")?;
        let cases = [
            256 * 1024,
            256 * 1024 + 1,
            crate::WIKI_MAX_PAGE_BYTES - 1,
            crate::WIKI_MAX_PAGE_BYTES,
        ]
        .into_iter()
        .flat_map(|size| [false, true].map(move |chinese| (size, chinese)));
        let boundary_body = |size: usize, chinese: bool| {
            // Keep an ASCII last byte so edits test content changes rather than
            // accidentally splitting a multi-byte character at an exact boundary.
            if chinese {
                let mut body = "中".repeat((size - 1) / 3);
                body.push_str(&"x".repeat(size - body.len()));
                body
            } else {
                "x".repeat(size)
            }
        };
        for (index, (size, chinese)) in cases.enumerate() {
            let body = boundary_body(size, chinese);
            assert_eq!(body.len(), size);
            let page_id = uuid::Uuid::new_v4().to_string();
            let first = catalog.commit_generated_pages(
                &scope,
                &library.id,
                &format!("commit-{index}"),
                vec![KnowledgePageDraft {
                    page_id: page_id.clone(),
                    expected_revision: None,
                    title: "Large page".into(),
                    kind: KnowledgePageKind::Concept,
                    markdown: body.clone(),
                    citations: vec![KnowledgeCitation {
                        source_id: source.source_id.clone(),
                        revision_id: source.revision_id.clone(),
                        chunk_id: "chunk-1".into(),
                        quote: "evidence".into(),
                    }],
                    related_page_ids: vec![],
                }],
            )?[0]
                .revision_id
                .clone();
            let bytes = catalog.export_markdown_bundle(&scope, &library.id)?;
            assert!(
                catalog
                    .import_markdown_bundle(
                        &scope,
                        &library.id,
                        &format!("unchanged-{index}"),
                        &bytes
                    )?
                    .is_empty()
            );
            let mut bundle: crate::WikiMarkdownBundle = serde_json::from_slice(&bytes)?;
            let page = bundle
                .pages
                .iter_mut()
                .find(|page| page.page_id == page_id)
                .unwrap();
            page.body.replace_range(page.body.len() - 1.., "y");
            let edited_body = page.body.clone();
            catalog.import_markdown_bundle(
                &scope,
                &library.id,
                &format!("edit-{index}"),
                &serde_json::to_vec(&bundle)?,
            )?;
            let archive = catalog.export_archive(&scope, &library.id)?;
            let imported = catalog.import_archive(&scope, &format!("copy-{index}"), &archive)?;
            let restored = catalog.read_page(&scope, &imported.id, &page_id, None)?;
            assert_eq!(restored.draft.markdown, edited_body);
            assert!(restored.human_edited);
            assert_eq!(
                catalog
                    .read_page(&scope, &imported.id, &page_id, Some(&first))?
                    .draft
                    .markdown,
                body
            );
            assert_eq!(
                catalog
                    .page_history(&scope, &imported.id, &page_id, None, 10)?
                    .len(),
                2
            );
            let before = catalog
                .read_page(&scope, &library.id, &page_id, None)?
                .revision_id;
            let page = bundle
                .pages
                .iter_mut()
                .find(|page| page.page_id == page_id)
                .unwrap();
            page.base_revision = before.clone();
            page.body = boundary_body(crate::WIKI_MAX_PAGE_BYTES + 1, chinese);
            assert!(
                catalog
                    .import_markdown_bundle(
                        &scope,
                        &library.id,
                        &format!("over-{index}"),
                        &serde_json::to_vec(&bundle)?
                    )
                    .is_err()
            );
            assert_eq!(
                catalog
                    .read_page(&scope, &library.id, &page_id, None)?
                    .revision_id,
                before
            );
            // A valid object digest must not hide an over-limit page during
            // snapshot import. Rejection leaves no newly created library.
            let mut oversized: Archive = serde_json::from_slice(&archive)?;
            let old_hash = oversized.records["knowledge_page_revisions"][0][5]
                .as_str()
                .unwrap()
                .to_owned();
            let over_body = boundary_body(crate::WIKI_MAX_PAGE_BYTES + 1, chinese);
            let over_hash = digest(over_body.as_bytes());
            for row in oversized
                .records
                .get_mut("knowledge_page_revisions")
                .unwrap()
            {
                if row[5].as_str() == Some(&old_hash) {
                    row[5] = over_hash.clone().into();
                }
            }
            oversized.objects.remove(&old_hash);
            oversized
                .objects
                .insert(over_hash, encode_hex(over_body.as_bytes()));
            let count = catalog.list(&scope, None, 100)?.len();
            let error = catalog
                .import_archive(
                    &scope,
                    &format!("over-copy-{index}"),
                    &serde_json::to_vec(&oversized)?,
                )
                .unwrap_err();
            assert!(format!("{error:#}").contains("invalid page body"));
            assert_eq!(catalog.list(&scope, None, 100)?.len(), count);
            let mut invalid: Value = serde_json::from_slice(&archive)?;
            invalid["records"]["knowledge_page_revisions"][0][6] = serde_json::json!([{"sourceId":source.source_id,"revisionId":source.revision_id,"chunkId":"missing","quote":"evidence"}]).to_string().into();
            let count = catalog.list(&scope, None, 100)?.len();
            assert!(
                catalog
                    .import_archive(
                        &scope,
                        &format!("bad-ref-{index}"),
                        &serde_json::to_vec(&invalid)?
                    )
                    .is_err()
            );
            assert_eq!(catalog.list(&scope, None, 100)?.len(), count);
        }
        Ok(())
    }
}

#[path = "archive_stream.rs"]
pub(crate) mod archive_stream;
