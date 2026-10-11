use super::*;

#[derive(Clone, Copy)]
pub(super) struct MarkdownFence {
    pub(super) marker: u8,
    pub(super) width: usize,
}

/// Return a Markdown fence marker with at most three leading spaces, its length, and remaining content.
pub(super) fn markdown_fence_run(line: &str) -> Option<(u8, usize, &str)> {
    let bytes = line.as_bytes();
    let indentation = bytes.iter().take_while(|byte| **byte == b' ').count();
    if indentation > 3 {
        return None;
    }
    let marker = *bytes.get(indentation)?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let width = bytes[indentation..]
        .iter()
        .take_while(|byte| **byte == marker)
        .count();
    if width < 3 {
        return None;
    }
    Some((marker, width, &line[indentation + width..]))
}

pub(super) fn markdown_fence_opens(line: &str) -> Option<MarkdownFence> {
    let (marker, width, suffix) = markdown_fence_run(line)?;
    // CommonMark does not treat a backtick line whose info string still contains a backtick as an opener.
    if marker == b'`' && suffix.as_bytes().contains(&b'`') {
        return None;
    }
    Some(MarkdownFence { marker, width })
}

pub(super) fn markdown_fence_closes(line: &str, active: MarkdownFence) -> bool {
    let Some((marker, width, suffix)) = markdown_fence_run(line) else {
        return false;
    };
    marker == active.marker && width >= active.width && suffix.trim().is_empty()
}

pub(super) fn markdown_indented_code_line(line: &str) -> bool {
    let bytes = line.as_bytes();
    let indentation = bytes.iter().take_while(|byte| **byte == b' ').count();
    indentation >= 4 || bytes.get(indentation) == Some(&b'\t')
}

pub(super) fn blocked_reason_is_verifier_infrastructure(reason: &str) -> bool {
    let normalized = reason.to_ascii_lowercase();
    let verifier = normalized.contains("verifier")
        || normalized.contains("验证器")
        || normalized.contains("验证协议")
        || normalized.contains("verification side")
        || normalized.contains("verification infrastructure")
        || normalized.contains("验证侧")
        || normalized.contains("验证基础设施");
    let infrastructure = [
        "infrastructure",
        "protocol",
        "maximum turns",
        "max turns",
        "timed out",
        "timeout",
        "invalid verdict",
        "filtered",
        "raw exit",
        "exit code",
        "exit status",
        "test evidence",
        "基础设施",
        "协议",
        "最大轮数",
        "超时",
        "判词",
        "退出码",
        "过滤",
    ]
    .iter()
    .any(|needle| normalized.contains(needle));
    verifier && infrastructure
}

pub(super) fn parse_verifier_verdict_line(line: &str) -> Option<Option<GoalVerificationVerdict>> {
    let line = line
        .strip_prefix("### ")
        .or_else(|| line.strip_prefix("## "))
        .or_else(|| line.strip_prefix("# "))
        .or_else(|| line.strip_prefix("- "))
        .unwrap_or(line)
        .trim_start();
    let explicit_clause = explicit_verifier_verdict_clause(line);
    let line = explicit_clause.unwrap_or(line);

    let (token, suffix) = if let Some(rest) = line.strip_prefix("**") {
        let (token, suffix) = rest.split_once("**")?;
        (token, suffix)
    } else if let Some(rest) = line.strip_prefix("__") {
        let (token, suffix) = rest.split_once("__")?;
        (token, suffix)
    } else {
        let token_end = line
            .find(|character: char| !character.is_ascii_alphabetic())
            .unwrap_or(line.len());
        let (token, suffix) = line.split_at(token_end);
        (token, suffix)
    };
    let verdict = match token {
        "PASS" => GoalVerificationVerdict::Pass,
        "FAIL" => GoalVerificationVerdict::Fail,
        "FLAKY" => GoalVerificationVerdict::Flaky,
        _ if explicit_clause.is_some() => return None,
        _ => return Some(None),
    };
    if suffix
        .split(|character: char| !character.is_ascii_alphabetic())
        .any(|word| matches!(word, "PASS" | "FAIL" | "FLAKY"))
    {
        return None;
    }
    let trimmed_suffix = suffix.trim_start();
    if explicit_clause.is_none()
        && !trimmed_suffix.is_empty()
        && !matches!(
            trimmed_suffix.chars().next(),
            Some(':' | '-' | '—' | '.' | '!' | '?')
        )
    {
        return Some(None);
    }
    Some(Some(verdict))
}

/// Extract explicit `Verdict:` clauses outside code. The label must begin a logical
/// line or immediately follow a completed sentence. This accepts common same-line
/// model conclusions without treating examples such as “emit `Verdict: PASS`” as real verdicts.
pub(super) fn explicit_verifier_verdict_clause(line: &str) -> Option<&str> {
    const LABEL: &str = "Verdict:";

    line.match_indices(LABEL).find_map(|(index, _)| {
        if markdown_inline_code_contains(line, index) {
            return None;
        }
        let prefix = line[..index].trim_end();
        let prefix = prefix
            .strip_suffix("**")
            .or_else(|| prefix.strip_suffix("__"))
            .unwrap_or(prefix)
            .trim_end();
        if !prefix.is_empty() && !matches!(prefix.chars().last(), Some('.' | '!' | '?')) {
            return None;
        }
        Some(line[index + LABEL.len()..].trim_start())
    })
}

pub(super) fn markdown_inline_code_contains(line: &str, byte_index: usize) -> bool {
    let mut delimiter_width = None;
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < byte_index {
        if bytes[index] != b'`' {
            index += 1;
            continue;
        }
        let start = index;
        while index < byte_index && bytes[index] == b'`' {
            index += 1;
        }
        let width = index - start;
        match delimiter_width {
            None => delimiter_width = Some(width),
            Some(active) if active == width => delimiter_width = None,
            Some(_) => {}
        }
    }
    delimiter_width.is_some()
}
