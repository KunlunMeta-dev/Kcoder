//! Compile the exact production resolver and settings projection without the CLI runtime.
extern crate self as kcoder_engine;

#[path = "../../../../../kcoder_engine/src/agent_tool_policy.rs"]
pub mod agent_tool_policy;
#[path = "../../../../src/app_server/engine_factory/tool_selections/resolution.rs"]
#[allow(dead_code)]
mod resolution;
