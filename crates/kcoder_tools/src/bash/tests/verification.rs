use super::*;

#[test]
fn verifier_dependency_guard_detects_common_environment_mutations() {
    for command in [
        "pip install -e .",
        "python -m pip uninstall pytest -y",
        "/root/miniconda3/bin/conda install sphinx",
        "uv sync",
        "npm ci",
        "cargo install cargo-nextest",
        "apt-get update",
    ] {
        assert!(dependency_mutation_command(command), "{command}");
    }
    for command in [
        "pytest tests",
        "python -m pytest tests",
        "cargo test --workspace",
        "npm test",
        "git diff -- tests",
        "find . -name pip -o -name install",
        "printf '%s\\n' 'pip install'",
    ] {
        assert!(!dependency_mutation_command(command), "{command}");
    }
    assert!(dependency_mutation_command(
        "cd project && /usr/bin/env PYTHONNOUSERSITE=1 python -m pip install -e ."
    ));
}

#[test]
fn verifier_test_evidence_rejects_filters_and_narrow_selectors() {
    assert!(!test_command_preserves_raw_exit("pytest tests | tail -20"));
    assert!(!test_command_preserves_raw_exit("pytest tests || true"));
    assert!(test_command_preserves_raw_exit("pytest tests -q"));
    assert!(test_command_preserves_raw_exit(
        "env -u PYTHONPATH python -m pytest tests -q"
    ));
    assert!(test_like_command(
        "env --unset=PYTHONPATH python -m pytest tests -q"
    ));
    assert!(test_like_command("python -m unittest discover -s tests"));
    assert!(test_command_preserves_raw_exit(
        "python -m unittest discover -s tests"
    ));
    assert!(test_command_preserves_raw_exit(
        "cd tests && python runtests.py --parallel 1 2>/dev/null"
    ));
    assert!(!test_command_preserves_raw_exit(
        "pytest tests 2>/dev/null; echo $?"
    ));
    assert!(!test_like_command("rg pytest docs && echo pytest"));
    assert!(test_command_has_narrow_scope("pytest tests -k issue_123"));
    assert!(test_command_has_narrow_scope("pytest tests -x"));
    assert!(test_command_has_narrow_scope(
        "python -m pytest tests --exitfirst"
    ));
    assert!(test_command_has_narrow_scope("pytest tests --maxfail=1"));
    assert!(test_command_has_narrow_scope("pytest tests --maxfail 2"));
    assert!(!test_command_has_narrow_scope(
        "python -m pytest xarray/tests -q"
    ));
    assert!(!test_command_has_narrow_scope(
        "python3 -m pytest xarray/tests/test_dataset.py -q"
    ));
    assert!(!test_command_has_narrow_scope(
        "env -u PYTHONPATH python -m pytest xarray/tests -q"
    ));
    assert!(test_command_has_narrow_scope(
        "python -m pytest -m slow xarray/tests"
    ));
    assert!(test_command_has_narrow_scope("pytest -m slow xarray/tests"));
    assert!(test_command_has_narrow_scope(
        "pytest tests/test_x.py::test_case"
    ));
    assert!(test_command_has_narrow_scope(
        "cargo test -p crate_name one_test"
    ));
    assert!(test_command_has_narrow_scope("cargo test --no-run"));
    assert!(test_command_has_narrow_scope(
        "python -m pytest tests --collect-only"
    ));
    assert!(test_command_has_narrow_scope(
        "python -m pytest tests --ignore tests/test_required.py"
    ));
    assert!(test_command_has_narrow_scope(
        "python -m pytest tests --ignore-glob='*required*'"
    ));
    assert!(test_command_has_narrow_scope(
        "python -m pytest tests -o addopts='-k passing'"
    ));
    assert!(test_command_has_narrow_scope(
        "python -m pytest tests --override-ini=addopts='-m smoke'"
    ));
    for command in [
        "python -m pytest --version tests",
        "pytest --help tests",
        "pytest --setup-only tests",
        "pytest --fixtures tests",
        "cargo test -- --list",
        "./gradlew test --dry-run",
        "mvn test -DskipTests=true",
    ] {
        assert!(test_command_skips_execution(command), "{command}");
        assert!(test_command_has_narrow_scope(command), "{command}");
    }
    assert!(!test_command_skips_execution("pytest -v tests"));
    assert!(!test_command_has_narrow_scope(
        "cargo test -p crate_name --tests"
    ));
    assert!(
        verifier_test_command_rejection(
            "pytest tests 2>/dev/null; echo $?",
            Some(GoalProTestScope::TargetSuite),
            true,
        )
        .unwrap()
        .contains("original exit status")
    );
    assert!(
        verifier_test_command_rejection(
            "pytest tests/test_x.py::test_case",
            Some(GoalProTestScope::TargetSuite),
            true,
        )
        .unwrap()
        .contains("narrowly selected")
    );
    assert!(
        verifier_test_command_rejection(
            "pytest tests -q",
            Some(GoalProTestScope::TargetSuite),
            true,
        )
        .is_none()
    );
    assert_eq!(
        test_command_signature("python -m pytest tests/checkers -q"),
        test_command_signature(
            "PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider tests/checkers -q"
        )
    );
}

