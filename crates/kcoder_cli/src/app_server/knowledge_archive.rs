//! Connection-owned streaming archive staging, separate from attachment quotas.
use super::knowledge_archive_owner::ArchiveOwner;
use super::knowledge_requests;
use anyhow::{Context, Result, ensure};
use base64::Engine as _;
use kcoder_app_protocol::*;
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{
    ArchiveCollection, ArchiveCollectionManifest, ArchiveSegmentReader, ArchiveSegmentWriter,
    ArchiveStreamProgress, MAX_ARCHIVE_SEGMENT_BYTES,
};
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const CHUNK_BYTES: usize = 192 * 1024;
const TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(15 * 60);
// One active collection per process also bounds aggregate staging across connections.
static PROCESS_SLOT: AtomicBool = AtomicBool::new(false);
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
static WATCHED_TRANSFER: Mutex<Option<Weak<Transfer>>> = Mutex::new(None);
struct Slot;
impl Slot {
    fn acquire() -> Result<Self> {
        ensure!(
            !PROCESS_SLOT.swap(true, Ordering::AcqRel),
            "Wiki archive service is busy"
        );
        Ok(Self)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        PROCESS_SLOT.store(false, Ordering::Release);
    }
}

#[derive(Default)]
pub(super) struct ArchiveTransfers {
    current: Option<Arc<Transfer>>,
}
struct Transfer {
    profile: PathBuf,
    cancelled: AtomicBool,
    touched: Mutex<Instant>,
    state: Mutex<State>,
}
struct State {
    status: KnowledgeArchiveStatus,
    storage: Option<Storage>,
    slot: Option<Slot>,
}
enum Storage {
    Export {
        collection: ArchiveCollection,
        _root: ArchiveOwner,
    },
    Import {
        files: Vec<File>,
        root: ArchiveOwner,
        manifest: ArchiveCollectionManifest,
        received: u64,
        index: usize,
        offset: u64,
        key: String,
    },
}
impl Drop for ArchiveTransfers {
    fn drop(&mut self) {
        if let Some(transfer) = self.current.take() {
            transfer.cancel();
        }
    }
}
impl Transfer {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        self.state
            .lock()
            .map_err(|_| anyhow::anyhow!("Wiki transfer state unavailable"))
    }
    fn check(&self) -> Result<()> {
        ensure!(
            !self.cancelled.load(Ordering::Acquire),
            "Wiki archive transfer cancelled"
        );
        ensure!(
            self.touched
                .lock()
                .map_err(|_| anyhow::anyhow!("transfer clock unavailable"))?
                .elapsed()
                < TTL,
            "Wiki archive transfer expired"
        );
        Ok(())
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut state) = self.state.lock()
            && state.status.phase != "processing"
        {
            state.storage = None;
            state.slot = None;
            if state.status.phase != "completed" {
                state.status.phase = "cancelled".into();
            }
        }
    }
    fn progress(&self, progress: ArchiveStreamProgress) -> Result<()> {
        self.check()?;
        let mut state = self.lock()?;
        state.status.completed_bytes = progress.completed_bytes;
        state.status.total_bytes = progress.total_bytes;
        Ok(())
    }
    fn finish(&self, result: Result<Option<Storage>>, library: Option<kcoder_knowledge::Library>) {
        if let Ok(mut state) = self.state.lock() {
            match result {
                Ok(storage) if library.is_some() || !self.cancelled.load(Ordering::Acquire) => {
                    if let Some(Storage::Export { collection, .. }) = storage.as_ref() {
                        state.status.manifest = serde_json::to_value(&collection.manifest)
                            .ok()
                            .and_then(|value| serde_json::from_value(value).ok());
                        state.status.total_bytes = collection.manifest.size;
                        state.status.completed_bytes = collection.manifest.size;
                    }
                    state.status.library = library
                        .and_then(|library| serde_json::to_value(library).ok())
                        .and_then(|value| serde_json::from_value(value).ok());
                    state.status.phase = if storage.is_some() {
                        "ready"
                    } else {
                        "completed"
                    }
                    .into();
                    state.storage = storage;
                    if state.storage.is_none() {
                        state.slot = None;
                    }
                }
                other => {
                    // Drop any cancelled export files before releasing the aggregate quota.
                    let error = other.err();
                    state.storage = None;
                    state.slot = None;
                    state.status.phase = if self.cancelled.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    state.status.error =
                        error.map(|error| error.to_string().chars().take(2048).collect());
                }
            }
        }
    }
}

