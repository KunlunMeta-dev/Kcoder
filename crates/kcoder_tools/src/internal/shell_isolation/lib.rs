//! Sandbox policy and platform isolation for Shell tool processes.

#[path = "../../os_sandbox.rs"]
pub mod os_sandbox;
#[path = "../../sandbox.rs"]
pub mod sandbox;
#[path = "../../shell_snapshot.rs"]
pub mod shell_snapshot;
// Only the Unix shell snapshot fixtures spawn helper executables.
#[cfg(all(test, unix))]
#[path = "../../test_executable.rs"]
mod test_executable;
#[cfg(windows)]
#[path = "../../windows_sandbox.rs"]
pub mod windows_sandbox;
