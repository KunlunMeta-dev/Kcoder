//! Quote-aware shell syntax, invocation parsing, nested commands, and delegated prefix checks.

use super::*;

/// Retain only unquoted text at the shell-syntax layer. Quoted bodies and comments
/// may contain source such as `|| true` or `set +e`; they do not show that the command suppresses failures.
pub(super) fn shell_unquoted_syntax(command: &str) -> String {
    let mut syntax = String::with_capacity(command.len());
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    let mut comment = false;
    let mut at_word_start = true;

    for character in command.chars() {
        if comment {
            if character == '\n' {
                comment = false;
                syntax.push(character);
                at_word_start = true;
            } else {
                syntax.push(' ');
            }
            continue;
        }
        if escaped {
            syntax.push(' ');
            escaped = false;
            at_word_start = false;
            continue;
        }
        if character == '\\' && !single_quote {
            syntax.push(' ');
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => {
                single_quote = !single_quote;
                syntax.push(' ');
                at_word_start = false;
            }
            '"' if !single_quote => {
                double_quote = !double_quote;
                syntax.push(' ');
                at_word_start = false;
            }
            '#' if !single_quote && !double_quote && at_word_start => {
                comment = true;
                syntax.push(' ');
            }
            _character if single_quote || double_quote => syntax.push(' '),
            character => {
                syntax.extend(character.to_lowercase());
                at_word_start =
                    character.is_whitespace() || matches!(character, ';' | '|' | '&' | '(' | ')');
            }
        }
    }
    syntax
}

pub(super) fn shell_has_unquoted_sequence(syntax: &str, needle: &str) -> bool {
    syntax
        .as_bytes()
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

pub(super) fn shell_has_unquoted_pipe(command: &str) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '|' if !single_quote && !double_quote => return true,
            _ => {}
        }
    }
    false
}

pub(super) fn shell_has_unquoted_control_operator(command: &str) -> bool {
    shell_has_unquoted_character(command, |character| {
        matches!(character, ';' | '\n' | '|' | '&')
    })
}

pub(super) fn shell_has_command_substitution(command: &str) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    let mut characters = command.chars().peekable();
    while let Some(character) = characters.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '`' if !single_quote => return true,
            '$' if !single_quote && characters.peek() == Some(&'(') => return true,
            _ => {}
        }
    }
    false
}

pub(super) fn shell_has_unquoted_variable_expansion(command: &str) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '$' if !single_quote => return true,
            _ => {}
        }
    }
    false
}

pub(super) fn shell_has_unquoted_character(
    command: &str,
    predicate: impl Fn(char) -> bool,
) -> bool {
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            character if !single_quote && !double_quote && predicate(character) => return true,
            _ => {}
        }
    }
    false
}

