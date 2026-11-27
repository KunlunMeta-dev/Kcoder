//! `kcoder doctor` legacy channel data: detection lines and the explicit,
//! consent-gated `--clean-legacy-channel-data` command. Output carries domain
//! labels, hashed namespace names, counts and sizes only, never file contents.
use anyhow::{Result, bail};
use kcoder_state::domain_storage::legacy_channel::{
    LegacyChannelDataEntry, LegacyChannelDataReport, LegacyChannelDataStatus,
    clean_legacy_channel_data, detect_legacy_channel_data,
};
use std::io::Write;
use std::path::Path;

pub const CLEAN_FLAG: &str = "--clean-legacy-channel-data";

/// Native integration domains live directly in the user settings directory,
/// the same profile the app-server captures from its settings path.
pub fn native_profile(loaded: &kcoder_config::LoadedSettings) -> Option<&Path> {
    loaded.paths.user_settings.parent()
}

/// Entry point for `kcoder doctor --clean-legacy-channel-data [--yes]`.
pub fn run_from_cli(loaded: &kcoder_config::LoadedSettings, assume_yes: bool) -> Result<()> {
    let Some(profile) = native_profile(loaded) else {
        bail!("LEGACY_CHANNEL_PROFILE_UNAVAILABLE");
    };
    let mut confirm = confirm_on_terminal;
    run_cleanup(
        profile,
        CleanupConsent {
            assume_yes,
            interactive: stdin_is_interactive(),
            confirm: &mut confirm,
        },
        &mut std::io::stdout().lock(),
    )
}

/// Detection lines for the ordinary read-only doctor report.
pub fn gather(profile: &Path) -> Vec<String> {
    match detect_legacy_channel_data(profile) {
        Ok(report) => report_lines(&report),
        Err(error) => vec![format!(
            "legacy channel data: not inspected ({})",
            first_line(&error)
        )],
    }
}

pub fn report_lines(report: &LegacyChannelDataReport) -> Vec<String> {
    if report.entries.is_empty() {
        return vec!["legacy channel data: none".to_owned()];
    }
    let removable = report.removable().count();
    let refused = report.refused().count();
    let mut lines = vec![format!(
        "legacy channel data: {removable} removable, {refused} refused{}",
        if removable > 0 {
            format!(" — remove with `kcoder doctor {CLEAN_FLAG}` (asks for confirmation)")
        } else {
            String::new()
        }
    )];
    lines.extend(report.entries.iter().map(entry_line));
    lines
}

fn entry_line(entry: &LegacyChannelDataEntry) -> String {
    format!(
        "  legacy {}: namespace={} entries={} bytes={} state={}",
        entry.domain_label(),
        entry.namespace_id,
        entry.top_level_entries,
        entry.top_level_bytes,
        status_label(&entry.status)
    )
}

fn status_label(status: &LegacyChannelDataStatus) -> String {
    match status {
        LegacyChannelDataStatus::Present => "present".into(),
        LegacyChannelDataStatus::MarkerOnly => "marker-only".into(),
        LegacyChannelDataStatus::InterruptedCleanup => "interrupted-cleanup".into(),
        LegacyChannelDataStatus::Refused(reason) => format!("refused ({reason})"),
    }
}

/// How consent is obtained. `assume_yes` is the explicit `--yes` flag.
pub struct CleanupConsent<'a> {
    pub assume_yes: bool,
    pub interactive: bool,
    pub confirm: &'a mut dyn FnMut(&str) -> Result<bool>,
}

/// Runs only when the user invoked the explicit cleanup flag. Non-interactive
/// callers must pass `--yes`; nothing is removed without consent.
pub fn run_cleanup(profile: &Path, consent: CleanupConsent<'_>, out: &mut dyn Write) -> Result<()> {
    let report = detect_legacy_channel_data(profile)?;
    for line in report_lines(&report) {
        writeln!(out, "{line}")?;
    }
    let removable = report.removable().count();
    if removable == 0 {
        writeln!(out, "legacy channel cleanup: nothing to remove")?;
        return finish(report.refused().count());
    }
    if !consent.assume_yes {
        if !consent.interactive {
            bail!(
                "LEGACY_CHANNEL_CLEANUP_CONSENT_REQUIRED: rerun with `kcoder doctor {CLEAN_FLAG} --yes` to remove {removable} legacy channel data entr{}",
                if removable == 1 { "y" } else { "ies" }
            );
        }
        let prompt = format!(
            "Permanently remove {removable} legacy channel data entr{} under {}? [y/N] ",
            if removable == 1 { "y" } else { "ies" },
            profile.display()
        );
        if !(consent.confirm)(&prompt)? {
            writeln!(out, "legacy channel cleanup: cancelled; nothing removed")?;
            return Ok(());
        }
    }
    let cleanup = clean_legacy_channel_data(profile)?;
    for entry in &cleanup.removed {
        writeln!(
            out,
            "removed legacy {}: namespace={}",
            entry.domain_label(),
            entry.namespace_id
        )?;
    }
    for entry in &cleanup.refused {
        writeln!(out, "kept{}", entry_line(entry).trim_start_matches(' '))?;
    }
    writeln!(
        out,
        "legacy channel cleanup: {} removed, {} refused",
        cleanup.removed.len(),
        cleanup.refused.len()
    )?;
    finish(cleanup.refused.len())
}

fn finish(refused: usize) -> Result<()> {
    if refused > 0 {
        bail!(
            "LEGACY_CHANNEL_CLEANUP_REFUSED: {refused} entr{} left untouched (unsafe type, ownership or active use)",
            if refused == 1 { "y" } else { "ies" }
        );
    }
    Ok(())
}

/// Interactive confirmation on the controlling terminal.
pub fn confirm_on_terminal(prompt: &str) -> Result<bool> {
    let mut stderr = std::io::stderr();
    write!(stderr, "{prompt}")?;
    stderr.flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

pub fn stdin_is_interactive() -> bool {
    use std::io::IsTerminal as _;
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

fn first_line(error: &anyhow::Error) -> String {
    error
        .to_string()
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[cfg(test)]
#[path = "legacy_channel_doctor_tests.rs"]
mod tests;
