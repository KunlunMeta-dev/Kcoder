use kcoder_plugin_rpc::RuntimeObservation;
use std::collections::BTreeMap;

pub(super) fn capture(
    engine: &kcoder_engine::QueryEngine,
    plugin: &str,
    factory: &super::engine_factory::AppServerEngineFactory,
) -> RuntimeObservation {
    let registry = engine.active_tool_registry();
    let mut tools = BTreeMap::new();
    for name in registry.names() {
        if let Some(kcoder_tools::ToolSource::Plugin {
            plugin: owner,
            server,
            ..
        }) = registry.source(&name)
            && owner == plugin
        {
            *tools.entry(server.clone()).or_insert(0) += 1;
        }
    }
    let hooks = engine
        .hook_registry()
        .settings_hooks
        .iter()
        .filter_map(|(event, matcher)| {
            matcher
                .source
                .as_ref()
                .filter(|source| source.id == plugin)
                .map(|_| event.as_str().to_owned())
        })
        .collect();
    let snapshot = engine.plugin_snapshot();
    let attempts = snapshot
        .mcp_configs
        .iter()
        .zip(&snapshot.mcp_config_sources)
        .filter(|(_, source)| source.plugin_id == plugin)
        .filter_map(|(config, _)| {
            factory
                .mcp_connection_attempt_for_registry(config, &registry)
                .map(|status| (config.name.clone(), status))
        })
        .collect();
    RuntimeObservation {
        thread_id: engine.session_id(),
        generation: engine.plugin_snapshot().generation,
        tools,
        attempts,
        mcp_configs: snapshot
            .mcp_configs
            .iter()
            .zip(&snapshot.mcp_config_sources)
            .filter(|(_, source)| source.plugin_id == plugin)
            .map(|(config, _)| config.clone())
            .collect(),
        authorizations: BTreeMap::new(),
        skill_paths: engine
            .client_skill_catalog()
            .into_iter()
            .map(|skill| skill.path)
            .collect(),
        hooks,
        hook_observations: engine
            .hook_registry()
            .plugin_observations(plugin)
            .into_iter()
            .map(|observation| (observation.event.as_str().into(), observation))
            .collect(),
        hooks_disabled: engine.hook_registry().disabled,
    }
}
