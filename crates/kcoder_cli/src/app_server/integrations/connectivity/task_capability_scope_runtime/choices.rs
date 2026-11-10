//! Exact task descriptor pages. A cursor neither selects a source nor grants access.
use super::*;
use kcoder_app_rpc_codec as rpc_codec;
use std::{
    sync::Weak,
    time::{Duration, Instant},
};
const PAGE: usize = 10;
pub(super) struct Directory {
    snapshots: Mutex<BTreeMap<String, Snapshot>>,
    blocking: Arc<tokio::sync::Semaphore>,
}
impl Default for Directory {
    fn default() -> Self {
        Self::new()
    }
}
struct Snapshot {
    owner: Weak<()>,
    target: IntegrationTaskCapabilityScopeControlTarget,
    revision: String,
    expires: Instant,
    items: Vec<IntegrationTaskCapabilitySourceDescriptor>,
    state: IntegrationTaskCapabilitySourceCatalogState,
}
pub(crate) struct PreparedSourceChoices {
    runtime: Arc<NativeTaskCapabilityScopeRuntime>,
    source: PreparedTaskCapabilityScopeControl,
    params: IntegrationTaskCapabilitySourceChoicesParams,
}
impl NativeTaskCapabilityScopeRuntime {
    pub(crate) fn capture_public_choices(
        self: &Arc<Self>,
        state: &ConnectionState,
        request: IntegrationRequest,
        threads: &ThreadManager,
        configuration: &AppServerEngineFactory,
    ) -> Result<PreparedSourceChoices> {
        request.validate(false)?;
        ensure!(
            !state.native_source_dispatch && state.native_source_accepted.is_none(),
            "TASK_CAPABILITY_SCOPE_PUBLIC_CHOICES_REQUIRED"
        );
        let params: IntegrationTaskCapabilitySourceChoicesParams =
            rpc_codec::decode(serde_json::Value::Object(request.payload.clone()))?;
        params.validate()?;
        let mut read = request;
        read.operation_id = None;
        read.expected_revision = None;
        read.payload=serde_json::json!({"target":params.target,"params":{"threadId":params.target.initial_attempt.thread_id}}).as_object().unwrap().clone();
        let source = self.capture_public_control(
            state,
            read,
            NativeTaskCapabilityScopeControlMethod::Read,
            threads,
            configuration,
        )?;
        Ok(PreparedSourceChoices {
            runtime: self.clone(),
            source,
            params,
        })
    }
}
impl PreparedSourceChoices {
    pub(crate) async fn run(self) -> Result<IntegrationTaskCapabilitySourceChoicesPage> {
        let source = self.source;
        ensure!(
            source.owner.upgrade().is_some() && !source.cancel.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        NativeTaskCapabilityScopeControlTarget::restore(
            &source.context,
            &source.reference,
            source.facts.clone(),
            source.catalog.clone(),
        )
        .await?
        .context("TASK_CAPABILITY_SCOPE_ORIGINAL_BINDING_NOT_OBSERVED")?;
        let facts = source.facts.clone();
        let catalog = source.catalog.clone();
        let context = source.context.clone();
        let permit = self
            .runtime
            .choices
            .blocking
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SOURCE_CHOICES_BUSY"))?;
        let inventory = crate::app_server::task_spawn::spawn_blocking(move || {
            let _permit = permit;
            facts.source_choices_inventory(&context, &catalog)
        })
        .await
        .context("TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE")??;
        ensure!(
            source.owner.upgrade().is_some() && !source.cancel.is_cancelled(),
            "TASK_CAPABILITY_SCOPE_NATIVE_CALLER_EXPIRED"
        );
        let revision = key_choices(&self.params.target, &inventory.request_revision)?;
        let state = if inventory.catalog_state == "observed" {
            IntegrationTaskCapabilitySourceCatalogState::Observed
        } else {
            IntegrationTaskCapabilitySourceCatalogState::Unknown
        };
        self.runtime.choices.page(
            source.owner,
            &self.params,
            revision,
            inventory.task_sources,
            state,
        )
    }
}
impl Directory {
    pub(super) fn new() -> Self {
        Self {
            snapshots: Mutex::new(BTreeMap::new()),
            blocking: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
    fn page(
        &self,
        owner: Weak<()>,
        request: &IntegrationTaskCapabilitySourceChoicesParams,
        revision: String,
        items: Vec<IntegrationTaskCapabilitySourceDescriptor>,
        state: IntegrationTaskCapabilitySourceCatalogState,
    ) -> Result<IntegrationTaskCapabilitySourceChoicesPage> {
        ensure!(
            items.len() <= 256,
            "TASK_CAPABILITY_SOURCE_CHOICES_CAPACITY"
        );
        let mut snapshots = self
            .snapshots
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE"))?;
        snapshots.retain(|_, s| s.owner.upgrade().is_some() && s.expires > Instant::now());
        let (id, offset) = match request.cursor.as_deref() {
            None => {
                ensure!(
                    snapshots.len() < 32,
                    "TASK_CAPABILITY_SOURCE_CHOICES_CAPACITY"
                );
                let id = uuid::Uuid::new_v4().to_string();
                snapshots.insert(
                    id.clone(),
                    Snapshot {
                        owner,
                        target: request.target.clone(),
                        revision: revision.clone(),
                        expires: Instant::now() + Duration::from_secs(60),
                        items,
                        state,
                    },
                );
                (id, 0)
            }
            Some(cursor) => {
                let (id, offset) = cursor
                    .split_once('.')
                    .context("TASK_CAPABILITY_SOURCE_CHOICES_CURSOR_INVALID")?;
                let offset = offset.parse::<usize>().map_err(|_| {
                    anyhow::anyhow!("TASK_CAPABILITY_SOURCE_CHOICES_CURSOR_INVALID")
                })?;
                let snapshot = snapshots
                    .get(id)
                    .context("TASK_CAPABILITY_SOURCE_CHOICES_CURSOR_EXPIRED")?;
                ensure!(
                    Weak::ptr_eq(&snapshot.owner, &owner)
                        && snapshot.target == request.target
                        && snapshot.revision == revision
                        && request.catalog_revision.as_deref() == Some(revision.as_str())
                        && offset > 0
                        && offset % PAGE == 0
                        && offset < snapshot.items.len(),
                    "TASK_CAPABILITY_SOURCE_CHOICES_CURSOR_CHANGED"
                );
                (id.to_owned(), offset)
            }
        };
        let snapshot = snapshots.get(&id).unwrap();
        let end = (offset + PAGE).min(snapshot.items.len());
        Ok(IntegrationTaskCapabilitySourceChoicesPage {
            target: snapshot.target.clone(),
            catalog_revision: snapshot.revision.clone(),
            catalog_state: snapshot.state,
            items: snapshot.items[offset..end].to_vec(),
            next_cursor: if end < snapshot.items.len() {
                IntegrationNullable::Value(format!("{id}.{end}"))
            } else {
                IntegrationNullable::Null
            },
        })
    }
}
fn key_choices(
    target: &IntegrationTaskCapabilityScopeControlTarget,
    inventory: &str,
) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(target, inventory))?)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> IntegrationTaskCapabilityScopeControlTarget {
        serde_json::from_value(serde_json::json!({"initialAttempt":{"threadId":"original-thread","turnId":"original-turn","attemptId":"original-attempt"}})).unwrap()
    }
    fn items() -> Vec<IntegrationTaskCapabilitySourceDescriptor> {
        (0..11)
            .map(|i| IntegrationTaskCapabilitySourceDescriptor {
                source_ref: IntegrationRevisionRef {
                    id: format!("controlled-source-{i}"),
                    revision: "1".into(),
                },
                account_ref: IntegrationNullable::Null,
                kind: IntegrationTaskCapabilitySourceKind::Mcp,
                display_name: format!("controlled-source-{i}"),
                account_display_name: IntegrationNullable::Null,
                state: IntegrationTaskCapabilitySourceState::Ready,
                reason_code: IntegrationNullable::Null,
                capabilities: [IntegrationTaskCapabilitySourceCapability::Tools]
                    .into_iter()
                    .collect(),
            })
            .collect()
    }
    #[test]
    fn exact_choices_cursor_preserves_original_page_and_refuses_peer_target_or_revision()
    -> Result<()> {
        let directory = Directory::new();
        let owner = Arc::new(());
        let request = IntegrationTaskCapabilitySourceChoicesParams {
            target: target(),
            cursor: None,
            catalog_revision: None,
        };
        let first = directory.page(
            Arc::downgrade(&owner),
            &request,
            "original-catalog".into(),
            items(),
            IntegrationTaskCapabilitySourceCatalogState::Observed,
        )?;
        assert_eq!(first.items.len(), 10);
        let mut next = request;
        next.cursor = first.next_cursor.as_ref().cloned();
        next.catalog_revision = Some(first.catalog_revision);
        let second = directory.page(
            Arc::downgrade(&owner),
            &next,
            "original-catalog".into(),
            items(),
            IntegrationTaskCapabilitySourceCatalogState::Observed,
        )?;
        assert_eq!(second.items.len(), 1);
        assert!(second.next_cursor.as_ref().is_none());
        assert_eq!(second.target, next.target);
        let peer = Arc::new(());
        assert!(
            directory
                .page(
                    Arc::downgrade(&peer),
                    &next,
                    "original-catalog".into(),
                    items(),
                    IntegrationTaskCapabilitySourceCatalogState::Observed
                )
                .is_err()
        );
        assert!(
            directory
                .page(
                    Arc::downgrade(&owner),
                    &next,
                    "changed-catalog".into(),
                    items(),
                    IntegrationTaskCapabilitySourceCatalogState::Observed
                )
                .is_err()
        );
        next.target.initial_attempt.attempt_id = "different-attempt".into();
        assert!(
            directory
                .page(
                    Arc::downgrade(&owner),
                    &next,
                    "original-catalog".into(),
                    items(),
                    IntegrationTaskCapabilitySourceCatalogState::Observed
                )
                .is_err()
        );
        Ok(())
    }
}
