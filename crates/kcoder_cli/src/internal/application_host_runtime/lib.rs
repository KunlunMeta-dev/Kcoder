//! Owned application host without Engine, tool execution or client orchestration.
pub mod app_server {
    pub use kcoder_host_transport::native_component_parent;
    pub use kcoder_host_transport::task_spawn;
    pub use kcoder_native_service_runtime::scope_host::NativeScopeHostBootstrap;
    pub mod integrations {
        pub mod core {
            pub use kcoder_native_scope::*;
        }
        pub mod connectivity;
    }
}
pub use app_server::integrations::connectivity;
