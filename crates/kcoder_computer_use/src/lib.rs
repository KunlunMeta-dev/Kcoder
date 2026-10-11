//! Desktop control ownership and lifecycle, independent of Engine/UI.
//! The Windows host must authenticate its IPC peer, obtain permission and check
//! the interactive Session before calling `acquire_authorized`.
pub mod admission;
pub mod broker;
pub mod client;
pub mod connection;
pub mod desktop;
pub mod failure;
pub mod framing;
#[cfg(any(windows, test))]
mod input_health;
pub mod input_ownership;
pub mod launch;
pub mod packaged;
pub mod policy;
pub mod recovery_bootstrap;
pub mod runtime;
pub mod session;
#[cfg(windows)]
pub mod windows_clipboard;
#[cfg(windows)]
pub mod windows_clipboard_actor;
#[cfg(windows)]
pub mod windows_exclusive;
#[cfg(windows)]
pub mod windows_hotkey;
#[cfg(windows)]
pub mod windows_input_observer;
#[cfg(windows)]
pub mod windows_input_release;
#[cfg(windows)]
pub mod windows_peer;
#[cfg(windows)]
pub mod windows_pipe;
#[cfg(windows)]
pub mod windows_process;
#[cfg(windows)]
pub mod windows_recovery;
#[cfg(windows)]
pub mod windows_recovery_client;
#[cfg(windows)]
pub mod windows_recovery_task;
pub mod worker;

use kcoder_types::computer_use::{
    DesktopControlError as Error, DesktopControlState as State, DesktopLease, DesktopOwner,
};

struct ActiveLease {
    owner: DesktopOwner,
    lease: DesktopLease,
    request: Option<u64>,
    last_request: u64,
}

/// Place behind a host mutex. Cancellation uses this short-held state lock,
/// never the long-held MCP transport lock.
pub struct DesktopControl {
    state: State,
    generation: u64,
    active: Option<ActiveLease>,
    completed_stop: Option<(DesktopOwner, DesktopLease)>,
}

impl Default for DesktopControl {
    fn default() -> Self {
        Self {
            state: State::Unavailable,
            generation: 0,
            active: None,
            completed_stop: None,
        }
    }
}

impl DesktopControl {
    pub fn state(&self) -> State {
        self.state
    }

    /// Host preflight succeeded and no prior worker remains capable of input.
    pub fn ready_after_preflight(&mut self) -> Result<(), Error> {
        if self.active.is_some() {
            return Err(Error::DesktopBusy);
        }
        self.completed_stop = None;
        self.state = State::Ready;
        Ok(())
    }

    pub fn acquire_authorized(&mut self, owner: DesktopOwner) -> Result<DesktopLease, Error> {
        if owner.client_instance.is_empty()
            || owner.thread_id.is_empty()
            || owner.turn_id.is_empty()
        {
            return Err(Error::LeaseRevoked);
        }
        if let Some(active) = &self.active {
            if self.state == State::Active && active.owner == owner {
                return Ok(active.lease.clone());
            }
            return Err(Error::DesktopBusy);
        }
        if self.state != State::Ready {
            return Err(Error::DesktopUnavailable);
        }
        self.generation = self.generation.checked_add(1).ok_or(Error::LeaseRevoked)?;
        let lease = DesktopLease {
            id: uuid::Uuid::new_v4().to_string(),
            generation: self.generation,
        };
        self.active = Some(ActiveLease {
            owner,
            lease: lease.clone(),
            request: None,
            last_request: 0,
        });
        self.state = State::Active;
        Ok(lease)
    }

    fn owned(
        &mut self,
        owner: &DesktopOwner,
        lease: &DesktopLease,
    ) -> Result<&mut ActiveLease, Error> {
        self.active
            .as_mut()
            .filter(|active| active.owner == *owner && active.lease == *lease)
            .ok_or(Error::LeaseRevoked)
    }

    pub fn begin_action(
        &mut self,
        owner: &DesktopOwner,
        lease: &DesktopLease,
        request: u64,
    ) -> Result<(), Error> {
        if self.state != State::Active {
            return Err(Error::LeaseRevoked);
        }
        let active = self.owned(owner, lease)?;
        if active.request.is_some() {
            return Err(Error::OperationBusy);
        }
        if request <= active.last_request {
            return Err(Error::StaleResponse);
        }
        active.last_request = request;
        active.request = Some(request);
        Ok(())
    }

    /// Returns false after cancellation: a late observation may not reactivate a turn.
    pub fn finish_action(
        &mut self,
        owner: &DesktopOwner,
        lease: &DesktopLease,
        request: u64,
    ) -> Result<bool, Error> {
        let active = self.owned(owner, lease)?;
        if active.request != Some(request) {
            return Err(Error::StaleResponse);
        }
        active.request = None;
        Ok(self.state == State::Active)
    }

    pub fn request_stop(
        &mut self,
        owner: &DesktopOwner,
        lease: &DesktopLease,
    ) -> Result<(), Error> {
        if self.state == State::Unavailable
            && self
                .completed_stop
                .as_ref()
                .is_some_and(|(previous_owner, previous_lease)| {
                    previous_owner == owner && previous_lease == lease
                })
        {
            return Ok(());
        }
        self.owned(owner, lease)?;
        self.state = State::Stopping;
        Ok(())
    }

