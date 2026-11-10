//! MCP configuration, credential preparation and name policy without a transport.

#[path = "naming.rs"]
mod naming;
#[path = "policy.rs"]
mod policy;
#[path = "../../tool/private_values.rs"]
mod private_values;

pub use naming::mcp_tool_name;
pub use policy::{
    CredentialContext, check_workspace, prepare, prepare_in, validate, validate_account,
    validate_references,
};
pub use private_values::PrivateValues;
