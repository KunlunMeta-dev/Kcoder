//! Model-facing contracts built independently of tool execution.

// Each concrete input instantiates serde and schemars here.
macro_rules! builtin_input {
    ($($input:ident),+ $(,)?) => {$(
        impl $input {
            pub fn schema() -> serde_json::Value {
                crate::clean_schema(schemars::schema_for!($input))
            }

            pub fn parse(input: &serde_json::Value) -> Result<Self, kcoder_tool_error::ToolError> {
                crate::parse_input(input)
            }
        }
    )+};
}

#[path = "goal.rs"]
pub mod goal;
#[path = "skill_hub.rs"]
pub mod skill_hub;
#[path = "skill_manage.rs"]
pub mod skill_manage;
#[path = "task.rs"]
pub mod task;
#[path = "workflow.rs"]
pub mod workflow;
#[path = "workflow_draft.rs"]
pub mod workflow_draft;
