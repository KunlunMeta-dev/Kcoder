//! Fixed, consent-gated public constraint probes through the native search runtime.
use kcoder_tools::{ToolContext, web_search::WebSearchRuntime};
use kcoder_types::web_search::{WebSearchProvider, WebSearchStatus};
use serde_json::json;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("KCODER_E2E_WEB_EXTERNAL_NETWORK").as_deref() == Ok("1"),
        "Explicit external-provider consent is required"
    );
    let root = PathBuf::from(
        std::env::var_os("KCODER_CONFIG_DIR")
            .ok_or_else(|| anyhow::anyhow!("Owned profile required"))?,
    );
    anyhow::ensure!(
        root.is_absolute() && root.is_dir(),
        "Owned profile must exist"
    );
    let queries = [
        json!({"query":"official Python asyncio cancellation documentation","region":"US","allowed_domains":["docs.python.org"],"num_results":3,"freshness":"live"}),
        json!({"query":"Rust programming language stable release announcement","time_range":"week","allowed_domains":["blog.rust-lang.org"],"num_results":3,"freshness":"live"}),
        json!({"query":"Python software release announcement","region":"US","time_range":"day","allowed_domains":["python.org"],"num_results":3,"freshness":"live"}),
    ];
    let runtime = WebSearchRuntime::new();
    let mut results = Vec::new();
    for (index, input) in queries.into_iter().enumerate() {
        let context = ToolContext::new(kcoder_state::AppState::new(&root));
        let source_input = serde_json::from_value(input.clone())?;
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(65),
            runtime.execute(source_input, &context),
        )
        .await;
        let (response, error) = match response {
            Ok(Ok(response)) => (Some(response), None),
            Ok(Err(_)) => (None, Some("native_runtime_error")),
            Err(_) => (None, Some("outer_probe_timeout")),
        };
        let passed = response.as_ref().is_some_and(|response| {
            matches!(
                response.status,
                WebSearchStatus::Success | WebSearchStatus::Partial | WebSearchStatus::Empty
            ) && response.provider == Some(WebSearchProvider::Exa)
        });
        results.push(
            json!({"case":index+1,"input":input,"response":response,"error":error,"passed":passed}),
        );
    }
    let passed = results.iter().all(|result| result["passed"] == true);
    println!(
        "{}",
        json!({"schemaVersion":1,"modelCalls":0,"logicalRequests":3,"searchKeyUsed":false,"searchSettingsDeclared":false,"scope":"Anonymous advanced source contracts and native strict filtering; not model quality or installer acceptance","cases":results,"passed":passed})
    );
    anyhow::ensure!(
        passed,
        "At least one public constraint probe did not produce a valid native response"
    );
    Ok(())
}
