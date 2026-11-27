use serde_json::Value;

pub const MAX_ATTACHMENTS_PER_TURN: usize = 32;
pub const KCODER_ATTACHMENTS_OPEN: &str = "<kcoder_attachments version=\"1\">\n";
pub const KCODER_ATTACHMENTS_CLOSE: &str = "\n</kcoder_attachments>";

pub fn split_history_attachment_envelope(content: String) -> (String, Vec<Value>) {
    let Some(open_index) = content.rfind(KCODER_ATTACHMENTS_OPEN) else {
        return (content, Vec::new());
    };
    if !content.ends_with(KCODER_ATTACHMENTS_CLOSE) {
        return (content, Vec::new());
    }
    let body_start = open_index + KCODER_ATTACHMENTS_OPEN.len();
    let body_end = content.len() - KCODER_ATTACHMENTS_CLOSE.len();
    let lines = content[body_start..body_end].lines().collect::<Vec<_>>();
    if lines.is_empty() || lines.len() > MAX_ATTACHMENTS_PER_TURN {
        return (content, Vec::new());
    }
    let mut attachments = Vec::with_capacity(lines.len());
    for (index, line) in lines.into_iter().enumerate() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return (content, Vec::new());
        };
        let Some(object) = record.as_object() else {
            return (content, Vec::new());
        };
        if !object.get("filename").is_some_and(Value::is_string)
            || !object.get("path").is_some_and(Value::is_string)
        {
            return (content, Vec::new());
        }
        attachments.push(serde_json::json!({
            "id": format!("attachment-{index}"),
            "type": "attachment",
            "status": "done",
            "attachment": record,
        }));
    }
    (content[..open_index].trim_end().to_string(), attachments)
}