#[test]
fn node_test_commands_are_recognized_as_target_tests() {
    // The built-in runner flag and the common JS test-file conventions both
    // count; a Goal Pro verifier that runs them must not be rejected with
    // "no target test command in its own session".
    for command in [
        "node --test",
        "node --test tests/app.test.js",
        "node --test-reporter tap --test spec/",
        "node test.js",
        "node ./tests/unit.test.mjs",
        "node src/widget.spec.js",
        "node C:/repo/workspace/test.js",
    ] {
        assert!(test_like_command(command), "{command}");
        assert!(test_command_preserves_raw_exit(command), "{command}");
        assert!(!test_command_has_narrow_scope(command), "{command}");
    }
    // Plain scripts, eval probes, and flags passed through to a script are
    // not test commands.
    for command in [
        "node server.js",
        "node -e \"require('./tests/app.test.js')\"",
        "node app.js --test",
        "node --version",
        "node run-tests-helper.js",
    ] {
        assert!(!test_like_command(command), "{command}");
    }
}

#[test]
fn direct_test_runner_programs_are_recognized() {
    for command in [
        "jest",
        "vitest run",
        "mocha spec/",
        "jasmine",
        "ava",
        "tape test/*.js",
        "phpunit tests/Unit",
        "vendor/bin/phpunit --testsuite unit",
        "rspec spec/",
        "prove -l t/",
        "bats test/",
        "Invoke-Pester -Path tests",
    ] {
        assert!(test_like_command(command), "{command}");
    }
    for command in ["node server.js", "php index.php", "bundle install"] {
        assert!(!test_like_command(command), "{command}");
    }
}

#[test]
fn subcommand_test_runners_are_recognized() {
    for command in [
        "dotnet test",
        "dotnet vstest tests/bin/app.dll",
        "swift test",
        "mix test",
        "dart test",
        "flutter test",
        "sbt test",
        "bazel test //...",
        "lein test",
        "stack test",
        "cabal test",
        "ninja -C build test",
        "meson test -C build",
        "zig build test",
        "dune runtest",
        "nimble test",
        "crystal spec",
        "rebar3 eunit",
        "rake test",
        "rake spec",
        "hatch test",
        "pdm test",
        "deno test",
        "deno task test",
        "playwright test",
        "cypress run",
        "ng test",
        "react-scripts test",
        "karma start",
        "python manage.py test",
        "python setup.py test",
        "php vendor/bin/phpunit",
    ] {
        assert!(test_like_command(command), "{command}");
    }
    for command in [
        "dotnet build",
        "swift build",
        "mix deps.get",
        "flutter pub get",
        "bazel build //...",
        "ninja -C build",
        "crystal build src/app.cr",
        "rake db:migrate",
        "deno run server.ts",
        "cypress open",
        "playwright install",
        "python manage.py runserver",
        "php artisan serve",
    ] {
        assert!(!test_like_command(command), "{command}");
    }
}

