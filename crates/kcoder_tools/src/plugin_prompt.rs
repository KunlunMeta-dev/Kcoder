//! Resolve a registered plugin prompt into an ordinary permission-bound child task.
use crate::{ToolContext, ToolError, agent::AgentInput};
use kcoder_types::plugin_prompt::PluginPromptProfile;
use std::io::Read;

fn tool_alias(name: &str) -> String {
    match name {
        "Read" => "read",
        "Write" => "write",
        "Edit" | "MultiEdit" => "edit",
        "Glob" => "glob",
        "Grep" => "grep",
        "Bash" => {
            if cfg!(windows) {
                "PowerShell"
            } else {
                "bash"
            }
        }
        "Task" | "Agent" => "spawn_agent",
        other => other,
    }
    .to_owned()
}
pub(crate) async fn apply_profile(
    input: &mut AgentInput,
    ctx: &ToolContext,
) -> Result<(), ToolError> {
    let Some(name) = input.plugin_agent.clone() else {
        return Ok(());
    };
    if input
        .agent_type
        .as_deref()
        .is_some_and(|role| role != "general")
    {
        return Err(ToolError::InvalidInput(
            "plugin_agent cannot be combined with a different agent_type".into(),
        ));
    }
    let source = {
        let registry = ctx
            .skill_registry
            .as_ref()
            .ok_or_else(|| ToolError::Execution("Plugin prompt registry unavailable".into()))?
            .read()
            .unwrap();
        if registry.is_trust_denied(&name) {
            return Err(ToolError::Execution(
                "Plugin prompt folder is not trusted".into(),
            ));
        }
        let skill = registry
            .get_active(&name)
            .filter(|skill| skill.category.as_deref() == Some("plugin-prompt"))
            .ok_or_else(|| {
                ToolError::InvalidInput(format!(
                    "Unknown plugin prompt {name}; use an exact registered plugin skill name"
                ))
            })?;
        skill.source.clone()
    };
    crate::skill::authorize_plugin_prompt(ctx, &name, &source).await?;
    let profile = (|| -> anyhow::Result<PluginPromptProfile> {
        let directory = kcoder_config::PrivateDirectory::open_existing(
            source
                .parent()
                .ok_or_else(|| anyhow::anyhow!("missing profile directory"))?,
        )?;
        let file = directory.open_regular_file(std::ffi::OsStr::new("plugin-agent.json"))?;
        let mut bytes = Vec::new();
        file.take(256 * 1024 + 1).read_to_end(&mut bytes)?;
        anyhow::ensure!(bytes.len() <= 256 * 1024, "plugin profile exceeds limit");
        Ok(serde_json::from_slice(&bytes)?)
    })()
    .map_err(|error| ToolError::Execution(format!("Cannot load plugin prompt: {error:#}")))?;
    if !matches!(profile.kind.as_str(), "agent" | "command")
        || profile.max_turns.is_some_and(|n| !(1..=100).contains(&n))
    {
        return Err(ToolError::InvalidInput(
            "Invalid plugin prompt execution metadata".into(),
        ));
    }
    let task = input.message.clone();
    if task.trim().is_empty() {
        return Err(ToolError::InvalidInput(
            "Plugin prompt requires a task in message".into(),
        ));
    }
    // Launchers are one-shot instructions, not persistent child skills. Keeping
    // this active would tell the child to delegate itself recursively.
    if let Some(active) = &ctx.active_skills {
        active.write().unwrap().retain(|skill| skill != &name);
    }
    input.plugin_policy = Some(kcoder_types::plugin_prompt::PluginPromptPolicy {
        allowed_tools: profile
            .allowed_tools
            .clone()
            .map(|tools| tools.iter().map(|name| tool_alias(name)).collect()),
        max_turns: profile.max_turns,
    });
    input.plugin_profile = Some(profile);
    Ok(())
}

