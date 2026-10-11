//! Verifier command recognition, workdir/environment guards, scope, and raw-exit rules.

use super::*;

pub(crate) fn test_like_command(command: &str) -> bool {
    !test_command_invocations(command).is_empty()
}

pub(crate) fn test_command_signature(command: &str) -> Option<String> {
    let invocation = test_command_invocations(command).into_iter().next()?;
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    let mut args = invocation.args.iter().map(String::as_str).peekable();
    let is_pytest = program == "pytest"
        || python_interpreter_program(program)
            && invocation
                .args
                .windows(2)
                .any(|window| window == ["-m", "pytest"]);
    let mut canonical_args = Vec::with_capacity(invocation.args.len());
    while let Some(arg) = args.next() {
        if is_pytest
            && arg == "-p"
            && args
                .peek()
                .is_some_and(|plugin| *plugin == "no:cacheprovider")
        {
            // A read-only baseline cannot write `.pytest_cache`. Disabling cacheprovider does
            // not change test selection or assertion semantics, so it may pair with the same
            // candidate test even when that test does not disable caching explicitly.
            args.next();
            continue;
        }
        canonical_args.push(arg);
    }
    Some(
        std::iter::once(program)
            .chain(canonical_args)
            .collect::<Vec<_>>()
            .join("\u{1f}"),
    )
}

pub(crate) fn verification_like_command(command: &str) -> bool {
    verification_like_command_inner(command, 0)
}

pub(super) fn verification_like_command_inner(command: &str, depth: usize) -> bool {
    let invocations = shell_command_invocations(command);
    if test_like_command(command) {
        return true;
    }
    if invocations.iter().any(|invocation| {
        python_interpreter_program(&invocation.program)
            && invocation.args.iter().any(|arg| arg == "-c")
    }) {
        return true;
    }
    if depth < 4
        && invocations.iter().any(|invocation| {
            let program = invocation
                .program
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(invocation.program.as_str());
            matches!(program, "bash" | "sh" | "dash" | "zsh" | "ksh")
                && invocation
                    .args
                    .windows(2)
                    .find(|window| window[0] == "-c")
                    .is_some_and(|window| verification_like_command_inner(&window[1], depth + 1))
        })
    {
        return true;
    }
    let syntax = shell_unquoted_syntax(command);
    [
        "cargo check",
        "cargo build",
        "cargo clippy",
        "npm run build",
        "pnpm build",
        "yarn build",
        "tsc",
        "eslint",
    ]
    .iter()
    .any(|needle| syntax.contains(needle))
}

pub(super) fn python_interpreter_program(program: &str) -> bool {
    let basename = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let basename = basename.strip_suffix(".exe").unwrap_or(&basename);
    ["python", "pypy"].iter().any(|prefix| {
        basename.strip_prefix(prefix).is_some_and(|suffix| {
            suffix.is_empty()
                || suffix
                    .chars()
                    .all(|character| character.is_ascii_digit() || character == '.')
                    && suffix.chars().any(|character| character.is_ascii_digit())
        })
    })
}

/// Recognize only a grep/rg query without wrappers, control operators, or redirection.
/// Exit 1 with no output means no matches for such a command, not verification failure.
pub(crate) fn read_only_search_no_match_command(command: &str) -> bool {
    if shell_has_unquoted_control_operator(command)
        || shell_has_unquoted_redirection(command)
        || shell_has_command_substitution(command)
        || command_may_mask_failure(command)
    {
        return false;
    }
    let Some(words) = shell_words(command.trim()) else {
        return false;
    };
    let Some(program) = words.first() else {
        return false;
    };
    matches!(
        program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(program.as_str()),
        "grep" | "rg"
    )
}

/// Treat only directly executed inline Python checks as behavior probes. Text
/// searches, diffs, and ordinary inspection commands cannot prove that a candidate
/// patch changed runtime behavior.
pub(crate) fn behavior_probe_command(command: &str) -> bool {
    if test_like_command(command)
        || shell_has_unquoted_pipe(command)
        || command_may_mask_failure(command)
        || shell_has_unquoted_redirection(command)
        || dependency_mutation_command(command)
        || baseline_mutation_command(command)
    {
        return false;
    }
    let invocations = shell_command_invocations(command);
    if invocations.len() != 1 {
        return false;
    }
    let invocation = &invocations[0];
    if invocation.program.contains(['/', '\\']) {
        return false;
    }
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    python_interpreter_program(program)
        && invocation.args.first().is_some_and(|arg| arg == "-c")
        && invocation
            .args
            .get(1)
            .is_some_and(|code| behavior_probe_python_code_is_safe(code))
}

