//! Native event frames are captured by the one real stream producer.
use super::{NativeToolAuthorizationError, NativeToolEmitterWitness, NativeToolExecutionWitness};
use crate::{EngineEvent, QueryEngine};
use kcoder_tools::ToolRegistry;
use std::sync::Arc;

/// An in-process producer frame, never a public event, grant or JSON actor label.
/// The original execution scope is retained when a collector has no task-local TI.
pub struct NativeEngineEventFrame {
    event: EngineEvent,
    output_boundaries: Vec<usize>,
    assistant_start: bool,
    execution: Arc<NativeToolExecutionWitness>,
    tool: Option<NativeToolEmitterWitness>,
    registry: Option<ToolRegistry>,
}
impl NativeEngineEventFrame {
    pub fn event(&self) -> &EngineEvent {
        &self.event
    }
    pub fn model_output_fragment_count(&self) -> usize {
        match self.event {
            EngineEvent::AssistantTextDelta(_) | EngineEvent::AssistantThinkingDelta(_) => {
                self.output_boundaries.len() + 1
            }
            _ => 0,
        }
    }
    pub fn execution(&self) -> &NativeToolExecutionWitness {
        self.tool
            .as_ref()
            .map_or(&self.execution, NativeToolEmitterWitness::execution)
    }
    pub fn tool(&self) -> Option<&NativeToolEmitterWitness> {
        self.tool.as_ref()
    }
    pub fn has_tool_identity(&self) -> bool {
        tool_name(&self.event).is_some()
    }
    pub(crate) fn into_event(self) -> EngineEvent {
        self.event
    }
    pub(crate) fn with_output_boundaries(mut self, boundaries: Vec<usize>) -> Self {
        self.output_boundaries = boundaries;
        self
    }
    pub(crate) fn with_assistant_start(mut self, started: bool) -> Self {
        debug_assert!(!started || self.model_output_fragment_count() > 0);
        self.assistant_start = started;
        self
    }
    pub(crate) fn starts_assistant_message(&self) -> bool {
        self.assistant_start || matches!(self.event, EngineEvent::AssistantMessageStarted)
    }
    /// Publish original transport fragments only after the complete emitter
    /// frame has passed current native authorization.
    pub(crate) fn for_each_output(&self, mut publish: impl FnMut(&EngineEvent)) {
        if self.assistant_start {
            publish(&EngineEvent::AssistantMessageStarted);
        }
        if self.output_boundaries.is_empty() {
            publish(&self.event);
            return;
        }
        let (text, make): (&String, fn(String) -> EngineEvent) = match &self.event {
            EngineEvent::AssistantTextDelta(text) => (text, EngineEvent::AssistantTextDelta),
            EngineEvent::AssistantThinkingDelta(text) => {
                (text, EngineEvent::AssistantThinkingDelta)
            }
            _ => unreachable!("only contiguous model output carries fragment boundaries"),
        };
        let mut start = 0;
        for end in self
            .output_boundaries
            .iter()
            .copied()
            .chain(std::iter::once(text.len()))
        {
            publish(&make(text[start..end].to_owned()));
            start = end;
        }
    }
    fn current(&self, engine: &QueryEngine) -> bool {
        self.execution().matches_engine_owner(engine)
            && match (&self.tool, &self.registry) {
                (Some(tool), Some(registry)) => {
                    tool.matches_registry(registry) && tool.tool().is_model_visible()
                }
                (None, None) => !self.has_tool_identity(),
                _ => false,
            }
    }
}
fn tool_name(event: &EngineEvent) -> Option<&str> {
    match event {
        EngineEvent::ToolUseStarted { name, .. }
        | EngineEvent::ToolExecutionStarted { name, .. }
        | EngineEvent::ToolInputProgress { name, .. }
        | EngineEvent::ToolResult { name, .. }
        | EngineEvent::ToolDenied { name, .. } => Some(name),
        _ => None,
    }
}
impl QueryEngine {
    #[cfg(test)]
    pub(crate) fn native_event_frame(
        &self,
        event: EngineEvent,
        registry: Option<&ToolRegistry>,
    ) -> NativeEngineEventFrame {
        self.native_event_frame_with_epoch(event, registry, &mut None)
    }
    pub(crate) fn native_event_frame_with_epoch(
        &self,
        event: EngineEvent,
        registry: Option<&ToolRegistry>,
        epoch: &mut Option<Arc<NativeToolExecutionWitness>>,
    ) -> NativeEngineEventFrame {
        if !epoch
            .as_ref()
            .is_some_and(|execution| execution.matches_current_engine(self))
        {
            *epoch = Some(Arc::new(self.native_tool_execution_witness()));
        }
        let execution = epoch.as_ref().expect("native epoch captured above").clone();
        let tool = tool_name(&event).and_then(|name| {
            let registry = registry?;
            let tool = registry.get(name)?;
            self.capture_native_tool_emitter_in_frame(registry, name, &tool, execution.clone())
                .ok()
        });
        let registry = tool.as_ref().and(registry).cloned();
        NativeEngineEventFrame {
            event,
            output_boundaries: Vec::new(),
            assistant_start: false,
            execution,
            tool,
            registry,
        }
    }
    pub(crate) async fn authorize_native_provider(
        &self,
    ) -> Result<(), NativeToolAuthorizationError> {
        let Some(authority) = &self.native_tool_authorization else {
            return Ok(());
        };
        let execution = self.native_tool_execution_witness();
        let result = tokio::time::timeout(
            // Native source admission already permits 30 seconds for the same
            // signed-policy and current SDK checks. Do not truncate that proof
            // to five seconds immediately before the actual model request.
            std::time::Duration::from_secs(30),
            authority.authorize_provider(&execution),
        )
        .await
        .unwrap_or_else(|_| {
            tracing::warn!(target: "kcoder_native_task_authority",
                source_guard_stage = "provider",
                source_guard_code = "NATIVE_PROVIDER_AUTHORIZATION_DEADLINE",
                "Native provider authorization did not finish within its original deadline"
            );
            Err(NativeToolAuthorizationError::Unavailable)
        });
        result?;
        if !execution.matches_current_engine(self) {
            return Err(NativeToolAuthorizationError::Denied);
        }
        Ok(())
    }
    pub(crate) async fn authorize_native_child_event(
        &self,
        parent: &QueryEngine,
        frame: &NativeEngineEventFrame,
    ) -> Result<(), NativeToolAuthorizationError> {
        let Some(authority) = &self.native_tool_authorization else {
            return Ok(());
        };
        // The actual child control and parent State are checked before consulting
        // policy. No collector task-local attempt is substituted for the producer.
        let current = || {
            frame.current(self)
                && frame.execution().parent().is_some_and(|witness| {
                    witness.matches_state(&parent.state)
                        && witness.session_id() == parent.session_id()
                        && parent.state.task(witness.agent_id()).is_some_and(|task| {
                            matches!(
                                task.status,
                                kcoder_types::TaskStatus::Pending
                                    | kcoder_types::TaskStatus::Running
                            ) && task.background_run.as_ref() == witness.background_run()
                        })
                })
                && frame.tool().is_none_or(|tool| {
                    self.native_tool_ceiling
                        .as_ref()
                        .is_none_or(|ceiling| ceiling.contains(tool.tool_name()))
                })
        };
        if !current() {
            return Err(NativeToolAuthorizationError::Denied);
        }
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            authority.authorize_event(frame),
        )
        .await
        .unwrap_or_else(|_| {
            tracing::warn!(target: "kcoder_native_task_authority",
                source_guard_stage = "event",
                source_guard_code = "NATIVE_CHILD_EVENT_AUTHORIZATION_DEADLINE",
                "Native child event authorization did not finish within its original deadline");
            Err(NativeToolAuthorizationError::Unavailable)
        })?;
        if !current() {
            return Err(NativeToolAuthorizationError::Denied);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
