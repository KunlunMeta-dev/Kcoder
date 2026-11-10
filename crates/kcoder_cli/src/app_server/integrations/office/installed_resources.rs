//! Native Office installation resources for the App Server.

pub(crate) use kcoder_office_worker::installed_resources::{
    NativeOfficeLaunchAuthority, NativeOfficeRetainedScopeResources, NativeOfficeRuntimeAuthority,
    OfficeNodeRuntimeMode,
};

#[cfg(test)]
#[path = "installed_resources_tests.rs"]
mod tests;