/// Behavioral-difference evidence must come from target API results, not candidate
/// or baseline source, paths, environments, or process fingerprints. This deliberately
/// fails closed: keywords cannot prove dynamic Python code is read-only, but known file,
/// reflection, evaluation, and process entry points can be rejected. Workspace
/// fingerprints and Landlock provide post-execution write defenses.
pub(super) fn behavior_probe_python_code_is_safe(code: &str) -> bool {
    let normalized = code.to_ascii_lowercase();
    if normalized.trim().is_empty() {
        return false;
    }
    const FORBIDDEN: &[&str] = &[
        "pathlib",
        "read_text",
        "read_bytes",
        "write_text",
        "write_bytes",
        "open(",
        "io.open",
        "os.open",
        "os.getcwd",
        "os.getcwdb",
        "os.chdir",
        "os.environ",
        "getenv(",
        "__file__",
        "__code__",
        "inspect",
        "getsource",
        "linecache",
        "subprocess",
        "os.system",
        "os.popen",
        "shlex",
        "compile(",
        "eval(",
        "exec(",
        "globals(",
        "locals(",
        "vars(",
        "dir(",
        "getattr(",
        "setattr(",
        "delattr(",
        "__import__(",
        "importlib",
        "pkgutil",
        "sys.modules",
        "sys.path",
        "sys.argv",
        "sys.executable",
        "platform.",
        "socket",
        "requests",
        "urllib",
        "http.client",
        "tempfile",
        "shutil",
        "marshal",
    ];
    if FORBIDDEN.iter().any(|needle| normalized.contains(needle)) {
        return false;
    }

    // A sentinel may wrap only expected domain exceptions from the target API; it
    // cannot disguise missing dependencies, ABI problems, or other infrastructure
    // failures as behavioral differences. Apply a conservative lexical gate to inline
    // Python: imports must precede the try block, and broad, import, or process exceptions are rejected.
    if let Some(try_offset) = normalized.find("try:") {
        let guarded = &normalized[try_offset + "try:".len()..];
        if guarded.lines().any(|line| {
            let line = line.trim_start_matches([' ', '\t', ';']);
            line.starts_with("import ") || line.starts_with("from ")
        }) {
            return false;
        }
    }
    for clause in normalized.split("except").skip(1) {
        let header = clause.split(':').next().unwrap_or_default().trim();
        if header.is_empty()
            || [
                "exception",
                "baseexception",
                "importerror",
                "modulenotfounderror",
                "oserror",
                "timeouterror",
                "systemexit",
                "keyboardinterrupt",
            ]
            .iter()
            .any(|exception| header.contains(exception))
        {
            return false;
        }
    }
    true
}

pub(crate) fn behavior_probe_command_signature(command: &str) -> Option<String> {
    behavior_probe_command(command).then(|| command.trim().to_string())
}

