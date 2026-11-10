//! Metadata-only platform API check when unrelated native C dependencies prevent
//! a full cross-target build. This does not prove proxy behavior on that host.
#[derive(Debug)]
pub enum ToolError {
    Execution(String),
}
#[path = "../../src/web_network/system_proxy.rs"]
mod system_proxy;

pub fn check_platform_api() -> Result<(), ToolError> {
    system_proxy::apply(&mut Vec::new())
}
