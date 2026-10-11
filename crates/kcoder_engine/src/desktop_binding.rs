//! Explicit host binding for one authorized desktop turn. Cloned engines share
//! revocation; new engines and independently constructed subagents start empty.
use super::QueryEngine;
use kcoder_tools::ToolContext;
use kcoder_types::computer_use::DesktopOwner;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Default)]
pub(super) struct DesktopBindings(Arc<Mutex<Option<Binding>>>);
struct Binding {
    owner: DesktopOwner,
    active: Arc<AtomicBool>,
}

/// Drop revokes both future contexts and already-issued contexts. Host must also
/// await the desktop session's stop receipt; revocation alone does not kill input.
pub struct DesktopTurnGuard {
    bindings: DesktopBindings,
    active: Arc<AtomicBool>,
}
#[derive(Clone)]
pub struct DesktopTurnRevoker(Arc<AtomicBool>);
impl DesktopTurnRevoker {
    pub fn revoke(&self) {
        self.0.store(false, Ordering::Release);
    }
}
impl DesktopTurnGuard {
    pub fn revoker(&self) -> DesktopTurnRevoker {
        DesktopTurnRevoker(self.active.clone())
    }
}
impl Drop for DesktopTurnGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        if let Ok(mut current) = self.bindings.0.lock()
            && current
                .as_ref()
                .is_some_and(|binding| Arc::ptr_eq(&binding.active, &self.active))
        {
            *current = None;
        }
    }
}
impl DesktopBindings {
    fn bind(&self, owner: DesktopOwner) -> Result<DesktopTurnGuard, &'static str> {
        let mut current = self.0.lock().map_err(|_| "desktop binding unavailable")?;
        if current.is_some() {
            return Err("desktop turn already bound");
        }
        let active = Arc::new(AtomicBool::new(true));
        *current = Some(Binding {
            owner,
            active: active.clone(),
        });
        Ok(DesktopTurnGuard {
            bindings: self.clone(),
            active,
        })
    }
    pub(super) fn apply(&self, context: ToolContext) -> ToolContext {
        let Ok(current) = self.0.lock() else {
            return context;
        };
        match current.as_ref() {
            Some(binding) => {
                context.with_revocable_desktop_owner(binding.owner.clone(), binding.active.clone())
            }
            None => context,
        }
    }
}
impl QueryEngine {
    /// The owning app-server must obtain permission and a matching DesktopSession
    /// before calling this. No model-facing Config/tool can create this binding.
    pub fn bind_desktop_turn(&self, owner: DesktopOwner) -> Result<DesktopTurnGuard, &'static str> {
        if owner.thread_id != self.state.session_id()
            || owner.client_instance.is_empty()
            || owner.turn_id.is_empty()
        {
            return Err("desktop owner does not match engine session");
        }
        self.desktop_binding.bind(owner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dropping_guard_revokes_existing_contexts_and_allows_next_turn() {
        let state = kcoder_state::AppState::new(std::env::temp_dir());
        let owner = DesktopOwner {
            client_instance: "client".into(),
            thread_id: state.session_id(),
            turn_id: "first".into(),
        };
        let bindings = DesktopBindings::default();
        let guard = bindings.bind(owner.clone()).unwrap();
        let context = bindings.apply(ToolContext::new(state.clone()));
        assert!(context.authorizes_desktop_owner(&owner));
        assert!(bindings.bind(owner.clone()).is_err());
        guard.revoker().revoke();
        assert!(!context.authorizes_desktop_owner(&owner));
        drop(guard);
        assert!(!context.authorizes_desktop_owner(&owner));
        let mut next = owner;
        next.turn_id = "next".into();
        let _next = bindings.bind(next.clone()).unwrap();
        let next_context = bindings.apply(ToolContext::new(state));
        assert!(next_context.authorizes_desktop_owner(&next));
        assert!(!context.authorizes_desktop_owner(&next));
    }
}