/// Recognize the sole preparation operation a verifier may execute in a pristine baseline.
///
/// Return the exact signature of a typed recipe instead of generalizing it to an
/// arbitrary build shell. The command must directly invoke tracked Python
/// `setup.py build_ext --inplace`; only parallelism and rebuild behavior may vary.
/// Wrappers, environment assignments, path arguments, pipelines, redirection, and control operators are rejected.
pub(crate) fn verifier_native_build_command_signature(command: &str) -> Option<String> {
    if shell_has_unquoted_control_operator(command)
        || shell_has_unquoted_redirection(command)
        || shell_has_command_substitution(command)
        || command_may_mask_failure(command)
        || dependency_mutation_command(command)
    {
        return None;
    }
    let words = shell_words(command.trim())?;
    let program = words.first()?;
    if program.contains(['/', '\\']) || !python_interpreter_program(program) {
        return None;
    }
    let args = &words[1..];
    if !matches!(
        args.first().map(String::as_str),
        Some("setup.py" | "./setup.py")
    ) || args.get(1).map(String::as_str) != Some("build_ext")
    {
        return None;
    }

    let mut inplace = false;
    let mut index = 2usize;
    while let Some(argument) = args.get(index) {
        match argument.as_str() {
            "--inplace" => inplace = true,
            "--force" | "-f" | "--quiet" | "-q" => {}
            "-j" | "--parallel" => {
                index += 1;
                if !args.get(index).is_some_and(|value| {
                    value
                        .parse::<usize>()
                        .is_ok_and(|parallelism| parallelism > 0 && parallelism <= 64)
                }) {
                    return None;
                }
            }
            value
                if value.strip_prefix("-j").is_some_and(|parallelism| {
                    !parallelism.is_empty()
                        && parallelism
                            .parse::<usize>()
                            .is_ok_and(|parallelism| parallelism > 0 && parallelism <= 64)
                }) => {}
            value
                if value
                    .strip_prefix("--parallel=")
                    .is_some_and(|parallelism| {
                        parallelism
                            .parse::<usize>()
                            .is_ok_and(|parallelism| parallelism > 0 && parallelism <= 64)
                    }) => {}
            _ => return None,
        }
        index += 1;
    }
    inplace.then(|| command.trim().to_string())
}

pub(super) fn verifier_native_build_execution_rejection(
    verifier_native_build: bool,
    run_in_background: bool,
) -> Option<String> {
    (run_in_background && verifier_native_build).then(|| {
        "Goal Pro verifier native build guard rejected background execution. Candidate and baseline preparation must each complete in the foreground so the machine gate can authenticate the raw exit code before any test or behavior probe runs."
            .to_string()
    })
}

/// Bash `workdir` is the sole source of verifier execution provenance. Commands
/// may not change directories again or point test selectors at absolute paths;
/// otherwise recorded Candidate/Baseline provenance would diverge from the actual execution directory.
pub(super) fn verifier_workdir_command_rejection(command: &str) -> Option<String> {
    let invocations = shell_command_invocations(command);
    let dynamic_or_compound_shell = shell_has_command_substitution(command)
        || shell_has_unquoted_variable_expansion(command)
        || shell_has_unquoted_character(command, |character| {
            matches!(character, '(' | ')' | '{' | '}')
        })
        || invocations.iter().any(|invocation| {
            matches!(
                invocation.program.as_str(),
                "if" | "then"
                    | "elif"
                    | "else"
                    | "fi"
                    | "for"
                    | "while"
                    | "until"
                    | "case"
                    | "esac"
                    | "select"
                    | "function"
                    | "do"
                    | "done"
            )
        });
    let changes_directory = invocations.iter().any(|invocation| {
        let program = invocation
            .program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(invocation.program.as_str());
        matches!(program, "cd" | "pushd" | "popd" | "source" | "." | "eval")
            || (matches!(program, "bash" | "sh" | "dash" | "zsh" | "ksh")
                && invocation.args.iter().any(|argument| argument == "-c"))
    }) || split_unquoted_shell_segments(command)
        .iter()
        .any(|segment| {
            let Some(words) = shell_words(segment) else {
                return true;
            };
            let Some(first) = words.first() else {
                return false;
            };
            let program = first.rsplit(['/', '\\']).next().unwrap_or(first.as_str());
            program == "env"
                && words.iter().skip(1).any(|word| {
                    matches!(word.as_str(), "-C" | "--chdir") || word.starts_with("--chdir=")
                })
        });
    let escaping_test_selector = invocations
        .iter()
        .filter(|invocation| test_invocation(invocation))
        .any(test_invocation_escapes_workdir);
    let escaping_directory_option = split_unquoted_shell_segments(command)
        .iter()
        .any(|segment| {
            let Some(words) = shell_words(segment) else {
                return true;
            };
            words.windows(2).any(|window| {
                matches!(window[0].as_str(), "-C" | "--directory" | "--chdir")
                    && path_escapes_workdir(&window[1])
            }) || words.iter().any(|word| {
                ["--directory=", "--chdir="]
                    .iter()
                    .any(|prefix| word.strip_prefix(prefix).is_some_and(path_escapes_workdir))
            })
        });
    let protected_environment = verifier_overrides_protected_environment(command);
    if !dynamic_or_compound_shell
        && !changes_directory
        && !escaping_test_selector
        && !escaping_directory_option
        && !protected_environment
    {
        return None;
    }
    Some(
        "Goal Pro verifier workdir guard rejected this command before execution. The authenticated Candidate/Baseline origin comes only from the Bash `workdir` field; use one simple command without shell grouping, command/variable substitution, directory changes, source/eval or shell `-c` wrappers, escaping test selectors, or overrides of verifier runtime variables. Set `workdir` to the intended isolated repository and keep source/test paths relative."
            .to_string(),
    )
}

