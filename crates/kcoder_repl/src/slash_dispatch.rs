//! Slash command routing and path-token disambiguation.

use super::*;

pub(super) async fn handle_slash_command(
    command: &str,
    app: &mut ReplApp,
    engine: &QueryEngine,
) -> Option<UserAction> {
    let (cmd, args) = parse_slash_input(command);
    // Clone the Arc to avoid borrowing `app` while running the command.
    let registry = Arc::clone(&app.slash_registry);
    if let Some(cmd) = registry.get(cmd) {
        match cmd.run(args, app, engine).await {
            SlashResult::Quit => return Some(UserAction::Quit),
            SlashResult::Submit(text) => {
                return Some(UserAction::Submit(SubmittedMessage::text(text)));
            }
            SlashResult::SubmitWithDisplay {
                visible_text,
                model_text,
            } => {
                return Some(UserAction::Submit(SubmittedMessage::text_with_visible(
                    visible_text,
                    model_text,
                )));
            }
            SlashResult::StartCompact => return Some(UserAction::CompactConversation),
            SlashResult::StartSideQuestion(question) => {
                return Some(UserAction::StartSideQuestion(question));
            }
            SlashResult::StartMoaPlan(request) => {
                return Some(UserAction::StartMoaPlan(request));
            }
            SlashResult::Handled => {}
        }
    } else if slash_token_looks_like_path(cmd) {
        // The leading token is not a registered command but looks like a
        // filesystem path: the user is referring to a path (for example
        // "/tmp describe this project"), not invoking a command. Submit the input as a
        // normal message instead of rejecting it.
        return Some(UserAction::Submit(SubmittedMessage::text(
            command.to_string(),
        )));
    } else {
        app.push_message(
            MessageRole::System,
            format!(
                "Unknown command: {}. Type /help for available commands, or start the input with a space to send it as a message.",
                cmd
            ),
        );
    }
    None
}

/// True when an unrecognized `/token` looks like a filesystem path rather
/// than a mistyped command: it contains another path separator (`/data/x`),
/// or it exists as an absolute path on disk (`/tmp`).
pub(super) fn slash_token_looks_like_path(cmd: &str) -> bool {
    let body = cmd.strip_prefix('/').unwrap_or(cmd);
    if body.is_empty() {
        return false;
    }
    if body.contains('/') || body.contains('\\') {
        return true;
    }
    std::path::Path::new(cmd).exists()
}
