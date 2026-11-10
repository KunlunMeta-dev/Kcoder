//! Office services. The host injects native authority and runtime providers.
mod dataset;
pub use dataset::{dataset_page, export_dataset};

mod projection;
pub use projection::{OfficeContextAssembler, append_context_projection, project_dataset};
mod native_projection;
pub use native_projection::{
    NativeCoreWorkflowOfficeChildCapability, NativeOfficeToolProjection,
    NativeOfficeToolProjectionAuthority, NativeOfficeToolProjectionRequest,
    OfficeNativeProjectionStats, office_tool_input_sha256, project_native_office_tool_inputs,
};
mod projection_authority;
pub use projection_authority::{OfficeNativeProjectionAuthority, OfficeProjectionScopeResolver};
mod request_projection;
mod service;
pub use service::{
    OfficeGeneratedFile, OfficeHost, OfficePublishedContent, OfficeService, OfficeSharedAssistant,
};
mod tool_backend;
pub use tool_backend::{OfficeNativeToolBackend, OfficeNativeToolOwner, OfficeToolOwnerResolver};
