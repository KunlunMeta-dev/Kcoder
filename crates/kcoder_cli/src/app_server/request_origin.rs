//! In-process transport provenance for an accepted turn.
//!
//! A public client frame, a scheduler dispatch, a desktop recovery, and a
//! native source ticket are distinct. No JSON field or request ID supplies
//! this value, and the value alone grants neither work nor source authority.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RequestOrigin {
    #[default]
    Unverified,
    ClientFrame,
    Automation,
    DesktopRecovery,
    NativeSource,
}

impl RequestOrigin {
    /// Classify only the branch selected by the connection owner. The caller
    /// must pass actual private scheduler/recovery state, never RPC fields.
    pub fn selected_by_owner(desktop_recovery: bool, automation: bool) -> Self {
        if desktop_recovery {
            Self::DesktopRecovery
        } else if automation {
            Self::Automation
        } else {
            Self::ClientFrame
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_and_scheduler_are_never_client_frames() {
        assert_eq!(RequestOrigin::default(), RequestOrigin::Unverified);
        assert_eq!(
            RequestOrigin::selected_by_owner(false, false),
            RequestOrigin::ClientFrame
        );
        assert_eq!(
            RequestOrigin::selected_by_owner(false, true),
            RequestOrigin::Automation
        );
        assert_eq!(
            RequestOrigin::selected_by_owner(true, true),
            RequestOrigin::DesktopRecovery
        );
        assert_eq!(
            RequestOrigin::selected_by_owner(true, false),
            RequestOrigin::DesktopRecovery
        );
    }
}
