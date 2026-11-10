//! Public configuration domains re-exported by the crate facade.
pub mod integrations;

mod permissions;
pub use permissions::*;
mod tui;
pub use tui::*;
mod provider;
pub use provider::*;
mod tools;
pub use tools::*;
mod memory;
pub use memory::*;
mod context;
pub use context::*;
mod extensions;
pub use extensions::*;
mod moa;
pub use moa::*;
mod goal;
pub use goal::*;
mod orchestration;
pub use orchestration::*;
mod continuous_work;
pub use continuous_work::*;
pub(super) mod defaults;

mod knowledge;
pub use knowledge::*;

mod web;
pub use web::*;

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
