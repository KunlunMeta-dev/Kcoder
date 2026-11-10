//! Sandbox policy and platform isolation for Shell tool processes.

#[path = "../../os_sandbox.rs"]
pub mod os_sandbox;
#[path = "../../sandbox.rs"]
pub mod sandbox;
#[path = "../../shell_snapshot.rs"]
pub mod shell_snapshot;
#[cfg(windows)]
#[path = "../../windows_sandbox.rs"]
pub mod windows_sandbox;
