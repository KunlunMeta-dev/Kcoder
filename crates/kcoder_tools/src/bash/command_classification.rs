//! Test/dependency/workspace command classification shared with goal and PowerShell tools.

use super::*;

pub(super) fn baseline_mutation_command(command: &str) -> bool {
    shell_command_invocations(command)
        .into_iter()
        .any(|invocation| {
            let program = invocation
                .program
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(invocation.program.as_str());
            let args = invocation.args.as_slice();
            matches!(
                program,
                "rm" | "mv"
                    | "cp"
                    | "mkdir"
                    | "rmdir"
                    | "touch"
                    | "truncate"
                    | "install"
                    | "patch"
                    | "tee"
                    | "chmod"
                    | "chown"
                    | "chgrp"
                    | "ln"
                    | "apply_patch"
            ) || program == "git" && git_invocation_mutates_workspace(args)
                || program == "sed" && args.iter().any(|arg| arg == "-i" || arg.starts_with("-i"))
                || shell_has_unquoted_output_redirection(command)
        })
}

pub(super) fn test_invocation(invocation: &ShellCommandInvocation) -> bool {
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(invocation.program.as_str());
    // Windows resolves npm/pnpm/yarn through `.cmd`/`.bat` shims (execution
    // policy blocks the `.ps1` form) and full-path invocations carry `.exe`.
    let program = program
        .strip_suffix(".cmd")
        .or_else(|| program.strip_suffix(".exe"))
        .or_else(|| program.strip_suffix(".bat"))
        .unwrap_or(program);
    let args = invocation.args.as_slice();
    match program {
        // The program itself is a test runner.
        "pytest" | "py.test" | "tox" | "nox" | "ctest" | "phpunit" | "paratest" | "pest"
        | "rspec" | "prove" | "bats" | "jest" | "vitest" | "mocha" | "jasmine" | "ava" | "tape"
        | "tap" | "uvu" | "Invoke-Pester" => true,
        "cargo" => args
            .first()
            .is_some_and(|arg| matches!(arg.as_str(), "test" | "nextest")),
        _ if python_interpreter_program(program) => {
            args.windows(2)
                .any(|window| window == ["-m", "pytest"] || window == ["-m", "unittest"])
                || args.iter().any(|arg| {
                    arg.ends_with("/bin/test") || arg == "bin/test" || arg.ends_with("runtests.py")
                })
                // `python manage.py test` (Django) and `python setup.py test`
                // (legacy setuptools) are the standard Python test entries.
                || args.windows(2).any(|window| {
                    matches!(window[0].as_str(), "manage.py" | "setup.py") && window[1] == "test"
                })
        }
        "runtests.py" => true,
        "test" => invocation.program.ends_with("/bin/test"),
        "npm" | "pnpm" | "yarn" | "bun" => package_manager_test(args),
        "deno" => args.iter().any(|arg| arg == "test"),
        "make" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "check")),
        "go" => args.first().is_some_and(|arg| arg == "test"),
        "mvn" | "mvnw" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "verify")),
        "gradle" | "gradlew" => args
            .iter()
            .any(|arg| arg == "test" || arg.ends_with(":test")),
        "sbt" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "testOnly")),
        "bazel" | "bazelisk" => args.iter().any(|arg| arg == "test"),
        "lein" => args.iter().any(|arg| arg == "test"),
        "stack" => args.iter().any(|arg| arg == "test"),
        "cabal" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "v2-test")),
        "dotnet" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "vstest")),
        "swift" => args.iter().any(|arg| arg == "test"),
        "mix" => args.iter().any(|arg| arg == "test"),
        "dart" | "flutter" => args.iter().any(|arg| arg == "test"),
        "ninja" => args.iter().any(|arg| arg == "test"),
        "meson" => args.iter().any(|arg| arg == "test"),
        "zig" => args.iter().any(|arg| arg == "test"),
        "dune" => args.iter().any(|arg| arg == "runtest"),
        "nimble" => args.iter().any(|arg| arg == "test"),
        "crystal" => args.iter().any(|arg| arg == "spec"),
        "rebar3" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "eunit" | "ct" | "test")),
        "rake" => args
            .iter()
            .any(|arg| matches!(arg.as_str(), "test" | "spec")),
        "hatch" => args.iter().any(|arg| arg == "test"),
        "pdm" => args.iter().any(|arg| arg == "test"),
        "karma" => args.iter().any(|arg| arg == "start"),
        "cypress" => args.iter().any(|arg| arg == "run"),
        "playwright" => args.iter().any(|arg| arg == "test"),
        "ng" => args.iter().any(|arg| arg == "test"),
        "react-scripts" => args.iter().any(|arg| arg == "test"),
        "node" => node_test_invocation(args),
        "php" => args
            .iter()
            .any(|arg| arg.ends_with("phpunit") || arg.ends_with("pest")),
        // Wrappers that delegate to another command; classify what they run.
        "npx" | "pnpx" | "uv" | "poetry" | "pipenv" | "conda" | "bundle" | "mise" => {
            wrapper_test_invocation(args)
        }
        // Task runners that delegate to a named task.
        "just" | "task" | "nx" => task_runner_test(args),
        "lerna" | "turbo" => args
            .windows(2)
            .any(|window| window[0] == "run" && test_task_name(&window[1])),
        _ => false,
    }
}

