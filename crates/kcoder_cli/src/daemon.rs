//! `kcoder daemon`: background sessions managed by tmux.
//!
//! tmux owns terminal and process lifecycles; this module provides lightweight
//! registration and wrappers. Sessions outlive foreground processes and remain
//! available for listing, inspection, reattachment, and termination.

use anyhow::{Context, Result, bail};
use clap::Subcommand;
use kcoder_config::Settings;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SESSION_PREFIX: &str = "klnd-";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct DaemonSessionMeta {
    name: String,
    cwd: PathBuf,
    log: PathBuf,
    args: Vec<String>,
    started_at_ms: u128,
    #[serde(default)]
    killed: bool,
}

#[derive(Debug, Clone, Subcommand)]
pub enum DaemonAction {
    /// Start a detached background session. Everything after `bg` is forwarded
    /// to the spawned kcoder verbatim (e.g. `--json --resume latest
    /// "prompt"`). The tail is recovered from the raw process arguments so
    /// global CLI flags of the outer process are forwarded too, never eaten.
    #[command(trailing_var_arg = true, allow_hyphen_values = true)]
    Bg {
        #[arg(hide = true)]
        args: Vec<String>,
    },
    /// List background sessions with their liveness.
    Ps,
    /// Attach the current terminal to a running session.
    Attach {
        /// Session name or unique prefix.
        target: String,
    },
    /// Kill a background session.
    Kill {
        /// Session name or unique prefix.
        target: String,
    },
    /// Print the last lines of a session log (`--follow` keeps streaming).
    Logs {
        /// Session name or unique prefix.
        target: String,
        /// Number of lines to print (ignored with --follow).
        #[arg(long, default_value_t = 50)]
        lines: usize,
        /// Stream the log like `tail -f`.
        #[arg(long, short = 'f')]
        follow: bool,
    },
}

pub async fn run(action: DaemonAction) -> Result<()> {
    match action {
        DaemonAction::Bg { args } => run_bg(&args),
        DaemonAction::Ps => run_ps(),
        DaemonAction::Attach { target } => run_attach(&target),
        DaemonAction::Kill { target } => run_kill(&target),
        DaemonAction::Logs {
            target,
            lines,
            follow,
        } => run_logs(&target, lines, follow),
    }
}

// ---------------------------------------------------------------- registry

