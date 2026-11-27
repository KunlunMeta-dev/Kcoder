//! Collaboration definitions compile into the existing native graph/runtime.
mod compiler;
mod contracts;
pub mod presets;
mod validation;
pub use compiler::compile;
pub use validation::{validate_definition, validate_node};

#[cfg(test)]
mod tests;

/// Validate declarations only; actual filesystem permissions remain native.
pub fn validate_relative_artifact_path(path: &str) -> anyhow::Result<()> {
    contracts::relative_path(path)
}
