//! `tool_execute` is the only route to a discovered capability: search never returns a tool
//! the request already attaches, so every discovery result is executed through this tool.

use kcoder_tools::Tool;
use kcoder_tools::tool_execute::ToolExecuteTool;
use kcoder_tools::tool_search::ToolSearchTool;

#[test]
fn discovery_tools_never_promise_directly_callable_search_results() {
    let search = ToolSearchTool.description();
    let execute = ToolExecuteTool.description();

    for (name, description) in [("tool_search", &search), ("tool_execute", &execute)] {
        assert!(
            !description.contains("already_available"),
            "{name} must not describe attached tools as notable search results: {description}"
        );
    }
    assert!(
        search.contains("already attached to this request are never returned"),
        "tool_search must state that attached tools are excluded: {search}"
    );
    assert!(
        search.contains("tool_execute"),
        "tool_search must name the deferred execution route: {search}"
    );
}
