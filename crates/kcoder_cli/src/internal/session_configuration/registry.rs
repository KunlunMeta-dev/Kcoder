use kcoder_cli_commands::cli_args::Cli;
use kcoder_config::Settings;
use kcoder_tools::{ConfigTool, ToolRegistry, core_registry, default_registry, nano_registry};

pub fn builtin_tools_for_settings(cli: &Cli, settings: &Settings) -> ToolRegistry {
    builtin_tools_for_profile(cli.tool_profile.effective(settings.tools.profile), settings)
}

pub fn builtin_tools_for_profile(
    profile: kcoder_config::ToolProfile,
    settings: &Settings,
) -> ToolRegistry {
    let tools = match profile {
        kcoder_config::ToolProfile::Full => default_registry(),
        kcoder_config::ToolProfile::Core => core_registry(),
        kcoder_config::ToolProfile::Nano => nano_registry(),
        kcoder_config::ToolProfile::None => return ToolRegistry::new(),
    };
    let tools = tools.register(ConfigTool);
    let tools = if settings.knowledge.can_retrieve() {
        tools.register(kcoder_tools::wiki::WikiTool)
    } else {
        tools
    };
    if settings.knowledge.can_organize() {
        tools.register(kcoder_tools::wiki_manage::WikiManageTool)
    } else {
        tools
    }
}
