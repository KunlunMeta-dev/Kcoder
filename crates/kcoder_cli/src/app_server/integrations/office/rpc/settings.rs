//! Office configuration remains available before the business feature is enabled.
use super::*;
use crate::app_server::engine_factory::AppServerEngineFactory;
use crate::app_server::task_spawn::JoinSetExt as _;
use kcoder_app_protocol::integrations::office_settings::{
    OFFICE_SETTINGS_READ, OFFICE_SETTINGS_SAVE, OfficeSettingsSaveParams,
};
use kcoder_app_rpc_codec as rpc_codec;

pub(in crate::app_server) async fn dispatch_settings(
    method: &str,
    id: &Value,
    params: &Value,
    workspace: &QueryEngine,
    factory: &AppServerEngineFactory,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let save = match method {
        OFFICE_SETTINGS_READ => false,
        OFFICE_SETTINGS_SAVE => true,
        _ => return Ok(false),
    };
    let parsed = (|| -> Result<_> {
        ensure!(
            state.integration_office_settings_v1,
            "OFFICE_SETTINGS_UNAVAILABLE"
        );
        ensure!(
            state.knowledge_rpc_tasks.len() < 64,
            "OFFICE_SETTINGS_UNAVAILABLE"
        );
        if save {
            Ok(Some(rpc_codec::decode::<OfficeSettingsSaveParams>(
                params.clone(),
            )?))
        } else {
            ensure!(
                params.as_object().is_some_and(|value| value.is_empty()),
                "OFFICE_SETTINGS_INVALID_REQUEST"
            );
            Ok(None)
        }
    })();
    let parsed = match parsed {
        Ok(parsed) => parsed,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32602, "OFFICE_SETTINGS_INVALID_REQUEST"),
            )
            .await?;
            return Ok(true);
        }
    };
    let (workspace, factory) = (workspace.clone(), factory.clone());
    let (id, outbound) = (id.clone(), outbound.clone());
    let cancel = state.input_ended.child_token();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let _cancel_on_drop = cancel.clone().drop_guard();
        let result = tokio::task::spawn_blocking(move || match parsed {
            Some(params) => super::super::settings::save(&workspace, &factory, params, &cancel),
            None => super::super::settings::read(&workspace, &factory, &cancel),
        })
        .await;
        let response = match result {
            Ok(Ok(result)) => match serde_json::to_value(result) {
                Ok(result) => success_response(id, result),
                Err(_) => error_response(id, -32076, "OFFICE_SETTINGS_RESULT_UNCONFIRMED"),
            },
            // These errors are sanitized inside the configuration leaf. A
            // cancelled post-commit save must be reconciled with a fresh read.
            Ok(Err(error)) => error_response(id, -32075, &error.to_string()),
            Err(_) => error_response(id, -32076, "OFFICE_SETTINGS_RESULT_UNCONFIRMED"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
