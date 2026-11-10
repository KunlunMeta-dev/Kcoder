//! Restore persistent session state and enforce project boundaries.

use super::*;

pub(crate) fn resume_session_from_history_path(
    path: &Path,
    engine: &QueryEngine,
    app: &mut ReplApp,
) {
    if app.has_cancelled_input_barrier() {
        app.show_cancelled_input_notice();
        return;
    }
    if app
        .input_admission
        .as_ref()
        .is_some_and(|admission| admission.observer.is_some())
    {
        app.push_message(
            MessageRole::System,
            "An input is still being saved. Wait before opening another session.",
        );
        return;
    }
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
        match transcript_history
            .load_entries_range(
                visible_count.saturating_sub(RESUME_TRANSCRIPT_INITIAL_MESSAGES)..visible_count,
            )
            .map(|entries| {
                (
                    visible_count.saturating_sub(RESUME_TRANSCRIPT_INITIAL_MESSAGES),
                    web_sources::messages_for_entries(entries),
                )
            }) {
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
        match transcript_history
            .load_entries_range(0..visible_count)
            .map(web_sources::messages_for_entries)
        {
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

    if !app.can_replace_input_owner() {
        app.push_message(
            MessageRole::System,
            "Previous inputs are still being reconciled. Wait before opening another session.",
        );
        return;
    }
    app.cancel_preparing_inputs();
    if let Some(owner) = app.input_session_owner.clone() {
        app.cancel_side_questions_for(&owner);
    }
    match engine.apply_prepared_session_resume_with_lifecycle(prepared_resume) {
        Ok((_count, owner)) => {
            app.install_input_owner(owner);
            app.refresh_engine_metadata(engine);
            if defer_earlier_transcript {
                app.replace_transcript_from_resumed_tail(
                    &visible_messages,
                    transcript_history,
                    loaded_start,
                );
                app.append_history_web_sources(&visible_messages);
            } else {
                app.replace_web_history(&visible_messages);
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
