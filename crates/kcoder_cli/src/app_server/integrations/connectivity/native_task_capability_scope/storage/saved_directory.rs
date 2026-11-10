//! A bounded page from the original index/records, without activating a runtime.
use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

const PAGE_SCAN_LIMIT: usize = 10;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    version: u32,
    offset: usize,
    index_revision: String,
}
impl NativeTaskCapabilityScopeBindingStore {
    pub(crate) fn read_saved_directory(
        &self,
        context: &NativeIntegrationContext,
        params: &IntegrationTaskCapabilityScopeDirectoryReadParams,
    ) -> Result<IntegrationTaskCapabilityScopeDirectorySnapshot> {
        params.validate()?;
        let directory = self.directory(context)?;
        let _lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("TASK_CAPABILITY_SCOPE_DIRECTORY_BUSY")?;
        let index = read_index(&directory)?;
        let index_revision = digest(&serde_json::json!([
            context.scope(),
            params.thread_id,
            index
        ]))?;
        let offset = if let Some(cursor) = &params.cursor {
            let raw = URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_DIRECTORY_CURSOR_INVALID"))?;
            let cursor: Cursor = serde_json::from_slice(&raw)
                .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_DIRECTORY_CURSOR_INVALID"))?;
            ensure!(
                cursor.version == 1
                    && cursor.index_revision == index_revision
                    && cursor.offset <= index.len(),
                "TASK_CAPABILITY_SCOPE_DIRECTORY_CURSOR_STALE"
            );
            cursor.offset
        } else {
            0
        };
        let end = offset.saturating_add(PAGE_SCAN_LIMIT).min(index.len());
        let mut entries = Vec::new();
        let mut has_unknown = false;
        for (key, _) in index.iter().skip(offset).take(PAGE_SCAN_LIMIT) {
            let reference_id = format!(
                "saved-source-{}",
                digest(&serde_json::json!(["saved-directory-row", key]))?
            );
            let record = match read_record_with_index(&directory, key, &index) {
                Ok(Some(record)) => record,
                _ => {
                    has_unknown = true;
                    entries.push(IntegrationTaskCapabilityScopeDirectoryEntry {
                        reference_id,
                        target: None,
                        saved_snapshot: None,
                        observation_state: IntegrationTaskCapabilityScopeDirectoryState::Unknown,
                        reason_code: Some("TASK_CAPABILITY_SCOPE_SAVED_RECORD_UNREADABLE".into()),
                    });
                    continue;
                }
            };
            ensure!(
                IntegrationOwner::from(&record.accepted.scope) == self.owner,
                "TASK_CAPABILITY_SCOPE_DIRECTORY_OWNER_CHANGED"
            );
            if params
                .thread_id
                .as_ref()
                .is_some_and(|thread| *thread != record.snapshot.thread_id)
            {
                continue;
            }
            // Project the saved tuple directly as lookup data. Do not create a
            // NativeAcceptedTaskIdentity from a record without actual runtime facts.
            let target = IntegrationTaskCapabilityScopeControlTarget {
                initial_attempt: record.accepted.initial_attempt,
                runtime_operation_id: match record.accepted.origin {
                    AcceptedOrigin::Runtime { operation_id, .. } => Some(operation_id),
                    AcceptedOrigin::Studio => None,
                },
            };
            let legacy_pending = record
                .pending
                .as_ref()
                .is_some_and(|pending| !record.controls.contains_key(&pending.operation_id));
            // Rows are saved metadata, not permits. The live context is checked
            // before this locked read and again before publishing the page.
            let scope_changed = context
                .check_captured_scope(&record.accepted.scope)
                .is_err();
            let reason = if legacy_pending {
                "TASK_CAPABILITY_SCOPE_LEGACY_PENDING_AUTHORITY_UNKNOWN"
            } else if scope_changed {
                "TASK_CAPABILITY_SCOPE_SAVED_SCOPE_CHANGED"
            } else {
                "TASK_CAPABILITY_SCOPE_LIVE_AUTHORITY_NOT_OBSERVED"
            };
            has_unknown |= legacy_pending || scope_changed;
            entries.push(IntegrationTaskCapabilityScopeDirectoryEntry {
                reference_id,
                target: Some(target),
                saved_snapshot: Some(record.snapshot),
                observation_state: if legacy_pending || scope_changed {
                    IntegrationTaskCapabilityScopeDirectoryState::Unknown
                } else {
                    IntegrationTaskCapabilityScopeDirectoryState::SavedOnly
                },
                reason_code: Some(reason.into()),
            });
        }
        let next_cursor = if end < index.len() {
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
                version: 1,
                offset: end,
                index_revision,
            })?))
        } else {
            None
        };
        let _ = self.directory(context)?;
        context.verify()?;
        // This state describes the saved directory only; it never means that
        // a task, account, source or nonresident runtime currently has authority.
        Ok(IntegrationTaskCapabilityScopeDirectorySnapshot {
            entries,
            next_cursor,
            observation_state: if has_unknown {
                IntegrationTaskCapabilityScopeDirectoryState::Unknown
            } else {
                IntegrationTaskCapabilityScopeDirectoryState::SavedOnly
            },
            reason_code: has_unknown.then(|| "TASK_CAPABILITY_SCOPE_SAVED_RECORDS_UNKNOWN".into()),
        })
    }
}
