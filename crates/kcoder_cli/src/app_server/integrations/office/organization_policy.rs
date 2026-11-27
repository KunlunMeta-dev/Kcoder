//! Office consumes the shared owner-bound resource policy.
pub(super) use super::super::resource_policy::*;

pub(in crate::app_server) use super::super::resource_policy::authorize_action as authorize_office_action;
