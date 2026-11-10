//! Native source/account directory. Registrations are facts, never task authorization.
use super::super::core::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    CredentialBackend, PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, Settings,
};
use kcoder_tools::{ToolRegistry, ToolSource};
use kcoder_types::{McpServerConfig, integrations::core::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::File,
    io::Read,
    sync::Arc,
};
mod history;
pub(super) mod leased;
use leased::NativePluginSourceLease;

const LOCK: &str = "native-sources.lock";
const STATE: &str = "native-sources.json";
const MAX_SOURCES: usize = 256;
const MAX_OPERATIONS: usize = 1024;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RETAINED_VERSIONS: usize = 1024;

/// Actual configuration selector, independent of display labels or exposed tool names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeMcpSourceSelector {
    pub server: String,
    pub plugin: Option<String>,
}
impl NativeMcpSourceSelector {
    fn key(&self) -> Result<String> {
        ensure!(
            !self.server.is_empty()
                && self.server.len() <= 256
                && self
                    .plugin
                    .as_ref()
                    .is_none_or(|id| !id.is_empty() && id.len() <= 256),
            "NATIVE_SOURCE_SELECTOR_INVALID"
        );
        digest(&json!([self.server, self.plugin]))
    }
    pub(crate) fn matches_tool_source(&self, source: &ToolSource) -> bool {
        match source {
            ToolSource::Mcp { server, .. } => self.plugin.is_none() && server == &self.server,
            ToolSource::Plugin { plugin, server, .. } => {
                self.plugin.as_ref() == Some(plugin) && server == &self.server
            }
            _ => false,
        }
    }
}

