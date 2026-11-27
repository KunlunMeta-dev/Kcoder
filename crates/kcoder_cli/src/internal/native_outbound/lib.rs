//! Original accepted-turn outgoing Native execution and reconciliation adapters.
// Self-contained regressions run in this crate's libtest. Regressions that need
// CLI runtime fixtures run in `kcoder_cli_runtime` against this compiled code
// through the `test-oracle` feature.
pub mod app_server {
    pub use kcoder_host_transport::task_spawn;
    pub mod integrations {
        pub mod core {
            pub use kcoder_native_journal::{NativeOperations, budget_host};
            pub use kcoder_native_scope::{
                NativeDomain, NativeDomainGuard, NativeIntegrationContext,
            };
            pub mod runtime_driver {
                pub use kcoder_runtime_driver::{NativeRuntimeDriver, RuntimeExternalSend};
            }
            pub mod remote_delegations;
        }
    }
}
pub use app_server::integrations::core::remote_delegations::*;
