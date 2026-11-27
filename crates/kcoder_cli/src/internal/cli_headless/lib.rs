//! Noninteractive execution for the CLI.

#[path = "../../headless.rs"]
mod headless;
#[path = "../../headless_interrupt.rs"]
mod headless_interrupt;
#[path = "../../headless_outcome.rs"]
mod headless_outcome;

pub use headless::run;
