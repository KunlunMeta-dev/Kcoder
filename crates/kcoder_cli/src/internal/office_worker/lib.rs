//! Office subprocess adapters using paths and authority supplied by the host.

#[path = "installed_resources.rs"]
pub mod installed_resources;
#[path = "../../app_server/integrations/office/node_generator.rs"]
pub mod node_generator;
#[path = "../../app_server/integrations/office/read_worker/mod.rs"]
pub mod read_worker;
