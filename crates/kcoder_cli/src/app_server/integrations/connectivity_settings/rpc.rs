use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{ConnectionState, error_response, send, success_response};
use tokio::sync::mpsc;

pub(in crate::app_server) async fn dispatch(
    method: &str,
    id: &Value,
    params: &Value,
    engine: &QueryEngine,
    factory: &AppServerEngineFactory,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let save = match method {
        CONNECTIVITY_SETTINGS_READ => false,
        CONNECTIVITY_SETTINGS_SAVE => true,
        _ => return Ok(false),
    };
    let parsed = (|| -> Result<_> {
        ensure!(
            state.integration_connectivity_settings_v1 && state.knowledge_rpc_tasks.len() < 64,
            "CONNECTIVITY_SETTINGS_UNAVAILABLE"
        );
        ensure!(
            !state.native_source_dispatch && state.native_source_accepted.is_none(),
            "CONNECTIVITY_SETTINGS_UNAVAILABLE"
        );
        if save {
            Ok(Some(serde_json::from_value::<
                ConnectivitySettingsSaveParams,
            >(params.clone())?))
        } else {
            ensure!(
                params.as_object().is_some_and(|object| object.is_empty()),
                "CONNECTIVITY_SETTINGS_INVALID_REQUEST"
            );
            Ok(None)
        }
    })();
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32602, "CONNECTIVITY_SETTINGS_INVALID_REQUEST"),
            )
            .await?;
            return Ok(true);
        }
    };
    let (engine, factory, id, outbound) = (
        engine.clone(),
        factory.clone(),
        id.clone(),
        outbound.clone(),
    );
    let cancel = state.input_ended.child_token();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let _cancel_on_drop = cancel.clone().drop_guard();
        let result = tokio::task::spawn_blocking(move || match parsed {
            Some(params) => super::save(&engine, &factory, params, &cancel),
            None => super::read(&engine, &factory, &cancel),
        })
        .await;
        let response = match result {
            Ok(Ok(result)) => match serde_json::to_value(result) {
                Ok(result) => success_response(id, result),
                Err(_) => error_response(id, -32086, "CONNECTIVITY_SETTINGS_RESULT_UNCONFIRMED"),
            },
            Ok(Err(error)) => error_response(id, -32085, &error.to_string()),
            Err(_) => error_response(id, -32086, "CONNECTIVITY_SETTINGS_RESULT_UNCONFIRMED"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
