fn make_msg(role: MessageRole, text: &str) -> DisplayMessage {
    DisplayMessage {
        role,
        text: text.to_string(),
    }
}

fn lines_to_plain_text(lines: &[Line<'_>]) -> String {
    lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
