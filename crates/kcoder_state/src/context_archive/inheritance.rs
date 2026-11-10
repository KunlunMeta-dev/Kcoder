use super::*;
use std::ffi::OsStr;
use std::io::Write;
use std::sync::Arc;

/// Opaque source identity captured with the exact native message payload.
/// Equal summary text cannot select a different generation's source range.
#[derive(Debug, Clone)]
pub struct ContextHistoryAnchor {
    pub(super) owner: crate::AppStateLifecycleIdentity,
    pub(super) path: PathBuf,
    pub(super) root: String,
    pub(super) summary_digest: [u8; 32],
    pub(super) checkpoint_body: Option<(uuid::Uuid, uuid::Uuid, u64)>,
}

impl ContextHistoryAnchor {
    /// Locate the canonical summary behind request-only Runtime overlays.
    /// Fork engines rebuild those overlays from their own frozen services.
    pub fn canonical_prefix_len(&self, messages: &[Message]) -> Result<Option<usize>> {
        let prefix = messages
            .iter()
            .take_while(|message| message.origin() == MessageOrigin::Runtime)
            .count();
        let Some(summary) = messages
            .get(prefix)
            .filter(|message| message.origin() == MessageOrigin::Compaction)
        else {
            return Ok(None);
        };
        ensure!(
            <[u8; 32]>::from(Sha256::digest(serde_json::to_vec(summary)?)) == self.summary_digest,
            "fork summary does not match its captured native source"
        );
        Ok(Some(prefix))
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ArchiveReference {
    pub file: uuid::Uuid,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug)]
pub(crate) struct InheritedArchive {
    reference: ArchiveReference,
    summary: Message,
    source: ContextBlockSource,
    summary_uuid: std::sync::OnceLock<String>,
    // History-less children own this directory until their last State drops.
    storage: Option<Arc<kcoder_config::PrivateTempDir>>,
}

struct UnpublishedArchive {
    directory: PrivateDirectory,
    name: String,
    attached: bool,
}

impl Drop for UnpublishedArchive {
    fn drop(&mut self) {
        if !self.attached {
            let _ = self.directory.remove_regular_file(OsStr::new(&self.name));
        }
    }
}

pub(super) fn archive_directory(path: &Path, create: bool) -> Result<PrivateDirectory> {
    let parent = path.parent().context("history has no parent")?;
    let id = path
        .file_stem()
        .and_then(OsStr::to_str)
        .context("invalid history name")?;
    PrivateDirectory::open_existing(parent)?
        .open_child(OsStr::new(&crate::artifact_id_path_component(id)), create)?
        .open_child(OsStr::new("context-history"), create)
}

pub(super) fn open_archive(path: &Path, reference: &ArchiveReference) -> Result<File> {
    ensure!(
        reference.sha256.len() == 64 && reference.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid inherited history digest"
    );
    archive_directory(path, false)?
        .open_single_link_regular_file(OsStr::new(&format!("{}.jsonl", reference.file)))
}

impl InheritedArchive {
    pub(crate) fn write_header(
        &self,
        output: &mut Vec<u8>,
        summary: &Message,
        uuid: &str,
    ) -> Result<()> {
        serde_json::to_writer(
            &mut *output,
            &serde_json::json!({
                "type":"system", "subtype":"context_archive_reference", "archive":self.reference
            }),
        )?;
        output.push(b'\n');
        let selected = summary.origin() == MessageOrigin::Compaction
            && self
                .summary_uuid
                .get()
                .map_or_else(|| summary == &self.summary, |bound| bound == uuid);
        if selected {
            self.summary_uuid.get_or_init(|| uuid.to_owned());
            serde_json::to_writer(
                &mut *output,
                &serde_json::json!({
                    "type":"system", "subtype":"compact_boundary",
                    "compactMetadata":{"contextSource":self.source}
                }),
            )?;
            output.push(b'\n');
        }
        Ok(())
    }
}

impl AppState {
    pub fn context_history_anchor(
        &self,
        messages: &kcoder_types::SharedMessages,
    ) -> Option<ContextHistoryAnchor> {
        let inner = self.read_inner();
        let summary = inner
            .messages
            .first()
            .filter(|message| message.origin() == MessageOrigin::Compaction)?;
        if !messages
            .iter()
            .any(|message| std::ptr::eq(message, summary))
        {
            return None;
        }
        Some(ContextHistoryAnchor {
            owner: crate::history_append_context::lifecycle_identity_locked(self, &inner),
            path: inner.history_path.clone()?,
            root: inner.message_history_ids.first()?.clone()?,
            summary_digest: Sha256::digest(serde_json::to_vec(summary).ok()?).into(),
            checkpoint_body: None,
        })
    }

