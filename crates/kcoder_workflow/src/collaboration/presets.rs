//! Role presets reuse executable Agent kinds; prompts never grant tools or paths.
use kcoder_types::workflow::WorkflowCollaborationRole;
use serde_json::{Value, json};
pub fn catalog() -> Value {
    json!({"version":1,"roles":[
        {"id":"researcher","agentType":"explore","writeAccess":"none","purpose":"Gather evidence from explicitly bound inputs"},
        {"id":"planner","agentType":"plan","writeAccess":"none","purpose":"Define the task structure and dependencies"},
        {"id":"writer","agentType":"implementer","writeAccess":"explicit_scopes","purpose":"Create real scoped artifacts and verify their requirements"},
        {"id":"reviewer","agentType":"review","writeAccess":"none","purpose":"Review supplied evidence and identify gaps"},
        {"id":"verifier","agentType":"verifier","writeAccess":"none","purpose":"Independently check results after original writers and file observations"}
    ],"modelModes":["inherit_current","explicit"],"writeOrdering":"original_dag_topological_serialization","execution":"saved_native_workflow_only"})
}
pub fn default_instructions(role: WorkflowCollaborationRole) -> &'static str {
    match role {
        WorkflowCollaborationRole::Researcher => {
            "Research only the supplied scope. Separate evidence from assumptions and provide exact source references."
        }
        WorkflowCollaborationRole::Planner => {
            "Plan from the supplied inputs. Declare constraints, dependencies and measurable acceptance criteria."
        }
        WorkflowCollaborationRole::Writer => {
            "Produce the declared artifacts inside the explicitly allowed paths. Use real file tools and report missing prerequisites honestly."
        }
        WorkflowCollaborationRole::Reviewer => {
            "Review the supplied results and evidence without modifying files. Identify unsupported claims, errors and unresolved questions."
        }
        WorkflowCollaborationRole::Verifier => {
            "Independently inspect the original inputs, completed member results and native file observations. Verify each criterion; do not accept an author's self-reported success."
        }
    }
}