#[test]
fn wrapper_and_task_runner_test_commands_are_recognized() {
    for command in [
        "npx jest",
        "npx playwright test",
        "npx mocha spec/",
        "uv run pytest -q",
        "poetry run pytest",
        "pipenv run pytest",
        "conda run pytest",
        "bundle exec rspec",
        "mise x -- pytest",
        "yarn jest",
        "pnpm vitest run",
        "npm run test",
        "npm run test:unit",
        "yarn run test",
        "pnpm run test",
        "bun run test",
        "just test",
        "task test",
        "nx test app",
        "lerna run test",
        "turbo run test",
    ] {
        assert!(test_like_command(command), "{command}");
    }
    // Installing or running a package must never look like a test.
    for command in [
        "npm install jest",
        "npm i vitest",
        "yarn add jest",
        "pnpm add vitest",
        "npx playwright install",
        "npx cowsay hello",
        "uv run server.js",
        "bundle exec rake db:migrate",
        "just deploy",
        "task build",
        "lerna run build",
        "turbo run build",
        "npm run build",
    ] {
        assert!(!test_like_command(command), "{command}");
    }
}

#[test]
fn windows_cmd_wrapped_test_runners_are_recognized() {
    // Windows resolves npm/pnpm/yarn through .cmd/.bat shims (execution
    // policy blocks the .ps1 form) and full-path invocations carry .exe.
    for command in [
        "npm.cmd test",
        "npm test",
        "yarn.cmd test",
        "\"C:/Program Files/nodejs/node.exe\" --test",
    ] {
        assert!(test_like_command(command), "{command}");
    }
    assert!(
        !test_like_command("npm.cmd install"),
        "npm install is not a test"
    );
}

#[test]
fn ecosystem_test_name_filters_are_narrow_scope() {
    for command in [
        "node --test --test-name-pattern=win",
        "node --test --test-skip-pattern slow",
        "jest -t \"login flow\"",
        "vitest -t=widget",
        "mocha -g \"api\"",
        "mocha --grep api",
        "playwright test --grep smoke",
        "go test -run TestParser ./...",
        "mvn -Dtest=AppTest test",
        "gradle test --tests com.app.AppTest",
        "sbt testOnly com.app.AppTest",
        "dotnet test --filter FullyQualifiedName~AppTest",
        "phpunit --filter testLogin",
        "bats --filter \"login\" test/",
        "mix test --only integration",
        "flutter test --name login",
    ] {
        assert!(test_command_has_narrow_scope(command), "{command}");
    }
    for command in [
        "node --test tests/app.test.js",
        "node test.js",
        "jest",
        "mocha spec/",
        "go test ./...",
        "mvn test",
        "gradle test",
        "dotnet test",
        "phpunit tests/Unit",
        "mix test",
        "flutter test",
    ] {
        assert!(!test_command_has_narrow_scope(command), "{command}");
    }
}

#[test]
fn verifier_baseline_guard_allows_only_separate_read_only_test_runs() {
    let candidate = Path::new("/tmp/candidate/workspace");
    let baseline = Path::new("/tmp/baseline/workspace");
    assert!(
        verifier_baseline_command_rejection(
            "python -m pytest tests -q",
            baseline,
            Some(baseline),
            false,
        )
        .is_none()
    );
    assert!(
        verifier_baseline_command_rejection(
            "git -C /tmp/baseline/workspace diff",
            candidate,
            Some(baseline),
            false,
        )
        .unwrap()
        .contains("actual test")
    );
    assert!(
        verifier_baseline_command_rejection(
            "cd /tmp/baseline/workspace && python -m pytest tests -q",
            candidate,
            Some(baseline),
            false,
        )
        .unwrap()
        .contains("workdir")
    );
    assert!(
        verifier_baseline_command_rejection(
            "python -m pytest /tmp/baseline/workspace/tests/test_dataset.py -q",
            candidate,
            Some(baseline),
            false,
        )
        .unwrap()
        .contains("workdir was not the baseline")
    );
    assert!(
        verifier_baseline_command_rejection(
            "python -m pytest /tmp/baseline/workspace/tests/test_dataset.py -q",
            baseline,
            Some(baseline),
            false,
        )
        .unwrap()
        .contains("selector relative")
    );
    assert!(
        verifier_baseline_command_rejection(
            "git apply /tmp/kcoder-goal-worktree-candidate/workspace/fix.patch && pytest tests",
            baseline,
            Some(baseline),
            false,
        )
        .unwrap()
        .contains("mixed candidate/baseline")
    );
    assert!(
        verifier_baseline_command_rejection(
            "touch changed && pytest tests",
            baseline,
            Some(baseline),
            false,
        )
        .unwrap()
        .contains("mutating baseline")
    );
}