    /// Freeze only the compression ancestry actually inherited by this new
    /// child. No path, receipt, permission or parent runtime is delegated.
    pub fn inherit_compacted_history_from(
        &self,
        parent: &AppState,
        anchor: &ContextHistoryAnchor,
        cancelled: impl Fn() -> bool,
    ) -> Result<bool> {
        ensure!(
            !self.shares_state_with(parent),
            "compression inheritance requires a separate child State"
        );
        ensure!(
            anchor.owner.matches(parent),
            "parent context lifecycle changed"
        );
        let (messages, revision) = self.shared_messages_with_revision();
        let Some(summary) = messages
            .first()
            .filter(|m| m.origin() == MessageOrigin::Compaction)
        else {
            return Ok(false);
        };
        let (path, storage) = {
            let inner = self.read_inner();
            ensure!(
                inner.inherited_context_archive.is_none(),
                "compression inheritance is already bound"
            );
            if let Some(path) = &inner.history_path {
                ensure!(
                    !path.try_exists()? || open_history(path)?.metadata()?.len() == 0,
                    "compression inheritance requires an uncommitted child"
                );
                (path.clone(), None)
            } else {
                let root = self
                    .usage_history_root()
                    .and_then(|root| root.parent().map(Path::to_path_buf))
                    .unwrap_or_else(|| inner.cwd.clone());
                let storage = Arc::new(kcoder_config::create_private_temp_dir_in(
                    &root,
                    "kcoder-context-history",
                )?);
                (
                    storage.path().join(format!("{}.jsonl", inner.session_id)),
                    Some(storage),
                )
            }
        };
        let query = ContextHistoryQuery::default();
        loop {
            let page = parent.context_history(&query, &cancelled)?;
            if !page.indexing {
                if page.blocks.is_empty() {
                    return Ok(false);
                }
                break;
            }
        }
        let (source, parent_root) = {
            let inner = parent.read_inner();
            (
                inner
                    .history_source
                    .clone()
                    .context("parent compression source unavailable")?,
                inner
                    .message_history_ids
                    .first()
                    .cloned()
                    .flatten()
                    .context("parent compression identity unavailable")?,
            )
        };
        source.check_read_binding()?;
        let mut cache = parent
            .context_archive_cache
            .try_lock()
            .map_err(|_| anyhow::anyhow!("parent context history is busy"))?;
        let archive = cache
            .as_mut()
            .context("parent compression index unavailable")?;
        ensure!(
            archive.path == anchor.path && archive.reachable(&parent_root)?.contains(&anchor.root),
            "inherited summary is outside the parent's reachable compression ancestry"
        );
        let root = anchor.root.clone();
        ensure!(
            <[u8; 32]>::from(Sha256::digest(serde_json::to_vec(summary)?)) == anchor.summary_digest,
            "inherited summary does not match its original source identity"
        );
        archive.read_message(&root)?;
        if let Some((incarnation, generation, bytes)) = anchor.checkpoint_body {
            let body = archive.stamp.committed_body_key()?;
            let row = &archive.rows[&root];
            ensure!(
                body.0 == incarnation
                    && body.1 == generation
                    && !row.inherited
                    && row.offset + row.bytes as u64 <= bytes,
                "checkpoint root is outside its committed body"
            );
        }
        let directory = archive_directory(&path, true)?;
        let file_id = uuid::Uuid::new_v4();
        let name = format!("{file_id}.jsonl");
        let mut pending = UnpublishedArchive {
            directory,
            name,
            attached: false,
        };
        let mut file = pending
            .directory
            .open_read_write_file(OsStr::new(&pending.name), true)?;
        let exported = archive
            .export_sources(&root, &mut file, &cancelled)
            .and_then(|reference| {
                file.sync_all()?;
                pending.directory.sync()?;
                source.check_read_binding()?;
                let current = parent.read_inner();
                ensure!(
                    anchor.owner.matches_locked(parent, &current)
                        && current.history_path.as_ref() == Some(&anchor.path)
                        && current
                            .history_source
                            .as_ref()
                            .is_some_and(|current| source.identity().matches(current)),
                    "parent context lifecycle changed during inheritance"
                );
                drop(current);
                ensure!(
                    committed_source_stamp(&archive.path)?.extends_committed_body(&archive.stamp),
                    "parent history changed during inheritance"
                );
                Ok(ArchiveReference {
                    file: file_id,
                    ..reference
                })
            });
        let reference = match exported {
            Ok(reference) => reference,
            Err(error) => {
                drop(file);
                return Err(error);
            }
        };
        drop(file);
        let inherited = Arc::new(InheritedArchive {
            reference,
            summary: summary.clone(),
            source: archive.blocks[&root].source.clone(),
            summary_uuid: std::sync::OnceLock::new(),
            storage,
        });
        drop(cache);
        ensure!(!cancelled(), "context history inheritance cancelled");
        {
            let _persist = self.lock_session_state_persistence();
            let mut inner = self.write_inner();
            ensure!(
                inner.message_revision == revision
                    && inner.inherited_context_archive.is_none()
                    && inner
                        .history_path
                        .as_ref()
                        .is_none_or(|current| current == &path),
                "child context changed during inheritance"
            );
            if inner.history_path.is_none() {
                Self::install_history_path(&mut inner, path);
            }
            if let Some(storage) = &inherited.storage {
                inner
                    .history_source
                    .as_ref()
                    .context("child history source unavailable")?
                    .retain_private_storage(storage.clone());
            }
            inner.inherited_context_archive = Some(inherited);
            pending.attached = true;
        }
        self.save_history()?;
        Ok(true)
    }
}

impl ContextArchive {
    fn export_sources(
        &mut self,
        root: &str,
        file: &mut File,
        cancelled: &impl Fn() -> bool,
    ) -> Result<ArchiveReference> {
        let mut pending = vec![root.to_owned()];
        let mut ids = HashSet::new();
        while let Some(id) = pending.pop() {
            ensure!(!cancelled(), "context history inheritance cancelled");
            if let Some(block) = self.blocks.get(&id) {
                for source in &block.source.message_ids {
                    if ids.insert(source.clone()) {
                        pending.push(source.clone());
                    }
                }
            }
            ensure!(
                ids.len() <= MAX_ROWS,
                "inherited context exceeds its record budget"
            );
        }
        ids.remove(root);
        let mut ids = ids
            .into_iter()
            .filter(|id| self.rows.contains_key(id))
            .collect::<Vec<_>>();
        ids.sort_by_key(|id| {
            let row = &self.rows[id];
            (!row.inherited, row.offset)
        });
        let mut hash = Sha256::new();
        let mut bytes = 0;
        for id in ids {
            ensure!(!cancelled(), "context history inheritance cancelled");
            let (message, _) = self.read_message(&id)?;
            let message = if self.rows[&id].is_summary {
                message
            } else {
                kcoder_types::public_conversation_message(&message)
                    .unwrap_or_else(|| Message::runtime_text(""))
            };
            let entry = HistoryEntry {
                web_sources: Vec::new(),
                history_attempt: None,
                session_id: String::new(),
                timestamp_ms: 0,
                uuid: Some(id.clone()),
                parent_uuid: None,
                message,
            };
            let mut encoded = Vec::new();
            if let Some(block) = self.blocks.get(&id) {
                serde_json::to_writer(
                    &mut encoded,
                    &serde_json::json!({"type":"system", "subtype":"compact_boundary", "compactMetadata":{"contextSource":block.source}}),
                )?;
                encoded.push(b'\n');
            }
            serde_json::to_writer(&mut encoded, &entry)?;
            encoded.push(b'\n');
            file.write_all(&encoded)?;
            hash.update(&encoded);
            bytes += encoded.len() as u64;
        }
        Ok(ArchiveReference {
            file: uuid::Uuid::nil(),
            bytes,
            sha256: format!("{:x}", hash.finalize()),
        })
    }
}
