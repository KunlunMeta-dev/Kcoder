//! List continuation and fenced-code language helpers.

use super::*;

pub(super) fn list_continuation_prefix_for(kind: ListKind, depth: usize) -> String {
    let marker_width = depth.saturating_mul(4).saturating_sub(3).max(1);
    let indent = match kind {
        ListKind::Bullet => marker_width.saturating_add(1),
        ListKind::Ordered => marker_width.saturating_add(2),
    };
    " ".repeat(indent)
}

pub(super) fn code_fence_language_token(info: &str) -> &str {
    info.split([',', ' ', '\t'])
        .next()
        .filter(|token| !token.is_empty())
        .unwrap_or("")
}