/// npm/pnpm/yarn/bun run tests through the `test` script, the `run`/`exec`
/// subcommand with a test task name, or by directly invoking a bundled runner
/// binary (`yarn jest`). Installing a package must never look like a test.
pub(super) fn package_manager_test(args: &[String]) -> bool {
    args.first().is_some_and(|arg| arg == "test")
        || args.windows(2).any(|window| {
            matches!(window[0].as_str(), "run" | "exec") && test_task_name(&window[1])
        })
        || args.first().is_some_and(|arg| test_runner_word(arg))
}

/// Wrappers such as `npx`, `uv run`, `poetry run`, and `bundle exec` execute
/// another command; classify every suffix of their arguments as a potential
/// invocation, mirroring the nested `docker exec` handling.
pub(super) fn wrapper_test_invocation(args: &[String]) -> bool {
    for index in 0..args.len() {
        let invocation = ShellCommandInvocation {
            program: args[index].clone(),
            args: args[index + 1..].to_vec(),
        };
        if test_invocation(&invocation) {
            return true;
        }
    }
    false
}

/// Task runners such as `just`, `task`, and `nx` execute a named task; `test`
/// and `test:*` task names are test runs.
pub(super) fn task_runner_test(args: &[String]) -> bool {
    args.first().is_some_and(|arg| test_task_name(arg))
        || args
            .windows(2)
            .any(|window| window[0] == "run" && test_task_name(&window[1]))
}

pub(super) fn test_task_name(name: &str) -> bool {
    name == "test" || name.starts_with("test:")
}

/// Unambiguous test-runner program names, usable both as a program and as a
/// bare word inside a wrapper invocation (`yarn jest`, `npx playwright test`).
pub(super) fn test_runner_word(word: &str) -> bool {
    matches!(
        word,
        "pytest"
            | "py.test"
            | "tox"
            | "nox"
            | "phpunit"
            | "paratest"
            | "pest"
            | "rspec"
            | "prove"
            | "bats"
            | "jest"
            | "vitest"
            | "mocha"
            | "jasmine"
            | "ava"
            | "tape"
            | "tap"
            | "uvu"
    )
}

/// `node --test` launches the built-in test runner; the flag must sit among
/// node's own options, before the first positional script path. Option values
/// (for example the `tap` in `--test-reporter tap`) are not scripts, so only a
/// path-like argument starts the script boundary. A plain `node <script>`
/// counts only when the script path follows the common JavaScript test-file
/// conventions.
pub(super) fn node_test_invocation(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| !node_script_boundary(arg))
        .any(|arg| arg == "--test")
        || args.iter().any(|arg| node_test_script_argument(arg))
}

/// True for the first positional argument that looks like a script path;
/// anything after it belongs to the script, not to node.
pub(super) fn node_script_boundary(argument: &str) -> bool {
    !argument.starts_with('-')
        && (argument.contains('/') || argument.contains('\\') || argument.contains('.'))
}

/// Recognize `test.js`, `*.test.js`, `*-test.js`, and `*.spec.js` (plus their
/// `.mjs`/`.cjs` forms) as JavaScript test scripts.
pub(super) fn node_test_script_argument(argument: &str) -> bool {
    if argument.starts_with('-') {
        return false;
    }
    let name = argument.rsplit(['/', '\\']).next().unwrap_or(argument);
    let Some(stem) = name
        .strip_suffix(".js")
        .or_else(|| name.strip_suffix(".mjs"))
        .or_else(|| name.strip_suffix(".cjs"))
    else {
        return false;
    };
    stem == "test" || stem.ends_with(".test") || stem.ends_with("-test") || stem.ends_with(".spec")
}

