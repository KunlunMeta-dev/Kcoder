//! Execute finite task controls with the original manager, gates, and journals.
use super::*;
use crate::app_server::{
    ConnectionState, history_refresh_processor::HistoryRefreshProcessor,
    thread_list_snapshots::ThreadListSnapshots,
};

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    origin: &kcoder_engine::QueryEngine,
    outbound: &mpsc::Sender<Value>,
    manager: &mut ThreadManager,
    state: &mut ConnectionState,
) -> Result<()> {
    use kcoder_app_protocol::method;
    match method {
        method::THREAD_METADATA_UPDATE => {
            let mut snapshots = ThreadListSnapshots::default();
            let mut refresh = HistoryRefreshProcessor::default();
            crate::app_server::thread_read_requests::dispatch_original(
                method,
                id,
                params,
                origin,
                outbound,
                manager,
                state,
                &mut snapshots,
                &mut refresh,
            )
            .await
            .map(|_| ())
        }
        method::THREAD_MODEL_SELECT => {
            crate::app_server::runtime_requests::select_model_request(id, params, outbound, manager)
                .await
        }
        method::THREAD_GOAL_SET | method::THREAD_GOAL_CLEAR => {
            crate::app_server::goal_requests::dispatch(
                method,
                id,
                params,
                origin,
                outbound,
                manager,
                Some(state),
            )
            .await
            .map(|_| ())
        }
        method::THREAD_COMPACT | method::THREAD_ROLLBACK => {
            crate::app_server::thread_rewind_requests::dispatch(
                method, id, params, outbound, manager,
            )
            .await
            .map(|_| ())
        }
        _ => anyhow::bail!("TASK_UI_COMMAND_NOT_SUPPORTED"),
    }
}
