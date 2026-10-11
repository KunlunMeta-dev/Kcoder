//! Version-three snapshots store a bounded manifest followed by raw immutable objects.
//! No compression, archive paths or binary-to-JSON expansion is involved.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const ARCHIVE_STREAM_MAGIC: &[u8; 8] = b"KCWIKI3\n";
const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_OBJECT_BYTES: u64 = 32 * 1024 * 1024;
const EXTRACTION_TABLE: (&str, &str) = (
    "knowledge_source_extractions",
    "source_id,revision_id,summary_json",
);
pub const MAX_STREAM_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamManifest {
    format: String,
    version: u32,
    name: String,
    purpose: String,
    archived: bool,
    #[serde(deserialize_with = "unique_map")]
    records: BTreeMap<String, Vec<Vec<Value>>>,
    #[serde(deserialize_with = "unique_map")]
    objects: BTreeMap<String, u64>,
}

fn unique_map<'de, D, T>(deserializer: D) -> std::result::Result<BTreeMap<String, T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct Unique<T>(std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Unique<T> {
        type Value = BTreeMap<String, T>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a map without duplicate entries")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut result = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, T>()? {
                if result.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate Wiki manifest entry"));
                }
            }
            Ok(result)
        }
    }
    deserializer.deserialize_map(Unique(std::marker::PhantomData))
}

/// Progress refers to durable stream bytes, not network receipt or library publication.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStreamProgress {
    pub completed_bytes: u64,
    pub total_bytes: u64,
    pub completed_objects: usize,
    pub total_objects: usize,
}

impl KnowledgeCatalog {
    /// The snapshot transaction ends before writing to a possibly slow destination.
    /// Returning an error from progress cancels without mutating the source library.
    pub fn export_archive_stream(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        writer: &mut impl Write,
        mut progress: impl FnMut(ArchiveStreamProgress) -> Result<()>,
    ) -> Result<ArchiveStreamProgress> {
        let (manifest, manifest_bytes, total_bytes) =
            self.archive_stream_snapshot(scope, library)?;
        let mut state = ArchiveStreamProgress {
            completed_bytes: 0,
            total_bytes,
            completed_objects: 0,
            total_objects: manifest.objects.len(),
        };
        progress(state.clone())?;
        writer.write_all(ARCHIVE_STREAM_MAGIC)?;
        writer.write_all(&(manifest_bytes.len() as u64).to_le_bytes())?;
        writer.write_all(&manifest_bytes)?;
        state.completed_bytes = 16 + manifest_bytes.len() as u64;
        progress(state.clone())?;
        for (hash, size) in manifest.objects {
            let mut destination = ProgressWriter {
                writer,
                state: &mut state,
                progress: &mut progress,
            };
            ensure!(
                self.objects
                    .copy_object_to(library, &hash, &mut destination)?
                    == size,
                "snapshot object size changed"
            );
            state.completed_objects += 1;
        }
        writer.flush()?;
        progress(state.clone())?;
        Ok(state)
    }

    /// Reports the exact byte size of the current manifest and immutable object set.
    pub fn estimate_archive_stream(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
    ) -> Result<ArchiveStreamProgress> {
        let (manifest, _, total_bytes) = self.archive_stream_snapshot(scope, library)?;
        Ok(ArchiveStreamProgress {
            completed_bytes: 0,
            total_bytes,
            completed_objects: 0,
            total_objects: manifest.objects.len(),
        })
    }