    pub(crate) fn lease_for_owner(&self, owner: &DesktopOwner) -> Option<DesktopLease> {
        self.active
            .as_ref()
            .filter(|active| active.owner == *owner)
            .map(|active| active.lease.clone())
    }

    pub fn disconnected(&mut self, client_instance: &str) -> bool {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.owner.client_instance == client_instance)
        {
            self.state = State::Stopping;
            true
        } else {
            false
        }
    }

    /// Must only follow an observed worker exit, not a timer or dropped socket.
    /// Host restart/preflight is separately required before accepting another owner.
    pub fn confirm_worker_stopped(&mut self, lease: &DesktopLease) -> Result<(), Error> {
        if self
            .active
            .as_ref()
            .is_none_or(|active| active.lease != *lease)
        {
            return Err(Error::LeaseRevoked);
        }
        let active = self.active.take().ok_or(Error::LeaseRevoked)?;
        self.completed_stop = Some((active.owner, active.lease));
        self.state = State::Unavailable;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn owner(thread: &str) -> DesktopOwner {
        DesktopOwner {
            client_instance: "client".into(),
            thread_id: thread.into(),
            turn_id: "turn".into(),
        }
    }
    #[test]
    fn ownership_is_exclusive_across_threads_and_no_action_runs_after_stop() {
        let mut control = DesktopControl::default();
        control.ready_after_preflight().unwrap();
        let a = owner("a");
        let b = owner("b");
        let lease = control.acquire_authorized(a.clone()).unwrap();
        assert_eq!(
            control.acquire_authorized(b.clone()),
            Err(Error::DesktopBusy)
        );
        assert_eq!(
            control.begin_action(&b, &lease, 1),
            Err(Error::LeaseRevoked)
        );
        control.begin_action(&a, &lease, 1).unwrap();
        assert_eq!(
            control.begin_action(&a, &lease, 2),
            Err(Error::OperationBusy)
        );
        control.request_stop(&a, &lease).unwrap();
        assert_eq!(control.finish_action(&a, &lease, 1), Ok(false));
        assert_eq!(
            control.begin_action(&a, &lease, 2),
            Err(Error::LeaseRevoked)
        );
        assert_eq!(control.ready_after_preflight(), Err(Error::DesktopBusy));
        assert_eq!(
            control.acquire_authorized(b.clone()),
            Err(Error::DesktopBusy)
        );
        control.confirm_worker_stopped(&lease).unwrap();
        assert_eq!(
            control.acquire_authorized(b.clone()),
            Err(Error::DesktopUnavailable)
        );
        control.ready_after_preflight().unwrap();
        let next = control.acquire_authorized(b).unwrap();
        assert!(next.generation > lease.generation);
        assert_eq!(
            control.confirm_worker_stopped(&lease),
            Err(Error::LeaseRevoked)
        );
        assert_eq!(control.state(), State::Active);
    }
    #[test]
    fn repeated_stop_requires_exact_owner_and_confirmed_cleanup_receipt() {
        let mut control = DesktopControl::default();
        control.ready_after_preflight().unwrap();
        let a = owner("a");
        let lease = control.acquire_authorized(a.clone()).unwrap();
        control.request_stop(&a, &lease).unwrap();
        assert_eq!(control.state(), State::Stopping);
        control.confirm_worker_stopped(&lease).unwrap();
        for _ in 0..3 {
            control.request_stop(&a, &lease).unwrap();
        }
        assert_eq!(control.state(), State::Unavailable);
        assert_eq!(
            control.request_stop(&owner("b"), &lease),
            Err(Error::LeaseRevoked)
        );
        let mut forged = lease.clone();
        forged.generation += 1;
        assert_eq!(control.request_stop(&a, &forged), Err(Error::LeaseRevoked));
        assert_eq!(
            control.begin_action(&a, &lease, 2),
            Err(Error::LeaseRevoked)
        );
        control.ready_after_preflight().unwrap();
        let next = control.acquire_authorized(a.clone()).unwrap();
        assert_eq!(control.request_stop(&a, &lease), Err(Error::LeaseRevoked));
        assert_eq!(control.state(), State::Active);
        control.request_stop(&a, &next).unwrap();
    }

    #[test]
    fn duplicate_actions_and_disconnected_owners_cannot_replay_input() {
        let mut control = DesktopControl::default();
        control.ready_after_preflight().unwrap();
        let owner = owner("a");
        let lease = control.acquire_authorized(owner.clone()).unwrap();
        control.begin_action(&owner, &lease, 1).unwrap();
        assert_eq!(control.finish_action(&owner, &lease, 1), Ok(true));
        assert_eq!(
            control.begin_action(&owner, &lease, 1),
            Err(Error::StaleResponse)
        );
        assert!(!control.disconnected("another-client"));
        assert!(control.disconnected("client"));
        assert_eq!(
            control.begin_action(&owner, &lease, 2),
            Err(Error::LeaseRevoked)
        );
    }
}