#[test]
fn verifier_native_build_guard_accepts_only_typed_in_place_setuptools_builds() {
    for command in [
        "python setup.py build_ext --inplace",
        "python3 setup.py build_ext --inplace -j 4",
        "python3.11 ./setup.py build_ext --parallel=2 --inplace",
    ] {
        assert!(
            verifier_native_build_command_signature(command).is_some(),
            "{command}"
        );
    }

    for command in [
        "python setup.py build_ext",
        "python setup.py build_ext --inplace && touch tests/test_bad.py",
        "python setup.py build_ext --inplace > build.log",
        "/usr/bin/python3 setup.py build_ext --inplace",
        "python /tmp/setup.py build_ext --inplace",
        "python setup.py build_ext --inplace --build-lib /tmp/out",
        "python -m pip install -e .",
        "env -C /tmp python setup.py build_ext --inplace",
    ] {
        assert!(
            verifier_native_build_command_signature(command).is_none(),
            "{command}"
        );
    }

    let baseline = Path::new("/tmp/baseline/workspace");
    assert!(
        verifier_baseline_command_rejection(
            "python setup.py build_ext --inplace -j 4",
            baseline,
            Some(baseline),
            true,
        )
        .is_none()
    );
    assert!(
        verifier_native_build_execution_rejection(true, true,)
            .unwrap()
            .contains("foreground")
    );
    assert!(verifier_native_build_execution_rejection(false, true).is_none());
}

#[test]
fn verifier_workdir_guard_rejects_shell_level_directory_changes_and_absolute_selectors() {
    for command in [
        "cd /tmp/original-workspace && python -m pytest tests -q",
        "pushd ../original && pytest tests -q",
        "env --chdir=/tmp/original pytest tests -q",
        "python -m pytest /tmp/original/tests/test_case.py -q",
        "pytest ../original/tests -q",
        "make -C ../original test",
        "source switch-dir.sh && pytest tests -q",
        "eval 'cd ../original' && pytest tests -q",
        "PYTHONPATH=../original pytest tests -q",
        "PYTEST_ADDOPTS='-k one_case' pytest tests -q",
        "env -u PYTHONPATH pytest tests -q",
        "../venv/bin/python -m pytest tests -q",
        "/usr/bin/python -m pytest tests -q",
        "/tmp/original-workspace/bin/test tests -q",
        "(cd ../original && pytest tests -q)",
        "f(){ cd ../original; }; f; pytest tests -q",
        "if cd ../original; then pytest tests -q; fi",
        "pytest \"$(realpath ../original/tests)\" -q",
        "P=../original pytest \"$P/tests\" -q",
        "env \"$(printf 'PYTHONPATH=../original')\" pytest tests -q",
        "env PYTHON${EMPTY}PATH=../original pytest tests -q",
        "HOME=/root pytest tests -q",
        "TMPDIR=/tmp pytest tests -q",
        "CARGO_TARGET_DIR=/tmp/target cargo test",
        "KCODER_ISOLATED_HOME=/root pytest tests -q",
    ] {
        assert!(
            verifier_workdir_command_rejection(command).is_some(),
            "{command}"
        );
    }

    for command in [
        "python -m pytest tests -q",
        "MPLBACKEND=Agg python -m pytest tests -q",
        "python -m pytest tests -q --basetemp=/tmp/kcoder-runtime",
        "python -m pytest tests -q --junitxml=/tmp/kcoder-runtime/results.xml",
        "python -c 'from app import behavior; assert behavior()'",
        "python setup.py build_ext --inplace -j 4",
    ] {
        assert!(
            verifier_workdir_command_rejection(command).is_none(),
            "{command}"
        );
    }
}

