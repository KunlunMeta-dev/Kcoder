//! Catalog and apply do not create threads, select models or execute workflows.
use anyhow::{Result, ensure};
use kcoder_app_protocol::*;
use kcoder_engine::QueryEngine;
#[cfg(test)]
use kcoder_types::workflow::*;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;

/// Runtime-only observed model facts. Ordinary workspace requests never create
/// these facts from a thread string or the bootstrap Engine.
pub(in crate::app_server) struct NativeThreadModelFact {
    thread_id: String,
    model: kcoder_types::ModelConfigurationSummary,
}
pub(in crate::app_server) fn observe_resident_model(
    workspace: &QueryEngine,
    manager: &crate::app_server::thread_runtime::ThreadManager,
    id: &str,
) -> Result<Option<NativeThreadModelFact>> {
    let Some(original) = manager.engine(id) else {
        return Ok(None);
    };
    ensure!(
        original.session_id() == id
            && original.settings_persistence_path() == workspace.settings_persistence_path()
            && original.state.cwd() == workspace.state.cwd(),
        "workflow_collaboration: original thread target/profile mismatch"
    );
    Ok(Some(NativeThreadModelFact {
        thread_id: id.into(),
        model: original.active_model_configuration_summary()?,
    }))
}
pub(in crate::app_server) fn request_observed(
    engine: &QueryEngine,
    method: &str,
    params: Value,
    observed: Option<NativeThreadModelFact>,
) -> Result<Value> {
    request_inner(engine, method, params, observed)
}
pub(super) fn request(engine: &QueryEngine, method: &str, params: Value) -> Result<Value> {
    request_inner(engine, method, params, None)
}
fn request_inner(
    engine: &QueryEngine,
    method: &str,
    params: Value,
    observed: Option<NativeThreadModelFact>,
) -> Result<Value> {
    kcoder_workflow_rpc::collaboration::request(
        method,
        params,
        observed.map(|fact| (fact.thread_id, fact.model)),
        &|| engine.settings_persistence_path(),
        &|name| {
            let tool = engine.tools.get(name);
            WorkflowCollaborationToolFact {
                name: name.into(),
                registered: tool.is_some(),
                read_only: tool.map(|tool| tool.is_read_only()),
            }
        },
        &|definition| {
            kcoder_tools::workflow_draft::validate_workflow_agent_types(definition)?;
            let _ = kcoder_tools::workflow_draft::validate_workflow_tool_contracts(
                definition,
                |name| {
                    engine
                        .tools
                        .get(name)
                        .map(|tool| kcoder_types::ToolDefinition {
                            name: tool.name(),
                            description: tool.description(),
                            input_schema: tool.input_schema(),
                        })
                },
            )?;
            Ok(())
        },
    )
}

#[cfg(test)]
mod tests;
