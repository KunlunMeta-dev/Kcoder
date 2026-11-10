//! One native infrastructure process per original scope. No service permission
//! is obtained from this bootstrap, its paths, an OS task or a "ready" receipt.
mod adapter;
pub(crate) use kcoder_native_service_runtime::scope_host::bootstrap;
pub(crate) mod frontend;
pub(super) mod launch {
    pub use kcoder_native_journal::service_host_launch::{OriginalScopeHostLaunch, task_reference};

    #[cfg(all(test, target_os = "linux"))]
    #[path = "tests.rs"]
    mod tests;
}
pub(crate) mod task_frontend;
pub(crate) use bootstrap::NativeScopeHostBootstrap;
