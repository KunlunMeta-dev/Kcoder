//! Native Office installation resources for the App Server.

#[cfg(test)]
pub(crate) use kcoder_office_worker::installed_resources::NativeOfficeRetainedScopeResources;
pub(crate) use kcoder_office_worker::installed_resources::{
    NativeOfficeLaunchAuthority, NativeOfficeRuntimeAuthority, OfficeNodeRuntimeMode,
};

#[cfg(test)]
#[path = "installed_resources_tests.rs"]
mod tests;
