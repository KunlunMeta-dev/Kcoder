//! KCoder integration wire contracts.

#[path = "../../integrations/host.rs"]
pub mod host;
#[path = "../../integrations/knowledge/mod.rs"]
pub mod knowledge;
#[path = "../../integrations/knowledge_host.rs"]
pub mod knowledge_host;
#[path = "../../integrations/knowledge_settings.rs"]
pub mod knowledge_settings;
#[path = "../../integrations/model_policies.rs"]
mod model_policies;
#[path = "../../integrations/office/mod.rs"]
pub mod office;
#[path = "../../integrations/office_settings.rs"]
pub mod office_settings;
pub use model_policies::*;
#[path = "../../integrations/model_policy_settings.rs"]
mod model_policy_settings;
pub use model_policy_settings::*;
#[path = "../../integrations/remotes.rs"]
mod remotes;
pub use remotes::*;
#[path = "../../integrations/remote_operations.rs"]
mod remote_operations;
pub use remote_operations::*;
