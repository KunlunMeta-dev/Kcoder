//! Original native organization budgets and Workflow provenance for model admission.

#[path = "../../app_server/integrations/core/organization_model.rs"]
mod organization_model;
#[path = "remote_receiver.rs"]
pub mod remote_receiver;
#[path = "workflow_origin.rs"]
pub mod workflow_origin;

pub use organization_model::{install, validate_model_input};
