//! Resource requests: extracted from the app-server connection boundary.

use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed connection and resource owners explicit at the extracted dispatch boundary"
)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    next_terminal_id: &AtomicU64,
    terminals: &TerminalRegistry,
    browsers: &mut BrowserRegistry,
    profile_context: Option<&mut integrations::core::NativeIntegrationContext>,
) -> Result<DispatchControl> {
    match method {
        method::TERMINAL_START
        | method::TERMINAL_LIST
        | method::TERMINAL_ATTACH
        | method::TERMINAL_WRITE
        | method::TERMINAL_RESIZE
        | method::TERMINAL_CLOSE => {
            kcoder_workspace_resources::terminal_requests::dispatch(
                method,
                id,
                params,
                &|| (workspace_engine.state.cwd(), workspace_engine.session_id()),
                outbound_tx,
                next_terminal_id,
                terminals,
            )
            .await?;
        }
        _ => {
            browser::requests::dispatch(
                method,
                id,
                params,
                &workspace_engine.state,
                &|| {
                    Ok(workspace_engine
                        .active_model_configuration_summary()?
                        .revision)
                },
                outbound_tx,
                browsers,
                profile_context,
            )
            .await?;
        }
    }
    Ok(DispatchControl::Continue)
}