#[test]
fn verifier_baseline_guard_only_allows_safe_behavior_probe_when_configured() {
    let baseline = Path::new("/tmp/baseline/workspace");
    let probe = "python -c 'from app import behavior; assert behavior()'";
    assert!(behavior_probe_command(probe));
    assert!(
        verifier_baseline_command_rejection(probe, baseline, Some(baseline), false)
            .unwrap()
            .contains("baseline guard rejected")
    );
    assert!(verifier_baseline_command_rejection(probe, baseline, Some(baseline), true).is_none());

    for unsafe_probe in [
        "/usr/bin/python -c 'assert behavior()'",
        "python -c 'assert behavior()' | tail -1",
        "python -c 'assert behavior()' || true",
        "python -c 'assert behavior()' > result.txt",
        "python -m pip install package",
        "rg 'fixed text' src",
        "python -c 'try:\n import missing_native\nexcept ImportError:\n raise AssertionError(\"KCODER_BEHAVIOR_DELTA\") from None'",
        "python -c 'from app import behavior\ntry:\n behavior()\nexcept Exception:\n raise AssertionError(\"KCODER_BEHAVIOR_DELTA\") from None'",
    ] {
        assert!(!behavior_probe_command(unsafe_probe), "{unsafe_probe}");
        assert!(
            verifier_baseline_command_rejection(unsafe_probe, baseline, Some(baseline), true,)
                .is_some(),
            "{unsafe_probe}"
        );
    }
}

#[test]
fn behavior_probe_rejects_source_environment_and_mutation_fingerprints() {
    let valid = "python -c 'from pkg.api import normalize; actual = normalize(\"x\"); assert actual == \"y\", actual'";
    assert!(behavior_probe_command(valid));

    for unsafe_probe in [
        "python -c 'from pathlib import Path; assert \"fixed\" in Path(\"app.py\").read_text()'",
        "python -c 'from pathlib import Path; Path(\"marker\").write_text(\"x\")'",
        "python -c 'open(\"marker\", \"w\").write(\"x\")'",
        "python -c 'import os; assert \"baseline\" not in os.getcwd()'",
        "python -c 'import os; assert os.environ.get(\"MODE\") == \"candidate\"'",
        "python -c 'import inspect; from pkg import api; assert \"fix\" in inspect.getsource(api)'",
        "python -c 'from pkg import api; assert api.__code__.co_argcount == 2'",
        "python -c 'from pkg import api; assert \"candidate\" in api.__file__'",
        "python -c 'import sys; sys.modules[\"optional_dependency\"] = stub'",
        "python -c 'import subprocess; assert subprocess.run([\"true\"]).returncode == 0'",
        "python -c '__import__(\"pathlib\").Path(\"app.py\").read_text()'",
        "python -c 'eval(\"assert True\")'",
    ] {
        assert!(!behavior_probe_command(unsafe_probe), "{unsafe_probe}");
    }
}

#[test]
fn behavior_probe_allows_in_memory_pickle_round_trip() {
    let probe = "python -c 'import pickle; from pkg.api import value; blob = pickle.dumps(value()); assert pickle.loads(blob) == value()'";
    let baseline = Path::new("/tmp/baseline/workspace");

    assert!(behavior_probe_command(probe));
    assert!(verifier_baseline_command_rejection(probe, baseline, Some(baseline), true).is_none());
}

#[test]
fn verifier_workspace_guard_detects_test_file_edits() {
    assert!(workspace_mutation_command(
        "sed -i 's/old/new/' tests/test_issue.py"
    ));
    assert!(!workspace_mutation_command("python -c 'assert 1 + 1 == 2'"));
    assert!(workspace_mutation_command("git checkout -- tests"));
    assert!(!workspace_mutation_command("git diff -- tests"));
    assert!(!workspace_mutation_command("pytest tests"));
    for command in [
        "find . -name patch -o -name install",
        "ls -la tests/patch fixtures/install",
        "cd src && git diff --stat && git diff -- tests",
        "pytest tests 2>/dev/null; echo $?",
        "git log --all --oneline 2>/dev/null | head -10; git stash list",
    ] {
        assert!(!workspace_mutation_command(command), "{command}");
    }
    assert!(workspace_mutation_command(
        "cd src && git diff --stat; touch tests/changed.py"
    ));
    assert!(workspace_mutation_command("printf x > tests/changed.py"));
    assert!(!workspace_mutation_command(
        "pytest tests > /tmp/verifier-output.log 2>/dev/null"
    ));
}

