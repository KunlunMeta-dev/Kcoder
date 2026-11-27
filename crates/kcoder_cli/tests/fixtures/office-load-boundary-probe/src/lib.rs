//! The actual Office loader with actual Engine/types/supervisor dependencies.
//! Avoid code-generating the entire CLI unit-test binary for this load boundary.
#[path = "../../../../src/app_server/integrations/office/node_generator.rs"]
#[allow(dead_code)]
mod node_generator;
