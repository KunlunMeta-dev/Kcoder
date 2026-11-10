//! core integration domain. Its provider is registered by the host.

mod model_policies;
pub use model_policies::*;
mod channel_task_budget;
pub use channel_task_budget::ConfiguredChannelTaskBudget;
