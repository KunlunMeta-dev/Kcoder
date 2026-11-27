//! External editor, suspension, and terminal-aware actions.

use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_user_action_with_terminal<B: Backend + Write>(
    action: UserAction,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    terminal: &mut Terminal<B>,
    terminal_guard: &mut TerminalGuard,
    terminal_events: &TerminalEventController,
    frame_requester: &FrameRequester,
) -> Result<bool> {
    match action {
        UserAction::Suspend => {
            suspend_tui_with_restored_terminal(
                terminal,
                terminal_guard,
                terminal_events,
                app,
                frame_requester,
            )
            .await?;
            Ok(false)
        }
        UserAction::OpenExternalEditor => {
            app.open_external_editor_with_restored_terminal(
                terminal,
                terminal_guard,
                terminal_events,
                frame_requester,
            )
            .await?;
            Ok(false)
        }
        UserAction::Quit => {
            draw_shutdown_feedback(terminal, app, terminal_guard)?;
            handle_user_action(UserAction::Quit, engine, app, tx, prompt).await
        }
        action => {
            let should_quit = handle_user_action(action, engine, app, tx, prompt).await?;
            if should_quit {
                draw_shutdown_feedback(terminal, app, terminal_guard)?;
            }
            Ok(should_quit)
        }
    }
}

#[cfg(unix)]
pub(super) async fn suspend_tui_with_restored_terminal<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    terminal_guard: &mut TerminalGuard,
    terminal_events: &TerminalEventController,
    app: &mut ReplApp,
    frame_requester: &FrameRequester,
) -> Result<()> {
    terminal_events.pause().await;
    let result = suspend_tui_inner(terminal, terminal_guard, app, frame_requester);
    flush_terminal_input_buffer();
    terminal_events.resume();
    result
}

#[cfg(unix)]
pub(super) fn suspend_tui_inner<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    terminal_guard: &mut TerminalGuard,
    app: &mut ReplApp,
    frame_requester: &FrameRequester,
) -> Result<()> {
    let suspend_cursor_y = terminal.viewport_area.y;
    terminal
        .reset_cursor_style()
        .context("failed to reset cursor style before suspend")?;
    let _ = terminal.show_cursor();
    std::io::Write::flush(terminal.backend_mut()).context("failed to flush before suspend")?;

    let restored_state = terminal_guard.restore_for_suspend();
    let restored_alternate_screen = restored_state.alternate_screen_enabled();
    crossterm::execute!(
        std::io::stdout(),
        crossterm::cursor::MoveTo(0, suspend_cursor_y),
        crossterm::cursor::Show
    )
    .context("failed to position cursor before suspend")?;

    let suspend_result = terminal_modes::suspend_current_process();
    let reenter_result = terminal_guard
        .reenter_after_external_program(restored_state)
        .and_then(|_| terminal_modes::reapply_raw_mode_after_resume())
        .context("failed to re-enter KCoder terminal after suspend");

    if restored_alternate_screen {
        if let Ok(size) = terminal.size() {
            terminal.set_viewport_area(Rect::new(0, 0, size.width.max(1), size.height.max(1)));
        }
        terminal.clear().context("failed to clear after suspend")?;
    } else if let Ok(Some(position)) =
        terminal_probe::cursor_position(terminal_probe::DEFAULT_TIMEOUT)
    {
        terminal.set_viewport_area(Rect::new(0, position.y, 0, 0));
    } else {
        terminal.set_viewport_area(Rect::new(0, suspend_cursor_y, 0, 0));
    }

    terminal.invalidate_viewport();
    app.force_next_viewport_redraw();
    frame_requester.schedule_frame();
    suspend_result.and(reenter_result)
}

#[cfg(not(unix))]
pub(super) async fn suspend_tui_with_restored_terminal<B: Backend + Write>(
    _terminal: &mut Terminal<B>,
    _terminal_guard: &mut TerminalGuard,
    _terminal_events: &TerminalEventController,
    app: &mut ReplApp,
    _frame_requester: &FrameRequester,
) -> Result<()> {
    app.push_message(
        MessageRole::System,
        "Suspend is not supported on this platform.",
    );
    Ok(())
}

pub(super) fn draw_shutdown_feedback<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    terminal_guard: &TerminalGuard,
) -> Result<()> {
    app.show_shutdown_in_progress();
    let surface_mode = if terminal_guard.uses_alternate_screen() {
        TerminalSurfaceMode::Fullscreen
    } else {
        TerminalSurfaceMode::Inline
    };
    draw_kcoder_frame_with_mode(terminal, app, surface_mode).map(|_| ())
}