pub(crate) fn dependency_mutation_command(command: &str) -> bool {
    for invocation in shell_command_invocations(command) {
        let program = invocation
            .program
            .rsplit('/')
            .next()
            .unwrap_or(invocation.program.as_str());
        let remaining = invocation.args.as_slice();
        let has_action = |actions: &[&str]| {
            remaining
                .iter()
                .any(|candidate| actions.contains(&candidate.as_str()))
        };
        match program {
            "pip" | "pip3" | "pipx"
                if has_action(&["install", "uninstall", "inject", "upgrade"]) =>
            {
                return true;
            }
            "conda" | "mamba" | "micromamba"
                if has_action(&[
                    "install",
                    "uninstall",
                    "remove",
                    "update",
                    "upgrade",
                    "create",
                ]) =>
            {
                return true;
            }
            "uv" if has_action(&["install", "uninstall", "sync", "add", "remove", "lock"]) => {
                return true;
            }
            "poetry" | "pdm"
                if has_action(&["install", "update", "add", "remove", "sync", "lock"]) =>
            {
                return true;
            }
            "npm" | "pnpm" | "yarn"
                if has_action(&[
                    "install",
                    "i",
                    "ci",
                    "add",
                    "remove",
                    "uninstall",
                    "update",
                    "upgrade",
                ]) =>
            {
                return true;
            }
            "cargo" if has_action(&["install", "uninstall", "update"]) => return true,
            "gem" if has_action(&["install", "uninstall", "update"]) => return true,
            "bundle" | "bundler" if has_action(&["install", "update"]) => return true,
            "apt" | "apt-get" | "dnf" | "yum" | "apk" | "pacman" | "brew"
                if has_action(&[
                    "install",
                    "remove",
                    "uninstall",
                    "update",
                    "upgrade",
                    "add",
                    "del",
                ]) =>
            {
                return true;
            }
            _ if python_interpreter_program(program)
                && remaining.windows(2).any(|window| {
                    window[0] == "pip"
                        && matches!(window[1].as_str(), "install" | "uninstall" | "upgrade")
                }) =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

#[cfg(test)]
pub(crate) fn workspace_mutation_command(command: &str) -> bool {
    if dependency_mutation_command(command) || shell_has_unquoted_output_redirection(command) {
        return true;
    }
    for invocation in shell_command_invocations(command) {
        let program = invocation
            .program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(invocation.program.as_str());
        let args = invocation.args.as_slice();
        match program {
            "rm" | "mv" | "cp" | "mkdir" | "rmdir" | "touch" | "truncate" | "install" | "patch"
            | "tee" | "chmod" | "chown" | "chgrp" | "ln" | "apply_patch" | "set-content"
            | "add-content" | "out-file" | "remove-item" | "move-item" | "copy-item"
            | "new-item" | "rename-item" | "clear-content" => {
                return true;
            }
            "sed" if args.iter().any(|arg| arg == "-i" || arg.starts_with("-i")) => {
                return true;
            }
            "perl" | "ruby"
                if args
                    .iter()
                    .any(|arg| arg == "-pi" || arg.starts_with("-pi")) =>
            {
                return true;
            }
            "git" if git_invocation_mutates_workspace(args) => return true,
            "cargo"
                if args.first().is_some_and(|arg| arg == "fmt")
                    && !args.iter().any(|arg| arg == "--check") =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

pub(super) fn git_invocation_mutates_workspace(args: &[String]) -> bool {
    let Some((index, command)) = args
        .iter()
        .enumerate()
        .find(|(_, arg)| !arg.starts_with('-'))
    else {
        return false;
    };
    if command == "stash" {
        return !matches!(
            args.get(index + 1).map(String::as_str),
            Some("list" | "show")
        );
    }
    matches!(
        command.as_str(),
        "add"
            | "apply"
            | "checkout"
            | "clean"
            | "commit"
            | "merge"
            | "mv"
            | "rebase"
            | "reset"
            | "restore"
            | "rm"
            | "switch"
    )
}
