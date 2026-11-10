//! The CLI's original session history selection and mode gates.
use anyhow::{Result, bail};
use kcoder_config::Settings;
use kcoder_state::AppState;
use std::path::PathBuf;

pub fn history_dir_for_session(settings: &Settings, cwd: &std::path::Path) -> Result<PathBuf> {
    if settings.history_directory.is_some() || std::env::var_os("KCODER_HISTORY_DIR").is_some() {
        settings.history_dir()
    } else {
        Settings::project_data_dir(cwd)
    }
}

pub fn history_dirs_for_read(settings: &Settings, cwd: &std::path::Path) -> Result<Vec<PathBuf>> {
    if settings.history_directory.is_some() || std::env::var_os("KCODER_HISTORY_DIR").is_some() {
        return settings.history_dir().map(|dir| vec![dir]);
    }
    Settings::project_data_dirs_for_read(cwd)
}

pub fn apply_cli_orchestrate_mode(state: &AppState, requested: bool, resumed: bool) -> Result<()> {
    if !requested {
        return Ok(());
    }
    if resumed && state.session_mode().is_default() {
        bail!(
            "cannot combine --orchestrate with a resumed default session; start a new session or resume an existing Orchestrate session without the flag"
        );
    }
    if state.session_mode().is_orchestrate() {
        return Ok(());
    }
    state.enter_orchestrate_before_first_message()?;
    Ok(())
}

pub fn resolve_resume_history_path(
    settings: &Settings,
    cwd: &std::path::Path,
    resume: &str,
) -> Result<PathBuf> {
    let history_dirs = history_dirs_for_read(settings, cwd)?;
    if resume == "latest" {
        let mut sessions = Vec::new();
        for history_dir in &history_dirs {
            sessions.extend(kcoder_state::recent_sessions(history_dir, 1)?);
        }
        sessions.sort_by_key(|(_, path, _)| {
            std::fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        return sessions
            .last()
            .map(|(_, path, _)| path.clone())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "no sessions found in {}",
                    history_dirs
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            });
    }
    for history_dir in &history_dirs {
        let direct = history_dir.join(format!(
            "{}.jsonl",
            kcoder_state::artifact_id_path_component(resume)
        ));
        if direct.is_file() {
            return Ok(direct);
        }
    }
    let mut sessions = Vec::new();
    for history_dir in &history_dirs {
        sessions.extend(kcoder_state::recent_sessions(history_dir, 100)?);
    }
    let matches: Vec<_> = sessions
        .iter()
        .filter(|(id, _, _)| id.starts_with(resume))
        .collect();
    match matches.len() {
        1 => Ok(matches[0].1.clone()),
        0 => anyhow::bail!(
            "no session matching '{resume}' in {}",
            history_dirs
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        n => anyhow::bail!("session prefix '{resume}' is ambiguous ({n} matches)"),
    }
}

pub fn configure_history_path(settings: &Settings, state: &AppState) {
    if settings.history_enabled
        && let Ok(history_dir) = history_dir_for_session(settings, &state.cwd())
    {
        let session_id = state.session_id();
        let history_path = history_dir.join(format!(
            "{}.jsonl",
            kcoder_state::artifact_id_path_component(&session_id)
        ));
        state.with_history_path(history_path);
    }
}
