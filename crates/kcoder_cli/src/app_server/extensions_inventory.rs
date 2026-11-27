//! `extensions/*`: unified read-only inventory, same-name skill source
//! preference and plugin conflict previews.
//!
//! Everything here runs only for explicit requests. Skill and plugin
//! discovery reuse the same registry builders as new conversations, so the
//! reported `effective` copy is the one invocation and catalogs use. Binary
//! probes run only with `includeBinaries`; nothing here hashes content.
use super::engine_factory::AppServerEngineFactory;
use super::protocol_io::{error_response, success_response};
use anyhow::{Context, Result};
use kcoder_app_protocol::{
    ExtensionConflictsPreviewParams, ExtensionSkillPreferenceUpdateParams,
    ExtensionsInventoryParams, ExtensionsInventoryResult, method,
};
use serde_json::{Value, json};

mod binaries;
mod hooks;
mod mcp;
mod preference;
mod preview;
mod shared;
mod skills;

pub(super) fn handles(method_name: &str) -> bool {
    matches!(
        method_name,
        method::EXTENSIONS_INVENTORY
            | method::EXTENSIONS_SKILL_PREFERENCE_UPDATE
            | method::EXTENSIONS_CONFLICTS_PREVIEW
    )
}

/// Everything one inventory projection reads, captured once per request.
pub(super) struct Sources {
    pub settings: kcoder_config::Settings,
    pub skills: kcoder_skills::SkillRegistry,
    pub plugins: Vec<kcoder_plugins::PluginListItem>,
    /// User-layer skill switch revisions of installed plugins that contribute skills.
    pub skill_policy_revisions: std::collections::BTreeMap<String, String>,
    pub snapshot: kcoder_plugins::EffectivePluginSnapshot,
    pub mcp: Vec<super::mcp_processor::ConfiguredMcp>,
    pub cwd: std::path::PathBuf,
    pub folder_trusted: bool,
}

impl Sources {
    pub fn load(factory: &AppServerEngineFactory) -> Result<Self> {
        let (cwd, folder_trusted) = factory.workspace_scope();
        let (settings, snapshot, mcp) = factory.current_mcp_configuration()?;
        let skills = factory.current_skills()?;
        let (plugins, skill_policy_revisions) = if settings.training_mode {
            Default::default()
        } else {
            let manager =
                kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
                    &cwd,
                    settings.plugins.clone(),
                )?;
            let plugins = manager.list(&cwd, folder_trusted)?.plugins;
            let revisions = manager.skill_policy_revisions(
                plugins
                    .iter()
                    .filter(|plugin| shared::has_switchable_skills(plugin))
                    .map(|plugin| plugin.id.as_str()),
            )?;
            (plugins, revisions)
        };
        Ok(Self {
            settings,
            skills,
            plugins,
            skill_policy_revisions,
            snapshot,
            mcp,
            cwd,
            folder_trusted,
        })
    }
}

fn inventory(
    factory: &AppServerEngineFactory,
    params: ExtensionsInventoryParams,
) -> Result<ExtensionsInventoryResult> {
    let sources = Sources::load(factory)?;
    let manifests = shared::PluginManifests::read(&sources.plugins);
    let mut items = Vec::new();
    let mut conflicts = Vec::new();
    skills::project(&sources, &manifests, &mut items, &mut conflicts);
    mcp::project(&sources, &mut items);
    let user_settings = factory.hook_user_settings_path()?;
    let mut hook_issues = Vec::new();
    hooks::project(&user_settings, &sources, &mut items, &mut hook_issues);
    shared::plugin_items(&sources, &manifests, &mut items);
    if params.include_binaries {
        binaries::project(&mut items, &mut conflicts);
    }
    shared::assign_unique_ids(&mut items);
    let (preference, revision) = preference::read(&user_settings)?;
    Ok(ExtensionsInventoryResult {
        items,
        conflicts,
        hook_issues,
        skill_preference: preference,
        skill_preference_revision: revision,
        binaries_included: params.include_binaries,
        applies_to_new_conversations: true,
        plugin_skill_policy: true,
    })
}

