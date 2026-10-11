//! Restore persistent session state and enforce project boundaries.

use super::*;

pub(crate) fn resume_session_from_history_path(
    path: &Path,
    engine: &QueryEngine,
    app: &mut ReplApp,
) {
    if !path.exists() {
        app.push_message(
            MessageRole::System,
            format!("Session history not found: {}", path.display()),
        );
        return;
    }

    let mut prepared_resume = match kcoder_state::prepare_session_resume(path) {
        Ok(value) => value,
        Err(error) => {
            app.push_message(
                MessageRole::System,
                format!("Failed to preflight session: {}", error),
            );
            return;
        }
    };
    if !prepared_resume.has_persisted_cwd()
        && !history_path_belongs_to_current_project(path, &engine.state.base_cwd())
    {
        app.push_message(
                MessageRole::System,
                format!(
                    "Session {} does not include working-directory metadata. To avoid running tools in the wrong project, start KCoder from that session's original directory and resume it there.",
                    path.display()
                ),
            );
        return;
    }

    if let Some(base_cwd) = prepared_resume.persisted_base_cwd()
        && !same_directory(base_cwd, &engine.cwd)
    {
        app.push_message(
            MessageRole::System,
            format!(
                "Session {} belongs to {}. Start KCoder from that directory before resuming it; this engine's tools, sandbox, skills, hooks, and memory are bound to {}.",
                path.display(),
                base_cwd.display(),
                engine.cwd.display(),
            ),
        );
        return;
    }

    let transcript_history = prepared_resume.take_transcript_history();
    let visible_count = transcript_history.len();
    let defer_earlier_transcript =
        app.fullscreen_surface && visible_count > RESUME_TRANSCRIPT_INITIAL_MESSAGES;
    let (loaded_start, visible_messages) = if defer_earlier_transcript {
        match transcript_history.load_tail(RESUME_TRANSCRIPT_INITIAL_MESSAGES) {
            Ok(tail) => tail,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to load resumed transcript tail: {error}"),
                );
                return;
            }
        }
    } else {
        match transcript_history.load_all() {
            Ok(messages) => (0, messages),
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to load resumed transcript: {error}"),
                );
                return;
            }
        }
    };

    match engine.apply_prepared_session_resume(prepared_resume) {
        Ok(_count) => {
            app.refresh_engine_metadata(engine);
            if defer_earlier_transcript {
                app.replace_transcript_from_resumed_tail(
                    &visible_messages,
                    transcript_history,
                    loaded_start,
                );
            } else {
                app.replace_transcript_from_history(&visible_messages);
            }
            app.reconcile_subagent_panels_from_engine(engine);
            app.push_message(
                MessageRole::System,
                format!(
                    "Resumed session from {} ({} messages).",
                    path.display(),
                    visible_count
                ),
            );
            app.snap_to_bottom();
        }
        Err(e) => {
            app.push_message(
                MessageRole::System,
                format!("Failed to resume session: {}", e),
            );
        }
    }
}

pub(super) fn same_directory(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left == right
}

pub(super) fn history_path_belongs_to_current_project(path: &Path, cwd: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(project_dirs) = Settings::project_data_dirs_for_read(cwd) else {
        return false;
    };
    project_dirs.iter().any(|dir| parent == dir)
}
