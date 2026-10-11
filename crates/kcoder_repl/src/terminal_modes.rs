use crate::custom_terminal::Terminal;
use crate::terminal_palette;
use crate::terminal_probe;
use anyhow::{Context, Result};
use crossterm::Command;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
};
use crossterm::terminal::{
    Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use kcoder_config::TuiAltScreenMode;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Position;
use std::fmt;
use std::io::{IsTerminal, Stdout, stdin, stdout};
use std::sync::Once;
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tracing::{debug, warn};

pub(crate) type KCoderTerminal = Terminal<CrosstermBackend<Stdout>>;

const TUI_ALTERNATE_SCREEN_DEFAULT: AltScreenMode = AltScreenMode::Auto;
const DISABLE_KEYBOARD_ENHANCEMENT_ENV_VAR: &str = "KCODER_TUI_DISABLE_KEYBOARD_ENHANCEMENT";
const NATIVE_SELECTION_ENV_VAR: &str = "KCODER_TUI_NATIVE_SELECTION";
const ALT_SCREEN_RUNTIME_UNSET: u8 = 0;
const ALT_SCREEN_RUNTIME_DISABLED: u8 = 1;
const ALT_SCREEN_RUNTIME_ENABLED: u8 = 2;
static TERMINAL_ALT_SCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);
static TERMINAL_ALT_SCREEN_RUNTIME_OVERRIDE: AtomicU8 = AtomicU8::new(ALT_SCREEN_RUNTIME_UNSET);
static TERMINAL_PANIC_HOOK: Once = Once::new();

/// Controls whether the TUI uses the terminal's alternate screen buffer.
///
/// KCoder defaults to taking over the full terminal buffer; `Never` is only the
/// legacy inline mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AltScreenMode {
    /// Select alternate screen mode automatically.
    Auto,
    /// Always use alternate screen mode.
    Always,
    /// Never use alternate screen; run legacy inline mode.
    Never,
}

