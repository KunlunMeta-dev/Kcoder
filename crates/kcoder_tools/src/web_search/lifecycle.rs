//! Search ownership is the native context lifecycle, not the current State pointer.
use crate::{ToolContext, ToolError};
use kcoder_state::AppStateLifecycleIdentity;
use kcoder_types::TurnAttemptIdentity;
use std::sync::Arc;

pub(super) fn owner(ctx: &ToolContext) -> Result<AppStateLifecycleIdentity, ToolError> {
    let owner = ctx.web_resources.lifecycle_owner(&ctx.state)?;
    for identity in ctx
        .native_web_source_identity
        .iter()
        .chain(ctx.state.current_history_attempt_identity().iter())
    {
        if identity.validate().is_err() || identity.thread_id != ctx.state.session_id() {
            return Err(ToolError::Execution(
                "Search native identity does not match the actual State thread".into(),
            ));
        }
    }
    Ok(owner)
}

pub(super) fn identity(ctx: &ToolContext) -> Result<Option<TurnAttemptIdentity>, ToolError> {
    owner(ctx)?;
    Ok(ctx
        .state
        .current_history_attempt_identity()
        .or_else(|| ctx.native_web_source_identity.clone()))
}

pub(super) fn context(ctx: &ToolContext) -> Result<ToolContext, ToolError> {
    let owner = owner(ctx)?;
    let state = ctx.state.clone();
    let parent = ctx.web_dispatch_check.clone();
    Ok(ctx.clone().with_web_dispatch_check(Arc::new(move || {
        if !owner.matches(&state) {
            return Err(ToolError::Execution(
                "Search request owner lifecycle is no longer current".into(),
            ));
        }
        if let Some(check) = &parent {
            check()?;
        }
        Ok(())
    })))
}
