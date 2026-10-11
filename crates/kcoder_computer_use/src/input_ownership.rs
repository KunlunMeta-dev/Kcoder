//! In-memory held-input ownership, not a keystroke log. The Windows observer
//! must classify only its worker's tagged injections as owned. External input
//! is retained only while held and is never included in cleanup requests.
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum InputControl {
    Key(u8),
    LeftMouse,
    RightMouse,
    MiddleMouse,
    X1Mouse,
    X2Mouse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InputRelease {
    pub control: InputControl,
    pub scan_code: u16,
    pub extended: bool,
    pub unicode: bool,
}

#[derive(Default)]
pub struct InputOwnership {
    external: BTreeSet<InputControl>,
    owned: BTreeMap<InputControl, (u64, InputRelease)>,
    sequence: u64,
    stopping: bool,
}
impl InputOwnership {
    /// Initialize from held input before starting the worker, then update from
    /// unowned down/up notifications. Never infer ownership from global state.
    pub fn external_transition(&mut self, control: InputControl, down: bool) {
        if down {
            self.external.insert(control);
        } else {
            self.external.remove(&control);
        }
    }
    /// Returns whether the observer should forward this worker's injection.
    pub fn owned_down(&mut self, release: InputRelease) -> bool {
        if self.stopping {
            return false;
        }
        if !self.external.contains(&release.control) && !self.owned.contains_key(&release.control) {
            self.sequence = self.sequence.saturating_add(1);
            self.owned.insert(release.control, (self.sequence, release));
        }
        true
    }
    /// Never allow a worker's up event to release an externally held input.
    pub fn owned_up(&mut self, control: InputControl) -> bool {
        self.owned.remove(&control);
        !self.external.contains(&control)
    }
    pub fn allow_owned_motion_or_wheel(&self) -> bool {
        !self.stopping
    }
    /// A replied tool error is recoverable only with no owned input held and
    /// no cleanup already underway. External physical keys are not ours to release.
    pub fn is_quiescent(&self) -> bool {
        !self.stopping && self.owned.is_empty()
    }
    /// Block late tagged downs/motion before requesting process termination.
    pub fn begin_stop(&mut self) {
        self.stopping = true;
    }
    /// Caller must first confirm worker process-tree exit. Returns releases in
    /// reverse press order, skipping controls another input source now holds.
    /// Planning alone does not acknowledge that OS release actually succeeded.
    pub fn releases_after_worker_exit(&mut self) -> Vec<InputRelease> {
        self.begin_stop();
        let mut held: Vec<_> = self
            .owned
            .values()
            .copied()
            .filter(|(_, input)| !self.external.contains(&input.control))
            .collect();
        held.sort_by_key(|(sequence, _)| std::cmp::Reverse(*sequence));
        held.into_iter().map(|(_, input)| input).collect()
    }
    /// Confirm only after a successful OS release. A failed/partial injection
    /// must retain the remaining entries; never clear ownership on intent alone.
    pub fn confirm_release(&mut self, input: InputRelease) -> bool {
        if !self.stopping
            || self
                .owned
                .get(&input.control)
                .is_none_or(|(_, held)| *held != input)
        {
            return false;
        }
        self.owned.remove(&input.control);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(value: u8) -> InputRelease {
        InputRelease {
            control: InputControl::Key(value),
            scan_code: 0,
            extended: false,
            unicode: false,
        }
    }
    #[test]
    fn quiescence_requires_no_owned_input_and_no_active_cleanup() {
        let mut state = InputOwnership::default();
        assert!(state.is_quiescent());
        state.external_transition(InputControl::Key(16), true);
        assert!(state.is_quiescent());
        state.owned_down(key(65));
        assert!(!state.is_quiescent());
        state.owned_up(InputControl::Key(65));
        assert!(state.is_quiescent());
        state.begin_stop();
        assert!(!state.is_quiescent());
    }
    #[test]
    fn preexisting_user_key_is_not_released_by_worker_or_cleanup() {
        let mut state = InputOwnership::default();
        state.external_transition(InputControl::Key(16), true);
        assert!(state.owned_down(key(16)));
        assert!(!state.owned_up(InputControl::Key(16)));
        assert!(state.releases_after_worker_exit().is_empty());
    }
    #[test]
    fn cleanup_only_releases_still_owned_inputs_in_reverse_press_order() {
        let mut state = InputOwnership::default();
        state.owned_down(key(17));
        state.owned_down(key(65));
        state.owned_down(key(65));
        state.owned_down(key(66));
        state.owned_up(InputControl::Key(66));
        assert_eq!(state.releases_after_worker_exit(), vec![key(65), key(17)]);
        assert!(state.confirm_release(key(65)));
        assert_eq!(state.releases_after_worker_exit(), vec![key(17)]);
        assert!(state.confirm_release(key(17)));
        assert!(state.releases_after_worker_exit().is_empty());
    }
    #[test]
    fn failed_release_retains_ownership_and_mismatched_receipt_cannot_clear_it() {
        let mut state = InputOwnership::default();
        state.owned_down(key(17));
        assert!(!state.confirm_release(key(17)));
        let attempt = state.releases_after_worker_exit();
        assert_eq!(attempt, vec![key(17)]);
        assert!(!state.confirm_release(InputRelease {
            extended: true,
            ..key(17)
        }));
        // Simulate a failed SendInput: no success receipt is delivered.
        assert_eq!(state.releases_after_worker_exit(), attempt);
        assert!(state.confirm_release(key(17)));
        assert!(state.releases_after_worker_exit().is_empty());
    }
    #[test]
    fn cancellation_blocks_late_input_and_preserves_user_mouse_press() {
        let mut state = InputOwnership::default();
        state.owned_down(InputRelease {
            control: InputControl::LeftMouse,
            ..key(0)
        });
        state.external_transition(InputControl::LeftMouse, true);
        state.begin_stop();
        assert!(!state.owned_down(key(17)));
        assert!(!state.allow_owned_motion_or_wheel());
        assert!(state.releases_after_worker_exit().is_empty());
    }
}