/// Private facts must originate in the actual selected-target configuration reader.
/// They are intentionally not deserializable and never accepted from an RPC scope.
pub(crate) struct NativeMcpSourceFact {
    scope: IntegrationScope,
    selector: NativeMcpSourceSelector,
    security_fingerprint: String,
    enabled: bool,
    account: NativeMcpAccountFact,
    leased_plugin: Option<Arc<NativePluginSourceLease>>,
}
enum NativeMcpAccountFact {
    NoSeparateAccount,
    Referenced(IntegrationRevisionRef),
    OAuth {
        reference: IntegrationRevisionRef,
        state: IntegrationTaskCapabilitySourceState,
        reason: &'static str,
    },
    Unknown(&'static str),
}
impl NativeMcpAccountFact {
    fn currently_authorized(&self) -> bool {
        match self {
            Self::NoSeparateAccount | Self::Referenced(_) => true,
            Self::OAuth { state, .. } => *state == IntegrationTaskCapabilitySourceState::Ready,
            Self::Unknown(_) => false,
        }
    }
}

impl NativeMcpSourceFact {
    /// Public availability only. This never grants resource reads or tool execution.
    pub(super) fn application_summary(&self) -> Value {
        let authorization = match &self.account {
            NativeMcpAccountFact::NoSeparateAccount => "notApplicable",
            NativeMcpAccountFact::Referenced(_) => "authorized",
            NativeMcpAccountFact::OAuth { state, .. }
                if *state == IntegrationTaskCapabilitySourceState::Ready =>
            {
                "authorized"
            }
            NativeMcpAccountFact::OAuth { .. } => "notAuthorized",
            NativeMcpAccountFact::Unknown(_) => "unavailable",
        };
        json!({"name":self.selector.server,"pluginId":self.selector.plugin,
            "enabled":self.enabled,"authorization":authorization})
    }
    pub(crate) fn matches_selector(&self, selector: &NativeMcpSourceSelector) -> bool {
        self.selector == *selector
    }
    /// Bind the original connection's immutable source, never a current-name
    /// lookup. Unknown/missing native connection birth evidence refuses.
    pub(crate) fn from_registered_tool(
        context: &NativeIntegrationContext,
        tool: &Arc<dyn kcoder_tools::Tool>,
    ) -> Result<Self> {
        let actual: &dyn std::any::Any = tool.as_ref();
        let actual = actual
            .downcast_ref::<kcoder_mcp::McpTool>()
            .context("NATIVE_MCP_ACTUAL_TOOL_REQUIRED")?;
        let origin = actual
            .native_origin()
            .context("NATIVE_MCP_CONNECTION_ORIGIN_REQUIRED")?;
        ensure!(
            origin.matches_profile(context.profile()?)?,
            "NATIVE_MCP_PROFILE_MISMATCH"
        );
        let config = origin.private_config();
        let selector = match tool.source() {
            ToolSource::Mcp { server, .. } => NativeMcpSourceSelector {
                server,
                plugin: None,
            },
            ToolSource::Plugin { server, plugin, .. } => NativeMcpSourceSelector {
                server,
                plugin: Some(plugin),
            },
            _ => anyhow::bail!("NATIVE_MCP_ACTUAL_TOOL_REQUIRED"),
        };
        ensure!(
            selector.server == config.name,
            "NATIVE_MCP_CONNECTION_SOURCE_MISMATCH"
        );
        selector.key()?;
        let security_fingerprint = digest(
            &json!({"selector":selector,"config":config,"enabled":true,"credentialStore":origin.credential_mode()}),
        )?;
        let account = if let Some(reference) = &config.policy.credential_ref {
            let revision = origin
                .credential_revision()
                .context("NATIVE_MCP_ORIGINAL_CREDENTIAL_REQUIRED")?;
            NativeMcpAccountFact::Referenced(IntegrationRevisionRef {
                id: reference.id.clone(),
                revision: digest(&json!(["native-mcp-credential", reference.id, revision]))?,
            })
        } else if !config.env.is_empty()
            || !config.headers.is_empty()
            || !config.policy.required_env.is_empty()
            || !config.policy.env_vars.is_empty()
            || !config.policy.env_aliases.is_empty()
            || !config.policy.required_headers.is_empty()
            || !config.policy.env_http_headers.is_empty()
            || config.policy.bearer_token_env_var.is_some()
        {
            NativeMcpAccountFact::Unknown("NATIVE_ACCOUNT_REFERENCE_UNAVAILABLE")
        } else if config.transport == "http" {
            match origin.oauth_metadata().cloned() {
                Some(metadata) => account_from_oauth_metadata(metadata)?,
                None => NativeMcpAccountFact::Unknown("NATIVE_OAUTH_ORIGINAL_BINDING_REQUIRED"),
            }
        } else {
            NativeMcpAccountFact::NoSeparateAccount
        };
        origin.verify_owner()?;
        context.verify()?;
        Ok(Self {
            scope: context.scope().clone(),
            selector,
            security_fingerprint,
            enabled: true,
            account,
            leased_plugin: None,
        })
    }

