use super::*;

pub(super) async fn process(id: Value, params: Value, engine: &QueryEngine) -> Value {
    if serde_json::from_value::<kcoder_app_protocol::UsageStatsParams>(params).is_err() {
        return error_response(id, -32602, "usage/stats expects an empty parameter object");
    }
    let Some(root) = engine.state.usage_history_root() else {
        return error_response(
            id,
            -32603,
            "Token usage tracking requires an explicit user profile",
        );
    };
    match tokio::task::spawn_blocking(move || kcoder_state::usage_history::read_usage(&root)).await
    {
        Ok(Ok(history)) => success_response(
            id,
            json!(kcoder_app_protocol::UsageStatsResult {
                window_days: 30,
                time_zone: "UTC".to_owned(),
                generated_at_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
                history,
            }),
        ),
        result => {
            tracing::warn!(?result, "failed to read token usage history");
            error_response(
                id,
                -32603,
                "Token usage history could not be read; check target diagnostics",
            )
        }
    }
}