fn spawn_archive_worker(
    transfer: Arc<Transfer>,
    work: impl FnOnce() -> Result<(Option<Storage>, Option<kcoder_knowledge::Library>)> + Send + 'static,
) {
    let fallback = Arc::clone(&transfer);
    if let Err(error) = std::thread::Builder::new().name("wiki-archive-worker".into()).spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("Wiki archive worker stopped without a confirmed result; retry the same collection to resolve its receipt")));
        match result {
            Ok((storage, library)) => transfer.finish(Ok(storage), library),
            Err(error) => transfer.finish(Err(error), None),
        }
    }) {
        fallback.finish(Err(anyhow::anyhow!("cannot start archive worker: {error}")), None);
    }
}

pub(super) fn supports(method: &str) -> bool {
    use knowledge_archive_method as am;
    matches!(
        method,
        am::CAPABILITIES
            | am::EXPORT_START
            | am::IMPORT_START
            | am::STATUS
            | am::READ
            | am::CHUNK
            | am::IMPORT_FINISH
            | am::CANCEL
    )
}
impl ArchiveTransfers {
    fn lookup(&self, id: &str, profile: &Path) -> Result<Arc<Transfer>> {
        let transfer = self
            .current
            .as_ref()
            .context("Wiki archive transfer not owned by this connection")?;
        ensure!(
            transfer.profile == profile && transfer.lock()?.status.transfer_id == id,
            "Wiki archive transfer not owned by this connection/profile"
        );
        *transfer
            .touched
            .lock()
            .map_err(|_| anyhow::anyhow!("transfer clock unavailable"))? = Instant::now();
        Ok(Arc::clone(transfer))
    }
    fn start(&mut self, profile: &Path, phase: &str, bytes: u64) -> Result<Arc<Transfer>> {
        if let Some(current) = self.current.as_ref() {
            ensure!(
                matches!(
                    current.lock()?.status.phase.as_str(),
                    "failed" | "cancelled" | "completed"
                ),
                "finish or cancel the current Wiki archive transfer first"
            );
        }
        self.current = None;
        let slot = Slot::acquire()?;
        let transfer = Arc::new(Transfer {
            profile: profile.to_path_buf(),
            cancelled: AtomicBool::new(false),
            touched: Mutex::new(Instant::now()),
            state: Mutex::new(State {
                status: KnowledgeArchiveStatus {
                    transfer_id: uuid::Uuid::new_v4().to_string(),
                    phase: phase.into(),
                    completed_bytes: 0,
                    total_bytes: bytes,
                    manifest: None,
                    library: None,
                    error: None,
                },
                storage: None,
                slot: Some(slot),
            }),
        });
        self.current = Some(Arc::clone(&transfer));
        *WATCHED_TRANSFER
            .lock()
            .map_err(|_| anyhow::anyhow!("archive reaper unavailable"))? =
            Some(Arc::downgrade(&transfer));
        if !WATCHER_STARTED.swap(true, Ordering::AcqRel)
            && let Err(error) = std::thread::Builder::new()
                .name("wiki-archive-reaper".into())
                .spawn(|| {
                    loop {
                        std::thread::sleep(Duration::from_secs(5));
                        let current = WATCHED_TRANSFER
                            .lock()
                            .ok()
                            .and_then(|value| value.as_ref().and_then(Weak::upgrade));
                        if let Some(transfer) = current
                            && transfer.check().is_err()
                        {
                            transfer.cancel();
                        }
                    }
                })
        {
            WATCHER_STARTED.store(false, Ordering::Release);
            transfer.cancel();
            transfer.finish(
                Err(anyhow::anyhow!(
                    "cannot start archive expiration worker: {error}"
                )),
                None,
            );
            anyhow::bail!("cannot start archive expiration worker: {error}");
        }
        Ok(transfer)
    }
    pub(super) fn request(&mut self, method: &str, params: Value, profile: &Path) -> Result<Value> {
        use knowledge_archive_method as am;
        if method == am::CAPABILITIES {
            let _: KnowledgeStatusParams = serde_json::from_value(params)?;
            return Ok(
                json!({"supported":true,"maxCollectionBytes":TOTAL_BYTES,"maxSegmentBytes":MAX_ARCHIVE_SEGMENT_BYTES,
                "maxChunkBytes":CHUNK_BYTES,"maxTransfers":1,"idleTtlSeconds":TTL.as_secs()}),
            );
        }
        // Cancel remains available after Wiki is disabled.
        if method != am::CANCEL {
            ensure!(knowledge_requests::enabled(profile)?, "Wiki is disabled");
        }
        if method == am::EXPORT_START {
            let input: KnowledgeArchiveExportParams = serde_json::from_value(params)?;
            let (mut catalog, scope) = knowledge_requests::open_catalog(profile)?;
            let estimate = catalog.estimate_archive_stream(&scope, &input.library_id)?;
            let transfer = self.start(profile, "processing", estimate.total_bytes)?;
            let result = serde_json::to_value(&transfer.lock()?.status)?;
            let context = Arc::clone(&transfer);
            spawn_archive_worker(transfer, move || {
                let root = ArchiveOwner::new()?;
                let mut writer = ArchiveSegmentWriter::new(root.path(), MAX_ARCHIVE_SEGMENT_BYTES)?;
                catalog.export_archive_stream(
                    &scope,
                    &input.library_id,
                    &mut writer,
                    |progress| context.progress(progress),
                )?;
                context.check()?;
                Ok((
                    Some(Storage::Export {
                        collection: writer.finish()?,
                        _root: root,
                    }),
                    None,
                ))
            });
            return Ok(result);
        }
        if method == am::IMPORT_START {
            ensure!(
                knowledge_requests::organization_enabled(profile)?,
                "Wiki organization is disabled"
            );
            let input: KnowledgeArchiveImportParams = serde_json::from_value(params)?;
            ensure!(
                !input.idempotency_key.trim().is_empty() && input.idempotency_key.len() <= 128,
                "invalid request key"
            );
            let manifest: ArchiveCollectionManifest =
                serde_json::from_value(serde_json::to_value(input.manifest)?)?;
            validate_manifest(&manifest)?;
            let transfer = self.start(profile, "uploading", manifest.size)?;
            let result = (|| -> Result<()> {
                let root = ArchiveOwner::new()?;
                let directory = PrivateDirectory::open_existing(root.path())?;
                let files = manifest
                    .segments
                    .iter()
                    .map(|segment| directory.open_read_write_file(OsStr::new(&segment.name), true))
                    .collect::<Result<Vec<_>>>()?;
                transfer.lock()?.storage = Some(Storage::Import {
                    files,
                    root,
                    manifest,
                    received: 0,
                    index: 0,
                    offset: 0,
                    key: input.idempotency_key,
                });
                Ok(())
            })();
            if let Err(error) = result {
                transfer.finish(Err(error), None);
            }
            return Ok(serde_json::to_value(&transfer.lock()?.status)?);
        }
        if method == am::READ {
            let input: KnowledgeArchiveReadParams = serde_json::from_value(params)?;
            let transfer = self.lookup(&input.transfer_id, profile)?;
            transfer.check()?;
            let state = transfer.lock()?;
            let Some(Storage::Export { collection, .. }) = state.storage.as_ref() else {
                anyhow::bail!("Wiki export is not ready")
            };
            let segment = collection
                .manifest
                .segments
                .get(input.index)
                .context("Wiki export segment missing")?;
            ensure!(input.offset <= segment.size, "invalid Wiki export offset");
            let path = collection.segment_path(input.index)?;
            let directory =
                PrivateDirectory::open_existing(path.parent().context("segment parent missing")?)?;
            let mut file =
                directory.open_regular_file(path.file_name().context("segment name missing")?)?;
            file.seek(SeekFrom::Start(input.offset))?;
            let mut bytes = Vec::with_capacity(CHUNK_BYTES);
            file.take(CHUNK_BYTES as u64).read_to_end(&mut bytes)?;
            let next_offset = input.offset + bytes.len() as u64;
            return Ok(serde_json::to_value(KnowledgeArchiveReadResult {
                content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                next_offset,
                size: segment.size,
                eof: next_offset == segment.size,
            })?);
        }
        if method == am::CHUNK {
            let input: KnowledgeArchiveChunkParams = serde_json::from_value(params)?;
            ensure!(
                input.content_base64.len() <= CHUNK_BYTES.div_ceil(3) * 4,
                "Wiki chunk exceeds limit"
            );
            let bytes = base64::engine::general_purpose::STANDARD.decode(input.content_base64)?;
            ensure!(
                !bytes.is_empty() && bytes.len() <= CHUNK_BYTES,
                "invalid Wiki chunk size"
            );
            let transfer = self.lookup(&input.transfer_id, profile)?;
            transfer.check()?;
            let mut state = transfer.lock()?;
            let Some(Storage::Import {
                files,
                manifest,
                received,
                index,
                offset,
                ..
            }) = state.storage.as_mut()
            else {
                anyhow::bail!("Wiki transfer is not accepting uploads")
            };
            ensure!(
                input.index == *index && input.offset == *offset,
                "Wiki upload is sequential; query status after uncertain delivery"
            );
            let entry = manifest
                .segments
                .get(*index)
                .context("Wiki upload is complete")?;
            ensure!(
                *offset + bytes.len() as u64 <= entry.size,
                "Wiki upload exceeds declared segment size"
            );
            files[*index].write_all(&bytes)?;
            *received += bytes.len() as u64;
            *offset += bytes.len() as u64;
            if *offset == entry.size {
                files[*index].sync_all()?;
                *index += 1;
                *offset = 0;
            }
            state.status.completed_bytes += bytes.len() as u64;
            return Ok(serde_json::to_value(&state.status)?);
        }
        let input: KnowledgeArchiveIdParams = serde_json::from_value(params)?;
        let transfer = self.lookup(&input.transfer_id, profile)?;
        if method == am::CANCEL {
            transfer.cancel();
            return Ok(serde_json::to_value(&transfer.lock()?.status)?);
        }
        if method == am::STATUS {
            return Ok(serde_json::to_value(&transfer.lock()?.status)?);
        }
        ensure!(
            method == am::IMPORT_FINISH,
            "unsupported Wiki transfer action"
        );
        ensure!(
            knowledge_requests::organization_enabled(profile)?,
            "Wiki organization is disabled"
        );
        let storage = {
            let mut state = transfer.lock()?;
            ensure!(
                state.status.phase == "uploading",
                "Wiki import was already submitted; query status"
            );
            let Some(Storage::Import {
                received, manifest, ..
            }) = state.storage.as_ref()
            else {
                anyhow::bail!("Wiki import state missing")
            };
            ensure!(*received == manifest.size, "incomplete Wiki collection");
            let storage = state.storage.take().context("Wiki import state missing")?;
            state.status.phase = "processing".into();
            state.status.completed_bytes = 0;
            storage
        };
        let settings = profile.to_path_buf();
        let result = serde_json::to_value(&transfer.lock()?.status)?;
        let context = Arc::clone(&transfer);
        spawn_archive_worker(transfer, move || {
            let Storage::Import {
                files,
                root,
                manifest,
                key,
                ..
            } = storage
            else {
                anyhow::bail!("invalid Wiki import direction")
            };
            drop(files);
            let paths = manifest
                .segments
                .iter()
                .map(|segment| root.path().join(&segment.name))
                .collect::<Vec<_>>();
            let mut reader = ArchiveSegmentReader::open(manifest, &paths)?;
            let (mut catalog, scope) = knowledge_requests::open_catalog(&settings)?;
            context.check()?;
            let library = catalog.import_archive_stream(&scope, &key, &mut reader, |progress| {
                context.progress(progress)
            })?;
            drop(reader);
            drop(root);
            Ok((None, Some(library)))
        });
        Ok(result)
    }
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn validate_manifest(manifest: &ArchiveCollectionManifest) -> Result<()> {
    ensure!(
        manifest.format == "kcoder-wiki-collection" && manifest.version == 1,
        "unsupported Wiki collection format"
    );
    ensure!(
        uuid::Uuid::parse_str(&manifest.collection_id)?.to_string() == manifest.collection_id,
        "invalid Wiki collection identity"
    );
    ensure!(
        valid_hash(&manifest.sha256)
            && !manifest.segments.is_empty()
            && manifest.segments.len() <= 16,
        "invalid Wiki collection manifest"
    );
    let mut total = 0u64;
    for (index, segment) in manifest.segments.iter().enumerate() {
        ensure!(
            segment.index == index
                && segment.name == format!("part-{:05}.kwiki", index + 1)
                && valid_hash(&segment.sha256),
            "invalid Wiki segment identity"
        );
        ensure!(
            segment.size > 0 && segment.size <= MAX_ARCHIVE_SEGMENT_BYTES,
            "invalid Wiki segment size"
        );
        total = total
            .checked_add(segment.size)
            .context("Wiki collection size overflow")?;
        ensure!(total <= TOTAL_BYTES, "Wiki collection exceeds 1 GiB");
    }
    ensure!(total == manifest.size, "Wiki collection size mismatch");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wait(transfers: &mut ArchiveTransfers, profile: &Path, id: &str) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = transfers.request(
                knowledge_archive_method::STATUS,
                json!({"transferId":id}),
                profile,
            )?;
            if status["phase"] != "processing" {
                return Ok(status);
            }
            ensure!(Instant::now() < deadline, "archive worker did not finish");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn upload(
        transfers: &mut ArchiveTransfers,
        profile: &Path,
        manifest: &Value,
        bytes: &[u8],
        key: &str,
    ) -> Result<String> {
        use knowledge_archive_method as am;
        let started = transfers.request(
            am::IMPORT_START,
            json!({"manifest":manifest,"idempotencyKey":key}),
            profile,
        )?;
        let id = started["transferId"]
            .as_str()
            .context("missing transfer id")?
            .to_owned();
        let chunk = json!({"transferId":id,"index":0,"offset":0,"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)});
        transfers.request(am::CHUNK, chunk.clone(), profile)?;
        assert!(transfers.request(am::CHUNK, chunk, profile).is_err());
        transfers.request(am::IMPORT_FINISH, json!({"transferId":id}), profile)?;
        assert!(
            transfers
                .request(am::IMPORT_FINISH, json!({"transferId":id}), profile)
                .is_err()
        );
        Ok(id)
    }
    #[test]
    fn actual_stream_roundtrip_owner_bounds_cancel_corruption_and_receipts() -> Result<()> {
        use knowledge_archive_method as am;
        use knowledge_method as km;
        let root = tempfile::tempdir()?;
        let profile = root.path().join("settings.json");
        std::fs::write(&profile, r#"{"knowledge":{"enabled":true}}"#)?;
        let library = knowledge_requests::request(
            &profile,
            km::CREATE,
            json!({"name":"stream test","idempotencyKey":"create"}),
        )?;
        knowledge_requests::request(
            &profile,
            km::IMPORT_TEXT,
            json!({"libraryId":library["id"],"idempotencyKey":"source","title":"source","text":"immutable evidence"}),
        )?;
        let mut export = ArchiveTransfers::default();
        let started = export.request(
            am::EXPORT_START,
            json!({"libraryId":library["id"]}),
            &profile,
        )?;
        let id = started["transferId"].as_str().unwrap();
        let ready = wait(&mut export, &profile, id)?;
        assert_eq!(ready["phase"], "ready");
        assert_eq!(started["totalBytes"], ready["totalBytes"]);
        let manifest = &ready["manifest"];
        let mut foreign = ArchiveTransfers::default();
        assert!(
            foreign
                .request(
                    am::READ,
                    json!({"transferId":id,"index":0,"offset":0}),
                    &profile
                )
                .is_err()
        );
        assert!(
            foreign
                .request(
                    am::EXPORT_START,
                    json!({"libraryId":library["id"]}),
                    &profile
                )
                .is_err()
        );
        assert!(
            export
                .request(
                    am::READ,
                    json!({"transferId":id,"index":0,"offset":0}),
                    &root.path().join("other.json")
                )
                .is_err()
        );
        let part = export.request(
            am::READ,
            json!({"transferId":id,"index":0,"offset":0}),
            &profile,
        )?;
        assert_eq!(part["eof"], true);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(part["contentBase64"].as_str().unwrap())?;
        let transfer = export.current.as_ref().unwrap().clone();
        let staging = match transfer.lock()?.storage.as_ref().unwrap() {
            Storage::Export { collection, .. } => {
                collection.segment_path(0)?.parent().unwrap().to_owned()
            }
            _ => unreachable!(),
        };
        drop(export); // Disconnect cancels the owner, not other staged attachments.
        assert!(!staging.exists());
        assert!(!PROCESS_SLOT.load(Ordering::Acquire));
        let mut importer = ArchiveTransfers::default();
        let mut bad_manifest = manifest.clone();
        bad_manifest["segments"][0]["name"] = json!("../escape");
        assert!(
            importer
                .request(
                    am::IMPORT_START,
                    json!({"manifest":bad_manifest,"idempotencyKey":"bad"}),
                    &profile
                )
                .is_err()
        );
        let imported = upload(&mut importer, &profile, manifest, &bytes, "exact-request")?;
        let complete = wait(&mut importer, &profile, &imported)?;
        assert_eq!(complete["phase"], "completed", "{complete}");
        let imported_id = complete["library"]["id"].clone();
        let repeated = upload(&mut importer, &profile, manifest, &bytes, "exact-request")?;
        assert_eq!(
            wait(&mut importer, &profile, &repeated)?["library"]["id"],
            imported_id
        );
        let count = knowledge_requests::request(&profile, km::LIST, json!({}))?["items"]
            .as_array()
            .unwrap()
            .len();
        let mut corrupted = bytes.clone();
        *corrupted.last_mut().unwrap() ^= 1;
        let corrupted_id = upload(&mut importer, &profile, manifest, &corrupted, "corrupt")?;
        assert_eq!(
            wait(&mut importer, &profile, &corrupted_id)?["phase"],
            "failed"
        );
        assert_eq!(
            knowledge_requests::request(&profile, km::LIST, json!({}))?["items"]
                .as_array()
                .unwrap()
                .len(),
            count
        );
        assert_eq!(
            knowledge_requests::request(
                &profile,
                km::SOURCE_LIST,
                json!({"libraryId":library["id"]})
            )?["items"][0]["title"],
            "source"
        );
        Ok(())
    }
}
