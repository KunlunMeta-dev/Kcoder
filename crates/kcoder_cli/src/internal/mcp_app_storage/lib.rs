//! Durable MCP App operation receipts and bounded resource data.

#[path = "../../app_server/mcp_apps_ledger.rs"]
pub mod ledger;
#[path = "../../app_server/mcp_apps_resources.rs"]
pub mod resources;

use sha2::Digest as _;

pub fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", sha2::Sha256::digest(bytes))
}
