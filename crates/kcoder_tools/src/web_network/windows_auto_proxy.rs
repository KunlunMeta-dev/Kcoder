//! Windows PAC regression tests use the original ToolContext policy.

include!("windows_auto_proxy/implementation.rs");

#[cfg(test)]
#[path = "windows_auto_proxy/tests.rs"]
mod owned_pac_tests;