    fn archive_stream_snapshot(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
    ) -> Result<(StreamManifest, Vec<u8>, u64)> {
        let tx = self.connection.transaction()?;
        let metadata: (String, String, bool) = tx.query_row(
            "SELECT name,purpose,archived FROM libraries WHERE id=?1 AND principal=?2 AND target=?3",
            params![library,scope.principal,scope.target], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        ).optional()?.ok_or_else(||anyhow::anyhow!("knowledge library not found"))?;
        let mut records = BTreeMap::new();
        let mut hashes = BTreeSet::new();
        let (mut count, mut budget) = (0, 1024usize);
        for (table, columns) in TABLES.iter().copied().chain([EXTRACTION_TABLE]) {
            let width = columns.split(',').count();
            let mut statement = tx.prepare(&format!(
                "SELECT {columns} FROM {table} WHERE library_id=?1 ORDER BY rowid"
            ))?;
            let mut rows = statement.query([library])?;
            let mut values = Vec::new();
            while let Some(row) = rows.next()? {
                count += 1;
                ensure!(count <= MAX_ROWS, "Wiki snapshot exceeds 100000 records");
                let record = (0..width)
                    .map(|index| -> Result<Value> {
                        Ok(match row.get_ref(index)? {
                            ValueRef::Null => Value::Null,
                            ValueRef::Integer(value) => value.into(),
                            ValueRef::Text(value) => std::str::from_utf8(value)?.into(),
                            _ => anyhow::bail!("unsupported Wiki record value"),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                budget = budget
                    .checked_add(serde_json::to_vec(&record)?.len() + 1)
                    .context("snapshot manifest size overflow")?;
                ensure!(budget <= MAX_MANIFEST_BYTES, "Wiki manifest exceeds 16 MiB");
                for (index, column) in columns.split(',').enumerate() {
                    if matches!(column, "body_hash" | "raw_hash") {
                        hashes.insert(string(&record, index)?.to_owned());
                    }
                }
                values.push(record);
            }
            records.insert(table.to_owned(), values);
        }
        tx.commit()?;
        let mut manifest = StreamManifest {
            format: "kcoder-wiki-stream".into(),
            version: 3,
            name: metadata.0,
            purpose: metadata.1,
            archived: metadata.2,
            records,
            objects: BTreeMap::new(),
        };
        let mut object_bytes = 0u64;
        for hash in hashes {
            let size = self.objects.object_len(library, &hash)?;
            object_bytes = object_bytes
                .checked_add(size)
                .context("snapshot size overflow")?;
            ensure!(
                object_bytes <= MAX_STREAM_BYTES,
                "Wiki stream exceeds 1 GiB; use a segmented collection"
            );
            manifest.objects.insert(hash, size);
        }
        let manifest_bytes = serde_json::to_vec(&manifest)?;
        ensure!(
            manifest_bytes.len() <= MAX_MANIFEST_BYTES,
            "Wiki manifest exceeds 16 MiB"
        );
        let total_bytes = 16 + manifest_bytes.len() as u64 + object_bytes;
        ensure!(total_bytes <= MAX_STREAM_BYTES, "Wiki stream exceeds 1 GiB");
        Ok((manifest, manifest_bytes, total_bytes))
    }

    /// Objects are staged and verified one at a time. Validation precedes publication.
    /// Failed or cancelled imports delete only this temporary directory and unpublished ID.
    pub fn import_archive_stream(
        &mut self,
        scope: &KnowledgeScope,
        request_key: &str,
        reader: &mut impl Read,
        mut progress: impl FnMut(ArchiveStreamProgress) -> Result<()>,
    ) -> Result<Library> {
        ensure!(
            !request_key.trim().is_empty() && request_key.len() <= 128,
            "invalid request key"
        );
        let mut hasher = Sha256::new();
        let mut header = [0; 16];
        reader
            .read_exact(&mut header)
            .context("incomplete Wiki stream header")?;
        hasher.update(header);
        ensure!(
            &header[..8] == ARCHIVE_STREAM_MAGIC,
            "unsupported Wiki stream format"
        );
        let length = u64::from_le_bytes(header[8..].try_into()?);
        ensure!(
            length > 0 && length <= MAX_MANIFEST_BYTES as u64,
            "Wiki manifest exceeds 16 MiB"
        );
        let mut manifest_bytes = vec![0; length as usize];
        reader
            .read_exact(&mut manifest_bytes)
            .context("incomplete Wiki stream manifest")?;
        hasher.update(&manifest_bytes);
        let manifest: StreamManifest =
            serde_json::from_slice(&manifest_bytes).context("invalid Wiki stream manifest")?;
        ensure!(
            manifest.format == "kcoder-wiki-stream" && manifest.version == 3,
            "unsupported Wiki stream version"
        );
        ensure!(manifest.objects.len() <= MAX_ROWS, "too many Wiki objects");
        ensure!(
            manifest.records.len() == TABLES.len() + 1
                && manifest.records.values().map(Vec::len).sum::<usize>() <= MAX_ROWS,
            "invalid Wiki record count"
        );
        let mut total_bytes = 16 + length;
        for (hash, size) in &manifest.objects {
            ensure!(
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "invalid Wiki object hash"
            );
            ensure!(*size <= MAX_OBJECT_BYTES, "Wiki object exceeds 32 MiB");
            total_bytes = total_bytes
                .checked_add(*size)
                .context("snapshot size overflow")?;
            ensure!(total_bytes <= MAX_STREAM_BYTES, "Wiki stream exceeds 1 GiB");
        }
        let staging = tempfile::tempdir()?;
        let mut state = ArchiveStreamProgress {
            completed_bytes: 16 + length,
            total_bytes,
            completed_objects: 0,
            total_objects: manifest.objects.len(),
        };
        progress(state.clone())?;
        for (hash, size) in &manifest.objects {
            let mut file = std::fs::File::create(staging.path().join(hash))?;
            let mut remaining = *size;
            let mut object_hash = Sha256::new();
            let mut buffer = [0; 64 * 1024];
            while remaining > 0 {
                let take = remaining.min(buffer.len() as u64) as usize;
                reader
                    .read_exact(&mut buffer[..take])
                    .context("incomplete Wiki object")?;
                object_hash.update(&buffer[..take]);
                hasher.update(&buffer[..take]);
                file.write_all(&buffer[..take])?;
                remaining -= take as u64;
                state.completed_bytes += take as u64;
                progress(state.clone())?;
            }
            ensure!(
                format!("{:x}", object_hash.finalize()) == *hash,
                "archive object hash mismatch"
            );
            state.completed_objects += 1;
        }
        let mut trailer = [0];
        ensure!(
            reader.read(&mut trailer)? == 0,
            "unexpected Wiki stream trailing data"
        );
        let mut archive = Archive {
            format: "kcoder-wiki".into(),
            version: 2,
            name: manifest.name,
            purpose: manifest.purpose,
            archived: manifest.archived,
            records: manifest.records,
            objects: manifest
                .objects
                .keys()
                .map(|hash| (hash.clone(), String::new()))
                .collect(),
        };
        let reports = archive
            .records
            .remove(EXTRACTION_TABLE.0)
            .context("source extraction table missing")?;
        let mut report_keys = BTreeSet::new();
        for row in &reports {
            ensure!(row.len() == 3, "invalid source extraction record width");
            let source = string(row, 0)?;
            let revision = string(row, 1)?;
            ensure!(
                report_keys.insert((source, revision)),
                "duplicate source extraction report"
            );
            ensure!(
                archive
                    .records
                    .get("knowledge_sources")
                    .context("sources missing")?
                    .iter()
                    .any(|row| row.first().and_then(Value::as_str) == Some(source)
                        && row.get(1).and_then(Value::as_str) == Some(revision)),
                "source extraction reference missing"
            );
            let original = archive
                .records
                .get("knowledge_originals")
                .context("originals missing")?
                .iter()
                .find(|row| {
                    row.first().and_then(Value::as_str) == Some(source)
                        && row.get(1).and_then(Value::as_str) == Some(revision)
                })
                .context("source extraction original missing")?;
            let chunks: Vec<_> = archive
                .records
                .get("knowledge_chunks")
                .context("chunks missing")?
                .iter()
                .filter(|row| {
                    row.first().and_then(Value::as_str) == Some(source)
                        && row.get(1).and_then(Value::as_str) == Some(revision)
                })
                .collect();
            let text_bytes = chunks
                .iter()
                .try_fold(0usize, |total, row| -> Result<usize> {
                    Ok(total + string(row, 6)?.len())
                })?;
            let value: Value = serde_json::from_str(string(row, 2)?)?;
            crate::sources::validate_extraction_report(
                &value,
                string(original, 3)?,
                text_bytes,
                chunks.len(),
            )?;
        }
        for original in archive
            .records
            .get("knowledge_originals")
            .context("originals missing")?
        {
            let hash = string(original, 2)?;
            let size = manifest
                .objects
                .get(hash)
                .context("original object missing")?;
            ensure!(
                *size
                    <= if string(original, 3)? == "image" {
                        10 * 1024 * 1024
                    } else {
                        MAX_OBJECT_BYTES
                    },
                "original exceeds format limit"
            );
        }
        let read_object =
            |hash: &str| -> Result<Vec<u8>> { Ok(std::fs::read(staging.path().join(hash))?) };
        validate_archive_with(&archive, false, read_object)?;
        let fingerprint = format!("{:x}", hasher.finalize());
        let previous:Option<(String,String)> = self.connection.query_row("SELECT payload_hash,library_id FROM knowledge_archive_receipts WHERE principal=?1 AND target=?2 AND request_key=?3",params![scope.principal,scope.target,request_key],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        if let Some((hash, id)) = previous {
            ensure!(hash == fingerprint, "archive idempotency conflict");
            return self.read(scope, &id);
        }
        progress(state.clone())?;
        let id = uuid::Uuid::new_v4().to_string();
        let result = (|| -> Result<()> {
            let tx = self
                .connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_archive_receipts WHERE principal=?1 AND target=?2 AND request_key=?3)",params![scope.principal,scope.target,request_key],|row|row.get(0))?;
            ensure!(
                !exists,
                "archive request completed concurrently; retry the same request"
            );
            tx.execute("INSERT INTO libraries(id,principal,target,name,purpose,archived,request_key,metadata_revision) VALUES(?1,?2,?3,?4,?5,?6,?7,1)",params![id,scope.principal,scope.target,archive.name,archive.purpose,archive.archived,format!("archive:{id}")])?;
            insert_records_with(&tx, &id, &archive, read_object)?;
            for row in &reports {
                tx.execute(
                    "INSERT INTO knowledge_source_extractions VALUES(?1,?2,?3,?4)",
                    params![id, string(row, 0)?, string(row, 1)?, string(row, 2)?],
                )?;
            }
            for hash in archive.objects.keys() {
                progress(state.clone())?;
                let mut file = std::fs::File::open(staging.path().join(hash))?;
                self.objects
                    .put_object_reader(&id, &mut file, manifest.objects[hash], hash)?;
            }
            tx.execute("INSERT INTO knowledge_archive_receipts(principal,target,request_key,payload_hash,library_id) VALUES(?1,?2,?3,?4,?5)",params![scope.principal,scope.target,request_key,fingerprint,id])?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = result {
            return Err(self.failed_archive_publication(&id, error));
        }
        self.read(scope, &id)
    }
}

struct ProgressWriter<'a, W, F> {
    writer: &'a mut W,
    state: &'a mut ArchiveStreamProgress,
    progress: &'a mut F,
}
impl<W: Write, F: FnMut(ArchiveStreamProgress) -> Result<()>> Write for ProgressWriter<'_, W, F> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let count = self.writer.write(bytes)?;
        self.state.completed_bytes += count as u64;
        (self.progress)(self.state.clone()).map_err(std::io::Error::other)?;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
    use std::io::{Cursor, Seek, SeekFrom};

    struct LargeArchiveFixture {
        root: tempfile::TempDir,
        scope: KnowledgeScope,
        store: KnowledgeCatalog,
        library: Library,
        source: crate::SourceRevision,
        page: String,
        initial: String,
    }

    // Shared fixed sample: 3 x 32MiB originals, extraction reports and a human
    // revision. Resource measurements and round trips use identical setup.
    fn large_archive_fixture() -> Result<LargeArchiveFixture> {
        let root = tempfile::tempdir()?;
        let scope = KnowledgeScope::from_authenticated_host("secret-owner", "secret-target")?;
        let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
        let library = store.create(&scope, "create", "Large originals", "Evidence")?;
        let mut source = None;
        for index in 0..3 {
            let original = vec![b'a' + index; 32 * 1024 * 1024];
            let report = serde_json::json!({"format":"pdf","textBytes":8,"chunkCount":1,"unit":"page","extractedUnits":1,"totalUnits":2,"warnings":["pdf_text_only","pdf_empty_pages"]});
            source = Some(store.import_extracted_with_report(
                &scope,
                &library.id,
                &format!("source-{index}"),
                "document.pdf",
                &original,
                "pdf",
                vec![crate::SourceChunk {
                    page: Some(2),
                    ordinal: 1,
                    chunk_id: "chunk-1".into(),
                    first_line: 1,
                    last_line: 1,
                    text: "evidence".into(),
                }],
                &report,
            )?);
        }
        let source = source.unwrap();
        let page = uuid::Uuid::new_v4().to_string();
        let initial = store.commit_generated_pages(
            &scope,
            &library.id,
            "generate",
            vec![KnowledgePageDraft {
                page_id: page.clone(),
                expected_revision: None,
                title: "Page".into(),
                kind: KnowledgePageKind::Concept,
                markdown: "First body".into(),
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
        store.edit_page(
            &scope,
            &library.id,
            &page,
            &initial,
            "human",
            "Page",
            "Human body",
        )?;
        Ok(LargeArchiveFixture {
            root,
            scope,
            store,
            library,
            source,
            page,
            initial,
        })
    }

    // Explicit export-only measurement. No repeated import, retry, cancel or
    // negative matrix; not part of every ordinary test run.
    #[test]
    #[ignore = "fixed 96MiB archive export resource measurement"]
    fn fixed_large_archive_export_resource_sample() -> Result<()> {
        let LargeArchiveFixture {
            root,
            scope,
            mut store,
            library,
            ..
        } = large_archive_fixture()?;
        let expected_bytes = store
            .estimate_archive_stream(&scope, &library.id)?
            .total_bytes;
        let mut writer =
            crate::ArchiveSegmentWriter::new(root.path(), crate::MAX_ARCHIVE_SEGMENT_BYTES)?;
        let begin = std::time::Instant::now();
        let progress = store.export_archive_stream(&scope, &library.id, &mut writer, |_| Ok(()))?;
        let collection = writer.finish()?;
        let export_ms = begin.elapsed().as_millis();
        assert_eq!(expected_bytes, progress.total_bytes);
        assert_eq!(collection.manifest.segments.len(), 2);
        assert!(progress.total_bytes > 96 * 1024 * 1024 && progress.total_bytes < 97 * 1024 * 1024);
        let peak = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status.lines().find_map(|line| {
                    line.strip_prefix("VmHWM:")?
                        .split_whitespace()
                        .next()?
                        .parse::<u64>()
                        .ok()
                })
            });
        eprintln!(
            "B02 export-only sample: {}",
            serde_json::json!({
                "originalBytes":100663296u64,
                "archiveBytes":progress.total_bytes,
                "exportMs":export_ms,
                "peakProcessKiB":peak,
                "segments":collection.manifest.segments.len(),
                "scope":"fixture construction and one segmented export; no import/retry/negative matrix",
            })
        );
        let paths = (0..collection.manifest.segments.len())
            .map(|index| collection.segment_path(index))
            .collect::<Result<Vec<_>>>()?;
        drop(collection);
        assert!(paths.iter().all(|path| !path.exists()));
        Ok(())
    }

    // Model-independent backup/storage test; no Provider request or identity is exported.
    #[test]
    fn stream_roundtrip_large_originals_history_reports_and_owned_cleanup() -> Result<()> {
        let LargeArchiveFixture {
            root,
            scope,
            mut store,
            library,
            source,
            page,
            initial,
        } = large_archive_fixture()?;
        let mut writer =
            crate::ArchiveSegmentWriter::new(root.path(), crate::MAX_ARCHIVE_SEGMENT_BYTES)?;
        let begin = std::time::Instant::now();
        let progress = store.export_archive_stream(&scope, &library.id, &mut writer, |_| Ok(()))?;
        let collection = writer.finish()?;
        let export_ms = begin.elapsed().as_millis();
        assert_eq!(
            store
                .estimate_archive_stream(&scope, &library.id)?
                .total_bytes,
            progress.total_bytes
        );
        assert_eq!(collection.manifest.segments.len(), 2);
        assert!(progress.total_bytes > 96 * 1024 * 1024 && progress.total_bytes < 97 * 1024 * 1024);
        let paths = (0..collection.manifest.segments.len())
            .map(|index| collection.segment_path(index))
            .collect::<Result<Vec<_>>>()?;
        let mut reader = crate::ArchiveSegmentReader::open(collection.manifest.clone(), &paths)?;
        let imported = store.import_archive_stream(&scope, "copy", &mut reader, |_| Ok(()))?;
        assert!(
            store
                .read_page(&scope, &imported.id, &page, None)?
                .human_edited
        );
        assert_eq!(
            store
                .read_page(&scope, &imported.id, &page, Some(&initial))?
                .draft
                .markdown,
            "First body"
        );
        assert_eq!(
            store
                .source_extraction(&scope, &imported.id, &source.source_id, &source.revision_id)?
                .unwrap()["totalUnits"],
            2
        );
        assert_eq!(
            store
                .original_source(&scope, &imported.id, &source.source_id, &source.revision_id)?
                .2
                .len(),
            32 * 1024 * 1024
        );
        let mut reader = crate::ArchiveSegmentReader::open(collection.manifest.clone(), &paths)?;
        assert_eq!(
            store
                .import_archive_stream(&scope, "copy", &mut reader, |_| Ok(()))?
                .id,
            imported.id
        );
        let count = store.list(&scope, None, 100)?.len();
        let mut reader = crate::ArchiveSegmentReader::open(collection.manifest.clone(), &paths)?;
        assert!(
            store
                .import_archive_stream(&scope, "cancel", &mut reader, |state| {
                    ensure!(state.completed_bytes < 256 * 1024, "cancelled");
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(store.list(&scope, None, 100)?.len(), count);
        let mut file = std::fs::OpenOptions::new().write(true).open(&paths[1])?;
        file.seek(SeekFrom::End(-1))?;
        file.write_all(b"z")?;
        drop(file);
        let mut reader = crate::ArchiveSegmentReader::open(collection.manifest.clone(), &paths)?;
        assert!(
            store
                .import_archive_stream(&scope, "corrupt", &mut reader, |_| Ok(()))
                .is_err()
        );
        assert_eq!(store.list(&scope, None, 100)?.len(), count);
        let mut file = std::fs::File::open(&paths[0])?;
        let mut header = [0; 16];
        file.read_exact(&mut header)?;
        let manifest_len = u64::from_le_bytes(header[8..16].try_into()?) as usize;
        let mut manifest = vec![0; manifest_len];
        file.read_exact(&mut manifest)?;
        let json = std::str::from_utf8(&manifest)?;
        assert!(!json.contains("secret-owner") && !json.contains("secret-target"));
        eprintln!(
            "B02 resource sample: originals=100663296 archive={} export_ms={} export+import+retry+negative_ms={}{}",
            progress.total_bytes,
            export_ms,
            begin.elapsed().as_millis(),
            std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|status| status
                    .lines()
                    .find(|line| line.starts_with("VmHWM:"))
                    .map(|line| format!(" {line}")))
                .unwrap_or_default()
        );
        drop(collection);
        assert!(paths.iter().all(|path| !path.exists()));
        Ok(())
    }

    #[test]
    fn rejects_duplicate_manifest_entries_and_bad_bounds_before_publication() -> Result<()> {
        let root = tempfile::tempdir()?;
        let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
        let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
        let library = store.create(&scope, "create", "Small", "")?;
        store.import_text(&scope, &library.id, "source", "Source", "evidence")?;
        let mut bytes = Vec::new();
        store.export_archive_stream(&scope, &library.id, &mut bytes, |_| Ok(()))?;
        let length = u64::from_le_bytes(bytes[8..16].try_into()?) as usize;
        let mut manifest: StreamManifest = serde_json::from_slice(&bytes[16..16 + length])?;
        manifest.records.get_mut("knowledge_chunks").unwrap()[0][6] = "forged".into();
        let changed = serde_json::to_vec(&manifest)?;
        let mut invalid = ARCHIVE_STREAM_MAGIC.to_vec();
        invalid.extend_from_slice(&(changed.len() as u64).to_le_bytes());
        invalid.extend_from_slice(&changed);
        invalid.extend_from_slice(&bytes[16 + length..]);
        assert!(
            store
                .import_archive_stream(&scope, "bad-ref", &mut Cursor::new(invalid), |_| Ok(()))
                .is_err()
        );
        let mut huge = ARCHIVE_STREAM_MAGIC.to_vec();
        huge.extend_from_slice(&(MAX_MANIFEST_BYTES as u64 + 1).to_le_bytes());
        assert!(
            store
                .import_archive_stream(&scope, "huge", &mut Cursor::new(huge), |_| Ok(()))
                .is_err()
        );
        assert!(
            store
                .import_archive_stream(
                    &scope,
                    "truncated",
                    &mut Cursor::new(&bytes[..bytes.len() - 1]),
                    |_| Ok(())
                )
                .is_err()
        );
        let sentinel = root.path().join("keep");
        std::fs::write(&sentinel, "owned elsewhere")?;
        let mut writer =
            crate::ArchiveSegmentWriter::new(root.path(), crate::MAX_ARCHIVE_SEGMENT_BYTES)?;
        assert!(
            store
                .export_archive_stream(&scope, &library.id, &mut writer, |state| {
                    ensure!(state.completed_bytes == 0, "cancelled");
                    Ok(())
                })
                .is_err()
        );
        drop(writer);
        assert!(sentinel.exists());
        assert!(serde_json::from_str::<StreamManifest>(r#"{"format":"kcoder-wiki-stream","version":3,"name":"x","purpose":"","archived":false,"records":{},"objects":{"abc":0,"abc":1}}"#).is_err());
        assert_eq!(store.list(&scope, None, 100)?.len(), 1);
        Ok(())
    }
}