pub(crate) fn render_task(
    profile: &PluginPromptProfile,
    name: &str,
    task: &str,
    cwd: &std::path::Path,
    session_id: &str,
) -> String {
    let workspace = cwd.to_string_lossy();
    let directory = std::path::Path::new(&profile.source)
        .parent()
        .unwrap_or_else(|| std::path::Path::new(&profile.plugin_root))
        .to_string_lossy();
    let instructions = render_instructions(
        &profile.instructions,
        task,
        &profile.plugin_root,
        &profile.argument_names,
        &[
            ("CLAUDE_SKILL_DIR", directory.as_ref()),
            ("CLAUDE_PROJECT_DIR", workspace.as_ref()),
            ("CLAUDE_SESSION_ID", session_id),
        ],
    );
    format!(
        "You are already executing plugin task profile {name}; do not invoke this same launcher again.\nTask working directory: {workspace}\nResolve user task files relative to this working directory. Plugin resources are separate and are used only when explicitly referenced. Parent permissions remain authoritative.\n\nUser task / arguments:\n{task}\n\nPlugin instructions:\n{instructions}\n\nPlugin resource directory (not the task workspace): {}\nDefinition source (reference only): {}",
        profile.plugin_root, profile.source
    )
}

fn render_instructions(
    template: &str,
    task: &str,
    root: &str,
    names: &[String],
    variables: &[(&str, &str)],
) -> String {
    let arguments = shell_words::split(task).unwrap_or_else(|_| vec![task.to_owned()]);
    let mut output = String::new();
    let mut remaining = template;
    while let Some(index) = remaining.find('$') {
        let prefix = &remaining[..index];
        let after = &remaining[index + 1..];
        let identifier_len = after
            .bytes()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == b'_')
            .count();
        let identifier = &after[..identifier_len];
        if prefix.ends_with('\\')
            && !prefix[..prefix.len() - 1].ends_with('\\')
            && (after.starts_with(|c: char| c.is_ascii_digit())
                || identifier == "ARGUMENTS"
                || names.iter().any(|name| name == identifier))
        {
            output.push_str(&prefix[..prefix.len() - 1]);
            output.push('$');
            remaining = after;
            continue;
        }
        output.push_str(prefix);
        if let Some(rest) = after.strip_prefix("ARGUMENTS[") {
            if let Some((number, tail)) = rest.split_once(']') {
                if let Ok(position) = number.parse::<usize>() {
                    if let Some(value) = arguments.get(position) {
                        output.push_str(value);
                        remaining = tail;
                        continue;
                    }
                }
            }
        }
        if let Some(tail) = after.strip_prefix("ARGUMENTS") {
            if !tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == '[') {
                output.push_str(task);
                remaining = tail;
                continue;
            }
        }
        let count = after.bytes().take_while(u8::is_ascii_digit).count();
        if count > 0 {
            if let Ok(position) = after[..count].parse::<usize>() {
                if let Some(value) = arguments.get(position) {
                    output.push_str(value);
                    remaining = &after[count..];
                    continue;
                }
            }
        }
        if let Some(position) = names.iter().position(|name| name == identifier) {
            output.push_str(arguments.get(position).map(String::as_str).unwrap_or(""));
            remaining = &after[identifier_len..];
            continue;
        }
        if let Some(rest) = after.strip_prefix('{') {
            if let Some((name, tail)) = rest.split_once('}') {
                if let Some((_, value)) = variables.iter().find(|(key, _)| *key == name) {
                    output.push_str(value);
                    remaining = tail;
                    continue;
                }
                if matches!(
                    name,
                    "PLUGIN_ROOT"
                        | "CLAUDE_PLUGIN_ROOT"
                        | "CODEX_PLUGIN_ROOT"
                        | "CODEBUDDY_PLUGIN_ROOT"
                        | "QODER_PLUGIN_ROOT"
                        | "TRAE_PLUGIN_ROOT"
                        | "GROK_PLUGIN_ROOT"
                ) {
                    output.push_str(root);
                    remaining = tail;
                    continue;
                }
            }
        }
        output.push('$');
        remaining = after;
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_prompt_arguments_are_literal_not_recursive_or_shell_executed() {
        assert_eq!(
            render_instructions(
                "$issue/$branch/$0/$1/\\$0",
                "42 main",
                "/plugin",
                &["issue".into(), "branch".into()],
                &[]
            ),
            "42/main/42/main/$0"
        );
        assert_eq!(
            render_instructions(
                "$ARGUMENTS | $0 | $ARGUMENTS[1] | $10 | ${CLAUDE_PLUGIN_ROOT}",
                "'hello world' '$1'",
                "/plugin",
                &[],
                &[]
            ),
            "'hello world' '$1' | hello world | $1 | $10 | /plugin"
        );
    }
}
