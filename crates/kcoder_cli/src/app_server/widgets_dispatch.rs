//! Connection-owned Widget negotiation and resident selection.
use super::*;
pub(super) use kcoder_mcp_app_runtime::widgets_dispatch::{store_directory, supports};

pub(super) fn request(
    method: &str,
    params: Value,
    manager: &ThreadManager,
    state: &ConnectionState,
) -> Result<Value> {
    kcoder_mcp_app_runtime::widgets_dispatch::request(
        method,
        params,
        manager,
        state.inline_widgets_v1,
    )
}
