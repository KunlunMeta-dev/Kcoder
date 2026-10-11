//! Attach live capture and promote the same owned shell process to a background task.

use super::*;

pub(super) fn spawn_running_shell_background(
    ctx: &ToolContext,
    input: &BashInput,
    running: RunningShell,
    limits: OutputLimits,
) -> Result<String, ToolError> {
    let description = crate::background::tool_background_description(
        "bash",
        input.description.as_deref().unwrap_or(&input.command),
    );
    let command = input.command.clone();
    let cancel = running.cancel_callback();
    ctx.spawn_cancellable_background(
        description,
        async move {
            match running.wait_for_output(&command, limits).await {
                Ok(output) => output,
                Err(err) => ToolOutput::error(err.to_string()),
            }
        },
        cancel,
    )
}

pub(super) async fn attach_managed_output(
    ctx: &ToolContext,
    task_id: &str,
    capture: &LiveOutputCapture,
) {
    if let Some(path) = ctx.state.task(task_id).and_then(|task| task.output_path) {
        capture.attach(path).await;
    }
}
