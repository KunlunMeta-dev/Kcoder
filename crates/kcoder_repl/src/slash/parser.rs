/// Parse a slash command line: returns `(command_name, args)`.
pub fn parse_slash_input(input: &str) -> (&str, &str) {
    let trimmed = input.trim_start();
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let cmd = parts.next().unwrap_or("");
    let args = parts.next().unwrap_or("").trim_start();
    (cmd, args)
}
