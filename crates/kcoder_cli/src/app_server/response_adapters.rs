//! Response adapters: extracted from the app-server connection boundary.

use super::*;

pub(super) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Serialize one outbound frame under the gateway's line-delimited limit.
///
/// The Studio gateway rejects app-server frames larger than 2 MiB and (before
/// the broker resilience fix) tore down every client of the workspace. Keep
/// responses attributable by degrading them to a structured error with the
/// same id; oversized notifications are unrecoverable and are dropped.
pub(super) fn bounded_outbound_frame(message: Value, limit: usize) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(&message).ok()?;
    if bytes.len() <= limit {
        return Some(bytes);
    }
    if let Some(id) = message.get("id").cloned().filter(|value| !value.is_null()) {
        tracing::warn!(
            bytes = bytes.len(),
            limit,
            "outbound app-server frame exceeded the transport limit"
        );
        let replacement = error_response(
            id,
            OUTBOUND_FRAME_LIMIT_CODE,
            "app-server response exceeds the transport frame limit",
        );
        return serde_json::to_vec(&replacement).ok();
    }
    tracing::warn!(
        bytes = bytes.len(),
        limit,
        method = message
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown"),
        "dropping oversized outbound app-server notification"
    );
    None
}

pub(super) fn turn_file_changes_review_payload(diff: String, limit: usize) -> Value {
    // `truncate_utf8_bytes` 的第三个返回值是字符数（original_chars），字节数必须
    // 在这里自行计算，否则非 ASCII diff 的 diffOriginalBytes 会误报。
    let diff_original_bytes = diff.len();
    let (diff, diff_truncated, _) = truncate_utf8_bytes(diff, limit);
    json!({
        "success": true,
        "diff": diff,
        "diffTruncated": diff_truncated,
        "diffOriginalBytes": diff_original_bytes,
    })
}
