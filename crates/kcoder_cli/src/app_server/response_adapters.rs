//! Response adapters: extracted from the app-server connection boundary.

use super::*;

pub(super) use kcoder_app_events::now_millis;

/// Serialize one outbound frame under the gateway's line-delimited limit.
///
/// The Studio gateway rejects app-server frames larger than 2 MiB and (before
/// the broker resilience fix) tore down every client of the workspace. Keep
/// responses attributable by degrading them to a structured error with the
/// same id. Desktop observations can shed their preview or image before an
/// oversized completion would otherwise be dropped.
pub(super) fn bounded_outbound_frame(mut message: Value, limit: usize) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(&message).ok()?;
    if bytes.len() <= limit {
        return Some(bytes);
    }
    if message["method"] == "item/completed"
        && let Some(item) = message.pointer_mut("/params/item")
        && item["name"]
            .as_str()
            .is_some_and(kcoder_types::computer_use::is_desktop_screenshot_tool)
        && item["outputImages"]
            .as_array()
            .is_some_and(|images| !images.is_empty())
    {
        let preview = item["output"].take();
        let truncated = std::mem::replace(&mut item["outputTruncated"], Value::Bool(true));
        let without_preview = serde_json::to_vec(&message).ok()?;
        if without_preview.len() <= limit {
            return Some(without_preview);
        }
        // Keep the completion event even when its screenshot cannot fit.
        let item = message.pointer_mut("/params/item")?;
        item["outputImages"] = json!([]);
        item["outputImagesOmitted"] = Value::Bool(true);
        item["output"] = preview;
        item["outputTruncated"] = truncated;
        let without_image = serde_json::to_vec(&message).ok()?;
        if without_image.len() <= limit {
            return Some(without_image);
        }
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
