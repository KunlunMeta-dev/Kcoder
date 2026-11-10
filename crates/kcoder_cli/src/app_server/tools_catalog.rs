use super::*;
use kcoder_app_protocol::{
    ToolCatalogCachePolicy, ToolCatalogScope, ToolsCatalogParams, ToolsCatalogResult,
};

pub(super) async fn query(
    params: Value,
    manager: &thread_runtime::ThreadManager,
    workspace_engine: &QueryEngine,
    state: &ConnectionState,
) -> anyhow::Result<ToolsCatalogResult> {
    let params: ToolsCatalogParams =
        serde_json::from_value(params).context("invalid tools/catalog params")?;
    if params.async_user_questions == Some(true) && !state.async_user_questions_v1 {
        anyhow::bail!("asyncUserQuestionsV1 negotiation is required");
    }
    let (engine, scope) = match params.thread_id.as_deref() {
        Some(thread_id) => {
            let original = integrations::connectivity::task_ui::prepare_resident_input(
                state, manager, thread_id,
            )?;
            (original.or_else(||manager.engine(thread_id)).context("tools/catalog requires a resident thread owned by this connection; resume it first")?, ToolCatalogScope::Thread)
        }
        None => (workspace_engine.clone(), ToolCatalogScope::Workspace),
    };
    let presentation = studio_presentation::validate(
        state,
        params.client_presentation.as_ref(),
        (scope == ToolCatalogScope::Thread).then(|| engine.state.studio_work_mode()),
    )?;
    let isolated_authorized = presentation
        .as_ref()
        .is_some_and(|value| value.isolated_widgets);
    let engine = engine
        .with_async_user_questions_supported(
            state.async_user_questions_v1 && params.async_user_questions.unwrap_or(false),
        )
        .with_client_presentation(presentation)
        .with_inline_widget_tool(
            kcoder_tools::ShowWidgetTool::preview()
                .with_isolated_html_authorized(isolated_authorized),
        );
    Ok(bounded_result(
        params.thread_id,
        scope,
        engine.effective_tool_catalog().await,
    ))
}

fn bounded_result(
    thread_id: Option<String>,
    scope: ToolCatalogScope,
    tools: Vec<kcoder_app_protocol::ToolCatalogEntry>,
) -> ToolsCatalogResult {
    let snapshot = kcoder_types::tool_ui::bounded_tool_catalog(tools);
    ToolsCatalogResult {
        scope,
        thread_id,
        cache_policy: ToolCatalogCachePolicy::NoStore,
        tools: snapshot.tools,
        total: snapshot.total,
        truncated: snapshot.truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_app_protocol::TOOL_CATALOG_LIMIT;

    #[test]
    fn catalog_enforces_count_and_serialized_byte_budgets() {
        let entry = kcoder_app_protocol::ToolCatalogEntry {
            name: "tool".into(),
            ui: kcoder_app_protocol::ToolUiMetadata::fallback("tool"),
        };
        let count = bounded_result(
            None,
            ToolCatalogScope::Workspace,
            vec![entry.clone(); TOOL_CATALOG_LIMIT + 1],
        );
        assert_eq!(count.tools.len(), TOOL_CATALOG_LIMIT);
        assert_eq!(count.total, TOOL_CATALOG_LIMIT + 1);
        assert!(count.truncated);
        let huge = kcoder_app_protocol::ToolCatalogEntry {
            name: "x".repeat(2 * 1024 * 1024),
            ..entry
        };
        let bytes = bounded_result(None, ToolCatalogScope::Workspace, vec![huge]);
        assert!(serde_json::to_vec(&bytes).unwrap().len() <= 1024 * 1024);
        assert!(bytes.truncated);
        assert_eq!(bytes.total, 1);
    }
}
