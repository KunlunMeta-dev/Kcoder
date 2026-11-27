//! ACP v1 boundary for clients launching KCoder over standard input/output.
//!
//! The bounded framing layer uses the pinned SDK wire types. Session execution
//! is delegated to an owned KCoder app-server, never a second model loop.

mod connection;
mod diagnostics;
mod failures;
mod framing;
mod input;
mod mcp;
mod native_binding;
mod permissions;
mod projection;
mod queue;
mod sessions;
mod upstream;

pub use connection::{AgentInfo, serve};
pub use failures::native_receiver_bind_diagnostic;
pub use projection::TurnProjection;
pub use upstream::AppServerConfig;

pub mod outbound;
