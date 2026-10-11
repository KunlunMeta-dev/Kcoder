//! Shared, fail-closed inspection policy for permissions and restricted shell tools.

use super::command_syntax::delegated_shell_segments;

/// Classify complete commands using literal Bash arguments and known program behavior.
pub fn shell_command_is_read_only(command: &str) -> bool {
    delegated_shell_segments(command).is_some_and(|segments| {
        segments
            .iter()
            .all(|segment| shell_segment_is_read_only(segment))
    })
}

pub(super) fn shell_segment_is_read_only(segment: &str) -> bool {
    let Some(words) = literal_words(segment) else {
        return false;
    };
    let Some(program) = words.first() else {
        return true;
    };
    let args = &words[1..];
    match program.as_str() {
        "pwd" | "ls" | "cat" | "head" | "tail" | "wc" | "cut" | "stat" | "du" | "df" | "which"
        | "whereis" | "realpath" | "readlink" | "dirname" | "basename" | "echo" | "grep" | "ps"
        | "uname" | "id" | "whoami" | "printenv" => true,
        "rg" => known_options(
            args,
            "abchilnopqsuvwxFHILNPSUV0",
            "efgjmrtABCEMT",
            RG_OPTIONS,
        ),
        "file" => known_options(args, "bcdEhiklLnNrsSv0", "eFfmP", FILE_OPTIONS),
        "find" => find_arguments_are_read_only(args),
        // Interactive monitors can save configuration; batch output has no such input path.
        "top" => args.iter().any(|arg| arg == "-b" || arg == "--batch-mode"),
        _ => false,
    }
}

/// Decode only literal words. Expansions and shell syntax require explicit authorization.
/// In double quotes Bash preserves backslashes before ordinary characters; empty quoted words are arguments too.
fn literal_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut started = false;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\0' {
            return None;
        }
        match (quote, ch) {
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('\''), ch) => word.push(ch),
            (Some('"'), '\\') => {
                let next = chars.next()?;
                if !matches!(next, '$' | '`' | '"' | '\\' | '\n') {
                    word.push('\\');
                }
                if next != '\n' {
                    word.push(next);
                }
            }
            (_, '\\') => {
                let next = chars.next()?;
                if next != '\n' {
                    word.push(next);
                    started = true;
                }
            }
            (None, '\'' | '"') => {
                quote = Some(ch);
                started = true;
            }
            (_, '$' | '`') => return None,
            (None, ' ' | '\t' | '\n') => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (None, ';' | '|' | '&' | '<' | '>' | '(' | ')' | '{' | '}' | '[' | ']' | '*' | '?') => {
                return None;
            }
            (None, '#' | '~') if !started => return None,
            (_, ch) => {
                word.push(ch);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}

fn known_options(args: &[String], switches: &str, values: &str, long: &[(&str, bool)]) -> bool {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        index += 1;
        if arg == "--" {
            return true;
        }
        if let Some(option) = arg.strip_prefix("--") {
            let (name, value) = option
                .split_once('=')
                .map_or((option, None), |(name, value)| (name, Some(value)));
            let Some((_, takes_value)) = long.iter().find(|(allowed, _)| *allowed == name) else {
                return false;
            };
            if *takes_value && value.is_none() {
                if args.get(index).is_none() {
                    return false;
                }
                index += 1;
            } else if !takes_value && value.is_some() {
                return false;
            }
        } else if let Some(options) = arg.strip_prefix('-').filter(|options| !options.is_empty()) {
            for (offset, flag) in options.char_indices() {
                if values.contains(flag) {
                    if offset + flag.len_utf8() == options.len() {
                        if args.get(index).is_none() {
                            return false;
                        }
                        index += 1;
                    }
                    break;
                }
                if !switches.contains(flag) {
                    return false;
                }
            }
        }
    }
    true
}

fn find_arguments_are_read_only(args: &[String]) -> bool {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        index += 1;
        match arg.as_str() {
            "-H"
            | "-L"
            | "-P"
            | "-depth"
            | "-mount"
            | "-xdev"
            | "-noleaf"
            | "-ignore_readdir_race"
            | "-noignore_readdir_race"
            | "-daystart"
            | "-follow"
            | "-print"
            | "-print0"
            | "-ls"
            | "-prune"
            | "-quit"
            | "-true"
            | "-false"
            | "-empty"
            | "-readable"
            | "-writable"
            | "-executable"
            | "-nouser"
            | "-nogroup"
            | "-a"
            | "-and"
            | "-o"
            | "-or"
            | "-not"
            | "!"
            | "("
            | ")" => {}
            "-name" | "-iname" | "-path" | "-ipath" | "-wholename" | "-iwholename" | "-regex"
            | "-iregex" | "-regextype" | "-type" | "-xtype" | "-maxdepth" | "-mindepth"
            | "-mtime" | "-mmin" | "-atime" | "-amin" | "-ctime" | "-cmin" | "-newer"
            | "-anewer" | "-cnewer" | "-size" | "-perm" | "-user" | "-group" | "-uid" | "-gid"
            | "-inum" | "-links" | "-samefile" => {
                if args.get(index).is_none() {
                    return false;
                }
                index += 1;
            }
            _ if arg.starts_with('-') => return false,
            _ => {}
        }
    }
    true
}

