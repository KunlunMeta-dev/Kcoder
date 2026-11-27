//! core integration domain. Its provider is registered by the host.
pub mod budgets;
pub mod operation_store;
pub use operation_store::{
    IntegrationOperationBegin, IntegrationOperationStore, IntegrationOperationUpdate,
};

pub mod remote_delegations;
pub mod service_leases;