pub(super) fn shell_has_unquoted_output_redirection(command: &str) -> bool {
    let characters = command.chars().collect::<Vec<_>>();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for (index, character) in characters.iter().copied().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            '>' if !single_quote && !double_quote => {
                let mut target_index = index + 1;
                if characters.get(target_index) == Some(&'>')
                    || characters.get(target_index) == Some(&'|')
                {
                    target_index += 1;
                }
                while characters
                    .get(target_index)
                    .is_some_and(|value| value.is_whitespace())
                {
                    target_index += 1;
                }
                if characters.get(target_index) == Some(&'&')
                    || characters.get(target_index) == Some(&'(')
                {
                    continue;
                }
                let target = characters[target_index..]
                    .iter()
                    .take_while(|value| !value.is_whitespace() && !matches!(value, ';' | '&' | '|'))
                    .collect::<String>()
                    .trim_matches(['\'', '"'])
                    .to_ascii_lowercase();
                if !matches!(
                    target.as_str(),
                    "/dev/null"
                        | "/dev/stdout"
                        | "/dev/stderr"
                        | "/proc/self/fd/1"
                        | "/proc/self/fd/2"
                        | "nul"
                        | "nul:"
                ) && !target.starts_with("/tmp/")
                    && !target.starts_with("$tmpdir/")
                    && !target.starts_with("${tmpdir}/")
                {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ShellCommandInvocation {
    pub(super) program: String,
    pub(super) args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum DockerExecNestedCommand {
    Shell(String),
    Direct(ShellCommandInvocation),
}

/// Extract the command actually run by `docker exec` or `podman exec`. Target
/// tests may live inside a task container while the host Bash exit code still
/// equals the container command's exit code. Auditing only the outer `docker`
/// would make machine gates misclassify a real pytest run as no test execution.
pub(super) fn docker_exec_nested_command(
    invocation: &ShellCommandInvocation,
) -> Option<DockerExecNestedCommand> {
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    if !matches!(program, "docker" | "podman") || invocation.args.first()? != "exec" {
        return None;
    }

    let mut index = 1usize;
    while let Some(argument) = invocation.args.get(index) {
        if argument == "--" {
            index += 1;
            break;
        }
        if !argument.starts_with('-') || argument == "-" {
            break;
        }
        let consumes_value = matches!(
            argument.as_str(),
            "-e" | "--env" | "--env-file" | "--detach-keys" | "-u" | "--user" | "-w" | "--workdir"
        );
        index += 1;
        if consumes_value {
            index += 1;
        }
    }

    // Container name.
    index += 1;
    let nested_program = invocation.args.get(index)?.clone();
    let nested_args = invocation.args.get(index + 1..)?.to_vec();
    let basename = nested_program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(nested_program.as_str());
    if matches!(basename, "bash" | "sh" | "dash" | "zsh" | "ksh")
        && let Some(command_index) = nested_args
            .iter()
            .position(|argument| matches!(argument.as_str(), "-c" | "-lc"))
        && let Some(command) = nested_args.get(command_index + 1)
    {
        return Some(DockerExecNestedCommand::Shell(command.clone()));
    }

    Some(DockerExecNestedCommand::Direct(ShellCommandInvocation {
        program: nested_program,
        args: nested_args,
    }))
}

pub(super) fn test_command_invocations(command: &str) -> Vec<ShellCommandInvocation> {
    test_command_invocations_inner(command, 0)
}

pub(super) fn test_command_invocations_inner(
    command: &str,
    depth: usize,
) -> Vec<ShellCommandInvocation> {
    let mut tests = Vec::new();
    for invocation in shell_command_invocations(command) {
        if test_invocation(&invocation) {
            tests.push(invocation.clone());
        }
        if depth >= 4 {
            continue;
        }
        match docker_exec_nested_command(&invocation) {
            Some(DockerExecNestedCommand::Shell(command)) => {
                tests.extend(test_command_invocations_inner(&command, depth + 1));
            }
            Some(DockerExecNestedCommand::Direct(command)) if test_invocation(&command) => {
                tests.push(command);
            }
            _ => {}
        }
    }
    tests
}

/// Treat only the first command word after a shell control operator as a program,
/// avoiding false execution matches for `find -name install` or paths containing `patch`.
pub(super) fn shell_command_invocations(command: &str) -> Vec<ShellCommandInvocation> {
    split_unquoted_shell_segments(command)
        .into_iter()
        .filter_map(|segment| shell_segment_invocation(&segment))
        .collect()
}

pub(super) fn split_unquoted_shell_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            current.push(character);
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => {
                single_quote = !single_quote;
                current.push(character);
            }
            '"' if !single_quote => {
                double_quote = !double_quote;
                current.push(character);
            }
            ';' | '\n' | '|' | '&' if !single_quote && !double_quote => {
                if !current.trim().is_empty() {
                    segments.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        segments.push(current);
    }
    segments
}

pub(super) fn shell_segment_invocation(segment: &str) -> Option<ShellCommandInvocation> {
    let tokens = shell_words(segment)?;
    let mut index = 0usize;
    while index < tokens.len()
        && (shell_assignment(&tokens[index]) || shell_redirection_token(&tokens[index]))
    {
        index += 1;
    }
    loop {
        let wrapper_token = tokens.get(index)?;
        let wrapper = wrapper_token
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(wrapper_token.as_str());
        match wrapper {
            "command" | "builtin" | "exec" | "nohup" => {
                index += 1;
                while tokens
                    .get(index)
                    .is_some_and(|token| token.starts_with('-'))
                {
                    index += 1;
                }
            }
            "env" => {
                index += 1;
                while let Some(token) = tokens.get(index) {
                    if shell_assignment(token) {
                        index += 1;
                        continue;
                    }
                    if matches!(token.as_str(), "-u" | "--unset" | "-C" | "--chdir") {
                        // These env options consume a value; do not mistake the variable name or directory for the program that follows.
                        index = index.saturating_add(2);
                        continue;
                    }
                    if token.starts_with("--unset=")
                        || token.starts_with("--chdir=")
                        || token.starts_with('-')
                    {
                        index += 1;
                        continue;
                    }
                    break;
                }
            }
            "timeout" => {
                index += 1;
                while tokens
                    .get(index)
                    .is_some_and(|token| token.starts_with('-'))
                {
                    index += 1;
                }
                // The first non-option timeout argument is the duration; the actual program follows it.
                index = index.saturating_add(1);
            }
            _ => break,
        }
    }
    let program = tokens.get(index)?.clone();
    Some(ShellCommandInvocation {
        program,
        args: tokens[index + 1..].to_vec(),
    })
}

/// Parse simple shell words for verifier auditing while preserving spaces inside
/// quotes and Python `-c` bodies. Fail closed on unclosed quotes; an earlier guard
/// continues to reject complex shell syntax.
pub(crate) fn shell_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    for character in command.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && !single_quote {
            escaped = true;
            continue;
        }
        match character {
            '\'' if !double_quote => single_quote = !single_quote,
            '"' if !single_quote => double_quote = !double_quote,
            character if character.is_whitespace() && !single_quote && !double_quote => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if escaped || single_quote || double_quote {
        return None;
    }
    if !current.is_empty() {
        words.push(current);
    }
    Some(words)
}

pub(super) fn shell_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().enumerate().all(|(index, character)| {
            character == '_'
                || character.is_ascii_alphanumeric() && (index > 0 || !character.is_ascii_digit())
        })
}

pub(super) fn shell_redirection_token(token: &str) -> bool {
    token.starts_with('<')
        || token.starts_with('>')
        || token
            .split_once(['<', '>'])
            .is_some_and(|(prefix, _)| prefix.chars().all(|character| character.is_ascii_digit()))
}

pub(super) fn scoped_shell_command_is_read_only(command: &str) -> bool {
    super::read_only::shell_command_is_read_only(command)
}

/// Check that a restricted implementer's command is entirely within prefixes explicitly delegated by the parent orchestrator.
///
/// This is not a complete shell parser, so it fails closed on host output
/// redirection, command substitution, unclosed quotes, or unauthorized top-level
/// command segments. External commands receive single-quoted content without host
/// expansion; input redirection may pass an authorized staged file into a container.
pub fn scoped_shell_command_matches_allowed_prefixes(
    command: &str,
    allowed_prefixes: &[String],
) -> bool {
    if allowed_prefixes.is_empty() {
        return false;
    }
    let Some(segments) = delegated_shell_segments(command) else {
        return false;
    };
    !segments.is_empty()
        && segments.iter().all(|segment| {
            scoped_shell_segment_is_read_only(segment)
                || allowed_prefixes
                    .iter()
                    .any(|prefix| shell_segment_has_literal_prefix(segment, prefix))
        })
}

pub(super) fn shell_segment_has_literal_prefix(segment: &str, prefix: &str) -> bool {
    let segment = segment.trim_matches([' ', '\t', '\n']);
    let prefix = prefix.trim_matches([' ', '\t', '\n']);
    !prefix.is_empty()
        && (segment == prefix
            || segment
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with([' ', '\t', '\n'])))
}

pub(super) fn delegated_shell_segments(command: &str) -> Option<Vec<String>> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut single_quote = false;
    let mut double_quote = false;
    let mut escaped = false;
    let characters = command.chars().collect::<Vec<_>>();
    let mut index = 0usize;
    while index < characters.len() {
        let character = characters[index];
        if escaped {
            current.push(character);
            escaped = false;
            index += 1;
            continue;
        }
        if character == '\\' && !single_quote {
            current.push(character);
            escaped = true;
            index += 1;
            continue;
        }
        match character {
            '\'' if !double_quote => {
                single_quote = !single_quote;
                current.push(character);
            }
            '"' if !single_quote => {
                double_quote = !double_quote;
                current.push(character);
            }
            '`' if !single_quote => return None,
            '$' if !single_quote
                && characters
                    .get(index + 1)
                    .is_some_and(|next| matches!(next, '(' | '{')) =>
            {
                return None;
            }
            '>' if !single_quote && !double_quote => return None,
            '<' if !single_quote
                && !double_quote
                && characters.get(index + 1).is_some_and(|next| *next == '(') =>
            {
                return None;
            }
            ';' | '|' | '&' | '\n' if !single_quote && !double_quote => {
                if character == '&' && characters.get(index + 1) != Some(&'&') {
                    return None;
                }
                if !current.trim_matches([' ', '\t', '\n']).is_empty() {
                    segments.push(std::mem::take(&mut current));
                }
                if matches!(character, '|' | '&')
                    && characters
                        .get(index + 1)
                        .is_some_and(|next| *next == character)
                {
                    index += 1;
                }
            }
            _ => current.push(character),
        }
        index += 1;
    }
    if escaped || single_quote || double_quote {
        return None;
    }
    if !current.trim_matches([' ', '\t', '\n']).is_empty() {
        segments.push(current);
    }
    Some(segments)
}

pub(super) fn scoped_shell_segment_is_read_only(segment: &str) -> bool {
    super::read_only::shell_segment_is_read_only(segment)
}