    /// The caller supplies already resolved, native-owned source configuration.
    /// No program is launched and no environment or Provider secret is consulted.
    pub(crate) fn from_resolved(
        context: &NativeIntegrationContext,
        settings: &Settings,
        config: &McpServerConfig,
        plugin_id: Option<&str>,
        backend: &dyn CredentialBackend,
    ) -> Result<Self> {
        context.verify()?;
        let selector = NativeMcpSourceSelector {
            server: config.name.clone(),
            plugin: plugin_id.map(str::to_owned),
        };
        selector.key()?;
        let enabled = settings.mcp_server_enabled(&config.name);
        let security_fingerprint = digest(&json!({
            "selector":selector,"config":config,"enabled":enabled,"credentialStore":settings.credential_store,
        }))?;
        let account = if let Some(reference) = &config.policy.credential_ref {
            let revision = kcoder_config::imported_credentials::ImportedCredentialStore::open(
                context.profile_path()?,
            )?
            .observe_mcp_connection_revision(
                config,
                settings.credential_store,
                backend,
            );
            match revision {
                // This opaque revision describes the verified native receipt/file identity;
                // it is not a digest of a secret value.
                Ok(revision) => NativeMcpAccountFact::Referenced(IntegrationRevisionRef {
                    id: reference.id.clone(),
                    revision: digest(&json!(["native-mcp-credential", reference.id, revision]))?,
                }),
                Err(_) => NativeMcpAccountFact::Unknown("NATIVE_CREDENTIAL_REFERENCE_UNAVAILABLE"),
            }
        } else if !config.env.is_empty()
            || !config.headers.is_empty()
            || !config.policy.required_env.is_empty()
            || !config.policy.env_vars.is_empty()
            || !config.policy.env_aliases.is_empty()
            || !config.policy.required_headers.is_empty()
            || !config.policy.env_http_headers.is_empty()
            || config.policy.bearer_token_env_var.is_some()
        {
            // ConfiguredHeader and resolved plugin environment values do not identify
            // a versioned private account. The proper native account adapter is required.
            NativeMcpAccountFact::Unknown("NATIVE_ACCOUNT_REFERENCE_UNAVAILABLE")
        } else if config.transport == "http" {
            observe_existing_oauth(context, config)?
        } else {
            NativeMcpAccountFact::NoSeparateAccount
        };
        context.verify()?;
        Ok(Self {
            scope: context.scope().clone(),
            selector,
            security_fingerprint,
            enabled,
            account,
            leased_plugin: None,
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRecord {
    source_ref: IntegrationRevisionRef,
    selector: NativeMcpSourceSelector,
    security_fingerprint: String,
    account_ref: IntegrationNullable<IntegrationRevisionRef>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u32,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
    sources: BTreeMap<String, SourceRecord>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    retained_versions: BTreeMap<String, SourceRecord>,
    operations: BTreeMap<String, String>,
}

pub(crate) struct NativeConnectivitySourceCatalog {
    guard: NativeDomainGuard,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
    lock_anchor: File,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeConnectivityInventory {
    pub tools: Vec<NativeConnectivityToolFact>,
    pub request_revision: String,
    pub task_sources: Vec<IntegrationTaskCapabilitySourceDescriptor>,
    pub catalog_state: &'static str,
    pub unresolved_sources: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeConnectivityToolFact {
    name: String,
    schema_revision: String,
    source_revision: String,
    registered: bool,
    allowed: bool,
    // Semantic capabilities require a certified native adapter/schema binding.
    // Tool name prefixes alone cannot create that assertion.
    capabilities: Vec<String>,
}

impl NativeConnectivitySourceCatalog {
    /// Capture the existing native source set once. Later registrations are not
    /// implicitly adopted by an already bound inherit_current task.
    pub(crate) fn current_choices(
        &self,
        context: &NativeIntegrationContext,
        facts: &[NativeMcpSourceFact],
    ) -> Result<Vec<IntegrationTaskCapabilitySourceChoice>> {
        self.current_choices_with_account_policy(context, facts, false)
    }

    pub(crate) fn current_choices_for_studio(
        &self,
        context: &NativeIntegrationContext,
        facts: &[NativeMcpSourceFact],
    ) -> Result<Vec<IntegrationTaskCapabilitySourceChoice>> {
        self.current_choices_with_account_policy(context, facts, true)
    }

    fn current_choices_with_account_policy(
        &self,
        context: &NativeIntegrationContext,
        facts: &[NativeMcpSourceFact],
        exclude_unverified: bool,
    ) -> Result<Vec<IntegrationTaskCapabilitySourceChoice>> {
        facts_intent(context, facts)?;
        let directory = self.directory(context)?;
        let _lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("NATIVE_SOURCE_CATALOG_BUSY")?;
        let document = self.document(&directory)?;
        let mut choices = Vec::new();
        for fact in facts {
            if !fact.enabled {
                continue;
            }
            let account_ref = match &fact.account {
                NativeMcpAccountFact::NoSeparateAccount => IntegrationNullable::Null,
                NativeMcpAccountFact::Referenced(reference) => {
                    IntegrationNullable::Value(reference.clone())
                }
                NativeMcpAccountFact::OAuth {
                    reference, state, ..
                } if *state == IntegrationTaskCapabilitySourceState::Ready => {
                    IntegrationNullable::Value(reference.clone())
                }
                NativeMcpAccountFact::OAuth { .. } => continue,
                NativeMcpAccountFact::Unknown(reason) if exclude_unverified => {
                    tracing::warn!(source = %fact.selector.server, reason, "Excluding source with unverified account identity from the task");
                    continue;
                }
                NativeMcpAccountFact::Unknown(_) => {
                    anyhow::bail!("NATIVE_SOURCE_ACCOUNT_UNAVAILABLE")
                }
            };
            let record = history::for_fact(&document, context, fact, &account_ref)?
                .context("NATIVE_SOURCE_REGISTRATION_REQUIRED")?;
            ensure!(
                record.security_fingerprint == fact.security_fingerprint
                    && record.account_ref == account_ref,
                "NATIVE_SOURCE_CHOICE_STALE"
            );
            choices.push(IntegrationTaskCapabilitySourceChoice {
                source_ref: record.source_ref.clone(),
                account_ref,
            });
        }
        ensure!(
            choices.len() <= MAX_TASK_CAPABILITY_SOURCES,
            "NATIVE_TASK_CAPABILITY_SOURCE_LIMIT"
        );
        choices.sort_by(|a, b| a.source_ref.id.cmp(&b.source_ref.id));
        Ok(choices)
    }
    pub(crate) fn observe(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        let Some(guard) = NativeDomainGuard::observe(
            context.profile()?,
            context.scope(),
            NativeDomain::ConnectivitySources,
        )?
        else {
            return Ok(None);
        };
        Self::from_guard(context, guard).map(Some)
    }
    /// Called only by the native configuration owner during an authorized opt-in write.
    pub(crate) fn initialize(
        context: &NativeIntegrationContext,
        operation_id: &str,
    ) -> Result<Self> {
        let (guard, ()) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::ConnectivitySources,
            operation_id,
            |directory| {
                let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
                lock.sync_all()?;
                save(
                    directory,
                    &Document {
                        version: 1,
                        owner: IntegrationOwner::from(context.scope()),
                        lock_identity: directory.portable_regular_handle_identity(&lock)?,
                        sources: BTreeMap::new(),
                        retained_versions: BTreeMap::new(),
                        operations: BTreeMap::new(),
                    },
                )
            },
        )?;
        Self::from_guard(context, guard)
    }
    fn from_guard(context: &NativeIntegrationContext, guard: NativeDomainGuard) -> Result<Self> {
        let directory = guard.directory(context.profile()?)?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let lock_identity = directory.portable_regular_handle_identity(&lock_anchor)?;
        let _lease = directory
            .try_existing_portable_lock(OsStr::new(LOCK), &lock_identity, PrivateLeaseMode::Shared)?
            .context("NATIVE_SOURCE_CATALOG_BUSY")?;
        let document = read(&directory)?;
        ensure!(
            document.owner == IntegrationOwner::from(context.scope())
                && document.lock_identity == lock_identity,
            "NATIVE_SOURCE_CATALOG_OWNER_CHANGED"
        );
        Ok(Self {
            guard,
            owner: document.owner,
            lock_identity,
            lock_anchor,
        })
    }
    fn directory(&self, context: &NativeIntegrationContext) -> Result<PrivateDirectory> {
        ensure!(
            self.owner == IntegrationOwner::from(context.scope()),
            "NATIVE_SOURCE_CATALOG_OWNER_CHANGED"
        );
        let directory = self.guard.directory(context.profile()?)?;
        ensure!(
            directory.portable_regular_handle_identity(&self.lock_anchor)? == self.lock_identity
                && directory.portable_regular_identity(OsStr::new(LOCK))? == self.lock_identity,
            "NATIVE_SOURCE_CATALOG_CONTROL_CHANGED"
        );
        Ok(directory)
    }
    fn document(&self, directory: &PrivateDirectory) -> Result<Document> {
        let document = read(directory)?;
        ensure!(
            document.owner == self.owner && document.lock_identity == self.lock_identity,
            "NATIVE_SOURCE_CATALOG_CONTROL_CHANGED"
        );
        Ok(document)
    }

    /// A native registration transaction is explicit; an ordinary inventory read
    /// never creates or refreshes source identity metadata behind a read-only RPC.
    pub(crate) fn register(
        &self,
        context: &NativeIntegrationContext,
        operation_id: &str,
        facts: &[NativeMcpSourceFact],
    ) -> Result<()> {
        ensure!(
            !operation_id.is_empty()
                && operation_id.len() <= 256
                && !operation_id.chars().any(char::is_control),
            "NATIVE_SOURCE_OPERATION_INVALID"
        );
        let intent = facts_intent(context, facts)?;
        let directory = self.directory(context)?;
        let _lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .context("NATIVE_SOURCE_CATALOG_BUSY")?;
        let mut document = self.document(&directory)?;
        if let Some(original) = document.operations.get(operation_id) {
            ensure!(original == &intent, "NATIVE_SOURCE_OPERATION_CONFLICT");
            return Ok(());
        }
        ensure!(
            document.operations.len() < MAX_OPERATIONS,
            "NATIVE_SOURCE_CATALOG_CAPACITY"
        );
        for fact in facts {
            let account_ref = match &fact.account {
                NativeMcpAccountFact::NoSeparateAccount => IntegrationNullable::Null,
                NativeMcpAccountFact::Referenced(reference)
                | NativeMcpAccountFact::OAuth { reference, .. } => {
                    IntegrationNullable::Value(reference.clone())
                }
                NativeMcpAccountFact::Unknown(_) => continue,
            };
            let key = fact.selector.key()?;
            let current = document.sources.get(&key).cloned();
            if current.as_ref().is_some_and(|record| {
                record.security_fingerprint == fact.security_fingerprint
                    && record.account_ref == account_ref
            }) {
                continue;
            }
            let retained = fact
                .leased_plugin
                .as_ref()
                .map(|proof| proof.verify(context))
                .transpose()?
                .is_some_and(|current| !current);
            if retained
                && history::for_fact(&document, context, fact, &account_ref)?.is_some_and(
                    |record| {
                        record.security_fingerprint == fact.security_fingerprint
                            && record.account_ref == account_ref
                    },
                )
            {
                continue;
            }
            let id = current
                .as_ref()
                .map(|record| record.source_ref.id.clone())
                .unwrap_or_else(|| format!("native-source-{}", uuid::Uuid::new_v4()));
            let next = SourceRecord {
                source_ref: IntegrationRevisionRef {
                    id,
                    revision: uuid::Uuid::new_v4().to_string(),
                },
                selector: fact.selector.clone(),
                security_fingerprint: fact.security_fingerprint.clone(),
                account_ref,
            };
            if retained {
                history::retain(&mut document, next)?;
            } else {
                if let Some(previous) = current
                    && previous.selector.plugin.is_some()
                {
                    history::retain(&mut document, previous)?;
                }
                document.sources.insert(key, next);
            }
        }
        ensure!(
            document.sources.len() <= MAX_SOURCES,
            "NATIVE_SOURCE_CATALOG_CAPACITY"
        );
        document.operations.insert(operation_id.into(), intent);
        save(&directory, &document)
    }

    pub(crate) fn inventory(
        &self,
        context: &NativeIntegrationContext,
        facts: &[NativeMcpSourceFact],
        allowed_registry: &ToolRegistry,
    ) -> Result<NativeConnectivityInventory> {
        facts_intent(context, facts)?;
        let directory = self.directory(context)?;
        let _lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("NATIVE_SOURCE_CATALOG_BUSY")?;
        let document = self.document(&directory)?;
        let mut task_sources = Vec::new();
        let mut tools = Vec::new();
        let mut unresolved_sources = 0;
        for fact in facts {
            let expected_account = match &fact.account {
                NativeMcpAccountFact::NoSeparateAccount => IntegrationNullable::Null,
                NativeMcpAccountFact::Referenced(reference)
                | NativeMcpAccountFact::OAuth { reference, .. } => {
                    IntegrationNullable::Value(reference.clone())
                }
                NativeMcpAccountFact::Unknown(_) => {
                    unresolved_sources += 1;
                    continue;
                }
            };
            let Some(record) = history::for_fact(&document, context, fact, &expected_account)?
            else {
                unresolved_sources += 1;
                continue;
            };
            let current = record.security_fingerprint == fact.security_fingerprint
                && record.account_ref == expected_account;
            let mut capabilities = BTreeSet::new();
            if current && fact.enabled && fact.account.currently_authorized() {
                for tool in allowed_registry.all() {
                    if !fact.selector.matches_tool_source(&tool.source())
                        || !tool.is_model_visible()
                    {
                        continue;
                    }
                    capabilities.insert(IntegrationTaskCapabilitySourceCapability::Tools);
                    tools.push(NativeConnectivityToolFact {
                        name: tool.name(),
                        schema_revision: digest(&tool.input_schema())?,
                        source_revision: record.source_ref.revision.clone(),
                        registered: true,
                        allowed: true,
                        capabilities: Vec::new(),
                    });
                }
            }
            let (state, reason) = if !fact.account.currently_authorized() {
                match &fact.account {
                    NativeMcpAccountFact::OAuth { state, reason, .. } => (*state, Some(*reason)),
                    _ => (
                        IntegrationTaskCapabilitySourceState::Unknown,
                        Some("NATIVE_SOURCE_ACCOUNT_UNAVAILABLE"),
                    ),
                }
            } else if !fact.enabled {
                (
                    IntegrationTaskCapabilitySourceState::Unavailable,
                    Some("NATIVE_SOURCE_DISABLED"),
                )
            } else if !current {
                (
                    IntegrationTaskCapabilitySourceState::Unknown,
                    Some("NATIVE_SOURCE_REGISTRATION_STALE"),
                )
            } else if capabilities.is_empty() {
                (
                    IntegrationTaskCapabilitySourceState::Unknown,
                    Some("NATIVE_SOURCE_NOT_DISCOVERED"),
                )
            } else {
                (
                    IntegrationTaskCapabilitySourceState::Ready,
                    if fact
                        .leased_plugin
                        .as_ref()
                        .map(|proof| proof.verify(context))
                        .transpose()?
                        .is_some_and(|current| !current)
                    {
                        Some("NATIVE_SOURCE_RETAINED_PLUGIN_VERSION")
                    } else {
                        None
                    },
                )
            };
            let descriptor = IntegrationTaskCapabilitySourceDescriptor {
                source_ref: record.source_ref.clone(),
                account_ref: record.account_ref.clone(),
                kind: if fact.selector.plugin.is_some() {
                    IntegrationTaskCapabilitySourceKind::PluginMcp
                } else {
                    IntegrationTaskCapabilitySourceKind::Mcp
                },
                display_name: fact.selector.server.clone(),
                account_display_name: IntegrationNullable::Null,
                state,
                reason_code: reason
                    .map(|value| IntegrationNullable::Value(value.into()))
                    .unwrap_or(IntegrationNullable::Null),
                capabilities,
            };
            descriptor.validate()?;
            task_sources.push(descriptor);
        }
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        task_sources.sort_by(|a, b| a.source_ref.id.cmp(&b.source_ref.id));
        let request_revision = digest(
            &json!({"scope":context.scope(),"tools":tools,"sources":task_sources,"unresolvedSources":unresolved_sources}),
        )?;
        context.verify()?;
        Ok(NativeConnectivityInventory {
            tools,
            request_revision,
            task_sources,
            catalog_state: if unresolved_sources > 0 {
                "unknown"
            } else {
                "observed"
            },
            unresolved_sources,
        })
    }

    /// Resolve a saved choice against actual current source/account facts. This
    /// returns provenance only; Root still installs task/resource/App/child guards.
    pub(crate) fn resolve_choice(
        &self,
        context: &NativeIntegrationContext,
        choice: &IntegrationTaskCapabilitySourceChoice,
        facts: &[NativeMcpSourceFact],
    ) -> Result<NativeMcpSourceSelector> {
        choice.validate()?;
        facts_intent(context, facts)?;
        let directory = self.directory(context)?;
        let _lease = directory
            .try_existing_portable_lock(
                OsStr::new(LOCK),
                &self.lock_identity,
                PrivateLeaseMode::Shared,
            )?
            .context("NATIVE_SOURCE_CATALOG_BUSY")?;
        let document = self.document(&directory)?;
        for fact in facts {
            let Some(record) = history::for_choice(&document, context, fact, choice)? else {
                continue;
            };
            if record.source_ref != choice.source_ref {
                continue;
            }
            let account = match &fact.account {
                NativeMcpAccountFact::NoSeparateAccount => IntegrationNullable::Null,
                NativeMcpAccountFact::Referenced(reference)
                | NativeMcpAccountFact::OAuth { reference, .. } => {
                    IntegrationNullable::Value(reference.clone())
                }
                NativeMcpAccountFact::Unknown(_) => {
                    anyhow::bail!("NATIVE_SOURCE_ACCOUNT_UNAVAILABLE")
                }
            };
            ensure!(
                fact.enabled
                    && fact.account.currently_authorized()
                    && record.security_fingerprint == fact.security_fingerprint
                    && record.account_ref == account
                    && choice.account_ref == account,
                "NATIVE_SOURCE_CHOICE_STALE"
            );
            context.verify()?;
            return Ok(fact.selector.clone());
        }
        anyhow::bail!("NATIVE_SOURCE_CHOICE_UNAVAILABLE")
    }
}

/// Reads the existing factory rather than loading a fresh default configuration.
/// Root must use the factory belonging to this exact native context/target.
pub(crate) fn native_mcp_source_facts(
    context: &NativeIntegrationContext,
    factory: &crate::app_server::engine_factory::AppServerEngineFactory,
    backend: &dyn CredentialBackend,
) -> Result<Vec<NativeMcpSourceFact>> {
    context.verify()?;
    let (settings, plugins, configured) = factory.current_mcp_configuration()?;
    ensure!(
        configured.len() <= MAX_SOURCES,
        "NATIVE_SOURCE_CATALOG_CAPACITY"
    );
    let mut facts = Vec::new();
    for source in &configured {
        let mut fact = NativeMcpSourceFact::from_resolved(
            context,
            &settings,
            &source.config,
            source.plugin_id.as_deref(),
            backend,
        )?;
        fact.certify_plugin_root_environment(context, &source.config, &plugins)?;
        facts.push(fact);
    }
    let (next_settings, next_plugins, next) = factory.current_mcp_configuration()?;
    ensure!(
        settings.mcp_disabled_servers == next_settings.mcp_disabled_servers
            && settings.credential_store == next_settings.credential_store
            && configured
                .iter()
                .map(|source| (&source.plugin_id, &source.config))
                .eq(next
                    .iter()
                    .map(|source| (&source.plugin_id, &source.config)))
            && plugins.managed_operations == next_plugins.managed_operations
            && plugins.mcp_configs == next_plugins.mcp_configs
            && plugins.mcp_config_sources == next_plugins.mcp_config_sources,
        "NATIVE_SOURCE_CONFIGURATION_CHANGED"
    );
    context.verify()?;
    Ok(facts)
}

fn facts_intent(
    context: &NativeIntegrationContext,
    facts: &[NativeMcpSourceFact],
) -> Result<String> {
    ensure!(facts.len() <= MAX_SOURCES, "NATIVE_SOURCE_CATALOG_CAPACITY");
    let mut inputs = BTreeMap::new();
    for fact in facts {
        context.validate_scope(&fact.scope)?;
        let account = match &fact.account {
            NativeMcpAccountFact::NoSeparateAccount => json!({"kind":"none"}),
            NativeMcpAccountFact::Referenced(reference) => {
                reference.validate()?;
                json!({"kind":"referenced","reference":reference})
            }
            NativeMcpAccountFact::OAuth {
                reference,
                state,
                reason,
            } => {
                reference.validate()?;
                json!({"kind":"oauth","reference":reference,"state":state,"reason":reason})
            }
            NativeMcpAccountFact::Unknown(reason) => json!({"kind":"unknown","reason":reason}),
        };
        ensure!(
            inputs
                .insert(
                    fact.selector.key()?,
                    json!([fact.security_fingerprint, fact.enabled, account])
                )
                .is_none(),
            "NATIVE_SOURCE_SELECTOR_AMBIGUOUS"
        );
    }
    digest(&json!({"scope":context.scope(),"sources":inputs}))
}
fn observe_existing_oauth(
    context: &NativeIntegrationContext,
    config: &McpServerConfig,
) -> Result<NativeMcpAccountFact> {
    use kcoder_mcp::authorization_index::observe::ExistingOAuthObservationStore;
    let endpoint = reqwest::Url::parse(&config.url)
        .map_err(|_| anyhow::anyhow!("NATIVE_OAUTH_ENDPOINT_INVALID"))?;
    let metadata = (|| -> Result<_> {
        let Some(store) = ExistingOAuthObservationStore::open_existing_for_account(
            context.profile()?,
            config.policy.oauth_account.as_deref(),
        )?
        else {
            return Ok(None);
        };
        store.observe_connection(&endpoint)
    })();
    let Some(metadata) = metadata.unwrap_or(None) else {
        return Ok(NativeMcpAccountFact::Unknown(
            "NATIVE_OAUTH_ACCOUNT_OBSERVATION_REQUIRED",
        ));
    };
    account_from_oauth_metadata(metadata)
}
fn account_from_oauth_metadata(
    metadata: kcoder_mcp::authorization_index::observe::OAuthPublicMetadata,
) -> Result<NativeMcpAccountFact> {
    use kcoder_mcp::authorization_index::observe::OAuthObservationState;
    let state = match metadata.state {
        OAuthObservationState::Authorized => IntegrationTaskCapabilitySourceState::Ready,
        OAuthObservationState::NotAuthorized
        | OAuthObservationState::Expired
        | OAuthObservationState::ReauthorizationRequired => {
            IntegrationTaskCapabilitySourceState::Unauthorized
        }
        OAuthObservationState::Unknown => {
            return Ok(NativeMcpAccountFact::Unknown(metadata.reason_code));
        }
    };
    let reference = IntegrationRevisionRef {
        id: format!("native-oauth-{}", metadata.binding_id),
        revision: metadata.authorization_revision,
    };
    reference.validate()?;
    Ok(NativeMcpAccountFact::OAuth {
        reference,
        state,
        reason: metadata.reason_code,
    })
}
fn digest(value: &Value) -> Result<String> {
    // serde_json::Map is sorted in the current manifest configuration. Explicit
    // canonicalization also preserves this property if preserve_order is enabled.
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), canonical(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical(value))?)
    ))
}
fn read(directory: &PrivateDirectory) -> Result<Document> {
    let file = directory.open_single_link_regular_file(OsStr::new(STATE))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_BYTES as usize,
        "NATIVE_SOURCE_CATALOG_INVALID"
    );
    let document: Document = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("NATIVE_SOURCE_CATALOG_INVALID"))?;
    ensure!(
        document.version == 1
            && document.sources.len() <= MAX_SOURCES
            && document.operations.len() <= MAX_OPERATIONS,
        "NATIVE_SOURCE_CATALOG_INVALID"
    );
    let mut ids = BTreeSet::new();
    for (key, record) in &document.sources {
        ensure!(
            key == &record.selector.key()? && ids.insert(record.source_ref.id.clone()),
            "NATIVE_SOURCE_CATALOG_INVALID"
        );
        record.source_ref.validate()?;
        ensure!(
            record.source_ref.id.starts_with("native-source-")
                && uuid::Uuid::parse_str(&record.source_ref.revision).is_ok(),
            "NATIVE_SOURCE_CATALOG_INVALID"
        );
        if let Some(account) = record.account_ref.as_ref() {
            account.validate()?;
        }
    }
    history::validate(&document)?;
    Ok(document)
}
fn save(directory: &PrivateDirectory, document: &Document) -> Result<()> {
    let bytes = serde_json::to_vec(document)?;
    ensure!(
        bytes.len() <= MAX_BYTES as usize,
        "NATIVE_SOURCE_CATALOG_CAPACITY"
    );
    directory.atomic_replace(OsStr::new(STATE), &bytes)
}

#[cfg(test)]
mod tests;
