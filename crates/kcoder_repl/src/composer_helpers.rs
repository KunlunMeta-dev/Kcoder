//! File mentions, paste expansion, and user action contract.

use super::*;

pub(super) fn project_file_index(cwd: &Path, limit: usize) -> Vec<String> {
    let output = std::process::Command::new("rg")
        .args(["--files", "--hidden", "-g", "!.git"])
        .current_dir(cwd)
        .output();
    let bytes = output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output.stdout)
        .or_else(|| {
            std::process::Command::new("git")
                .args(["ls-files", "--cached", "--others", "--exclude-standard"])
                .current_dir(cwd)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| output.stdout)
        })
        .unwrap_or_default();
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|line| {
            let line = line.trim();
            !line.is_empty()
                && !line.starts_with(".git/")
                && !line.starts_with(".kcoder/")
                && !line.starts_with("target/")
                && !line.starts_with("node_modules/")
        })
        .take(limit)
        .map(str::to_string)
        .collect()
}

pub(super) fn fuzzy_file_candidates(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let query = query.to_ascii_lowercase();
    let mut scored = files
        .iter()
        .filter_map(|path| fuzzy_file_score(path, &query).map(|score| (score, path)))
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.len().cmp(&right.len()))
            .then_with(|| left.cmp(right))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, path)| path.clone())
        .collect()
}

pub(super) fn fuzzy_file_score(path: &str, query: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let candidate = path.to_ascii_lowercase();
    if let Some(index) = candidate.find(query) {
        let basename = candidate.rsplit('/').next().unwrap_or(&candidate);
        let basename_bonus = basename.find(query).map_or(0, |_| 300);
        return Some(1_000 + basename_bonus - index as i64 - candidate.len() as i64);
    }
    let mut score = 0i64;
    let mut query_chars = query.chars();
    let mut wanted = query_chars.next()?;
    let mut previous_match = None;
    for (index, ch) in candidate.chars().enumerate() {
        if ch != wanted {
            continue;
        }
        score += 20;
        if previous_match.is_some_and(|previous| previous + 1 == index) {
            score += 35;
        }
        if index == 0 || candidate.as_bytes().get(index.wrapping_sub(1)) == Some(&b'/') {
            score += 15;
        }
        previous_match = Some(index);
        let Some(next) = query_chars.next() else {
            return Some(score - candidate.len() as i64);
        };
        wanted = next;
    }
    None
}

pub(super) fn queued_user_message_preview(message: &Message) -> String {
    let raw = match message {
        Message::User { content, .. } | Message::Assistant { content, .. } => {
            content_blocks_text(content)
        }
    };
    let preview = sanitize_tui_text(&raw.split_whitespace().collect::<Vec<_>>().join(" "));
    if preview.is_empty() {
        "[attachment]".to_string()
    } else {
        preview
    }
}

pub(super) fn editable_user_message_text(message: &Message) -> String {
    match message {
        Message::User { content, .. } => sanitize_tui_text(&content_blocks_text(content)),
        _ => String::new(),
    }
}

pub(super) fn local_image_placeholder(index: usize) -> String {
    format!("[Image #{index}]")
}

pub(super) fn expand_pending_pastes(text: &str, pending_pastes: &[(String, String)]) -> String {
    if pending_pastes.is_empty() {
        return text.to_string();
    }

    let mut replacements: Vec<_> = pending_pastes.iter().enumerate().collect();
    replacements.sort_by_key(|(_, (text, _))| std::cmp::Reverse(text.len()));

    let mut expanded = text.to_string();
    let mut staged = Vec::new();
    for (index, (placeholder, actual)) in replacements {
        if !expanded.contains(placeholder) {
            continue;
        }
        let token = format!("\x1fkcoder-paste-expand-{index}\x1f");
        expanded = expanded.replace(placeholder, &token);
        staged.push((token, actual.clone()));
    }

    for (token, actual) in staged {
        expanded = expanded.replace(&token, &actual);
    }
    expanded
}

/// Draw the slash-command picker in the transient bottom overlay band.
#[derive(Debug)]
pub(super) enum UserAction {
    Quit,
    Suspend,
    Submit(SubmittedMessage),
    RunShellCommand {
        command: String,
        history_text: String,
    },
    SlashCommand(String),
    CompactConversation,
    StartSideQuestion(String),
    StartMoaPlan(String),
    ResumeSession(PathBuf),
    ConfirmGoalReplacement {
        objective: String,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
    },
    ClearUi,
    CopyLastResponse,
    PasteClipboardImage,
    OpenExternalEditor,
    EditPreviousMessage,
    ToggleRawOutput,
    AdjustReasoning(ReasoningShortcutDirection),
    CompleteDeferredTurn,
    Interrupt,
    ShortenToolWait,
    TryStartTurn,
}

pub(super) fn is_clipboard_image_paste_key(key: &KeyEvent) -> bool {
    if key.kind != KeyEventKind::Press
        || !matches!(key.code, KeyCode::Char(c) if c.eq_ignore_ascii_case(&'v'))
    {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        key.modifiers == KeyModifiers::ALT
    }
    #[cfg(not(target_os = "windows"))]
    {
        (key.modifiers == KeyModifiers::CONTROL
            || key.modifiers == (KeyModifiers::CONTROL | KeyModifiers::ALT))
            && !key_hint::is_altgr(key.modifiers)
    }
}
