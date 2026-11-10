//! Foreground turn event-loop implementation compiled behind an erased future.
#[path = "../../app_server/turn_requests/foreground_stream.rs"]
mod foreground_stream;
pub use foreground_stream::{
    ForegroundStream, emit_committed_user, explicit_turn_appended_user_message, pump,
};