// Options are deliberately enumerated: new/unknown options cannot silently gain an inspection grant.
// Executing preprocessors/hostname helpers and compiling magic databases are excluded.
const FILE_OPTIONS: &[(&str, bool)] = &[
    ("brief", false),
    ("checking-printout", false),
    ("debug", false),
    ("exclude", true),
    ("exclude-quiet", true),
    ("separator", true),
    ("files-from", true),
    ("mime", false),
    ("mime-type", false),
    ("mime-encoding", false),
    ("keep-going", false),
    ("dereference", false),
    ("magic-file", true),
    ("no-buffer", false),
    ("no-pad", false),
    ("no-dereference", false),
    ("parameter", true),
    ("raw", false),
    ("special-files", false),
    ("version", false),
    ("print0", false),
    ("extension", false),
    ("apple", false),
    ("help", false),
];

const RG_OPTIONS: &[(&str, bool)] = &[
    ("regexp", true),
    ("file", true),
    ("glob", true),
    ("ignore-file", true),
    ("iglob", true),
    ("type", true),
    ("type-not", true),
    ("type-add", true),
    ("type-clear", true),
    ("type-list", false),
    ("after-context", true),
    ("before-context", true),
    ("context", true),
    ("context-separator", true),
    ("no-context-separator", false),
    ("max-count", true),
    ("max-columns", true),
    ("max-columns-preview", false),
    ("max-depth", true),
    ("max-filesize", true),
    ("threads", true),
    ("encoding", true),
    ("engine", true),
    ("regex-size-limit", true),
    ("dfa-size-limit", true),
    ("replace", true),
    ("color", true),
    ("colors", true),
    ("sort", true),
    ("sortr", true),
    ("path-separator", true),
    ("field-match-separator", true),
    ("field-context-separator", true),
    ("hyperlink-format", true),
    ("binary", false),
    ("text", false),
    ("byte-offset", false),
    ("column", false),
    ("count", false),
    ("count-matches", false),
    ("crlf", false),
    ("debug", false),
    ("trace", false),
    ("files", false),
    ("files-with-matches", false),
    ("files-without-match", false),
    ("fixed-strings", false),
    ("follow", false),
    ("heading", false),
    ("no-heading", false),
    ("hidden", false),
    ("ignore-case", false),
    ("case-sensitive", false),
    ("smart-case", false),
    ("invert-match", false),
    ("json", false),
    ("line-buffered", false),
    ("block-buffered", false),
    ("line-number", false),
    ("no-line-number", false),
    ("line-regexp", false),
    ("word-regexp", false),
    ("multiline", false),
    ("multiline-dotall", false),
    ("no-multiline", false),
    ("null", false),
    ("null-data", false),
    ("only-matching", false),
    ("pcre2", false),
    ("no-pcre2", false),
    ("pcre2-version", false),
    ("pretty", false),
    ("quiet", false),
    ("stats", false),
    ("no-stats", false),
    ("trim", false),
    ("no-trim", false),
    ("unrestricted", false),
    ("with-filename", false),
    ("no-filename", false),
    ("no-messages", false),
    ("no-config", false),
    ("no-ignore", false),
    ("no-ignore-vcs", false),
    ("no-ignore-dot", false),
    ("no-ignore-global", false),
    ("no-ignore-parent", false),
    ("no-ignore-exclude", false),
    ("no-require-git", false),
    ("one-file-system", false),
    ("help", false),
    ("version", false),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_and_carriage_return_are_literal_bash_characters() {
        for command in ["cat\u{a0}other", "\u{a0}", "cat\rother"] {
            assert!(!shell_command_is_read_only(command), "{command:?}");
        }
        assert_eq!(literal_words("cat a\u{a0}b").unwrap(), ["cat", "a\u{a0}b"]);
        assert!(
            !super::super::command_syntax::scoped_shell_command_matches_allowed_prefixes(
                "docker exec exact\u{a0}other",
                &["docker exec exact".into()]
            )
        );
    }

    #[test]
    fn literal_words_follow_bash_quote_and_escape_semantics() {
        assert_eq!(
            literal_words(r#"rg '' a\ b '--pre' --p\re "--p\re""#).unwrap(),
            ["rg", "", "a b", "--pre", "--pre", r"--p\re"]
        );
        assert_eq!(literal_words("r\\\ng --p\\\nre").unwrap(), ["rg", "--pre"]);
        assert_eq!(
            literal_words("cat '$HOME' \"\\$HOME\"").unwrap(),
            ["cat", "$HOME", "$HOME"]
        );
        for command in [
            "cat $HOME",
            "cat \"$HOME\"",
            "cat *.txt",
            "rg $'--pre' helper",
            "cat 'unclosed",
        ] {
            assert!(literal_words(command).is_none(), "{command}");
        }
    }
}
