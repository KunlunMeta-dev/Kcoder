//! Terminal display policy for web-link destinations.

use std::io::IsTerminal;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WebLinkDisplay {
    LabelOnly,
    WithDestination,
}

impl WebLinkDisplay {
    fn for_environment(
        stdout_is_terminal: bool,
        term: Option<&str>,
        term_program: Option<&str>,
        multiplexer: bool,
        known_hyperlink_terminal: bool,
    ) -> Self {
        if !stdout_is_terminal
            || multiplexer
            || term.is_some_and(|term| {
                let term = term.to_ascii_lowercase();
                term == "dumb" || term.starts_with("screen") || term.starts_with("tmux")
            })
        {
            return Self::WithDestination;
        }

        if known_hyperlink_terminal {
            return Self::LabelOnly;
        }

        match term_program.map(str::to_ascii_lowercase).as_deref() {
            Some(
                "ghostty" | "iterm.app" | "wezterm" | "vscode" | "kitty" | "alacritty"
                | "windows terminal" | "windows_terminal" | "konsole" | "gnome-terminal" | "vte",
            ) => Self::LabelOnly,
            _ => Self::WithDestination,
        }
    }
}

pub(super) fn hide_web_link_destinations() -> bool {
    static DISPLAY: LazyLock<WebLinkDisplay> = LazyLock::new(|| {
        let multiplexer = std::env::var_os("TMUX").is_some()
            || std::env::var_os("STY").is_some()
            || std::env::var_os("ZELLIJ").is_some()
            || std::env::var_os("ZELLIJ_SESSION_NAME").is_some();
        let known_hyperlink_terminal = [
            "KITTY_WINDOW_ID",
            "ALACRITTY_LOG",
            "ALACRITTY_SOCKET",
            "WT_SESSION",
            "KONSOLE_VERSION",
            "VTE_VERSION",
        ]
        .iter()
        .any(|name| std::env::var_os(name).is_some());
        WebLinkDisplay::for_environment(
            std::io::stdout().is_terminal(),
            std::env::var("TERM").ok().as_deref(),
            std::env::var("TERM_PROGRAM").ok().as_deref(),
            multiplexer,
            known_hyperlink_terminal,
        )
    });
    *DISPLAY == WebLinkDisplay::LabelOnly
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_hyperlink_terminals_use_label_only() {
        for terminal in [
            "ghostty",
            "iTerm.app",
            "WezTerm",
            "vscode",
            "kitty",
            "alacritty",
            "windows_terminal",
            "konsole",
            "gnome-terminal",
            "vte",
        ] {
            assert_eq!(
                WebLinkDisplay::for_environment(
                    true,
                    Some("xterm-256color"),
                    Some(terminal),
                    false,
                    false,
                ),
                WebLinkDisplay::LabelOnly,
                "terminal: {terminal}"
            );
        }
    }

    #[test]
    fn unknown_non_tty_and_multiplexer_environments_keep_destination() {
        for (stdout_is_terminal, term, multiplexer) in [
            (true, Some("xterm-256color"), false),
            (false, Some("xterm-256color"), false),
            (true, Some("tmux-256color"), false),
            (true, Some("screen-256color"), false),
            (true, Some("xterm-256color"), true),
        ] {
            assert_eq!(
                WebLinkDisplay::for_environment(stdout_is_terminal, term, None, multiplexer, false,),
                WebLinkDisplay::WithDestination,
            );
        }
    }
}
