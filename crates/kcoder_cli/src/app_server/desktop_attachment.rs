//! Pure turn-scoped desktop composition. Starting a native host remains a
//! platform-specific, separately authorized operation in desktop_turn.
use anyhow::{Context, Result};
use kcoder_computer_use::session::DesktopSession;
use kcoder_engine::{DesktopTurnGuard, QueryEngine};
use kcoder_mcp::{desktop_tool::DesktopTool, model::McpToolDefinition};
use std::sync::Arc;

pub(super) fn attach(
    engine: &QueryEngine,
    session: Arc<DesktopSession>,
    definitions: Vec<McpToolDefinition>,
) -> Result<(QueryEngine, DesktopTurnGuard)> {
    let mut scoped = engine.clone();
    // Never mutate the resident registry or the shared subagent base registry.
    let mut tools = scoped.tools.clone();
    for definition in definitions {
        let tool = DesktopTool::new(definition, session.clone()).map_err(anyhow::Error::msg)?;
        tools
            .try_register(Arc::new(tool))
            .context("desktop tool registration conflict")?;
    }
    let binding = scoped
        .bind_desktop_turn(session.owner().clone())
        .map_err(anyhow::Error::msg)?;
    scoped = scoped.with_turn_tools(tools);
    Ok((scoped, binding))
}
