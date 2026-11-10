//! Management RPC validation and policy-driven Knowledge domain handlers.

#[path = "../../app_server/integrations/knowledge/api.rs"]
pub mod api;
#[path = "../../app_server/integrations/knowledge/automation_api.rs"]
pub mod automation_api;
#[path = "../../app_server/integrations/knowledge/memory_api.rs"]
pub mod memory_api;
#[path = "../../app_server/integrations/knowledge/publication_api.rs"]
pub mod publication_api;

pub use api::{KnowledgeHostContext, KnowledgePolicyEvaluator, KnowledgeResource};
use kcoder_runtime_driver::business_templates;