/// Add `extensionConflicts` to a successful `plugin/install` or `plugin/read`
/// result for connections that negotiated `extensionsInventoryV1`. A failed
/// preview never changes the plugin operation's own outcome.
pub(super) async fn attach_plugin_conflicts(factory: AppServerEngineFactory, response: &mut Value) {
    let Some(plugin_id) = response
        .pointer("/result/plugin/id")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let preview =
        tokio::task::spawn_blocking(move || preview::conflicts_for_plugin(&factory, &plugin_id))
            .await;
    match preview {
        Ok(Ok(conflicts)) => {
            if let (Some(result), Ok(value)) = (
                response.get_mut("result").and_then(Value::as_object_mut),
                serde_json::to_value(conflicts),
            ) {
                result.insert("extensionConflicts".into(), value);
            }
        }
        Ok(Err(error)) => tracing::warn!(%error, "plugin conflict preview unavailable"),
        Err(error) => tracing::warn!(%error, "plugin conflict preview worker stopped"),
    }
}

fn failure(id: Value, code: i64, kind: &str, message: &str) -> Value {
    let mut response = error_response(id, code, message);
    response["error"]["data"] = json!({ "kind": kind });
    response
}

pub(super) async fn process(
    factory: AppServerEngineFactory,
    id: Value,
    operation: String,
    params: Value,
) -> Value {
    let outcome =
        tokio::task::spawn_blocking(move || -> Result<Value, (i64, &'static str, String)> {
            let invalid = |message: &str| (-32602, "extensions_invalid", message.to_owned());
            let unavailable =
                |error: anyhow::Error| (-32021, "extensions_unavailable", format!("{error:#}"));
            match operation.as_str() {
                method::EXTENSIONS_INVENTORY => {
                    let params: ExtensionsInventoryParams = kcoder_app_rpc_codec::decode(params)
                        .map_err(|_| invalid("Invalid extension inventory parameters"))?;
                    inventory(&factory, params)
                        .and_then(|result| Ok(serde_json::to_value(result)?))
                        .map_err(unavailable)
                }
                method::EXTENSIONS_SKILL_PREFERENCE_UPDATE => {
                    let params: ExtensionSkillPreferenceUpdateParams =
                        kcoder_app_rpc_codec::decode(params)
                            .map_err(|_| invalid("Invalid skill source preference parameters"))?;
                    preference::validate(&params).map_err(|error| invalid(&error.to_string()))?;
                    let path = factory.hook_user_settings_path().map_err(unavailable)?;
                    match preference::update(&path, params) {
                        Ok(result) => {
                            Ok(serde_json::to_value(result).expect("preference serializes"))
                        }
                        Err(error)
                            if error
                                .downcast_ref::<preference::RevisionConflict>()
                                .is_some() =>
                        {
                            Err((
                                -32049,
                                "skill_preference_conflict",
                                "Skill source preference changed; reload before saving".into(),
                            ))
                        }
                        Err(error) => Err(unavailable(error)),
                    }
                }
                _ => {
                    let params: ExtensionConflictsPreviewParams =
                        kcoder_app_rpc_codec::decode(params)
                            .map_err(|_| invalid("Invalid conflict preview parameters"))?;
                    preview::validate(&params).map_err(|error| invalid(&error.to_string()))?;
                    let sources = Sources::load(&factory).map_err(unavailable)?;
                    preview::preview(&sources, &params)
                        .and_then(|result| Ok(serde_json::to_value(result)?))
                        .map_err(unavailable)
                }
            }
        })
        .await
        .context("extension request worker stopped");
    match outcome {
        Ok(Ok(result)) => success_response(id, result),
        Ok(Err((code, kind, message))) => failure(id, code, kind, &message),
        Err(error) => failure(id, -32021, "extensions_unavailable", &format!("{error:#}")),
    }
}
