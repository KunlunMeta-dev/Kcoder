//! App Server ownership and Engine inspection for Workflow Canvas.
pub(in crate::app_server) mod collaboration;

use anyhow::Result;
use kcoder_app_protocol::{WORKFLOW_COLLABORATION_APPLY, WORKFLOW_COLLABORATION_CATALOG};
use kcoder_engine::QueryEngine;
use serde_json::Value;

pub(super) fn request(engine: &QueryEngine, method: &str, params: Value) -> Result<Value> {
    if matches!(
        method,
        WORKFLOW_COLLABORATION_CATALOG | WORKFLOW_COLLABORATION_APPLY
    ) {
        return collaboration::request(engine, method, params);
    }
    kcoder_workflow_rpc::request(
        &|| engine.settings_persistence_path(),
        method,
        params,
        &|draft| {
            use kcoder_tools::AgentRunner;
            kcoder_tools::workflow_draft::validate_workflow_agent_types(draft)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let inspector = kcoder_engine::agent::QueryEngineAgentRunner::new(engine.clone());
            kcoder_tools::workflow_draft::validate_workflow_tool_contracts(draft, |name| {
                inspector.workflow_tool_contract(name)
            })
            .map_err(|error| anyhow::anyhow!(error.to_string()))
        },
    )
}
