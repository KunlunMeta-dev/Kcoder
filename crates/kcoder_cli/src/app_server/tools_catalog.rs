use super::*;
use kcoder_app_protocol::{
    ToolCatalogCachePolicy, ToolCatalogScope, ToolsCatalogParams, ToolsCatalogResult,
};

pub(super) async fn query(
    params: Value,
    manager: &thread_runtime::ThreadManager,
    workspace_engine: &QueryEngine,
) -> anyhow::Result<ToolsCatalogResult> {
    let params: ToolsCatalogParams =
        serde_json::from_value(params).context("invalid tools/catalog params")?;
    let (engine, scope) = match params.thread_id.as_deref() {
        Some(thread_id) => (
            manager.engine(thread_id).context("tools/catalog requires a resident thread owned by this connection; resume it first")?,
            ToolCatalogScope::Thread,
        ),
        None => (workspace_engine.clone(), ToolCatalogScope::Workspace),
    };
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
