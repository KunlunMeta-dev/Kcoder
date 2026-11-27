use kcoder_engine::WriteInputPreview;

const WRITE_PREVIEW_PAYLOAD_PREFIX: &str = "[Write input preview] ";

pub(crate) fn format_write_preview_message(header: &str, preview: &WriteInputPreview) -> String {
    let payload = serde_json::to_string(preview).unwrap_or_default();
    format!("{header}\n{WRITE_PREVIEW_PAYLOAD_PREFIX}{payload}")
}

pub(crate) fn parse_write_preview_message(text: &str) -> Option<WriteInputPreview> {
    let payload = text
        .lines()
        .nth(1)?
        .strip_prefix(WRITE_PREVIEW_PAYLOAD_PREFIX)?;
    serde_json::from_str(payload).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_message_round_trips_without_exposing_raw_payload_lines() {
        let preview = WriteInputPreview {
            path: Some("src/demo.rs".to_string()),
            lines: vec!["fn main() {}".to_string()],
            first_line_number: 7,
            total_lines: 7,
            complete: false,
        };
        let message = format_write_preview_message("[Tool use: write]", &preview);

        assert_eq!(parse_write_preview_message(&message), Some(preview));
        assert_eq!(message.lines().count(), 2);
    }
}