fn daemon_dir() -> Result<PathBuf> {
    let dir = Settings::config_dir()?.join("daemon");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn log_dir() -> Result<PathBuf> {
    let dir = daemon_dir()?.join("logs");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn meta_path(name: &str) -> Result<PathBuf> {
    Ok(daemon_dir()?.join(format!("{name}.json")))
}

fn write_meta(meta: &DaemonSessionMeta) -> Result<()> {
    let path = meta_path(&meta.name)?;
    let mut file = fs::File::create(&path)?;
    use std::io::Write as _;
    file.write_all(serde_json::to_string_pretty(meta)?.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn load_metas_from(dir: &Path, include_killed: bool) -> Result<Vec<DaemonSessionMeta>> {
    let mut metas = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("failed to read daemon metadata {}", path.display()))?;
        let meta: DaemonSessionMeta = serde_json::from_str(&raw)
            .with_context(|| format!("invalid daemon metadata {}", path.display()))?;
        if include_killed || !meta.killed {
            metas.push(meta);
        }
    }
    metas.sort_by_key(|meta| meta.started_at_ms);
    Ok(metas)
}

fn load_metas(include_killed: bool) -> Result<Vec<DaemonSessionMeta>> {
    load_metas_from(&daemon_dir()?, include_killed)
}

fn resolve_target_in(dir: &Path, target: &str) -> Result<DaemonSessionMeta> {
    let metas = load_metas_from(dir, true)?;
    if let Some(meta) = metas.iter().find(|meta| meta.name == target) {
        return Ok(meta.clone());
    }
    let matches: Vec<_> = metas
        .iter()
        .filter(|meta| meta.name.starts_with(target))
        .collect();
    match matches.len() {
        1 => Ok(matches[0].clone()),
        0 => bail!("no daemon session matching '{target}' (run `kcoder daemon ps`)"),
        n => bail!("daemon session prefix '{target}' is ambiguous ({n} matches)"),
    }
}

fn resolve_target(target: &str) -> Result<DaemonSessionMeta> {
    resolve_target_in(&daemon_dir()?, target)
}

// ---------------------------------------------------------------- tmux glue

fn ensure_tmux() -> Result<()> {
    let status = Command::new("tmux")
        .arg("-V")
        .output()
        .context("tmux is required for `kcoder daemon` but was not found in PATH")?;
    if !status.status.success() {
        bail!("tmux is required for `kcoder daemon` but `tmux -V` failed");
    }
    Ok(())
}

fn tmux_session_names() -> Result<Vec<String>> {
    let output = Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
        .context("failed to run `tmux list-sessions`")?;
    // No tmux server running yet: treat as "no sessions" instead of an error.
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Recover the raw command line after `daemon bg` so every argument —
/// including flags the outer CLI also knows — is forwarded verbatim.
/// A leading `--` separator is dropped.
fn forwarded_bg_args() -> Vec<String> {
    let raw: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    split_bg_tail(&raw)
}

fn split_bg_tail(raw: &[String]) -> Vec<String> {
    let Some(daemon_pos) = raw.iter().position(|arg| arg == "daemon") else {
        return Vec::new();
    };
    let Some(bg_pos) = raw
        .iter()
        .skip(daemon_pos + 1)
        .position(|arg| arg == "bg")
        .map(|pos| daemon_pos + 1 + pos)
    else {
        return Vec::new();
    };
    let mut tail: Vec<String> = raw.iter().skip(bg_pos + 1).cloned().collect();
    if tail.first().is_some_and(|arg| arg == "--") {
        tail.remove(0);
    }
    tail
}

fn run_bg(_clap_args: &[String]) -> Result<()> {
    let args = forwarded_bg_args();
    if args.is_empty() {
        bail!(
            "daemon bg requires a command line, e.g.\n  kcoder daemon bg --json --permission-mode yolo \"<prompt>\"\n  kcoder daemon bg   (interactive TUI session)"
        );
    }
    ensure_tmux()?;
    let cwd = std::env::current_dir().context("failed to resolve current directory")?;
    let name = format!("{SESSION_PREFIX}{:08x}", rand_suffix());
    let log = log_dir()?.join(format!("{name}.log"));
    let exe = std::env::current_exe().context("failed to resolve the kcoder executable")?;

    let mut command = format!("cd {} && ", shell_quote(&cwd.display().to_string()));
    command.push_str(&shell_quote(&exe.display().to_string()));
    for arg in &args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }

    let status = Command::new("tmux")
        .args(["new-session", "-d", "-s", &name, "-c", ".", &command])
        .status()
        .context("failed to start tmux session")?;
    if !status.success() {
        bail!("tmux new-session failed for {name}");
    }
    // pipe-pane keeps the session's pty as stdout (interactive TUIs need a
    // terminal) while teeing everything written to the pane into the log.
    let pipe = Command::new("tmux")
        .args([
            "pipe-pane",
            "-t",
            &name,
            "-o",
            &format!("cat >> {}", shell_quote(&log.display().to_string())),
        ])
        .status()
        .context("failed to attach tmux pipe-pane")?;
    if !pipe.success() {
        bail!("tmux pipe-pane failed for {name}");
    }

    let meta = DaemonSessionMeta {
        name: name.clone(),
        cwd,
        log: log.clone(),
        args: args.to_vec(),
        started_at_ms: now_millis(),
        killed: false,
    };
    write_meta(&meta)?;

    println!("started {name}");
    println!("  log:    {}", log.display());
    println!("  attach: kcoder daemon attach {name}");
    println!("  logs:   kcoder daemon logs {name} -f");
    Ok(())
}

fn run_ps() -> Result<()> {
    let live: std::collections::HashSet<String> = tmux_session_names()?.into_iter().collect();
    let metas = load_metas(false)?;
    if metas.is_empty() {
        println!("No background sessions. Start one with `kcoder daemon bg ...`.");
        return Ok(());
    }
    println!(
        "{:<14} {:<7} {:<20} {:<30} ARGS",
        "NAME", "ALIVE", "STARTED", "CWD"
    );
    for meta in metas {
        let alive = live.contains(&meta.name);
        let started = format_time(meta.started_at_ms);
        let cwd = meta.cwd.display().to_string();
        let args = meta.args.join(" ");
        println!(
            "{:<14} {:<7} {:<20} {:<30} {}",
            meta.name,
            if alive { "yes" } else { "no" },
            started,
            truncate(&cwd, 30),
            truncate(&args, 60)
        );
    }
    Ok(())
}

fn run_attach(target: &str) -> Result<()> {
    ensure_tmux()?;
    let meta = resolve_target(target)?;
    if meta.killed {
        bail!("daemon session {} was killed", meta.name);
    }
    if !tmux_session_names()?.contains(&meta.name) {
        bail!(
            "daemon session {} is not running (its tmux session is gone)",
            meta.name
        );
    }
    // Replace this process with `tmux attach` so the terminal hands over fully.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = Command::new("tmux")
            .args(["attach-session", "-t", &meta.name])
            .exec();
        Err(anyhow::anyhow!("failed to exec tmux attach: {error}"))
    }
    #[cfg(not(unix))]
    {
        let status = Command::new("tmux")
            .args(["attach-session", "-t", &meta.name])
            .status()?;
        if !status.success() {
            bail!("tmux attach failed for {}", meta.name);
        }
        Ok(())
    }
}

fn run_kill(target: &str) -> Result<()> {
    ensure_tmux()?;
    let mut meta = resolve_target(target)?;
    if tmux_session_names()?.contains(&meta.name) {
        let status = Command::new("tmux")
            .args(["kill-session", "-t", &meta.name])
            .status()
            .context("failed to run tmux kill-session")?;
        if !status.success() {
            bail!("tmux kill-session failed for {}", meta.name);
        }
    }
    meta.killed = true;
    write_meta(&meta)?;
    println!("killed {}", meta.name);
    Ok(())
}

fn run_logs(target: &str, lines: usize, follow: bool) -> Result<()> {
    let meta = resolve_target(target)?;
    if !meta.log.is_file() {
        bail!("no log file yet at {}", meta.log.display());
    }
    if follow {
        let status = Command::new("tail")
            .args(["-n", "+1", "-f"])
            .arg(&meta.log)
            .status()
            .context("failed to run tail -f")?;
        if !status.success() {
            bail!("tail -f failed for {}", meta.log.display());
        }
        return Ok(());
    }
    let content = fs::read_to_string(&meta.log)?;
    let all: Vec<&str> = content.lines().collect();
    let start = all.len().saturating_sub(lines);
    for line in &all[start..] {
        println!("{line}");
    }
    Ok(())
}

// ---------------------------------------------------------------- helpers

fn rand_suffix() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos ^ std::process::id()
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn format_time(ms: u128) -> String {
    let secs = ms / 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    format!(
        "{}d {:02}:{:02}:{:02}",
        days,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn test_meta(name: &str, killed: bool) -> DaemonSessionMeta {
        DaemonSessionMeta {
            name: name.to_string(),
            cwd: PathBuf::from("/tmp/work"),
            log: PathBuf::from("/tmp/work.log"),
            args: vec!["--json".to_string(), "go".to_string()],
            started_at_ms: 1,
            killed,
        }
    }

    #[test]
    fn split_bg_tail_forwards_flags_verbatim() {
        let raw = vec![
            "kcoder".to_string(),
            "daemon".to_string(),
            "bg".to_string(),
            "--json".to_string(),
            "--permission-mode".to_string(),
            "yolo".to_string(),
            "--resume".to_string(),
            "latest".to_string(),
            "prompt with spaces".to_string(),
        ];
        assert_eq!(
            split_bg_tail(&raw),
            vec![
                "--json",
                "--permission-mode",
                "yolo",
                "--resume",
                "latest",
                "prompt with spaces"
            ]
        );
        let with_separator = vec![
            "kcoder".to_string(),
            "daemon".to_string(),
            "bg".to_string(),
            "--".to_string(),
            "--json".to_string(),
        ];
        assert_eq!(split_bg_tail(&with_separator), vec!["--json"]);
        assert!(split_bg_tail(&["kcoder".to_string(), "daemon".to_string()]).is_empty());
        assert!(split_bg_tail(&["kcoder".to_string()]).is_empty());
    }

    #[test]
    fn meta_serde_roundtrip() {
        let meta = test_meta("klnd-12345678", false);
        let raw = serde_json::to_string(&meta).unwrap();
        let parsed: DaemonSessionMeta = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, meta);
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
        assert_eq!(shell_quote("plain"), "'plain'");
    }

    #[test]
    fn truncate_appends_ellipsis_only_when_needed() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdefghijklmnop", 5), "abcd…");
    }

    #[test]
    fn daemon_dir_uses_config_dir() {
        let dir = daemon_dir().unwrap();
        assert!(dir.ends_with("daemon"));
    }

    fn write_meta_to(dir: &Path, meta: &DaemonSessionMeta) {
        fs::create_dir_all(dir).unwrap();
        let mut file = fs::File::create(dir.join(format!("{}.json", meta.name))).unwrap();
        file.write_all(serde_json::to_string_pretty(meta).unwrap().as_bytes())
            .unwrap();
    }

    #[test]
    fn resolve_target_matches_exact_prefix_and_reports_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let metas = [
            test_meta("klnd-aaaa1111", false),
            test_meta("klnd-bbbb2222", false),
            test_meta("klnd-aacc3333", false),
        ];
        for meta in &metas {
            write_meta_to(tmp.path(), meta);
        }

        let exact = resolve_target_in(tmp.path(), "klnd-aaaa1111").unwrap();
        assert_eq!(exact.name, "klnd-aaaa1111");
        let prefixed = resolve_target_in(tmp.path(), "klnd-bbbb").unwrap();
        assert_eq!(prefixed.name, "klnd-bbbb2222");
        assert!(resolve_target_in(tmp.path(), "klnd-aa").is_err());
        assert!(resolve_target_in(tmp.path(), "klnd-zzzz").is_err());
    }
}
