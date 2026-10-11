//! Automatic goal continuation and continuation-limit signaling.

use super::*;

pub(super) fn active_goal_for_continuation(engine: &QueryEngine) -> Option<Goal> {
    let goal = engine.state.goal()?;
    let final_text =
        kcoder_engine::goal_continuation::latest_assistant_text(&engine.state.messages());
    kcoder_engine::goal_continuation::plan_goal_continuation(
        engine.settings.read().unwrap().goal_enabled,
        &goal,
        final_text.as_deref(),
    )
    .map(|_| goal)
}

pub(super) fn active_goal_for_automatic_turn(engine: &QueryEngine) -> Option<Goal> {
    engine.state.goal().filter(|goal| goal.status.is_active())
}

pub(super) fn tui_goal_auto_continuation_limit_reached(
    engine: &QueryEngine,
    app: &ReplApp,
    goal: &Goal,
) -> bool {
    let limit = engine.settings.read().unwrap().goal_max_auto_continuations;
    let started = app
        .goal_auto_continuations_started
        .get(&goal.goal_id)
        .copied()
        .unwrap_or(0);
    kcoder_engine::goal_continuation::auto_continuation_limit_reached(limit, started)
}

#[cfg(unix)]
pub(super) const GOAL_AUTO_CONTINUATION_MARKER_FD_ENV: &str =
    "KCODER_GOAL_AUTO_CONTINUATION_MARKER_FD";

pub(super) fn goal_auto_continuation_notice_marker() -> String {
    #[cfg(unix)]
    {
        let descriptor = std::env::var(GOAL_AUTO_CONTINUATION_MARKER_FD_ENV)
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .filter(|descriptor| *descriptor > libc::STDERR_FILENO);
        if let Some(descriptor) = descriptor {
            return goal_auto_continuation_notice_marker_from_fd(descriptor);
        }
    }
    format_goal_auto_continuation_notice_marker(None)
}

#[cfg(unix)]
pub(super) fn goal_auto_continuation_notice_marker_from_fd(descriptor: i32) -> String {
    use std::os::fd::FromRawFd;

    // The harness explicitly inherits the descriptor through pass_fds. Take ownership
    // during TUI construction and close it immediately. Nonblocking reads ensure a forged
    // or damaged environment value cannot stall startup.
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return format_goal_auto_continuation_notice_marker(None);
    }
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return format_goal_auto_continuation_notice_marker(None);
    }
    // Duplicate before constructing File so this function exclusively owns a valid value passed to FromRawFd.
    let owned_descriptor = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 3) };
    if owned_descriptor < 0 {
        return format_goal_auto_continuation_notice_marker(None);
    }
    let _ = unsafe { libc::close(descriptor) };
    let mut file = unsafe { std::fs::File::from_raw_fd(owned_descriptor) };
    let flags = unsafe { libc::fcntl(owned_descriptor, libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(owned_descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return format_goal_auto_continuation_notice_marker(None);
    }
    let mut token = Vec::with_capacity(65);
    while token.len() < 65 {
        let mut chunk = [0_u8; 65];
        match file.read(&mut chunk[..65 - token.len()]) {
            Ok(0) => break,
            Ok(read) => token.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => return format_goal_auto_continuation_notice_marker(None),
        }
    }
    let token = String::from_utf8(token).ok();
    format_goal_auto_continuation_notice_marker(token.as_deref())
}

pub(super) fn format_goal_auto_continuation_notice_marker(token: Option<&str>) -> String {
    let token = token.filter(|token| {
        !token.is_empty()
            && token.len() <= 64
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    });
    match token {
        Some(token) => format!("[goal_auto_continuation_limit:{token}]"),
        None => "[goal_auto_continuation_limit]".to_string(),
    }
}

pub(super) fn emit_tui_goal_auto_continuation_limit_notice(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    goal: &Goal,
) {
    if app
        .goal_auto_continuation_limit_notices
        .contains(&goal.goal_id)
    {
        return;
    }
    let limit = engine.settings.read().unwrap().goal_max_auto_continuations;
    let marker = &app.goal_auto_continuation_notice_marker;
    if tx.send(AppEvent::SystemNotice(format!(
        "{marker} Goal auto-continuation limit reached ({limit}); goal remains active. Send a new instruction, clear the goal, or restart the process after reviewing its current state."
    ))) {
        app.goal_auto_continuation_limit_notices
            .insert(goal.goal_id.clone());
    }
}

pub(super) fn record_tui_goal_auto_continuation_start(
    engine: &QueryEngine,
    app: &mut ReplApp,
    goal: &Goal,
) -> Goal {
    let goal = engine
        .state
        .record_goal_continuation_start(&goal.goal_id)
        .unwrap_or_else(|| goal.clone());
    *app.goal_auto_continuations_started
        .entry(goal.goal_id.clone())
        .or_default() += 1;
    app.goal_auto_continuation_limit_notices
        .remove(&goal.goal_id);
    goal
}

pub(super) fn try_start_goal_continuation(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> bool {
    let Some(goal) = active_goal_for_continuation(engine) else {
        return false;
    };
    if tui_goal_auto_continuation_limit_reached(engine, app, &goal) {
        emit_tui_goal_auto_continuation_limit_notice(engine, app, tx, &goal);
        return false;
    }
    let final_text =
        kcoder_engine::goal_continuation::latest_assistant_text(&engine.state.messages());
    let Some(decision) = kcoder_engine::goal_continuation::plan_goal_continuation(
        true,
        &goal,
        final_text.as_deref(),
    ) else {
        return false;
    };
    if engine.state.session_mode().is_orchestrate() {
        match engine.claim_orchestrate_idle_continuation(
            kcoder_engine::orchestrate::continuation::IdleRequest {
                pending_question: app.pending_question.is_some(),
                cooldown_elapsed: true,
                ..Default::default()
            },
        ) {
            Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued {
                ..
            })
            | Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::NotApplicable)
            | Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
                reason: "no_incomplete_active_work",
                ..
            }) => {}
            Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
                reason,
                notify_once,
            }) => {
                if notify_once {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Orchestrate automatic continuation stopped ({reason}); the goal and work remain active for user review."
                    )));
                }
                return false;
            }
            Err(error) => {
                let _ = tx.send(AppEvent::SystemNotice(format!(
                    "Orchestrate continuation state could not be claimed: {error:#}"
                )));
                return false;
            }
        }
    }
    let goal = record_tui_goal_auto_continuation_start(engine, app, &goal);
    engine.state.add_message(Message::runtime_text(
        kcoder_engine::goal_continuation::format_goal_continuation_prompt(&goal, &decision),
    ));
    start_turn(engine, app, tx, prompt);
    true
}