pub(super) fn test_invocation_escapes_workdir(invocation: &ShellCommandInvocation) -> bool {
    const OUTPUT_PATH_OPTIONS: &[&str] = &[
        "--basetemp",
        "--junitxml",
        "--junit-xml",
        "--html",
        "--cov-report",
    ];
    if Path::new(&invocation.program).is_absolute() || path_escapes_workdir(&invocation.program) {
        return true;
    }
    let mut skip_output_value = false;
    for argument in &invocation.args {
        if skip_output_value {
            skip_output_value = false;
            continue;
        }
        if OUTPUT_PATH_OPTIONS.contains(&argument.as_str()) {
            skip_output_value = true;
            continue;
        }
        if OUTPUT_PATH_OPTIONS
            .iter()
            .any(|option| argument.starts_with(&format!("{option}=")))
        {
            continue;
        }
        let value = argument
            .split_once('=')
            .map_or(argument.as_str(), |(_, value)| value);
        if (Path::new(value).is_absolute() || path_escapes_workdir(value))
            && (!argument.starts_with('-')
                || [
                    "--rootdir",
                    "--confcutdir",
                    "--ignore",
                    "--ignore-glob",
                    "--deselect",
                    "--pyargs",
                ]
                .iter()
                .any(|option| argument.starts_with(option)))
        {
            return true;
        }
    }
    false
}

pub(super) fn path_escapes_workdir(value: &str) -> bool {
    use std::path::Component;

    if value.is_empty() {
        return false;
    }
    let path = Path::new(value);
    if path.is_absolute() || value.starts_with("\\\\") || value.as_bytes().get(1) == Some(&b':') {
        return true;
    }
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::Normal(_) => depth += 1,
            Component::ParentDir if depth == 0 => return true,
            Component::ParentDir => depth -= 1,
            Component::RootDir | Component::Prefix(_) => return true,
            Component::CurDir => {}
        }
    }
    false
}

