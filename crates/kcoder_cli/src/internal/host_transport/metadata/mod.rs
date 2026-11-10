//! App Server capability advertisement and process observations.

#[path = "capabilities.rs"]
mod capabilities;
#[path = "negotiation.rs"]
mod negotiation;

pub use capabilities::server_capabilities;
pub use negotiation::{ClientOptIns, advertise_requested, advertise_thread_capabilities};

#[path = "../../../app_server/resources_processor.rs"]
pub mod resources_processor;
