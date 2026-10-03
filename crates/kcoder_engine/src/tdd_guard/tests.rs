use super::*;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn test_candidates_cover_workspace_member_crate_tests_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let crate_root = tmp.path().join("crates/foo");
    fs::create_dir_all(crate_root.join("src")).unwrap();
    fs::write(crate_root.join("Cargo.toml"), "[package]\nname = \"foo\"\n").unwrap();
    let target = crate_root.join("src/bar.rs");
    let candidates = test_candidates(&target, tmp.path());
    assert!(
        candidates
            .iter()
            .any(|p| p == &crate_root.join("tests/bar.rs")),
        "crate-level tests dir must be a candidate: {candidates:?}"
    );
    assert!(
        candidates
            .iter()
            .any(|p| p == &crate_root.join("tests/bar_test.rs")),
        "crate-level _test.rs must be a candidate: {candidates:?}"
    );
}

#[test]
fn test_candidates_cover_deeply_nested_workspace_member_sources() {
    let tmp = tempfile::tempdir().unwrap();
    let crate_root = tmp.path().join("crates/foo");
    fs::create_dir_all(crate_root.join("src/domain/nested")).unwrap();
    fs::write(crate_root.join("Cargo.toml"), "[package]\nname = \"foo\"\n").unwrap();
    let target = crate_root.join("src/domain/nested/bar.rs");
    let candidates = test_candidates(&target, tmp.path());
    assert!(
        candidates
            .iter()
            .any(|p| p == &crate_root.join("tests/bar.rs")),
        "deep module must still resolve the crate-level tests dir: {candidates:?}"
    );
}

struct TddEnvGuard {
    _lock: MutexGuard<'static, ()>,
    previous: Option<OsString>,
}

impl TddEnvGuard {
    fn unset() -> Self {
        let lock = ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("KCODER_TDD_GATE");
        unsafe { std::env::remove_var("KCODER_TDD_GATE") };
        Self {
            _lock: lock,
            previous,
        }
    }

    fn set(value: &str) -> Self {
        let lock = ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("KCODER_TDD_GATE");
        unsafe { std::env::set_var("KCODER_TDD_GATE", value) };
        Self {
            _lock: lock,
            previous,
        }
    }
}

impl Drop for TddEnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            unsafe { std::env::set_var("KCODER_TDD_GATE", previous) };
        } else {
            unsafe { std::env::remove_var("KCODER_TDD_GATE") };
        }
    }
}

#[test]
fn allows_test_files() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    let err = check(
        "write",
        &test_input("src/foo.test.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    assert!(err.is_none());
}

#[test]
fn blocks_source_without_test() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    )
    .unwrap();
    assert!(err.contains("TDD gate"));
    assert!(err.contains("__tests__/foo.test.ts"));
}

#[test]
fn blocks_edit_tool_without_test() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let err = check(
        "edit",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    )
    .unwrap();
    assert!(err.contains("TDD gate"));
}

#[test]
fn ignores_read_only_tools() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let err = check(
        "read",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    assert!(err.is_none());
}

#[test]
fn off_setting_exempts_legacy_required_projects() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    // Legacy spec-driven project = hard gate under auto resolution.
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();

    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Off,
    );
    assert!(err.is_none(), "tdd_gate=off must exempt like Luna mode");
    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    assert!(err.is_some(), "same project must still block under auto");
}

#[test]
fn preferred_setting_warns_without_blocking() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();

    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Preferred,
    );
    assert!(err.is_none());
    let warn = warning(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Preferred,
    )
    .expect("preferred must warn");
    assert!(warn.contains("TDD preferred"));
}

#[test]
fn required_setting_blocks_even_when_project_is_standard() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    // spec-driven-superpowers change with standard (off) execution mode.
    let change = tmp
        .path()
        .join(".kcoder")
        .join("specs")
        .join("changes")
        .join("c1");
    fs::create_dir_all(&change).unwrap();
    fs::write(
        change.join(".spec.yaml"),
        "schema: spec-driven-superpowers\n",
    )
    .unwrap();
    fs::write(change.join("review.md"), "## Execution Mode\n\nstandard\n").unwrap();

    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    assert!(err.is_none(), "standard mode must allow under auto");
    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Required,
    );
    assert!(err.is_some(), "tdd_gate=required must force blocking");
}

#[test]
fn allows_files_without_known_test_convention() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let err = check(
        "write",
        &test_input("README.md"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    assert!(err.is_none());
}

#[test]
fn auto_enables_from_project_subdirectory() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let subdir = tmp.path().join("crates").join("app");
    fs::create_dir_all(&subdir).unwrap();

    let err = check(
        "write",
        &test_input("src/foo.ts"),
        &subdir,
        TddGateSetting::Auto,
    )
    .unwrap();
    assert!(err.contains("TDD gate"));
}

#[test]
fn tdd_skill_activation_matches_guarded_source_files() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();

    assert!(should_activate_tdd_skill(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto
    ));
    assert!(!should_activate_tdd_skill(
        "write",
        &test_input("README.md"),
        tmp.path(),
        TddGateSetting::Auto
    ));
    assert!(!should_activate_tdd_skill(
        "read",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto
    ));
}

#[test]
fn allows_source_with_corresponding_test() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    fs::create_dir_all(tmp.path().join("src").join("__tests__")).unwrap();
    let mut f = fs::File::create(tmp.path().join("src/__tests__/foo.test.ts")).unwrap();
    writeln!(f, "test").unwrap();
    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    assert!(err.is_none());
}

#[test]
fn disabled_by_env() {
    let _env = TddEnvGuard::set("0");
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".kcoder").join("specs")).unwrap();
    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    assert!(err.is_none());
}

#[test]
fn enhanced_standard_mode_disables_auto_gate() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    write_enhanced_change(tmp.path(), "standard");

    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );

    assert!(err.is_none());
    assert!(!should_activate_tdd_skill(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto
    ));
}

#[test]
fn enhanced_tdd_preferred_warns_without_blocking() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    write_enhanced_change(tmp.path(), "tdd-preferred");

    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    );
    let warning = warning(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    )
    .unwrap();

    assert!(err.is_none());
    assert!(warning.contains("TDD preferred"));
    assert!(should_activate_tdd_skill(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto
    ));
}

#[test]
fn enhanced_tdd_required_blocks_without_test() {
    let _env = TddEnvGuard::unset();
    let tmp = tempfile::tempdir().unwrap();
    write_enhanced_change(tmp.path(), "tdd-required");

    let err = check(
        "write",
        &test_input("src/foo.ts"),
        tmp.path(),
        TddGateSetting::Auto,
    )
    .unwrap();

    assert!(err.contains("TDD gate"));
}

fn write_enhanced_change(root: &Path, execution_mode: &str) {
    let specs = root.join(".kcoder").join("specs");
    fs::create_dir_all(specs.join("changes").join("x")).unwrap();
    fs::write(
        specs.join("config.yaml"),
        "schema: spec-driven-superpowers\n",
    )
    .unwrap();
    let change = specs.join("changes").join("x");
    fs::write(
        change.join(".spec.yaml"),
        "name: x\nschema: spec-driven-superpowers\ncreated_at: now\nstatus: draft\n",
    )
    .unwrap();
    fs::write(
        change.join("review.md"),
        format!("## Execution Mode\n\n{execution_mode}\n"),
    )
    .unwrap();
}

fn test_input(path: &str) -> Value {
    serde_json::json!({ "file_path": path, "content": "x" })
}