pub(super) fn verifier_overrides_protected_environment(command: &str) -> bool {
    const PROTECTED: &[&str] = &[
        "PATH",
        "HOME",
        "PWD",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONPYCACHEPREFIX",
        "PYTHONNOUSERSITE",
        "PYTHONDONTWRITEBYTECODE",
        "PYTEST_ADDOPTS",
        "PIP_CACHE_DIR",
        "PIP_CONFIG_FILE",
        "PIP_REQUIRE_VIRTUALENV",
        "NPM_CONFIG_CACHE",
        "CARGO_TARGET_DIR",
        "GIT_OPTIONAL_LOCKS",
        "KCODER_ISOLATED_HOME",
        "KCODER_ISOLATED_CACHE",
        "KCODER_ISOLATED_TMP",
        "KCODER_ISOLATED_PIP_CACHE",
        "KCODER_ISOLATED_NPM_CACHE",
        "KCODER_ISOLATED_PYTHON_CACHE",
        "KCODER_ISOLATED_PYTEST_ADDOPTS",
        "KCODER_ISOLATED_PYTHONPATH",
        "KCODER_VERIFIER_WORKSPACE",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "DYLD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "NODE_PATH",
        "RUBYLIB",
        "CLASSPATH",
    ];
    let protected = |name: &str| {
        PROTECTED
            .iter()
            .any(|protected| protected.eq_ignore_ascii_case(name))
    };
    let dynamic_name = |name: &str| {
        name.chars()
            .any(|character| matches!(character, '$' | '{' | '}' | '*' | '?' | '[' | ']'))
    };
    let verification_command = verification_like_command(command)
        || verifier_native_build_command_signature(command).is_some();
    split_unquoted_shell_segments(command)
        .iter()
        .any(|segment| {
            let Some(words) = shell_words(segment) else {
                return true;
            };
            if verification_command
                && words.iter().any(|word| {
                    word.split_once('=')
                        .is_some_and(|(name, _)| protected(name) || dynamic_name(name))
                        || word
                            .strip_prefix("-u")
                            .is_some_and(|name| !name.is_empty() && protected(name))
                })
            {
                return true;
            }
            let mut index = 0usize;
            while let Some(word) = words.get(index) {
                let Some((name, _)) = word.split_once('=') else {
                    break;
                };
                if protected(name) || dynamic_name(name) {
                    return true;
                }
                index += 1;
            }
            let Some(program) = words
                .get(index)
                .map(|word| word.rsplit(['/', '\\']).next().unwrap_or(word.as_str()))
            else {
                return false;
            };
            match program {
                "export" | "unset" => words.iter().skip(index + 1).any(|word| {
                    let name = word.split_once('=').map_or(word.as_str(), |(name, _)| name);
                    protected(name) || dynamic_name(name)
                }),
                "env" => {
                    let mut env_index = index + 1;
                    while let Some(word) = words.get(env_index) {
                        if matches!(word.as_str(), "-u" | "--unset") {
                            if words.get(env_index + 1).is_some_and(|name| protected(name)) {
                                return true;
                            }
                            env_index += 2;
                            continue;
                        }
                        if let Some(name) = word.strip_prefix("--unset=") {
                            if protected(name) {
                                return true;
                            }
                            env_index += 1;
                            continue;
                        }
                        if let Some((name, _)) = word.split_once('=') {
                            if protected(name) || dynamic_name(name) {
                                return true;
                            }
                            env_index += 1;
                            continue;
                        }
                        if word.starts_with('-') {
                            env_index += 1;
                            continue;
                        }
                        break;
                    }
                    false
                }
                _ => false,
            }
        })
}

pub(crate) fn test_command_has_narrow_scope(command: &str) -> bool {
    test_command_invocations(command)
        .iter()
        .any(test_invocation_has_narrow_scope)
}

pub(super) fn test_invocation_has_narrow_scope(invocation: &ShellCommandInvocation) -> bool {
    if test_invocation_skips_execution(invocation) {
        return true;
    }
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    if program == "cargo" {
        let Some(test_command) = invocation
            .args
            .iter()
            .position(|arg| matches!(arg.as_str(), "test" | "nextest"))
        else {
            return false;
        };
        let mut skip_value = false;
        for token in invocation.args.iter().skip(test_command + 1) {
            if skip_value {
                skip_value = false;
                continue;
            }
            if matches!(
                token.as_str(),
                "-p" | "--package" | "--manifest-path" | "--features" | "--jobs" | "-j"
            ) {
                skip_value = true;
                continue;
            }
            if token == "--" {
                break;
            }
            if token == "--no-run" {
                return true;
            }
            if !token.starts_with('-') {
                return true;
            }
        }
        return false;
    }

    let args = if python_interpreter_program(program) {
        if let Some(pytest_module) = invocation
            .args
            .windows(2)
            .position(|window| window == ["-m", "pytest"])
        {
            &invocation.args[pytest_module + 2..]
        } else if let Some(unittest_module) = invocation
            .args
            .windows(2)
            .position(|window| window == ["-m", "unittest"])
        {
            // Here `-m` is Python's module-launch option, not a pytest marker.
            &invocation.args[unittest_module + 2..]
        } else if let Some(test_script) = invocation.args.iter().position(|arg| {
            arg.ends_with("/bin/test") || arg == "bin/test" || arg.ends_with("runtests.py")
        }) {
            &invocation.args[test_script + 1..]
        } else {
            invocation.args.as_slice()
        }
    } else {
        invocation.args.as_slice()
    };

    args.iter().any(|token| {
        token == "-k"
            || token.starts_with("-k=")
            || token == "--keyword"
            || token.starts_with("--keyword=")
            || token == "-x"
            || token == "--exitfirst"
            || token == "--maxfail"
            || token.starts_with("--maxfail=")
            || token == "-m"
            || token.starts_with("-m=")
            || token == "--deselect"
            || token.starts_with("--deselect=")
            || token == "--ignore"
            || token.starts_with("--ignore=")
            || token == "--ignore-glob"
            || token.starts_with("--ignore-glob=")
            || token == "--collect-only"
            || token == "--collectonly"
            || token == "--co"
            || token == "-co"
            || token == "--lf"
            || token == "--last-failed"
            || token == "--ff"
            || token == "--failed-first"
            || token == "--run"
            || token.starts_with("--run=")
            || token == "-run"
            || token == "-t"
            || token.starts_with("-t=")
            || token == "-g"
            || token == "--grep"
            || token.starts_with("--grep=")
            || token == "--filter"
            || token.starts_with("--filter=")
            || token.starts_with("-Dtest=")
            || token == "--tests"
            || token.starts_with("--tests=")
            || token == "testOnly"
            || token == "--only"
            || token.starts_with("--only=")
            || token == "--name"
            || token.starts_with("--name=")
            || token == "--testnamepattern"
            || token.starts_with("--testnamepattern=")
            || token == "--test-name-pattern"
            || token.starts_with("--test-name-pattern=")
            || token == "--test-skip-pattern"
            || token.starts_with("--test-skip-pattern=")
            || token.contains("::")
            || token
                .strip_prefix("--override-ini=")
                .is_some_and(|value| value.trim_start().starts_with("addopts="))
            || token.strip_prefix("-o").is_some_and(|value| {
                !value.is_empty() && value.trim_start().starts_with("addopts=")
            })
    }) || args.windows(2).any(|window| {
        matches!(window[0].as_str(), "-o" | "--override-ini")
            && window[1].trim_start().starts_with("addopts=")
    })
}

