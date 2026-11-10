use anyhow::{Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use kcoder_types::integrations::core::{IntegrationModelSelectionIntent, IntegrationScope};
use kcoder_types::integrations::knowledge::{
    AutomationDeliveryStatus, AutomationDestination, AutomationRun, AutomationRunStatus,
    AutomationSubscription, AutomationSubscriptionDraft, KnowledgeOwner, KnowledgePage,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, io::Read, path::Path};

const FILE: &str = "automations.json";
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_ITEMS: usize = 10_000;
const READ_LOCK_WAIT: std::time::Duration = std::time::Duration::from_millis(250);
mod native_task_projection;
use native_task_projection::project_original_native_task;

/// Host-created consent evidence, intentionally not deserializable from RPC/model input.
pub struct ApprovedAutomationConsent {
    owner: KnowledgeOwner,
    reference: String,
    draft_identity: String,
    event_source: Option<String>,
    native_source_start: Option<std::sync::Arc<dyn VerifiedAutomationSourceStart>>,
}
impl ApprovedAutomationConsent {
    /// Call only after current native authorization and an explicit scheduling request.
    pub fn from_explicit_user_action(
        scope: &IntegrationScope,
        reference: &str,
        draft: &AutomationSubscriptionDraft,
    ) -> Result<Self> {
        scope.validate()?;
        validate_id(reference)?;
        validate_draft(draft)?;
        Ok(Self {
            owner: scope.into(),
            reference: reference.into(),
            draft_identity: digest(&serde_json::to_string(draft)?),
            event_source: draft.event_source.clone(),
            native_source_start: None,
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    intent: Value,
    result: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerReceipt {
    intent: Value,
    run_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Data {
    version: u32,
    owner: KnowledgeOwner,
    subscriptions: BTreeMap<String, AutomationSubscription>,
    #[serde(default)]
    subscription_versions: BTreeMap<String, AutomationSubscription>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    native_source_starts: BTreeMap<String, source_start::SourceStart>,
    receipts: BTreeMap<String, Receipt>,
    triggers: BTreeMap<String, TriggerReceipt>,
    runs: BTreeMap<String, AutomationRun>,
    hidden_runs: std::collections::BTreeSet<String>,
    #[serde(default)]
    event_cursors: BTreeMap<String, EventCursor>,
    #[serde(default)]
    native_acceptances:
        BTreeMap<String, kcoder_types::integrations::core::IntegrationRuntimeAcceptance>,
    #[serde(default)]
    event_admissions: BTreeMap<String, event_window::EventAdmission>,
    #[serde(default)]
    event_windows: BTreeMap<String, event_window::EventWindow>,
    #[serde(default)]
    quarantined_events: BTreeMap<String, event_window::QuarantinedEvent>,
    #[serde(default)]
    artifact_claims:
        BTreeMap<String, kcoder_types::integrations::knowledge::AutomationArtifactClaim>,
    #[serde(default)]
    submissions: std::collections::BTreeSet<String>,
    #[serde(default)]
    artifact_manifests:
        BTreeMap<String, Vec<kcoder_types::integrations::core::IntegrationEntityRef>>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventCursor {
    sequence: u64,
    event_id: String,
    run_id: String,
}
/// Private, crash-safe automation ledger. It never starts a timer or a model by itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreBinding {
    version: u32,
    owner: KnowledgeOwner,
    lock_identity: PortableLeaseIdentity,
}
pub struct AutomationStore {
    directory: PrivateDirectory,
    owner: KnowledgeOwner,
    binding: StoreBinding,
    binding_identity: PortableLeaseIdentity,
    lock_anchor: std::fs::File,
    binding_anchor: std::fs::File,
    #[cfg(test)]
    ack_loss: std::sync::atomic::AtomicBool,
}
impl AutomationStore {
    /// Pure draft validation creates no consent, namespace, timer or execution record.
    pub fn validate_subscription_draft(draft: &AutomationSubscriptionDraft) -> Result<()> {
        validate_draft(draft)
    }
    pub fn owner(&self) -> &KnowledgeOwner {
        &self.owner
    }
    /// Explicit first initialization; an existing domain directory is never adopted.
    pub fn create(path: &Path, scope: &IntegrationScope) -> Result<Self> {
        let parent = PrivateDirectory::open_existing(
            path.parent()
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_INVALID_STORE_PATH"))?,
        )?;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_INVALID_STORE_PATH"))?;
        Self::create_in(&parent, name, scope)
    }
    /// Initialize beneath an already authenticated parent without reopening its path.
    pub fn create_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        scope.validate()?;
        parent.verify_private_directory()?;
        let directory = parent
            .create_private_child(name)
            .map_err(|_| anyhow::anyhow!("AUTOMATION_STORE_CREATE_UNAVAILABLE"))?;
        let owner = KnowledgeOwner::from(scope);
        let initialized = (|| -> Result<()> {
            let lock = directory.open_read_write_file(OsStr::new("automations.lock"), true)?;
            lock.sync_all()?;
            directory.sync()?;
            let lock_identity = directory.portable_regular_handle_identity(&lock)?;
            let binding = StoreBinding {
                version: 1,
                owner: owner.clone(),
                lock_identity,
            };
            let data = Data {
                version: 1,
                owner: owner.clone(),
                subscriptions: BTreeMap::new(),
                subscription_versions: BTreeMap::new(),
                native_source_starts: BTreeMap::new(),
                receipts: BTreeMap::new(),
                triggers: BTreeMap::new(),
                runs: BTreeMap::new(),
                hidden_runs: Default::default(),
                submissions: Default::default(),
                artifact_manifests: Default::default(),
                event_cursors: Default::default(),
                native_acceptances: Default::default(),
                event_admissions: Default::default(),
                event_windows: Default::default(),
                quarantined_events: Default::default(),
                artifact_claims: Default::default(),
            };
            directory.atomic_replace(OsStr::new(FILE), &serde_json::to_vec(&data)?)?;
            directory.atomic_replace(
                OsStr::new("automation-binding.json"),
                &serde_json::to_vec(&binding)?,
            )?;
            Ok(())
        })();
        initialized.map_err(|_| anyhow::anyhow!("AUTOMATION_INITIALIZATION_UNCONFIRMED"))?;
        Self::from_directory(directory, scope)
    }
    /// Pure existing-store open: missing or damaged state never becomes an empty store.
    pub fn open(path: &Path, scope: &IntegrationScope) -> Result<Self> {
        Self::from_directory(PrivateDirectory::open_existing(path)?, scope)
    }
    /// Read an existing child through held native handles; missing entries stay missing.
    pub fn open_in(
        parent: &PrivateDirectory,
        name: &OsStr,
        scope: &IntegrationScope,
    ) -> Result<Self> {
        parent.verify_private_directory()?;
        let entry = parent.open_entry_handle(name)?;
        Self::from_directory(entry.open_child_directory()?, scope)
    }
    fn from_directory(directory: PrivateDirectory, scope: &IntegrationScope) -> Result<Self> {
        scope.validate()?;
        directory.verify_private_directory()?;
        let owner = KnowledgeOwner::from(scope);
        let binding: StoreBinding =
            read_private_json(&directory, "automation-binding.json", 16 * 1024)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_STORE_BINDING_INVALID"))?;
        ensure!(
            binding.version == 1 && binding.owner == owner,
            "AUTOMATION_SCOPE_MISMATCH"
        );
        let binding_anchor =
            directory.open_single_link_regular_file(OsStr::new("automation-binding.json"))?;
        let binding_identity = directory.portable_regular_handle_identity(&binding_anchor)?;
        let lock_anchor =
            directory.open_single_link_regular_file(OsStr::new("automations.lock"))?;
        ensure!(
            directory.portable_regular_handle_identity(&lock_anchor)? == binding.lock_identity,
            "AUTOMATION_STORE_LOCK_CHANGED"
        );
        let store = Self {
            directory,
            owner,
            binding,
            binding_identity,
            lock_anchor,
            binding_anchor,
            #[cfg(test)]
            ack_loss: std::sync::atomic::AtomicBool::new(false),
        };
        store.access(false, |_| Ok(()))?;
        Ok(store)
    }
    fn verify_binding(&self) -> Result<()> {
        self.directory.verify_private_directory()?;
        ensure!(
            self.directory
                .portable_regular_handle_identity(&self.lock_anchor)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_STORE_LOCK_CHANGED"))?
                == self.binding.lock_identity,
            "AUTOMATION_STORE_LOCK_CHANGED"
        );
        ensure!(
            self.directory
                .portable_regular_handle_identity(&self.binding_anchor)?
                == self.binding_identity,
            "AUTOMATION_STORE_BINDING_CHANGED"
        );
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new("automation-binding.json"))?
                == self.binding_identity,
            "AUTOMATION_STORE_BINDING_CHANGED"
        );
        let current: StoreBinding =
            read_private_json(&self.directory, "automation-binding.json", 16 * 1024)?;
        ensure!(current == self.binding, "AUTOMATION_STORE_BINDING_CHANGED");
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new("automations.lock"))
                .map_err(|_| anyhow::anyhow!("AUTOMATION_STORE_LOCK_CHANGED"))?
                == self.binding.lock_identity,
            "AUTOMATION_STORE_LOCK_CHANGED"
        );
        Ok(())
    }
    fn with_store_lock<T>(&self, write: bool, action: impl FnOnce() -> Result<T>) -> Result<T> {
        self.verify_binding()?;
        let mode = if write {
            PrivateLeaseMode::Exclusive
        } else {
            PrivateLeaseMode::Shared
        };
        let started = std::time::Instant::now();
        let mut attempted = false;
        let _lease = loop {
            ensure!(
                !attempted || started.elapsed() < READ_LOCK_WAIT,
                "AUTOMATION_BUSY"
            );
            attempted = true;
            if let Some(lease) = self
                .directory
                .try_existing_portable_lock(
                    OsStr::new("automations.lock"),
                    &self.binding.lock_identity,
                    mode,
                )
                .map_err(|_| anyhow::anyhow!("AUTOMATION_STORE_LOCK_CHANGED"))?
            {
                break lease;
            }
            // A live short writer is not missing/corrupt state. Pure reads may
            // wait for the same verified lock; writes never replay an action.
            ensure!(
                !write && started.elapsed() < READ_LOCK_WAIT,
                "AUTOMATION_BUSY"
            );
            std::thread::sleep(
                std::time::Duration::from_millis(2)
                    .min(READ_LOCK_WAIT.saturating_sub(started.elapsed())),
            );
            self.verify_binding()?;
        };
        action()
    }
    fn access<T>(&self, write: bool, action: impl FnOnce(&mut Data) -> Result<T>) -> Result<T> {
        self.with_store_lock(write, || {
            let mut data: Data = read_private_json(&self.directory, FILE, MAX_BYTES)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_STORE_UNAVAILABLE"))?;
            ensure!(data.version == 1, "AUTOMATION_STORE_VERSION_UNSUPPORTED");
            ensure!(data.owner == self.owner, "AUTOMATION_SCOPE_MISMATCH");
            let result = action(&mut data)?;
            self.verify_binding()?;
            if write {
                let bytes = serde_json::to_vec(&data)?;
                ensure!(bytes.len() <= MAX_BYTES, "AUTOMATION_STORE_FULL");
                self.directory
                    .atomic_replace(OsStr::new(FILE), &bytes)
                    .map_err(|_| anyhow::anyhow!("AUTOMATION_WRITE_UNCONFIRMED"))?;
                #[cfg(test)]
                if self
                    .ack_loss
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    anyhow::bail!("AUTOMATION_WRITE_UNCONFIRMED");
                }
                self.verify_binding()
                    .map_err(|_| anyhow::anyhow!("AUTOMATION_WRITE_UNCONFIRMED"))?;
            }
            Ok(result)
        })
    }
    /// Observe physical invalidation under the original verified reader lease.
    /// This is not authorization: a changed epoch still requires full source validation.
    pub fn observation_epoch(&self) -> Result<String> {
        self.observe_epoch(|_| Ok(()))
    }
    fn observe_epoch(&self, sampled: impl FnOnce(&std::fs::File) -> Result<()>) -> Result<String> {
        self.with_store_lock(false, || {
            let mut file = self
                .directory
                .open_single_link_regular_file(OsStr::new(FILE))?;
            let identity = self.directory.portable_regular_handle_identity(&file)?;
            let before = self.observation_stamp(&file)?;
            sampled(&file)?;
            ensure!(
                file.metadata()?.len() <= MAX_BYTES as u64,
                "PRIVATE_DOMAIN_RECORD_TOO_LARGE"
            );
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= MAX_BYTES, "PRIVATE_DOMAIN_RECORD_TOO_LARGE");
            let data: Data = serde_json::from_slice(&bytes)?;
            ensure!(data.version == 1, "AUTOMATION_STORE_VERSION_UNSUPPORTED");
            ensure!(data.owner == self.owner, "AUTOMATION_SCOPE_MISMATCH");
            ensure!(
                self.observation_stamp(&file)? == before
                    && self.directory.portable_regular_identity(OsStr::new(FILE))? == identity,
                "AUTOMATION_STORE_CHANGED_DURING_OBSERVATION"
            );
            self.verify_binding()?;
            Ok(format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&json!([
                    self.directory.directory_identity()?,
                    self.binding_identity,
                    self.binding.lock_identity,
                    before
                ]))?)
            ))
        })
    }
    fn observation_stamp(&self, file: &std::fs::File) -> Result<Value> {
        let identity = self.directory.portable_regular_handle_identity(file)?;
        let metadata = file.metadata()?;
        let modified = metadata.modified()?.duration_since(std::time::UNIX_EPOCH)?;
        #[cfg(unix)]
        let changed = {
            use std::os::unix::fs::MetadataExt;
            (metadata.ctime(), metadata.ctime_nsec())
        };
        #[cfg(not(unix))]
        let changed = ();
        Ok(json!([
            identity,
            metadata.len(),
            modified.as_secs(),
            modified.subsec_nanos(),
            changed
        ]))
    }
    fn replay<T: for<'de> Deserialize<'de>>(
        data: &Data,
        operation: &str,
        intent: &Value,
    ) -> Result<Option<T>> {
        validate_id(operation)?;
        if let Some(receipt) = data.receipts.get(operation) {
            ensure!(&receipt.intent == intent, "AUTOMATION_OPERATION_CONFLICT");
            return Ok(Some(serde_json::from_value(receipt.result.clone())?));
        }
        ensure!(
            data.receipts.len() < MAX_ITEMS,
            "AUTOMATION_RECEIPT_CAPACITY"
        );
        Ok(None)
    }
    fn receipt(
        data: &mut Data,
        operation: &str,
        intent: Value,
        result: &impl Serialize,
    ) -> Result<()> {
        data.receipts.insert(
            operation.into(),
            Receipt {
                intent,
                result: serde_json::to_value(result)?,
            },
        );
        Ok(())
    }
    pub fn save_subscription(
        &self,
        operation: &str,
        expected_revision: u64,
        draft: AutomationSubscriptionDraft,
        consent: &ApprovedAutomationConsent,
        next_fire_at_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<AutomationSubscription> {
        validate_draft(&draft)?;
        ensure!(
            consent.owner == self.owner
                && consent.draft_identity == digest(&serde_json::to_string(&draft)?),
            "AUTOMATION_CONSENT_MISMATCH"
        );
        let intent = json!({"action":"save","revision":expected_revision,"draft":draft,"consentRef":consent.reference});
        self.access(true, |data| {
            if let Some(old) = Self::replay(data, operation, &intent)? {
                return Ok(old);
            }
            ensure!(
                next_fire_at_ms.is_none_or(|t| t > now_ms),
                "AUTOMATION_NEXT_FIRE_NOT_FUTURE"
            );
            ensure!(
                draft.schedule.is_some() == next_fire_at_ms.is_some(),
                "AUTOMATION_SCHEDULE_PREVIEW_REQUIRED"
            );
            let previous = data.subscriptions.get(&draft.id);
            ensure!(
                previous.map_or(0, |s| s.revision) == expected_revision,
                "AUTOMATION_REVISION_CONFLICT"
            );
            ensure!(
                previous.is_some() || data.subscriptions.len() < MAX_ITEMS,
                "AUTOMATION_CAPACITY"
            );
            validate_period_change(data, &draft)?;
            let source_start = source_start::verified_start(
                &self.owner,
                draft.event_source.as_deref(),
                consent.native_source_start.as_deref(),
            )?;
            let next_version = version_key(
                &draft.id,
                expected_revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_REVISION_EXHAUSTED"))?,
            )?;
            if source_start.is_some() {
                ensure!(
                    !data.subscription_versions.contains_key(&next_version),
                    "AUTOMATION_SUBSCRIPTION_ID_RETIRED"
                );
            }

            let result = AutomationSubscription {
                owner: self.owner.clone(),
                revision: expected_revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_REVISION_EXHAUSTED"))?,
                enabled: true,
                draft,
                consent_ref: consent.reference.clone(),
                next_fire_at_ms,
                created_at_ms: previous.map_or(now_ms, |s| s.created_at_ms),
                updated_at_ms: now_ms,
            };
            data.subscription_versions.insert(
                version_key(&result.draft.id, result.revision)?,
                result.clone(),
            );
            if let Some(start) = source_start {
                data.native_source_starts.insert(next_version, start);
            }
            data.subscriptions
                .insert(result.draft.id.clone(), result.clone());
            Self::receipt(data, operation, intent, &result)?;
            Ok(result)
        })
    }
    /// Read-only preflight; save repeats this check under the original write lock.
    pub fn validate_period_configuration(&self, draft: &AutomationSubscriptionDraft) -> Result<()> {
        validate_draft(draft)?;
        self.access(false, |data| validate_period_change(data, draft))
    }
    pub fn read_subscription(&self, id: &str) -> Result<AutomationSubscription> {
        validate_id(id)?;
        self.access(false, |data| {
            Ok(data
                .subscriptions
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NOT_FOUND"))?
                .clone())
        })
    }
    pub fn read_subscription_version(
        &self,
        id: &str,
        revision: u64,
    ) -> Result<AutomationSubscription> {
        let key = version_key(id, revision)?;
        self.access(false, |data| {
            Ok(data
                .subscription_versions
                .get(&key)
                .or_else(|| {
                    data.subscriptions
                        .get(id)
                        .filter(|s| s.revision == revision)
                })
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_SUBSCRIPTION_REVISION_UNAVAILABLE"))?
                .clone())
        })
    }
    pub fn remove_subscription(&self, operation: &str, id: &str, revision: u64) -> Result<()> {
        let intent = json!({"action":"remove_subscription","id":id,"revision":revision});
        self.access(true, |data| {
            if Self::replay::<()>(data, operation, &intent)?.is_some() {
                return Ok(());
            }
            let sub = data
                .subscriptions
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NOT_FOUND"))?;
            ensure!(sub.revision == revision, "AUTOMATION_REVISION_CONFLICT");
            data.subscriptions.remove(id);
            Self::receipt(data, operation, intent, &())
        })
    }
    pub fn list_subscriptions(
        &self,
        after: Option<&str>,
    ) -> Result<KnowledgePage<AutomationSubscription>> {
        if let Some(c) = after {
            validate_id(c)?;
        }
        self.access(false, |data| {
            let mut items: Vec<_> = data
                .subscriptions
                .values()
                .filter(|s| after.is_none_or(|a| s.draft.id.as_str() > a))
                .take(11)
                .cloned()
                .collect();
            let more = items.len() > 10;
            items.truncate(10);
            let next_cursor = if more {
                items.last().map(|s| s.draft.id.clone())
            } else {
                None
            };
            Ok(KnowledgePage { items, next_cursor })
        })
    }
    pub fn set_subscription_enabled(
        &self,
        operation: &str,
        id: &str,
        revision: u64,
        enabled: bool,
        next_fire_at_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<AutomationSubscription> {
        self.set_subscription_enabled_with_source_start(
            operation,
            id,
            revision,
            enabled,
            next_fire_at_ms,
            now_ms,
            None,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn set_subscription_enabled_with_source_start(
        &self,
        operation: &str,
        id: &str,
        revision: u64,
        enabled: bool,
        next_fire_at_ms: Option<u64>,
        now_ms: u64,
        source_witness: Option<std::sync::Arc<dyn VerifiedAutomationSourceStart>>,
    ) -> Result<AutomationSubscription> {
        let intent = json!({"action":"set_enabled","id":id,"revision":revision,"enabled":enabled});
        self.access(true, |data| {
            if let Some(old) = Self::replay(data, operation, &intent)? {
                return Ok(old);
            }
            let sub = data
                .subscriptions
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NOT_FOUND"))?;
            ensure!(sub.revision == revision, "AUTOMATION_REVISION_CONFLICT");
            if enabled {
                ensure!(
                    sub.draft.schedule.is_some() == next_fire_at_ms.is_some()
                        && next_fire_at_ms.is_none_or(|t| t > now_ms),
                    "AUTOMATION_SCHEDULE_PREVIEW_REQUIRED"
                );
            }
            let source_start = if enabled {
                source_start::verified_start(
                    &self.owner,
                    sub.draft.event_source.as_deref(),
                    source_witness.as_deref(),
                )?
            } else {
                None
            };
            sub.enabled = enabled;
            sub.next_fire_at_ms = if enabled { next_fire_at_ms } else { None };
            sub.revision = sub
                .revision
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_REVISION_EXHAUSTED"))?;
            sub.updated_at_ms = now_ms;
            let result = sub.clone();
            data.subscription_versions
                .insert(version_key(id, result.revision)?, result.clone());
            if let Some(start) = source_start {
                data.native_source_starts
                    .insert(version_key(id, result.revision)?, start);
            }
            Self::receipt(data, operation, intent, &result)?;
            Ok(result)
        })
    }
    /// Prepare one deduplicated business trigger; executing it belongs to the native host.
    pub fn prepare_run(
        &self,
        subscription_id: &str,
        revision: u64,
        trigger_id: &str,
        trigger_facts: Value,
        next_fire_at_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<AutomationRun> {
        validate_id(trigger_id)?;
        ensure!(
            serde_json::to_vec(&trigger_facts)?.len() <= 64 * 1024,
            "AUTOMATION_EVENT_TOO_LARGE"
        );
        let key = digest(&serde_json::to_string(&(
            subscription_id,
            revision,
            trigger_id,
        ))?);
        let intent = json!({"subscriptionId":subscription_id,"revision":revision,"triggerId":trigger_id,"facts":trigger_facts});
        self.access(true, |data| {
            if let Some(old) = data.triggers.get(&key) {
                ensure!(old.intent == intent, "AUTOMATION_TRIGGER_CONFLICT");
                return Ok(data
                    .runs
                    .get(&old.run_id)
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_MISSING"))?
                    .clone());
            }
            ensure!(
                data.triggers.len() < MAX_ITEMS,
                "AUTOMATION_TRIGGER_CAPACITY"
            );
            let active: Vec<_> = data
                .runs
                .values()
                .filter(|r| {
                    !matches!(
                        r.status,
                        AutomationRunStatus::Completed
                            | AutomationRunStatus::Failed
                            | AutomationRunStatus::Cancelled
                    )
                })
                .collect();
            ensure!(active.len() < 4, "AUTOMATION_RUN_CAPACITY");
            ensure!(
                !active.iter().any(|r| r.subscription_id == subscription_id),
                "AUTOMATION_SUBSCRIPTION_BUSY"
            );
            let sub = data
                .subscriptions
                .get_mut(subscription_id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NOT_FOUND"))?;
            ensure!(sub.enabled, "AUTOMATION_DISABLED");
            ensure!(sub.revision == revision, "AUTOMATION_REVISION_CONFLICT");
            if sub.draft.schedule.is_some() {
                let scheduled = sub
                    .next_fire_at_ms
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NEXT_FIRE_MISSING"))?;
                ensure!(scheduled <= now_ms, "AUTOMATION_NOT_DUE");
                ensure!(
                    now_ms.saturating_sub(scheduled) <= 7 * 24 * 60 * 60 * 1000,
                    "AUTOMATION_TRIGGER_STALE"
                );
                ensure!(
                    next_fire_at_ms.is_none_or(|t| t > now_ms),
                    "AUTOMATION_NEXT_FIRE_NOT_FUTURE"
                );
                sub.next_fire_at_ms = next_fire_at_ms;
            } else {
                ensure!(
                    next_fire_at_ms.is_none(),
                    "AUTOMATION_EVENT_SCHEDULE_MISMATCH"
                );
            }
            let id = format!("run-{key}");
            let run = AutomationRun {
                id: id.clone(),
                title: sub.draft.title.clone(),
                owner: self.owner.clone(),
                subscription_id: subscription_id.into(),
                subscription_revision: revision,
                trigger_id: trigger_id.into(),
                native_operation_id: format!("automation-{key}"),
                native_thread_id: None,
                native_turn_id: None,
                native_task_id: None,
                status: AutomationRunStatus::Preparing,
                delivery_status: AutomationDeliveryStatus::NotReady,
                artifact_refs: Vec::new(),
                output: None,
                delivery_id: None,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
                error_code: None,
            };
            data.runs.insert(id.clone(), run.clone());
            data.triggers
                .insert(key, TriggerReceipt { intent, run_id: id });
            Ok(run)
        })
    }
    pub fn read_run(&self, id: &str) -> Result<AutomationRun> {
        validate_id(id)?;
        self.access(false, |data| {
            let run = data
                .runs
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_NOT_FOUND"))?;
            project_original_native_task(data, run)
        })
    }
    pub fn list_runs(&self, after: Option<&str>) -> Result<KnowledgePage<AutomationRun>> {
        self.access(false, |data| {
            let mut items: Vec<_> = data
                .runs
                .values()
                .filter(|r| {
                    !data.hidden_runs.contains(&r.id) && after.is_none_or(|a| r.id.as_str() > a)
                })
                .take(11)
                .map(|run| project_original_native_task(data, run))
                .collect::<Result<Vec<_>>>()?;
            let more = items.len() > 10;
            items.truncate(10);
            let next_cursor = if more {
                items.last().map(|r| r.id.clone())
            } else {
                None
            };
            Ok(KnowledgePage { items, next_cursor })
        })
    }
    pub fn hide_run(&self, operation: &str, id: &str) -> Result<()> {
        let intent = json!({"action":"hide_run","id":id});
        self.access(true, |data| {
            if Self::replay::<()>(data, operation, &intent)?.is_some() {
                return Ok(());
            }
            ensure!(data.runs.contains_key(id), "AUTOMATION_RUN_NOT_FOUND");
            data.hidden_runs.insert(id.into());
            Self::receipt(data, operation, intent, &())
        })
    }
    pub fn validate_event_sequence(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        sequence: u64,
        event_id: &str,
    ) -> Result<()> {
        validate_id(source)?;
        validate_id(event_id)?;
        self.access(false, |data| {
            let key = serde_json::to_string(&(subscription_id, revision, source))?;
            if let Some(cursor) = data.event_cursors.get(&key) {
                ensure!(
                    (sequence == cursor.sequence && event_id == cursor.event_id)
                        || sequence == cursor.sequence.saturating_add(1),
                    "AUTOMATION_EVENT_CURSOR_GAP"
                );
            } else {
                ensure!(sequence == 1, "AUTOMATION_EVENT_CURSOR_GAP");
            }
            Ok(())
        })
    }
    /// Acknowledge ingress only after its deduplicated run exists durably.
    #[allow(clippy::too_many_arguments)]
    pub fn checkpoint_event(
        &self,
        subscription_id: &str,
        revision: u64,
        source: &str,
        sequence: u64,
        event_id: &str,
        run_id: &str,
    ) -> Result<()> {
        self.access(true, |data| {
            let run = data
                .runs
                .get(run_id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_NOT_FOUND"))?;
            ensure!(
                run.subscription_id == subscription_id
                    && run.subscription_revision == revision
                    && run.trigger_id == event_id,
                "AUTOMATION_TRIGGER_CONFLICT"
            );
            let sub = data
                .subscription_versions
                .get(&version_key(subscription_id, revision)?)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_SUBSCRIPTION_REVISION_UNAVAILABLE"))?;
            ensure!(
                sub.draft.event_source.as_deref() == Some(source),
                "AUTOMATION_EVENT_SOURCE_MISMATCH"
            );
            let key = serde_json::to_string(&(subscription_id, revision, source))?;
            if let Some(cursor) = data.event_cursors.get(&key) {
                if sequence == cursor.sequence {
                    ensure!(
                        event_id == cursor.event_id && run_id == cursor.run_id,
                        "AUTOMATION_TRIGGER_CONFLICT"
                    );
                    return Ok(());
                }
                ensure!(
                    sequence == cursor.sequence.saturating_add(1),
                    "AUTOMATION_EVENT_CURSOR_GAP"
                );
            } else {
                ensure!(sequence == 1, "AUTOMATION_EVENT_CURSOR_GAP");
            }
            data.event_cursors.insert(
                key,
                EventCursor {
                    sequence,
                    event_id: event_id.into(),
                    run_id: run_id.into(),
                },
            );
            Ok(())
        })
    }
    /// Delivery polling includes hidden history and never changes execution or send receipts.
    pub fn pending_delivery_runs(
        &self,
        after: Option<&str>,
    ) -> Result<KnowledgePage<AutomationRun>> {
        self.access(false, |data| {
            let mut items = Vec::new();
            for run in data.runs.values().filter(|run| {
                after.is_none_or(|after| run.id.as_str() > after)
                    && run.status == AutomationRunStatus::Completed
                    && matches!(
                        run.delivery_status,
                        AutomationDeliveryStatus::StudioAvailable
                            | AutomationDeliveryStatus::Pending
                            | AutomationDeliveryStatus::Unknown
                    )
            }) {
                let subscription = data
                    .subscription_versions
                    .get(&version_key(
                        &run.subscription_id,
                        run.subscription_revision,
                    )?)
                    .or_else(|| {
                        data.subscriptions
                            .get(&run.subscription_id)
                            .filter(|subscription| {
                                subscription.revision == run.subscription_revision
                            })
                    })
                    .ok_or_else(|| {
                        anyhow::anyhow!("AUTOMATION_SUBSCRIPTION_REVISION_UNAVAILABLE")
                    })?;
                if matches!(
                    subscription.draft.delivery,
                    AutomationDestination::Channel { .. }
                ) {
                    items.push(run.clone());
                    if items.len() == 11 {
                        break;
                    }
                }
            }
            let more = items.len() > 10;
            items.truncate(10);
            let next_cursor = more.then(|| items.last().unwrap().id.clone());
            Ok(KnowledgePage { items, next_cursor })
        })
    }
    pub fn unsettled_runs(&self) -> Result<Vec<AutomationRun>> {
        self.access(false, |data| {
            Ok(data
                .runs
                .values()
                .filter(|r| {
                    !matches!(
                        r.status,
                        AutomationRunStatus::Completed
                            | AutomationRunStatus::Failed
                            | AutomationRunStatus::Cancelled
                    )
                })
                .take(32)
                .cloned()
                .collect())
        })
    }
    pub fn read_run_trigger_facts(&self, run_id: &str) -> Result<Value> {
        self.access(false, |data| {
            let receipt = data
                .triggers
                .values()
                .find(|r| r.run_id == run_id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_TRIGGER_MISSING"))?;
            receipt
                .intent
                .get("facts")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_TRIGGER_MISSING"))
        })
    }
    /// Claims the first submission durably. A replay must reconcile the original operation.
    pub fn claim_native_submission(&self, id: &str) -> Result<bool> {
        self.access(true, |data| {
            ensure!(data.runs.contains_key(id), "AUTOMATION_RUN_NOT_FOUND");
            Ok(data.submissions.insert(id.into()))
        })
    }
    /// Scheduler reads are bounded and do not initialize, repair, or execute anything.
    pub fn due_subscriptions(&self, now_ms: u64) -> Result<Vec<AutomationSubscription>> {
        self.access(false, |data| {
            Ok(data
                .subscriptions
                .values()
                .filter(|s| {
                    s.enabled
                        && !s.consent_ref.is_empty()
                        && s.next_fire_at_ms.is_some_and(|t| t <= now_ms)
                })
                .take(32)
                .cloned()
                .collect())
        })
    }
    pub fn record_submission_rejection(&self, id: &str, now_ms: u64) -> Result<AutomationRun> {
        self.update_run(id, now_ms, |run| {
            ensure!(
                run.native_thread_id.is_none()
                    && matches!(
                        run.status,
                        AutomationRunStatus::Preparing | AutomationRunStatus::Unknown
                    ),
                "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
            );
            run.status = AutomationRunStatus::Failed;
            run.error_code = Some("AUTOMATION_RUNTIME_REJECTED".into());
            Ok(())
        })
    }
    pub fn record_native_acceptance(
        &self,
        id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        now_ms: u64,
    ) -> Result<AutomationRun> {
        self.record_native_acceptance_receipt(
            id,
            &kcoder_types::integrations::core::IntegrationRuntimeAcceptance {
                thread_id: thread_id.into(),
                turn_id: turn_id.map(str::to_owned),
                task_id: None,
                state: kcoder_types::integrations::core::IntegrationTaskState::Queued,
            },
            now_ms,
        )
    }
    /// The full native acceptance is one immutable evidence tuple, not a latest-thread locator.
    pub fn record_native_acceptance_receipt(
        &self,
        id: &str,
        acceptance: &kcoder_types::integrations::core::IntegrationRuntimeAcceptance,
        now_ms: u64,
    ) -> Result<AutomationRun> {
        use kcoder_types::integrations::core::IntegrationTaskState;
        validate_id(&acceptance.thread_id)?;
        ensure!(
            acceptance.turn_id.is_some() || acceptance.task_id.is_some(),
            "AUTOMATION_NATIVE_EXACT_REFERENCE_REQUIRED"
        );
        for reference in acceptance.turn_id.iter().chain(acceptance.task_id.iter()) {
            validate_id(reference)?;
        }
        ensure!(
            matches!(
                acceptance.state,
                IntegrationTaskState::Queued | IntegrationTaskState::Running
            ),
            "AUTOMATION_NATIVE_RECEIPT_INVALID"
        );
        self.access(true, |data| {
            if let Some(old) = data.native_acceptances.get(id) {
                ensure!(old == acceptance, "AUTOMATION_NATIVE_RECEIPT_CONFLICT");
            }
            let run = data
                .runs
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_NOT_FOUND"))?;
            if let Some(old) = &run.native_thread_id {
                ensure!(
                    *old == acceptance.thread_id
                        && (run.native_turn_id.is_none()
                            || run.native_turn_id == acceptance.turn_id),
                    "AUTOMATION_NATIVE_RECEIPT_CONFLICT"
                );
            } else {
                ensure!(
                    matches!(
                        run.status,
                        AutomationRunStatus::Preparing | AutomationRunStatus::Unknown
                    ),
                    "AUTOMATION_RUN_NOT_PREPARING"
                );
                run.native_thread_id = Some(acceptance.thread_id.clone());
                run.native_turn_id = acceptance.turn_id.clone();
                run.status = AutomationRunStatus::Accepted;
                run.error_code = None;
                run.updated_at_ms = now_ms;
            }
            run.native_turn_id = acceptance.turn_id.clone();
            data.native_acceptances
                .insert(id.into(), acceptance.clone());
            Ok(run.clone())
        })
    }
    pub fn read_native_acceptance(
        &self,
        id: &str,
    ) -> Result<Option<kcoder_types::integrations::core::IntegrationRuntimeAcceptance>> {
        self.access(false, |data| {
            ensure!(data.runs.contains_key(id), "AUTOMATION_RUN_NOT_FOUND");
            Ok(data.native_acceptances.get(id).cloned())
        })
    }
    /// Preserve immutable native Artifact revisions separately from the legacy ID projection.
    pub fn record_artifact_manifests(
        &self,
        id: &str,
        manifests: Vec<kcoder_types::integrations::core::IntegrationEntityRef>,
    ) -> Result<()> {
        use kcoder_types::integrations::core::IntegrationEntityKind;
        ensure!(manifests.len() <= 128, "AUTOMATION_OUTPUT_TOO_LARGE");
        for reference in &manifests {
            ensure!(
                reference.kind == IntegrationEntityKind::Artifact,
                "AUTOMATION_NATIVE_RECEIPT_INVALID"
            );
            validate_id(&reference.id)?;
            validate_id(
                reference
                    .revision
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_ARTIFACT_REVISION_REQUIRED"))?,
            )?;
        }
        self.access(true, |data| {
            let run = data
                .runs
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_NOT_FOUND"))?;
            ensure!(
                run.native_thread_id.is_some(),
                "AUTOMATION_NATIVE_ACCEPTANCE_REQUIRED"
            );
            if matches!(
                run.status,
                AutomationRunStatus::Completed
                    | AutomationRunStatus::Failed
                    | AutomationRunStatus::Cancelled
            ) {
                ensure!(
                    data.artifact_manifests
                        .get(id)
                        .is_none_or(|old| old == &manifests),
                    "AUTOMATION_TERMINAL_CONFLICT"
                );
            }
            data.artifact_manifests.insert(id.into(), manifests);
            Ok(())
        })
    }
    pub fn read_artifact_manifests(
        &self,
        id: &str,
    ) -> Result<Vec<kcoder_types::integrations::core::IntegrationEntityRef>> {
        self.access(false, |data| {
            let run = data
                .runs
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_NOT_FOUND"))?;
            let references = data.artifact_manifests.get(id).cloned().unwrap_or_default();
            ensure!(
                references
                    .iter()
                    .map(|a| &a.id)
                    .eq(run.artifact_refs.iter()),
                "AUTOMATION_ARTIFACT_REVISION_REQUIRED"
            );
            Ok(references)
        })
    }
    pub fn record_native_status(
        &self,
        id: &str,
        status: AutomationRunStatus,
        output: Option<String>,
        artifacts: Vec<String>,
        now_ms: u64,
    ) -> Result<AutomationRun> {
        ensure!(artifacts.len() <= 128, "AUTOMATION_OUTPUT_TOO_LARGE");
        let output = output.map(|value| bounded_output_preview(&value));
        for a in &artifacts {
            validate_id(a)?;
        }
        self.update_run(id, now_ms, |run| {
            ensure!(
                run.native_thread_id.is_some(),
                "AUTOMATION_NATIVE_ACCEPTANCE_REQUIRED"
            );
            let terminal = matches!(
                run.status,
                AutomationRunStatus::Completed
                    | AutomationRunStatus::Failed
                    | AutomationRunStatus::Cancelled
            );
            if terminal {
                ensure!(
                    run.status == status && run.output == output && run.artifact_refs == artifacts,
                    "AUTOMATION_TERMINAL_CONFLICT"
                );
                return Ok(());
            }
            if status == AutomationRunStatus::Completed
                && output.as_ref().is_none_or(|s| s.trim().is_empty())
                && artifacts.is_empty()
            {
                run.status = AutomationRunStatus::Unknown;
                run.error_code = Some("AUTOMATION_OUTPUT_UNOBSERVED".into());
                return Ok(());
            }
            run.status = status;
            run.output = output;
            run.artifact_refs = artifacts;
            if status == AutomationRunStatus::Completed
                || status == AutomationRunStatus::Cancelled
                || run.error_code.as_deref() != Some("AUTOMATION_BUDGET_EXHAUSTED")
            {
                run.error_code = None;
            }
            if status == AutomationRunStatus::Completed {
                run.delivery_status = AutomationDeliveryStatus::StudioAvailable;
            }
            Ok(())
        })
    }
    pub fn record_unknown(&self, id: &str, code: &str, now_ms: u64) -> Result<AutomationRun> {
        ensure!(
            !code.is_empty() && code.len() <= 128,
            "AUTOMATION_INVALID_ERROR_CODE"
        );
        self.update_run(id, now_ms, |run| {
            if !matches!(
                run.status,
                AutomationRunStatus::Completed
                    | AutomationRunStatus::Failed
                    | AutomationRunStatus::Cancelled
            ) {
                run.status = AutomationRunStatus::Unknown;
                run.error_code = Some(code.into());
            }
            Ok(())
        })
    }
    /// Record the native observer's actual rejected reservation, not a task
    /// terminal state or an authorization grant. The original task still owns
    /// completion/cancellation and its reservations are never released here.
    pub fn record_observed_budget_exhaustion(
        &self,
        id: &str,
        now_ms: u64,
    ) -> Result<AutomationRun> {
        self.update_run(id, now_ms, |run| {
            ensure!(
                run.native_thread_id.is_some(),
                "AUTOMATION_NATIVE_ACCEPTANCE_REQUIRED"
            );
            ensure!(
                !matches!(
                    run.status,
                    AutomationRunStatus::Completed | AutomationRunStatus::Cancelled
                ),
                "AUTOMATION_TERMINAL_CONFLICT"
            );
            run.error_code = Some("AUTOMATION_BUDGET_EXHAUSTED".into());
            Ok(())
        })
    }
    pub fn record_delivery(
        &self,
        id: &str,
        delivery_id: &str,
        status: AutomationDeliveryStatus,
        now_ms: u64,
    ) -> Result<AutomationRun> {
        validate_id(delivery_id)?;
        ensure!(
            !matches!(
                status,
                AutomationDeliveryStatus::NotReady | AutomationDeliveryStatus::StudioAvailable
            ),
            "AUTOMATION_INVALID_DELIVERY_OBSERVATION"
        );
        self.update_run(id, now_ms, |run| {
            ensure!(
                run.status == AutomationRunStatus::Completed,
                "AUTOMATION_RESULT_NOT_READY"
            );
            if let Some(old) = &run.delivery_id {
                ensure!(old == delivery_id, "AUTOMATION_DELIVERY_CONFLICT");
            }
            if matches!(
                run.delivery_status,
                AutomationDeliveryStatus::Accepted
                    | AutomationDeliveryStatus::Cancelled
                    | AutomationDeliveryStatus::Failed
            ) {
                ensure!(
                    status == run.delivery_status,
                    "AUTOMATION_DELIVERY_TERMINAL_CONFLICT"
                );
            }
            run.delivery_id = Some(delivery_id.into());
            run.delivery_status = status;
            Ok(())
        })
    }
    fn update_run(
        &self,
        id: &str,
        now_ms: u64,
        update: impl FnOnce(&mut AutomationRun) -> Result<()>,
    ) -> Result<AutomationRun> {
        self.access(true, |data| {
            let run = data
                .runs
                .get_mut(id)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUN_NOT_FOUND"))?;
            update(run)?;
            run.updated_at_ms = now_ms;
            Ok(run.clone())
        })
    }
}
/// UTF-8 prefix with an exact JSON string budget; full output stays in the native task.
fn bounded_output_preview(value: &str) -> String {
    let mut bytes = 2usize;
    let mut output = String::new();
    for character in value.chars() {
        let encoded = match character {
            '"' | '\\' => 2,
            '\n' | '\r' | '\t' | '\u{0008}' | '\u{000c}' => 2,
            c if c < '\u{0020}' => 6,
            c => c.len_utf8(),
        };
        if bytes.saturating_add(encoded) > 64 * 1024 {
            break;
        }
        output.push(character);
        bytes += encoded;
    }
    output
}
fn read_private_json<T: for<'de> Deserialize<'de>>(
    directory: &PrivateDirectory,
    name: &str,
    max: usize,
) -> Result<T> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= max as u64,
        "PRIVATE_DOMAIN_RECORD_TOO_LARGE"
    );
    let mut bytes = Vec::new();
    file.take(max as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "PRIVATE_DOMAIN_RECORD_TOO_LARGE");
    Ok(serde_json::from_slice(&bytes)?)
}

fn validate_id(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty() && value.chars().count() <= 256,
        "AUTOMATION_INVALID_ID"
    );
    Ok(())
}
fn version_key(id: &str, revision: u64) -> Result<String> {
    validate_id(id)?;
    Ok(serde_json::to_string(&(id, revision))?)
}
fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn validate_period_change(data: &Data, draft: &AutomationSubscriptionDraft) -> Result<()> {
    if let Some(period) = data
        .subscription_versions
        .values()
        .filter(|version| version.draft.id == draft.id)
        .find_map(|version| version.draft.period_budget.as_ref())
    {
        ensure!(
            data.subscriptions.contains_key(&draft.id),
            "AUTOMATION_PERIOD_SUBSCRIPTION_ID_REUSED"
        );
        ensure!(
            draft
                .period_budget
                .as_ref()
                .is_some_and(|next| next.window_seconds == period.window_seconds),
            "AUTOMATION_PERIOD_WINDOW_IMMUTABLE"
        );
    }
    Ok(())
}
fn validate_draft(draft: &AutomationSubscriptionDraft) -> Result<()> {
    if let Some(period) = &draft.period_budget {
        period.validate().map_err(anyhow::Error::msg)?;
    }
    ensure!(
        serde_json::to_vec(draft)?.len() <= 96 * 1024,
        "AUTOMATION_DRAFT_TOO_LARGE"
    );
    validate_id(&draft.id)?;
    validate_id(&draft.workflow_id)?;
    match draft.effective_model_selection() {
        IntegrationModelSelectionIntent::InheritCurrent => {}
        IntegrationModelSelectionIntent::AutoPolicy { id, version } => {
            validate_id(&id)?;
            validate_id(&version)?;
        }
        IntegrationModelSelectionIntent::Explicit { provider, model } => {
            validate_id(&provider)?;
            validate_id(&model)?;
            ensure!(
                !provider.contains("::"),
                "AUTOMATION_MODEL_SELECTION_INVALID"
            );
        }
        IntegrationModelSelectionIntent::VerifierLocked {
            provider,
            model,
            configuration_revision,
        } => {
            validate_id(&provider)?;
            validate_id(&model)?;
            validate_id(&configuration_revision)?;
            ensure!(
                !provider.contains("::"),
                "AUTOMATION_MODEL_SELECTION_INVALID"
            );
        }
    }
    ensure!(
        !draft.title.trim().is_empty() && draft.title.len() <= 512,
        "AUTOMATION_INVALID_TITLE"
    );
    ensure!(
        draft.workflow_version > 0,
        "AUTOMATION_IMMUTABLE_WORKFLOW_REQUIRED"
    );
    ensure!(
        draft.schedule.is_some() != draft.event_source.is_some(),
        "AUTOMATION_ONE_TRIGGER_REQUIRED"
    );
    if let Some(source) = &draft.event_source {
        validate_id(source)?;
    }
    ensure!(
        draft.maximum_tokens > 0
            && draft.maximum_runtime_seconds > 0
            && draft.maximum_runtime_seconds <= 24 * 60 * 60,
        "AUTOMATION_BUDGET_REQUIRED"
    );
    ensure!(
        draft.inputs.is_object() && serde_json::to_vec(&draft.inputs)?.len() <= 64 * 1024,
        "AUTOMATION_INVALID_INPUTS"
    );
    if let AutomationDestination::Channel {
        destination_ref,
        destination_revision,
    } = &draft.delivery
    {
        validate_id(destination_ref)?;
        validate_id(destination_revision)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;

mod artifact_claims;
mod event_window;
pub use artifact_claims::ApprovedAutomationArtifactClaim;

mod source_start;
pub use source_start::{AutomationInboxEventDisposition, VerifiedAutomationSourceStart};
