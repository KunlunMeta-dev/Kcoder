//! Native budget facts and durable escrow. Serialized observations never grant admission.
mod model;
mod storage;
#[cfg(test)]
mod tests;
pub use model::*;
pub use storage::{NativeBudgetStore, NativeBudgetTaskParent};
