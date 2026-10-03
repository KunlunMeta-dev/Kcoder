use crate::{KnowledgeCatalog, KnowledgeScope, objects::digest};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRevision {
    #[serde(default)]
    pub removed: bool,
    pub source_id: String,
    pub revision_id: String,
    pub title: String,
    pub body_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceChunk {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    pub ordinal: usize,
    pub chunk_id: String,
    pub first_line: usize,
    pub last_line: usize,
    pub text: String,
}
impl KnowledgeCatalog {
    /// Authorize library/revision first; immutable object reading verifies its hash.
    pub fn original_source(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
        revision: &str,
    ) -> Result<(String, String, Vec<u8>)> {
        self.read(scope, library)?;
        let (title, hash, format): (String,String,String) = self.connection.query_row(
            "SELECT s.title,o.raw_hash,o.format FROM knowledge_sources s JOIN knowledge_originals o ON s.library_id=o.library_id AND s.source_id=o.source_id AND s.revision_id=o.revision_id WHERE s.library_id=?1 AND s.source_id=?2 AND s.revision_id=?3",
            params![library,source,revision],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))
        ).optional()?.ok_or_else(||anyhow::anyhow!("Original file unavailable for this source revision"))?;
        let bytes = self.objects.read_bytes(library, &hash)?;
        Ok((title, format, bytes))
    }
    /// Reuse a completed native-vision import without asking the model again.
    pub fn replay_image_import(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        key: &str,
        title: &str,
        original: &[u8],
        source: Option<&str>,
    ) -> Result<Option<SourceRevision>> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        let previous = self.connection.query_row(
            "SELECT source_id,revision_id,title,body_hash FROM knowledge_sources WHERE library_id=?1 AND request_key=?2",
            params![library,key], read_revision).optional()?;
        if let Some(mut revision) = previous {
            let (raw, format): (String, String) = self.connection.query_row(
                "SELECT raw_hash,format FROM knowledge_originals WHERE library_id=?1 AND source_id=?2 AND revision_id=?3",
                params![library,revision.source_id,revision.revision_id], |row| Ok((row.get(0)?,row.get(1)?)))?;
            ensure!(
                revision.title == title
                    && source.is_none_or(|id| id == revision.source_id)
                    && raw == digest(original)
                    && format == "image",
                "idempotency conflict"
            );
            revision.removed = self.connection.query_row(
                "SELECT removed FROM knowledge_source_lifecycle WHERE library_id=?1 AND source_id=?2",
                params![library,revision.source_id], |row| row.get(0))?;
            return Ok(Some(revision));
        }
        Ok(None)
    }

    /// Import an explicitly supplied UTF-8 source, never a model-supplied host path.
    pub fn import_text(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        request_key: &str,
        title: &str,
        text: &str,
    ) -> Result<SourceRevision> {
        self.import_extracted(
            scope,
            library,
            request_key,
            title,
            text.as_bytes(),
            "text",
            split_lines(text),
        )
    }

    /// Persist original bytes and extracted, bounded chunks in one catalog transaction.
    #[allow(clippy::too_many_arguments)]
    pub fn import_extracted(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        request_key: &str,
        title: &str,
        original: &[u8],
        format: &str,
        chunks: Vec<SourceChunk>,
    ) -> Result<SourceRevision> {
        self.import_source_revision(
            scope,
            library,
            request_key,
            title,
            original,
            format,
            chunks,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn import_source_revision(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        request_key: &str,
        title: &str,
        original: &[u8],
        format: &str,
        chunks: Vec<SourceChunk>,
        update: Option<(&str, &str)>,
    ) -> Result<SourceRevision> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        ensure!(original.len() <= 32 * 1024 * 1024, "file_too_large");
        ensure!(
            matches!(
                format,
                "text" | "markdown" | "html" | "pdf" | "docx" | "xlsx" | "pptx" | "image"
            ),
            "unsupported_format"
        );
        ensure!(
            !chunks.is_empty() && chunks.len() <= 8192,
            "invalid document chunks"
        );
        for (index, chunk) in chunks.iter().enumerate() {
            ensure!(
                chunk.ordinal == index + 1 && chunk.chunk_id == format!("chunk-{}", index + 1),
                "invalid chunk identity"
            );
            ensure!(
                chunk.text.len() <= 16 * 1024 && chunk.page != Some(0),
                "invalid chunk bounds"
            );
        }
        let text = chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<String>();
        let raw_hash = digest(original);
        ensure!(
            !request_key.is_empty() && request_key.len() <= 128,
            "invalid request key"
        );
        ensure!(
            !title.trim().is_empty() && title.chars().count() <= 240,
            "invalid source title"
        );
        ensure!(
            !text.trim().is_empty() && text.len() <= 32 * 1024 * 1024,
            "source text size out of range"
        );
        let hash = digest(text.as_bytes());
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&transaction, library)?;
        let previous = transaction.query_row("SELECT source_id,revision_id,title,body_hash FROM knowledge_sources WHERE library_id=?1 AND request_key=?2", params![library,request_key], read_revision).optional()?;
        if let Some(mut previous) = previous {
            ensure!(
                previous.title == title
                    && previous.body_hash == hash
                    && update.is_none_or(|(id, _)| id == previous.source_id),
                "idempotency conflict"
            );
            let stored: Option<(String, String)> = transaction.query_row("SELECT raw_hash,format FROM knowledge_originals WHERE library_id=?1 AND source_id=?2 AND revision_id=?3",params![library,previous.source_id,previous.revision_id],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
            ensure!(
                stored
                    .as_ref()
                    .is_none_or(|(hash, kind)| hash == &raw_hash && kind == format),
                "idempotency conflict"
            );
            let mut query = transaction.prepare("SELECT ordinal,chunk_id,first_line,last_line,text,page FROM knowledge_chunks WHERE library_id=?1 AND source_id=?2 AND revision_id=?3 ORDER BY ordinal")?;
            let stored_chunks = query
                .query_map(
                    params![library, previous.source_id, previous.revision_id],
                    |row| {
                        Ok(SourceChunk {
                            ordinal: row.get::<_, i64>(0)? as usize,
                            chunk_id: row.get(1)?,
                            first_line: row.get::<_, i64>(2)? as usize,
                            last_line: row.get::<_, i64>(3)? as usize,
                            text: row.get(4)?,
                            page: row.get(5)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ensure!(stored_chunks == chunks, "idempotency conflict");
            previous.removed = transaction.query_row("SELECT removed FROM knowledge_source_lifecycle WHERE library_id=?1 AND source_id=?2",params![library,previous.source_id],|row|row.get(0))?;
            return Ok(previous);
        }
        if let Some((source, expected)) = update {
            crate::source_lifecycle::require_current_source(
                &transaction,
                library,
                source,
                expected,
            )?;
        }
        let revision = SourceRevision {
            removed: false,
            source_id: update
                .map(|(id, _)| id.to_owned())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            revision_id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            body_hash: hash,
        };
        self.objects.put(library, &text)?;
        self.objects.put_bytes(library, original)?;
        transaction.execute(
            "INSERT INTO knowledge_originals VALUES(?1,?2,?3,?4,?5)",
            params![
                library,
                revision.source_id,
                revision.revision_id,
                raw_hash,
                format
            ],
        )?;
        transaction.execute("INSERT INTO knowledge_sources(library_id,source_id,revision_id,request_key,title,body_hash) VALUES(?1,?2,?3,?4,?5,?6)",params![library,revision.source_id,revision.revision_id,request_key,title,revision.body_hash])?;
        for chunk in chunks {
            transaction.execute("INSERT INTO knowledge_chunks(library_id,source_id,revision_id,chunk_id,ordinal,first_line,last_line,text,page) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![library,revision.source_id,revision.revision_id,chunk.chunk_id,chunk.ordinal as i64,chunk.first_line as i64,chunk.last_line as i64,chunk.text,chunk.page])?;
            crate::search::replace_index(
                &transaction,
                library,
                &format!("source:{}:{}", revision.source_id, chunk.chunk_id),
                &revision.revision_id,
                title,
                &chunk.text,
            )?;
        }
        if update.is_some() {
            transaction.execute("UPDATE knowledge_source_lifecycle SET current_revision=?3 WHERE library_id=?1 AND source_id=?2", params![library,revision.source_id,revision.revision_id])?;
            transaction.execute("UPDATE knowledge_jobs SET status='paused',error_code='source_updated',lease_token=NULL,lease_until_ms=0 WHERE library_id=?1 AND source_id=?2 AND status IN ('queued','running','awaiting_review')", params![library,revision.source_id])?;
        } else {
            transaction.execute("INSERT INTO knowledge_source_lifecycle(library_id,source_id,current_revision,removed) VALUES(?1,?2,?3,0)",params![library,revision.source_id,revision.revision_id])?;
        }
        transaction.commit()?;
        Ok(revision)
    }
    pub fn read_source(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
        revision: &str,
    ) -> Result<String> {
        self.read(scope, library)?;
        let hash: String = self.connection.query_row("SELECT body_hash FROM knowledge_sources WHERE library_id=?1 AND source_id=?2 AND revision_id=?3", params![library,source,revision], |row| row.get(0)).optional()?.ok_or_else(||anyhow::anyhow!("source revision not found"))?;
        self.objects.read(library, &hash)
    }
    pub fn source_chunks(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
        revision: &str,
        after_chunk: usize,
        limit: usize,
    ) -> Result<Vec<SourceChunk>> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "chunk limit must be 1..100");
        let mut statement = self.connection.prepare("SELECT chunk_id,first_line,last_line,text,ordinal,page FROM knowledge_chunks WHERE library_id=?1 AND source_id=?2 AND revision_id=?3 AND ordinal>?4 ORDER BY ordinal LIMIT ?5")?;
        Ok(statement
            .query_map(
                params![library, source, revision, after_chunk as i64, limit as i64],
                |row| {
                    Ok(SourceChunk {
                        page: row.get(5)?,
                        ordinal: row.get::<_, i64>(4)? as usize,
                        chunk_id: row.get(0)?,
                        first_line: row.get::<_, i64>(1)? as usize,
                        last_line: row.get::<_, i64>(2)? as usize,
                        text: row.get(3)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
fn read_revision(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceRevision> {
    Ok(SourceRevision {
        removed: false,
        source_id: row.get(0)?,
        revision_id: row.get(1)?,
        title: row.get(2)?,
        body_hash: row.get(3)?,
    })
}
fn split_lines(text: &str) -> Vec<SourceChunk> {
    let mut chunks = Vec::new();
    let mut body = String::new();
    let mut first = 1;
    let mut line = 1;
    let mut last = 1;
    for ch in text.chars() {
        if body.len() + ch.len_utf8() > 16 * 1024 {
            let ordinal = chunks.len() + 1;
            chunks.push(SourceChunk {
                page: None,
                ordinal,
                chunk_id: format!("chunk-{ordinal}"),
                first_line: first,
                last_line: last,
                text: std::mem::take(&mut body),
            });
            first = line;
        }
        body.push(ch);
        last = line;
        if ch == '\n' {
            line += 1;
        }
    }
    if !body.is_empty() {
        let ordinal = chunks.len() + 1;
        chunks.push(SourceChunk {
            page: None,
            ordinal,
            chunk_id: format!("chunk-{ordinal}"),
            first_line: first,
            last_line: last,
            text: body,
        });
    }
    chunks
}

impl KnowledgeCatalog {
    pub fn list_sources(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<SourceRevision>> {
        self.read(scope, library)?;
        ensure!((1..=100).contains(&limit), "source limit must be 1..100");
        let mut statement=self.connection.prepare("SELECT s.source_id,s.revision_id,s.title,s.body_hash FROM knowledge_sources s JOIN knowledge_source_lifecycle l ON l.library_id=s.library_id AND l.source_id=s.source_id AND l.current_revision=s.revision_id WHERE s.library_id=?1 AND s.source_id>?2 AND l.removed=0 ORDER BY s.source_id LIMIT ?3")?;
        Ok(statement
            .query_map(
                params![library, after_id.unwrap_or(""), limit as i64],
                read_revision,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

impl KnowledgeCatalog {
    pub fn resolve_citation(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        source: &str,
        revision: &str,
        chunk: &str,
    ) -> Result<(SourceRevision, SourceChunk)> {
        self.read(scope, library)?;
        let mut metadata=self.connection.query_row("SELECT source_id,revision_id,title,body_hash FROM knowledge_sources WHERE library_id=?1 AND source_id=?2 AND revision_id=?3",params![library,source,revision],read_revision).optional()?.ok_or_else(||anyhow::anyhow!("source revision not found"))?;
        let value=self.connection.query_row("SELECT chunk_id,first_line,last_line,text,ordinal,page FROM knowledge_chunks WHERE library_id=?1 AND source_id=?2 AND revision_id=?3 AND chunk_id=?4",params![library,source,revision,chunk],|row| Ok(SourceChunk {page:row.get(5)?,chunk_id:row.get(0)?,first_line:row.get::<_,i64>(1)? as usize,last_line:row.get::<_,i64>(2)? as usize,text:row.get(3)?,ordinal:row.get::<_,i64>(4)? as usize})).optional()?.ok_or_else(||anyhow::anyhow!("source chunk not found"))?;
        metadata.removed = self.source_status(scope, library, source)?.removed;
        Ok((metadata, value))
    }
}
