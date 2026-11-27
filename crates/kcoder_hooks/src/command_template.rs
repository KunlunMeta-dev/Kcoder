//! Bind untrusted template values as data, without inserting them into shell source.

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum CommandShell {
    Posix,
    PowerShell,
    Other,
}

#[derive(Clone, Copy, PartialEq)]
enum Quote {
    None,
    Single,
    Double,
}

pub(crate) struct CommandTemplate {
    pub(crate) command: String,
    pub(crate) environment: Vec<(String, String)>,
}

/// Complex shell syntax must use the existing JSON stdin interface instead.
pub(crate) fn render(
    template: &str,
    shell: CommandShell,
    mut resolve: impl FnMut(Option<&str>) -> Option<String>,
) -> Result<CommandTemplate, String> {
    let placeholders: Vec<_> = super::execution::hook_placeholder_regex()
        .captures_iter(template)
        .map(|capture| {
            let span = capture.get(0).unwrap();
            (
                span.start(),
                span.end(),
                capture.get(1).map(|key| key.as_str()),
            )
        })
        .collect();
    let mut result = CommandTemplate {
        command: String::new(),
        environment: Vec::new(),
    };
    if placeholders.is_empty() {
        result.command = template.to_owned();
        return Ok(result);
    }
    let invalid = || {
        "unsupported hook template context; pass hook data through JSON stdin instead".to_owned()
    };
    if shell == CommandShell::Other {
        return Err(invalid());
    }
    let mut quote = Quote::None;
    let mut index = 0;
    let mut placeholder = 0;
    let mut command_word = true;
    let mut in_word = false;
    while index < template.len() {
        if let Some(&(start, end, key)) = placeholders.get(placeholder)
            && start == index
        {
            if command_word {
                return Err(invalid());
            }
            if shell == CommandShell::PowerShell && quote == Quote::None {
                let previous = template[..index].chars().next_back();
                let next = template[end..].chars().next();
                if previous.is_some_and(|ch| !ch.is_whitespace())
                    || next.is_some_and(|ch| !ch.is_whitespace() && !matches!(ch, ';' | '|'))
                {
                    return Err(invalid());
                }
            }
            let value =
                resolve(key).ok_or_else(|| "unknown hook template placeholder".to_owned())?;
            if value.contains('\0') {
                return Err("hook template value contains NUL".to_owned());
            }
            let name = format!("KCODER_HOOK_ARG_{}", result.environment.len());
            let reference = match shell {
                CommandShell::PowerShell => format!("${{env:{name}}}"),
                _ => format!("${{{name}}}"),
            };
            match (shell, quote) {
                (CommandShell::Posix, Quote::None) => {
                    result.command.push_str(&format!("\"{reference}\""))
                }
                (CommandShell::Posix, Quote::Single) => {
                    result.command.push_str(&format!("'\"{reference}\"'"))
                }
                _ => result.command.push_str(&reference),
            }
            result.environment.push((name, value));
            in_word = true;
            index = end;
            placeholder += 1;
            continue;
        }
        let rest = &template[index..];
        let ch = rest.chars().next().unwrap();
        let next = &rest[ch.len_utf8()..];
        if shell == CommandShell::PowerShell && matches!(ch, '\u{2018}'..='\u{201f}') {
            return Err(invalid());
        }
        let escape = if shell == CommandShell::Posix {
            '\\'
        } else {
            '`'
        };
        if ch == escape && quote != Quote::Single {
            if placeholders
                .get(placeholder)
                .is_some_and(|span| span.0 == index + ch.len_utf8())
            {
                return Err(invalid());
            }
            let escaped = next.chars().next().ok_or_else(invalid)?;
            result.command.push(ch);
            result.command.push(escaped);
            if escaped != '\n' {
                in_word = true;
            }
            index += ch.len_utf8() + escaped.len_utf8();
            continue;
        }
        if quote != Quote::Single
            && ((ch == '$'
                && (next.starts_with('(') || next.starts_with('{') || next.starts_with('[')))
                || (shell == CommandShell::Posix && ch == '`')
                || (quote == Quote::None && matches!(ch, '(' | ')' | '{' | '}' | '#' | '[' | ']'))
                || (quote == Quote::None && rest.starts_with("<<"))
                || (shell == CommandShell::Posix
                    && ch == '$'
                    && (next.starts_with('\'') || next.starts_with('"')))
                || (shell == CommandShell::PowerShell
                    && quote == Quote::None
                    && matches!(ch, '@' | '&')))
        {
            return Err(invalid());
        }
        if quote == Quote::None && command_word {
            if matches!(ch, '=' | '<' | '>' | '$') {
                return Err(invalid());
            }
            if !in_word {
                let word = rest
                    .split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
                    .next()
                    .unwrap_or_default();
                if matches!(
                    word,
                    "if" | "then"
                        | "else"
                        | "elif"
                        | "while"
                        | "until"
                        | "for"
                        | "do"
                        | "case"
                        | "select"
                        | "function"
                        | "!"
                        | "time"
                        | "exec"
                        | "command"
                        | "builtin"
                        | "let"
                        | "declare"
                        | "typeset"
                        | "."
                ) {
                    return Err(invalid());
                }
            }
        }
        if quote == Quote::None && ch.is_whitespace() {
            if in_word {
                command_word = false;
            }
            in_word = false;
            if ch == '\n' {
                command_word = true;
            }
        } else if quote == Quote::None && matches!(ch, ';' | '|' | '&') {
            command_word = true;
            in_word = false;
        } else {
            in_word = true;
        }
        match (quote, ch) {
            (Quote::None, '\'') => {
                quote = Quote::Single;
                // PowerShell single-quoted literals become escaped expandable strings.
                result.command.push(if shell == CommandShell::PowerShell {
                    '"'
                } else {
                    ch
                });
            }
            (Quote::Single, '\'') => {
                if shell == CommandShell::PowerShell && next.starts_with('\'') {
                    result.command.push('\'');
                    index += 1;
                } else {
                    quote = Quote::None;
                    result.command.push(if shell == CommandShell::PowerShell {
                        '"'
                    } else {
                        ch
                    });
                }
            }
            (Quote::None, '"') => {
                quote = Quote::Double;
                result.command.push(ch);
            }
            (Quote::Double, '"') => {
                quote = Quote::None;
                result.command.push(ch);
            }
            (Quote::Single, '$' | '`' | '"') if shell == CommandShell::PowerShell => {
                result.command.push('`');
                result.command.push(ch);
            }
            _ => result.command.push(ch),
        }
        index += ch.len_utf8();
    }
    if quote != Quote::None {
        return Err(invalid());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ambiguous_template_contexts_before_execution() {
        for template in [
            "$ARGUMENTS",
            "> /dev/null {{query}}",
            "2>/dev/null {{query}}",
            "\\\n {{query}}",
            "let \"{{query}}\"",
            "$KCODER_HOOK_QUERY {{query}}",
            "echo $(echo $ARGUMENTS)",
            "echo ${x:-$ARGUMENTS}",
            "echo `echo $ARGUMENTS`",
            "echo $(( $ARGUMENTS ))",
            "echo $'$ARGUMENTS'",
            "cat <<EOF\n$ARGUMENTS\nEOF",
            "echo \\$ARGUMENTS",
            "echo # $ARGUMENTS",
        ] {
            assert!(
                render(template, CommandShell::Posix, |_| Some("value".into())).is_err(),
                "{template}"
            );
        }
        assert!(
            render("echo $ARGUMENTS", CommandShell::Other, |_| Some(
                "value".into()
            ))
            .is_err()
        );
        assert!(
            render("echo {{query}}", CommandShell::Posix, |_| Some(
                "nul\0value".into()
            ))
            .is_err()
        );
        assert!(render("echo {{missing}}", CommandShell::Posix, |_| None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn quoted_values_remain_literal_in_real_posix_shells() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("injection");
        let value = format!(
            "'\"$(touch {})`touch {}`\\\n中文’{{{{query}}}}$ARGUMENTS",
            marker.display(),
            marker.display()
        );
        for template in [
            "printf %s {{query}}",
            "printf %s \"{{query}}\"",
            "printf %s '{{query}}'",
            "printf %s prefix{{query}}suffix",
        ] {
            let rendered = render(template, CommandShell::Posix, |_| Some(value.clone())).unwrap();
            for shell in ["/bin/sh", "/bin/bash"] {
                let output = std::process::Command::new(shell)
                    .arg("-c")
                    .arg(&rendered.command)
                    .envs(rendered.environment.clone())
                    .output()
                    .unwrap();
                assert!(output.status.success(), "{template}");
                let expected = if template.contains("prefix") {
                    format!("prefix{value}suffix")
                } else {
                    value.clone()
                };
                assert_eq!(output.stdout, expected.as_bytes());
                assert!(!marker.exists());
            }
        }
    }

    #[test]
    fn powershell_templates_bind_values_as_data() {
        let value = "'\"; Write-Output INJECTION; # ’ ‘ ‚ ‛ $(Write-Output INJECTION) ` $ARGUMENTS {{query}}\n中文";
        let mut fixtures = Vec::new();
        for template in [
            "Write-Output {{query}}",
            "Write-Output \"{{query}}\"",
            "Write-Output '{{query}}'",
        ] {
            let rendered = render(template, CommandShell::PowerShell, |_| {
                Some(value.to_owned())
            })
            .unwrap();
            assert!(!rendered.command.contains("INJECTION"));
            fixtures.push(serde_json::json!({ "command": rendered.command, "environment": rendered.environment, "expected": value }));
        }
        println!(
            "KCODER_POWERSHELL_FIXTURE={}",
            serde_json::to_string(&fixtures).unwrap()
        );
    }

    #[test]
    fn powershell_single_quotes_escape_only_trusted_literal_source() {
        let rendered = render(
            "Write-Output 'prefix $literal ` \" {{query}} suffix'",
            CommandShell::PowerShell,
            |_| Some("’ ; injected".into()),
        )
        .unwrap();
        assert_eq!(
            rendered.command,
            "Write-Output \"prefix `$literal `` `\" ${env:KCODER_HOOK_ARG_0} suffix\""
        );
        assert_eq!(rendered.environment[0].1, "’ ; injected");
        assert!(!rendered.command.contains("injected"));
    }
}