/// Reject commands that only collect, list, show help, or perform setup without
/// running test bodies. Such runner meta-commands often exit 0 but cannot serve as Goal Pro completion evidence.
pub(crate) fn test_command_skips_execution(command: &str) -> bool {
    shell_command_invocations(command)
        .iter()
        .filter(|invocation| test_invocation(invocation))
        .any(test_invocation_skips_execution)
}

pub(super) fn test_invocation_skips_execution(invocation: &ShellCommandInvocation) -> bool {
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str())
        .to_ascii_lowercase();
    let args = invocation
        .args
        .iter()
        .map(|argument| argument.to_ascii_lowercase())
        .collect::<Vec<_>>();

    if args.iter().any(|argument| {
        matches!(
            argument.as_str(),
            "--collect-only"
                | "--collectonly"
                | "--co"
                | "-co"
                | "--no-run"
                | "--help"
                | "-h"
                | "--version"
                | "--fixtures"
                | "--fixtures-per-test"
                | "--setup-only"
                | "--setup-plan"
                | "--list"
                | "--list-tests"
                | "--listtests"
                | "--showconfig"
                | "--dry-run"
        )
    }) {
        return true;
    }

    if args
        .windows(2)
        .any(|window| window[0] == "-x" && window[1] == "test")
    {
        return true;
    }
    if args.iter().any(|argument| {
        matches!(
            argument.as_str(),
            "-dskiptests"
                | "-dskiptests=true"
                | "-dskipits"
                | "-dskipits=true"
                | "-dmaven.test.skip=true"
        ) || argument.starts_with("-list=")
    }) {
        return true;
    }

    (program == "cargo" && invocation.args.iter().any(|argument| argument == "-V"))
        || (program == "ctest" && args.iter().any(|argument| argument == "-n"))
        || ((program == "gradle" || program == "gradlew")
            && args.iter().any(|argument| argument == "-m"))
}

pub(crate) fn test_command_preserves_raw_exit(command: &str) -> bool {
    if shell_has_unquoted_pipe(command) || command_may_mask_failure(command) {
        return false;
    }
    let invocations = shell_command_invocations(command);
    let Some(last_test) = invocations
        .iter()
        .rposition(invocation_preserves_target_test_exit)
    else {
        return false;
    };
    // The ToolResult exit_code for `pytest; echo $?` belongs to echo, not pytest.
    // A leading `cd ... &&` is acceptable, but any command after the test invalidates original-exit-code evidence.
    last_test + 1 == invocations.len()
}