impl From<TuiAltScreenMode> for AltScreenMode {
    fn from(mode: TuiAltScreenMode) -> Self {
        match mode {
            TuiAltScreenMode::Auto => Self::Auto,
            TuiAltScreenMode::Always => Self::Always,
            TuiAltScreenMode::Never => Self::Never,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EnableAlternateScroll;

impl Command for EnableAlternateScroll {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str("\x1b[?1007h")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "EnableAlternateScroll requires ANSI support",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DisableAlternateScroll;

impl Command for DisableAlternateScroll {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str("\x1b[?1007l")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "DisableAlternateScroll requires ANSI support",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResetKeyboardEnhancementFlags;

impl Command for ResetKeyboardEnhancementFlags {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str("\x1b[<u")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "ResetKeyboardEnhancementFlags requires ANSI support",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EnableModifyOtherKeys;

impl Command for EnableModifyOtherKeys {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str("\x1b[>4;2m")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "EnableModifyOtherKeys requires ANSI support",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DisableModifyOtherKeys;

impl Command for DisableModifyOtherKeys {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        f.write_str("\x1b[>4;0m")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> std::io::Result<()> {
        Err(std::io::Error::other(
            "DisableModifyOtherKeys requires ANSI support",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawModeRestore {
    Disable,
    Keep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyboardReportingRestore {
    PopStack,
    ResetAfterExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalStartupModeStep {
    BracketedPaste,
    AlternateScreen,
    MouseCapture,
    RawMode,
    KeyboardEnhancement,
    FocusChange,
}

#[cfg(test)]
fn parse_env_bool(value: Option<&str>, default: bool) -> bool {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return default;
    };

    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => default,
    }
}

fn parse_env_bool_override(value: Option<&str>) -> Option<bool> {
    let value = value.map(str::trim).filter(|value| !value.is_empty())?;
    match value.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn parse_alt_screen_mode(value: Option<&str>, default: AltScreenMode) -> AltScreenMode {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return default;
    };

    match value.to_ascii_lowercase().as_str() {
        "auto" => AltScreenMode::Auto,
        "always" => AltScreenMode::Always,
        "never" => AltScreenMode::Never,
        _ => parse_env_bool_override(Some(value)).map_or(default, |enabled| {
            if enabled {
                AltScreenMode::Always
            } else {
                AltScreenMode::Never
            }
        }),
    }
}

fn determine_alt_screen_mode(no_alt_screen: bool, mode: AltScreenMode) -> bool {
    if no_alt_screen {
        return false;
    }

    mode != AltScreenMode::Never
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn native_selection_enabled_for_env<F>(get_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    parse_env_bool_override(get_env(NATIVE_SELECTION_ENV_VAR).as_deref()).unwrap_or(false)
}

fn native_selection_enabled() -> bool {
    native_selection_enabled_for_env(&process_env)
}

fn resolve_tui_alternate_screen_for_env<F>(
    get_env: &F,
    no_alt_screen: bool,
    default_mode: AltScreenMode,
) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    determine_alt_screen_mode(
        no_alt_screen,
        parse_alt_screen_mode(get_env("KCODER_TUI_ALT_SCREEN").as_deref(), default_mode),
    )
}

pub(crate) fn configure_tui_alternate_screen(
    no_alt_screen: bool,
    alternate_screen: TuiAltScreenMode,
) {
    let resolved =
        resolve_tui_alternate_screen_for_env(&process_env, no_alt_screen, alternate_screen.into());
    TERMINAL_ALT_SCREEN_RUNTIME_OVERRIDE.store(
        if resolved {
            ALT_SCREEN_RUNTIME_ENABLED
        } else {
            ALT_SCREEN_RUNTIME_DISABLED
        },
        Ordering::SeqCst,
    );
}

fn configured_tui_alternate_screen() -> Option<bool> {
    match TERMINAL_ALT_SCREEN_RUNTIME_OVERRIDE.load(Ordering::SeqCst) {
        ALT_SCREEN_RUNTIME_DISABLED => Some(false),
        ALT_SCREEN_RUNTIME_ENABLED => Some(true),
        _ => None,
    }
}

fn keyboard_enhancement_disabled_for(
    disable_env: Option<&str>,
    is_wsl: bool,
    is_vscode_terminal: bool,
) -> bool {
    if let Some(disabled) = parse_env_bool_override(disable_env) {
        return disabled;
    }

    // VS Code running a WSL shell may hide TERM_PROGRAM from the Linux
    // environment, so runtime detection also probes the Windows-side
    // environment through WSL interop.
    is_wsl && is_vscode_terminal
}

fn keyboard_enhancement_disabled() -> bool {
    keyboard_enhancement_disabled_for(
        std::env::var(DISABLE_KEYBOARD_ENHANCEMENT_ENV_VAR)
            .ok()
            .as_deref(),
        running_in_wsl(),
        running_in_vscode_terminal(),
    )
}

#[cfg(test)]
fn keyboard_enhancement_disabled_for_env<F>(get_env: F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    let is_wsl = wsl_session_detected_from_env(&get_env);
    let is_vscode_terminal = vscode_terminal_detected(
        get_env("TERM_PROGRAM").as_deref(),
        get_env("WIN_TERM_PROGRAM").as_deref(),
    );
    keyboard_enhancement_disabled_for(
        get_env(DISABLE_KEYBOARD_ENHANCEMENT_ENV_VAR).as_deref(),
        is_wsl,
        is_vscode_terminal,
    )
}

#[cfg(any(target_os = "linux", test))]
fn wsl_session_detected_from_env<F>(get_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    get_env("WSL_DISTRO_NAME").is_some() || get_env("WSL_INTEROP").is_some()
}

#[cfg(any(target_os = "linux", test))]
fn proc_version_indicates_wsl(proc_version: &str) -> bool {
    let lower = proc_version.to_ascii_lowercase();
    lower.contains("microsoft") || lower.contains("wsl")
}

fn running_in_wsl() -> bool {
    #[cfg(target_os = "linux")]
    {
        wsl_session_detected_from_env(&|name| std::env::var(name).ok())
            || std::fs::read_to_string("/proc/version")
                .is_ok_and(|version| proc_version_indicates_wsl(&version))
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn term_program_is_vscode(value: Option<&str>) -> bool {
    value.is_some_and(|value| value.eq_ignore_ascii_case("vscode"))
}

fn vscode_terminal_detected(
    linux_term_program: Option<&str>,
    windows_term_program: Option<&str>,
) -> bool {
    term_program_is_vscode(linux_term_program) || term_program_is_vscode(windows_term_program)
}

fn windows_term_program() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        static WINDOWS_TERM_PROGRAM: OnceLock<Option<String>> = OnceLock::new();
        WINDOWS_TERM_PROGRAM
            .get_or_init(read_windows_term_program)
            .clone()
    }

    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(target_os = "linux")]
fn read_windows_term_program() -> Option<String> {
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "set TERM_PROGRAM"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            line.trim_end_matches('\r')
                .strip_prefix("TERM_PROGRAM=")
                .map(str::to_string)
        })
        .filter(|value| !value.trim().is_empty())
}

fn running_in_vscode_terminal() -> bool {
    vscode_terminal_detected(
        std::env::var("TERM_PROGRAM").ok().as_deref(),
        windows_term_program().as_deref(),
    )
}

fn tmux_session_detected<F>(get_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    get_env("TMUX").is_some() || get_env("TMUX_PANE").is_some()
}

fn tmux_should_enable_modify_other_keys_for(
    running_in_tmux_session: bool,
    extended_keys_format: Option<&str>,
) -> bool {
    running_in_tmux_session && matches!(extended_keys_format, Some("csi-u"))
}

fn read_tmux_extended_keys_format() -> Option<String> {
    for args in [
        ["display-message", "-p", "#{extended-keys-format}"],
        ["show-options", "-gqv", "extended-keys-format"],
    ] {
        let output = std::process::Command::new("tmux")
            .args(args)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;

        if !output.status.success() {
            continue;
        }

        if let Some(value) = String::from_utf8(output.stdout)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Some(value);
        }
    }

    None
}

fn tmux_should_enable_modify_other_keys() -> bool {
    tmux_should_enable_modify_other_keys_for(
        tmux_session_detected(&|name| std::env::var(name).ok()),
        read_tmux_extended_keys_format().as_deref(),
    )
}

fn enable_keyboard_enhancement() {
    if keyboard_enhancement_disabled() {
        return;
    }

    let _ = crossterm::execute!(
        stdout(),
        DisableModifyOtherKeys,
        PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
        )
    );

    if tmux_should_enable_modify_other_keys() {
        let _ = crossterm::execute!(stdout(), EnableModifyOtherKeys);
    }
}

fn zellij_multiplexer_detected_from_env<F>(get_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    get_env("ZELLIJ").is_some()
        || get_env("TERM_PROGRAM")
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("zellij"))
}

pub(crate) fn zellij_multiplexer_detected() -> bool {
    zellij_multiplexer_detected_from_env(&|name| std::env::var(name).ok())
}

fn tui_alternate_screen_enabled_for_env<F>(get_env: &F) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    resolve_tui_alternate_screen_for_env(get_env, false, TUI_ALTERNATE_SCREEN_DEFAULT)
}

pub(crate) fn tui_alternate_screen_enabled() -> bool {
    configured_tui_alternate_screen()
        .unwrap_or_else(|| tui_alternate_screen_enabled_for_env(&process_env))
}

fn terminal_startup_mode_steps(
    enter_alternate_screen: bool,
    native_selection_enabled: bool,
) -> Vec<TerminalStartupModeStep> {
    let mut steps = vec![TerminalStartupModeStep::BracketedPaste];
    if enter_alternate_screen {
        steps.push(TerminalStartupModeStep::AlternateScreen);
        if !native_selection_enabled {
            steps.push(TerminalStartupModeStep::MouseCapture);
        }
    }
    steps.extend([
        TerminalStartupModeStep::RawMode,
        TerminalStartupModeStep::KeyboardEnhancement,
        TerminalStartupModeStep::FocusChange,
    ]);
    steps
}

fn set_terminal_modes(enter_alternate_screen: bool) -> Result<()> {
    for step in terminal_startup_mode_steps(enter_alternate_screen, native_selection_enabled()) {
        match step {
            TerminalStartupModeStep::BracketedPaste => {
                crossterm::execute!(stdout(), crossterm::event::EnableBracketedPaste)
                    .context("failed to enable terminal input modes")?;
            }
            TerminalStartupModeStep::AlternateScreen => {
                TERMINAL_ALT_SCREEN_ACTIVE.store(true, Ordering::SeqCst);
                if let Err(error) = crossterm::execute!(
                    stdout(),
                    EnterAlternateScreen,
                    EnableAlternateScroll,
                    Clear(ClearType::All),
                    crossterm::cursor::MoveTo(0, 0)
                )
                .context("failed to enter alternate screen")
                {
                    restore_terminal_modes();
                    return Err(error);
                }
            }
            TerminalStartupModeStep::MouseCapture => {
                if let Err(error) = crossterm::execute!(stdout(), EnableMouseCapture)
                    .context("failed to enable terminal mouse capture")
                {
                    restore_terminal_modes();
                    return Err(error);
                }
            }
            TerminalStartupModeStep::RawMode => {
                if let Err(error) = enable_raw_mode().context("failed to enable raw terminal mode")
                {
                    restore_terminal_modes();
                    return Err(error);
                }
            }
            TerminalStartupModeStep::KeyboardEnhancement => {
                enable_keyboard_enhancement();
            }
            TerminalStartupModeStep::FocusChange => {
                let _ = crossterm::execute!(stdout(), crossterm::event::EnableFocusChange);
            }
        }
    }
    Ok(())
}

fn restore_terminal_modes_with(
    raw_mode_restore: RawModeRestore,
    keyboard_restore: KeyboardReportingRestore,
) {
    let mut stdout = stdout();
    match keyboard_restore {
        KeyboardReportingRestore::PopStack => {
            let _ =
                crossterm::execute!(stdout, PopKeyboardEnhancementFlags, DisableModifyOtherKeys);
        }
        KeyboardReportingRestore::ResetAfterExit => {
            let _ = crossterm::execute!(
                stdout,
                PopKeyboardEnhancementFlags,
                ResetKeyboardEnhancementFlags,
                DisableModifyOtherKeys
            );
        }
    }
    let _ = crossterm::execute!(
        stdout,
        crossterm::event::DisableBracketedPaste,
        crossterm::event::DisableFocusChange,
        DisableMouseCapture,
        DisableAlternateScroll,
        crossterm::style::ResetColor,
        crossterm::style::Print("\x1b[0m\x1b[r\x1b[?25h"),
        crossterm::cursor::SetCursorStyle::DefaultUserShape,
        crossterm::cursor::Show
    );
    if TERMINAL_ALT_SCREEN_ACTIVE.swap(false, Ordering::SeqCst) {
        let _ = crossterm::execute!(stdout, LeaveAlternateScreen);
    }
    if matches!(raw_mode_restore, RawModeRestore::Disable) {
        let _ = disable_raw_mode();
    }
}

fn restore_terminal_modes() {
    restore_terminal_modes_with(
        RawModeRestore::Disable,
        KeyboardReportingRestore::ResetAfterExit,
    );
}

fn restore_terminal_modes_keep_raw() {
    restore_terminal_modes_with(RawModeRestore::Keep, KeyboardReportingRestore::PopStack);
}

#[cfg(unix)]
fn restore_terminal_modes_for_suspend() {
    restore_terminal_modes_with(RawModeRestore::Disable, KeyboardReportingRestore::PopStack);
}

#[cfg(unix)]
pub(crate) fn reapply_raw_mode_after_resume() -> Result<()> {
    disable_raw_mode().context("failed to clear raw mode state after resume")?;
    enable_raw_mode().context("failed to re-enable raw mode after resume")
}

#[cfg(unix)]
pub(crate) fn flush_terminal_input_buffer() {
    // Safety: tcflush only discards unread input from stdin and does not take
    // ownership of the file descriptor.
    let result = unsafe { libc::tcflush(libc::STDIN_FILENO, libc::TCIFLUSH) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        warn!(%error, "failed to flush terminal input buffer");
    }
}

#[cfg(not(unix))]
pub(crate) fn flush_terminal_input_buffer() {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RestoredTerminalState {
    alternate_screen_enabled: bool,
}

impl RestoredTerminalState {
    #[cfg(unix)]
    pub(crate) fn alternate_screen_enabled(&self) -> bool {
        self.alternate_screen_enabled
    }
}

fn set_terminal_panic_hook() {
    TERMINAL_PANIC_HOOK.call_once(|| {
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic_info| {
            restore_terminal_modes();
            hook(panic_info);
        }));
    });
}

#[derive(Debug, Default)]
pub(crate) struct TerminalGuard {
    alternate_screen_enabled: bool,
    restored: bool,
    inline_navigation_mouse: bool,
}

impl TerminalGuard {
    fn new(alternate_screen_enabled: bool) -> Self {
        Self {
            alternate_screen_enabled,
            restored: false,
            inline_navigation_mouse: false,
        }
    }

    pub(crate) fn uses_alternate_screen(&self) -> bool {
        self.alternate_screen_enabled
    }

    /// Inline mode normally preserves host selection and captures the mouse only while the application outline or history layer is open.
    pub(crate) fn sync_navigation_mouse(&mut self, navigation_open: bool) -> Result<()> {
        if self.alternate_screen_enabled {
            return Ok(());
        }
        let enabled = navigation_open && !native_selection_enabled();
        if enabled == self.inline_navigation_mouse {
            return Ok(());
        }
        if enabled {
            crossterm::execute!(stdout(), EnableMouseCapture)?;
        } else {
            crossterm::execute!(stdout(), DisableMouseCapture)?;
        }
        self.inline_navigation_mouse = enabled;
        Ok(())
    }

    pub(crate) fn restore(&mut self) {
        if self.restored {
            return;
        }
        restore_terminal_modes();
        self.inline_navigation_mouse = false;
        self.alternate_screen_enabled = false;
        self.restored = true;
    }

    pub(crate) fn restore_for_external_program_keep_raw(&mut self) -> RestoredTerminalState {
        let state = RestoredTerminalState {
            alternate_screen_enabled: self.alternate_screen_enabled,
        };
        restore_terminal_modes_keep_raw();
        self.inline_navigation_mouse = false;
        self.alternate_screen_enabled = false;
        self.restored = true;
        state
    }

    #[cfg(unix)]
    pub(crate) fn restore_for_suspend(&mut self) -> RestoredTerminalState {
        let state = RestoredTerminalState {
            alternate_screen_enabled: self.alternate_screen_enabled,
        };
        restore_terminal_modes_for_suspend();
        self.inline_navigation_mouse = false;
        self.alternate_screen_enabled = false;
        self.restored = true;
        state
    }

    pub(crate) fn reenter_after_external_program(
        &mut self,
        state: RestoredTerminalState,
    ) -> Result<()> {
        set_terminal_modes(state.alternate_screen_enabled)?;
        self.alternate_screen_enabled = state.alternate_screen_enabled;
        self.restored = false;
        self.inline_navigation_mouse = false;
        Ok(())
    }
}

#[cfg(unix)]
pub(crate) fn suspend_current_process() -> Result<()> {
    // Safety: SIGTSTP is delivered to the current foreground process group so
    // the shell can regain control, matching normal Ctrl+Z job control.
    let result = unsafe { libc::kill(0, libc::SIGTSTP) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error()).context("failed to suspend KCoder process")
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

pub(crate) fn startup_probe() -> terminal_probe::StartupProbe {
    match terminal_probe::startup(terminal_probe::DEFAULT_TIMEOUT) {
        Ok(probe) => {
            debug!(
                cursor_position = probe.cursor_position.is_some(),
                default_colors = probe.default_colors.is_some(),
                "terminal startup probe completed"
            );
            probe
        }
        Err(error) => {
            debug!(%error, "terminal startup probe failed");
            terminal_probe::StartupProbe::default()
        }
    }
}

fn cursor_position_from_startup_probe(probe: terminal_probe::StartupProbe) -> Option<Position> {
    match probe.cursor_position {
        Some(position) => Some(position),
        None => {
            debug!("initial cursor position probe timed out");
            None
        }
    }
}

fn inline_cursor_position_from_startup_probe(
    probe: terminal_probe::StartupProbe,
    screen_height: u16,
) -> Position {
    cursor_position_from_startup_probe(probe).unwrap_or_else(|| {
        warn!(
            "initial cursor position probe timed out; defaulting inline viewport to terminal bottom"
        );
        Position {
            x: 0,
            y: screen_height.max(1).saturating_sub(1),
        }
    })
}

fn inline_viewport_start_after_launch_line(cursor_pos: Position, screen_height: u16) -> Position {
    let max_y = screen_height.max(1).saturating_sub(1);
    Position {
        x: 0,
        y: cursor_pos.y.saturating_add(1).min(max_y),
    }
}

pub(crate) fn init_kcoder_terminal(
    startup_probe: terminal_probe::StartupProbe,
) -> Result<(KCoderTerminal, TerminalGuard)> {
    if !stdin().is_terminal() {
        anyhow::bail!("stdin is not a terminal");
    }
    if !stdout().is_terminal() {
        anyhow::bail!("stdout is not a terminal");
    }
    let alternate_screen_enabled = tui_alternate_screen_enabled();
    set_terminal_modes(alternate_screen_enabled)?;
    set_terminal_panic_hook();
    let mut terminal_guard = TerminalGuard::new(alternate_screen_enabled);
    terminal_palette::set_default_colors_from_startup_probe(startup_probe.default_colors);
    let cursor_pos = if alternate_screen_enabled {
        Position { x: 0, y: 0 }
    } else {
        let screen_height = crossterm::terminal::size()
            .map(|(_, height)| height)
            .unwrap_or_else(|_| {
                startup_probe
                    .cursor_position
                    .map(|position| position.y.saturating_add(2))
                    .unwrap_or(1)
            });
        let cursor_pos = inline_cursor_position_from_startup_probe(startup_probe, screen_height);
        if let Err(error) = crossterm::execute!(stdout(), crossterm::style::Print("\r\n"))
            .context("failed to move inline TUI below launch command")
        {
            terminal_guard.restore();
            return Err(error);
        }
        inline_viewport_start_after_launch_line(cursor_pos, screen_height)
    };
    let backend = CrosstermBackend::new(stdout());
    let terminal = Terminal::with_options_and_cursor_position(backend, cursor_pos)
        .context("failed to initialize KCoder custom terminal");
    if terminal.is_err() {
        terminal_guard.restore();
    }
    terminal.map(|terminal| (terminal, terminal_guard))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_env_bool_uses_default_for_missing_empty_or_unknown_values() {
        assert!(parse_env_bool(None, true));
        assert!(!parse_env_bool(None, false));
        assert!(parse_env_bool(Some("  "), true));
        assert!(!parse_env_bool(Some("maybe"), false));
    }

    #[test]
    fn parse_env_bool_accepts_common_boolean_spellings() {
        for value in ["1", "true", "TRUE", "yes", "on", " On "] {
            assert!(parse_env_bool(Some(value), false), "{value}");
        }

        for value in ["0", "false", "FALSE", "no", "off", " Off "] {
            assert!(!parse_env_bool(Some(value), true), "{value}");
        }
    }

    #[test]
    fn alternate_screen_defaults_to_fullscreen() {
        assert!(tui_alternate_screen_enabled_for_env(&|_| None));
    }

    #[test]
    fn alternate_screen_env_preserves_legacy_boolean_values() {
        assert!(tui_alternate_screen_enabled_for_env(&|name| match name {
            "KCODER_TUI_ALT_SCREEN" => Some("true".to_string()),
            _ => None,
        }));

        assert!(!tui_alternate_screen_enabled_for_env(&|name| match name {
            "KCODER_TUI_ALT_SCREEN" => Some("false".to_string()),
            _ => None,
        }));
    }

    #[test]
    fn alternate_screen_env_supports_codex_modes() {
        assert!(tui_alternate_screen_enabled_for_env(&|name| match name {
            "KCODER_TUI_ALT_SCREEN" => Some("auto".to_string()),
            _ => None,
        }));
        assert!(tui_alternate_screen_enabled_for_env(&|name| match name {
            "KCODER_TUI_ALT_SCREEN" => Some("always".to_string()),
            _ => None,
        }));
        assert!(!tui_alternate_screen_enabled_for_env(&|name| match name {
            "KCODER_TUI_ALT_SCREEN" => Some("never".to_string()),
            _ => None,
        }));
    }

    #[test]
    fn alternate_screen_respects_no_alt_override() {
        assert!(determine_alt_screen_mode(false, AltScreenMode::Auto));
        assert!(determine_alt_screen_mode(false, AltScreenMode::Always));
        assert!(!determine_alt_screen_mode(false, AltScreenMode::Never));
        assert!(!determine_alt_screen_mode(true, AltScreenMode::Auto));
    }

    #[test]
    fn alternate_screen_config_uses_codex_modes_with_env_and_cli_override() {
        assert!(resolve_tui_alternate_screen_for_env(
            &|_| None,
            false,
            TuiAltScreenMode::Auto.into()
        ));
        assert!(!resolve_tui_alternate_screen_for_env(
            &|_| None,
            false,
            TuiAltScreenMode::Never.into()
        ));
        assert!(!resolve_tui_alternate_screen_for_env(
            &|_| None,
            true,
            TuiAltScreenMode::Always.into()
        ));
        assert!(!resolve_tui_alternate_screen_for_env(
            &|name| match name {
                "KCODER_TUI_ALT_SCREEN" => Some("never".to_string()),
                _ => None,
            },
            false,
            TuiAltScreenMode::Always.into()
        ));
    }

    #[test]
    fn tui_terminal_defaults_to_fullscreen_takeover() {
        const {
            assert!(matches!(TUI_ALTERNATE_SCREEN_DEFAULT, AltScreenMode::Auto));
        }
    }

    #[test]
    fn inline_startup_mode_uses_expected_order() {
        assert_eq!(
            terminal_startup_mode_steps(false, false),
            vec![
                TerminalStartupModeStep::BracketedPaste,
                TerminalStartupModeStep::RawMode,
                TerminalStartupModeStep::KeyboardEnhancement,
                TerminalStartupModeStep::FocusChange,
            ]
        );
    }

    #[test]
    fn inline_viewport_starts_below_launch_line() {
        assert_eq!(
            inline_viewport_start_after_launch_line(Position { x: 30, y: 10 }, 24),
            Position { x: 0, y: 11 }
        );
    }

    #[test]
    fn inline_cursor_probe_fallback_uses_terminal_bottom() {
        assert_eq!(
            inline_cursor_position_from_startup_probe(terminal_probe::StartupProbe::default(), 24),
            Position { x: 0, y: 23 }
        );
    }

    #[test]
    fn inline_viewport_start_saturates_at_terminal_bottom() {
        assert_eq!(
            inline_viewport_start_after_launch_line(Position { x: 0, y: 23 }, 24),
            Position { x: 0, y: 23 }
        );
    }

    #[test]
    fn alternate_screen_startup_enables_application_mouse_events() {
        assert_eq!(
            terminal_startup_mode_steps(true, false),
            vec![
                TerminalStartupModeStep::BracketedPaste,
                TerminalStartupModeStep::AlternateScreen,
                TerminalStartupModeStep::MouseCapture,
                TerminalStartupModeStep::RawMode,
                TerminalStartupModeStep::KeyboardEnhancement,
                TerminalStartupModeStep::FocusChange,
            ]
        );
    }

    #[test]
    fn native_selection_mode_skips_application_mouse_capture() {
        assert_eq!(
            terminal_startup_mode_steps(true, true),
            vec![
                TerminalStartupModeStep::BracketedPaste,
                TerminalStartupModeStep::AlternateScreen,
                TerminalStartupModeStep::RawMode,
                TerminalStartupModeStep::KeyboardEnhancement,
                TerminalStartupModeStep::FocusChange,
            ]
        );
    }

    #[test]
    fn native_selection_defaults_to_mouse_capture_and_supports_explicit_override() {
        let ssh_env = |name: &str| match name {
            "SSH_TTY" => Some("/dev/pts/1".to_string()),
            _ => None,
        };
        assert!(!native_selection_enabled_for_env(&ssh_env));

        let disabled = |name: &str| match name {
            NATIVE_SELECTION_ENV_VAR => Some("false".to_string()),
            "SSH_TTY" => Some("/dev/pts/1".to_string()),
            _ => None,
        };
        assert!(!native_selection_enabled_for_env(&disabled));

        let enabled = |name: &str| match name {
            NATIVE_SELECTION_ENV_VAR => Some("true".to_string()),
            _ => None,
        };
        assert!(native_selection_enabled_for_env(&enabled));
    }

    #[test]
    fn keyboard_enhancement_disable_env_parses_override() {
        assert!(!keyboard_enhancement_disabled_for_env(|_| None));
        assert!(keyboard_enhancement_disabled_for_env(|name| match name {
            DISABLE_KEYBOARD_ENHANCEMENT_ENV_VAR => Some("true".to_string()),
            _ => None,
        }));
        assert!(!keyboard_enhancement_disabled_for_env(|name| match name {
            DISABLE_KEYBOARD_ENHANCEMENT_ENV_VAR => Some("false".to_string()),
            _ => None,
        }));
    }

    #[test]
    fn keyboard_enhancement_auto_disables_for_vscode_in_wsl() {
        assert!(keyboard_enhancement_disabled_for(None, true, true));
        assert!(!keyboard_enhancement_disabled_for(None, true, false));
        assert!(!keyboard_enhancement_disabled_for(None, false, true));
    }

    #[test]
    fn keyboard_enhancement_env_override_wins_over_auto_detection() {
        assert!(!keyboard_enhancement_disabled_for(
            Some("false"),
            true,
            true
        ));
        assert!(keyboard_enhancement_disabled_for(
            Some("true"),
            false,
            false
        ));
    }

    #[test]
    fn keyboard_enhancement_env_detects_wsl_vscode_combo() {
        assert!(keyboard_enhancement_disabled_for_env(|name| match name {
            "WSL_DISTRO_NAME" => Some("Ubuntu".to_string()),
            "TERM_PROGRAM" => Some("vscode".to_string()),
            _ => None,
        }));
        assert!(!keyboard_enhancement_disabled_for_env(|name| match name {
            "TERM_PROGRAM" => Some("vscode".to_string()),
            _ => None,
        }));
    }

    #[test]
    fn vscode_terminal_detection_checks_linux_and_windows_side_values() {
        assert!(vscode_terminal_detected(Some("vscode"), None));
        assert!(vscode_terminal_detected(None, Some("VSCode")));
        assert!(!vscode_terminal_detected(Some("WezTerm"), None));
    }

    #[test]
    fn proc_version_wsl_detection_uses_expected_markers() {
        assert!(proc_version_indicates_wsl(
            "Linux version 5.15.0-microsoft-standard-WSL2"
        ));
        assert!(proc_version_indicates_wsl(
            "Linux version 5.15.0-wsl-microsoft-standard"
        ));
        assert!(!proc_version_indicates_wsl("Linux version 6.8.0"));
    }

    #[test]
    fn tmux_modify_other_keys_only_for_csi_u_sessions() {
        assert!(!tmux_should_enable_modify_other_keys_for(
            false,
            Some("csi-u")
        ));
        assert!(!tmux_should_enable_modify_other_keys_for(true, None));
        assert!(!tmux_should_enable_modify_other_keys_for(
            true,
            Some("xterm")
        ));
        assert!(tmux_should_enable_modify_other_keys_for(
            true,
            Some("csi-u")
        ));
    }

    #[test]
    fn alternate_scroll_commands_match_codex_sequences() {
        let mut enable = String::new();
        let mut disable = String::new();

        EnableAlternateScroll.write_ansi(&mut enable).unwrap();
        DisableAlternateScroll.write_ansi(&mut disable).unwrap();

        assert_eq!(enable, "\x1b[?1007h");
        assert_eq!(disable, "\x1b[?1007l");
    }

    #[test]
    fn keyboard_reporting_cleanup_commands_match_codex_sequences() {
        let mut push_keyboard = String::new();
        let mut pop_keyboard = String::new();
        let mut reset_keyboard = String::new();
        let mut enable_modify_other_keys = String::new();
        let mut disable_modify_other_keys = String::new();

        PushKeyboardEnhancementFlags(
            KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS,
        )
        .write_ansi(&mut push_keyboard)
        .unwrap();
        PopKeyboardEnhancementFlags
            .write_ansi(&mut pop_keyboard)
            .unwrap();
        ResetKeyboardEnhancementFlags
            .write_ansi(&mut reset_keyboard)
            .unwrap();
        EnableModifyOtherKeys
            .write_ansi(&mut enable_modify_other_keys)
            .unwrap();
        DisableModifyOtherKeys
            .write_ansi(&mut disable_modify_other_keys)
            .unwrap();

        assert_eq!(push_keyboard, "\x1b[>7u");
        assert_eq!(pop_keyboard, "\x1b[<1u");
        assert_eq!(reset_keyboard, "\x1b[<u");
        assert_eq!(enable_modify_other_keys, "\x1b[>4;2m");
        assert_eq!(disable_modify_other_keys, "\x1b[>4;0m");
    }
}