#[test]
fn no_match_search_exemption_accepts_only_one_unredirected_grep_or_rg() {
    for command in [
        "grep -rn 'py:class' sphinx/util/typing.py",
        "rg --hidden 'needle;still-pattern' src",
        "rg '$(literal)' src",
        "/usr/bin/grep needle file.txt",
    ] {
        assert!(read_only_search_no_match_command(command), "{command}");
    }
    for command in [
        "git diff --check",
        "grep needle file.txt 2>/dev/null",
        "grep needle file.txt; echo $?",
        "grep needle file.txt | head",
        "cd src && rg needle",
        "env MODE=read rg needle src",
        "python -c 'print(1)'",
        "grep \"$(touch changed)\" file.txt",
        "rg \"`touch changed`\" file.txt",
    ] {
        assert!(!read_only_search_no_match_command(command), "{command}");
    }
}

#[test]
fn isolated_verifier_environment_uses_private_process_paths() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let environment = verifier_isolation_environment(root.path(), Some(&workspace)).unwrap();
    let values = environment
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();

    assert_eq!(
        values.get(&OsString::from("PYTHONNOUSERSITE")),
        Some(&"1".into())
    );
    assert_eq!(
        values.get(&OsString::from("PIP_REQUIRE_VIRTUALENV")),
        Some(&"1".into())
    );
    assert_eq!(
        values.get(&OsString::from("PYTEST_ADDOPTS")),
        Some(&"-p no:cacheprovider".into())
    );
    assert!(Path::new(values.get(&OsString::from("HOME")).unwrap()).starts_with(root.path()));
    assert!(Path::new(values.get(&OsString::from("TMPDIR")).unwrap()).starts_with(root.path()));
    let python_path = values.get(&OsString::from("PYTHONPATH")).unwrap();
    let paths = std::env::split_paths(python_path).collect::<Vec<_>>();
    assert_eq!(paths.first(), Some(&workspace));
    assert_eq!(
        values.get(&OsString::from("KCODER_ISOLATED_PYTHONPATH")),
        Some(python_path)
    );

    let cargo_target = values
        .get(&OsString::from("CARGO_TARGET_DIR"))
        .expect("candidate Cargo target directory");
    assert!(Path::new(cargo_target).starts_with(root.path().join("workspaces")));
    assert!(Path::new(cargo_target).ends_with("cache/cargo-target"));

    let baseline_workspace = root.path().join("baseline");
    let baseline_values = verifier_isolation_environment(root.path(), Some(&baseline_workspace))
        .unwrap()
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();
    for variable in [
        "HOME",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "PIP_CACHE_DIR",
        "NPM_CONFIG_CACHE",
        "PYTHONPYCACHEPREFIX",
    ] {
        assert_ne!(
            baseline_values.get(&OsString::from(variable)),
            values.get(&OsString::from(variable)),
            "candidate and baseline must not share {variable}"
        );
    }
    assert_ne!(
        baseline_values.get(&OsString::from("CARGO_TARGET_DIR")),
        Some(cargo_target),
        "candidate and baseline must not share compiled Cargo artifacts"
    );

    let repeated_values = verifier_isolation_environment(root.path(), Some(&workspace))
        .unwrap()
        .into_iter()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        repeated_values.get(&OsString::from("CARGO_TARGET_DIR")),
        Some(cargo_target),
        "the same verifier workspace must use a stable Cargo target directory"
    );
}

#[test]
fn verifier_python_path_uses_only_workspace_and_explicit_trusted_prefix() {
    let workspace = Path::new("/tmp/task-workspace");
    let trusted = std::env::join_paths([
        Path::new("/opt/kcoder/python-isolation"),
        Path::new("/opt/kcoder/second-prefix"),
    ])
    .unwrap();

    let python_path = verifier_python_path(workspace, Some(&trusted)).unwrap();
    let paths = std::env::split_paths(&python_path).collect::<Vec<_>>();

    assert_eq!(
        paths,
        vec![
            workspace.to_path_buf(),
            PathBuf::from("/opt/kcoder/python-isolation"),
            PathBuf::from("/opt/kcoder/second-prefix"),
        ]
    );
}