pub(super) fn invocation_preserves_target_test_exit(invocation: &ShellCommandInvocation) -> bool {
    if test_invocation(invocation) {
        return true;
    }
    let Some(nested) = docker_exec_nested_command(invocation) else {
        return false;
    };
    match nested {
        DockerExecNestedCommand::Shell(command) => test_command_preserves_raw_exit(&command),
        DockerExecNestedCommand::Direct(command) => test_invocation(&command),
    }
}

pub(crate) fn verifier_test_command_rejection(
    command: &str,
    minimum_scope: Option<GoalProTestScope>,
    require_raw_exit_code: bool,
) -> Option<String> {
    if !test_like_command(command) {
        return None;
    }
    if require_raw_exit_code && !test_command_preserves_raw_exit(command) {
        return Some(
            "Goal Pro verifier test guard rejected this command before execution because a pipe, failure-masking operator, or trailing command would hide the test process's original exit status. Run the test command directly in this tool call; Bash already returns `exit_code`."
                .to_string(),
        );
    }
    if minimum_scope == Some(GoalProTestScope::TargetSuite)
        && test_command_has_narrow_scope(command)
    {
        return Some(
            "Goal Pro verifier test guard rejected this incomplete or narrowly selected command before execution. The configured `target_suite` scope does not accept fail-fast options (`-x`, `--exitfirst`, `--maxfail`), `-k`, markers, `::test`, test-name filters, or a single Cargo test filter. Run the affected target test module or suite to completion without those selectors."
                .to_string(),
        );
    }
    None
}

pub(super) fn verifier_baseline_command_rejection(
    command: &str,
    invocation_cwd: &Path,
    baseline_root: Option<&Path>,
    allow_behavior_probe: bool,
) -> Option<String> {
    let baseline_root = baseline_root?;
    let invocations = shell_command_invocations(command);
    let test = invocations
        .iter()
        .find(|invocation| test_invocation(invocation));
    let runs_in_baseline = invocation_cwd.starts_with(baseline_root);
    let mentions_baseline = command.contains(&baseline_root.to_string_lossy().to_string());
    if !runs_in_baseline && !mentions_baseline {
        return None;
    }
    let behavior_probe = allow_behavior_probe && behavior_probe_command(command);
    let native_build = verifier_native_build_command_signature(command).is_some();
    if test.is_none() && !behavior_probe && !native_build {
        return Some(
            "Goal Pro verifier baseline guard rejected this command. The pristine baseline is available only for rerunning an actual test command, the exact same typed native build recipe used on the candidate, or, when configured, the exact same direct read-only `python -c` behavior probe; arbitrary inspection, copying, editing, archiving, filtering, and cleanup are forbidden."
                .to_string(),
        );
    }
    if mentions_baseline {
        return Some(if runs_in_baseline {
            "Goal Pro verifier baseline guard rejected a redundant shell-level baseline path. Keep the test selector relative to the pristine baseline workdir and run the exact same command used for the candidate."
                .to_string()
        } else {
            "Goal Pro verifier baseline guard rejected an absolute pristine-baseline path while the Bash workdir was not the baseline. Keep the test selector relative, set the Bash `workdir` field to the pristine baseline, and run the exact same command used for the candidate."
                .to_string()
        });
    }
    if runs_in_baseline && command.contains("kcoder-goal-worktree-") {
        return Some(
            "Goal Pro verifier baseline guard rejected this mixed candidate/baseline command. Run the exact candidate test and exact baseline test as separate Bash calls so their raw results can be paired."
                .to_string(),
        );
    }
    if !native_build && (baseline_mutation_command(command) || dependency_mutation_command(command))
    {
        return Some(
            "Goal Pro verifier baseline guard rejected a mutating baseline command. The engine-provided pristine baseline is read-only and may only run tests."
                .to_string(),
        );
    }
    None
}

pub(super) fn shell_has_unquoted_redirection(command: &str) -> bool {
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
            '<' | '>' if !single_quote && !double_quote => return true,
            _ => {}
        }
    }
    false
}
