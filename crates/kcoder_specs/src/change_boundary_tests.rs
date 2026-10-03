use super::*;

fn public_change_operations(cwd: &Path, name: &str) -> Vec<(&'static str, Result<()>)> {
    vec![
        ("new_change", new_change(cwd, name, None).map(|_| ())),
        ("archive", archive(cwd, name).map(|_| ())),
        ("validate", validate(cwd, Some(name)).map(|_| ())),
        ("status", status(cwd, name).map(|_| ())),
        ("apply_preflight", apply_preflight(cwd, name).map(|_| ())),
        (
            "record_verification",
            record_verification(
                cwd,
                name,
                SpecVerificationRecord {
                    completion_decision: "pending".to_string(),
                    ..Default::default()
                },
            )
            .map(|_| ()),
        ),
        (
            "review_writeback",
            review_writeback(
                cwd,
                name,
                SpecReviewWritebackRecord {
                    review_status: "pending".to_string(),
                    ..Default::default()
                },
            )
            .map(|_| ()),
        ),
        ("review", review(cwd, name, None).map(|_| ())),
        (
            "apply_plan",
            apply_plan(cwd, Some(name), "- task").map(|_| ()),
        ),
        ("sync", sync::sync(cwd, name).map(|_| ())),
    ]
}

#[test]
fn public_change_operations_reject_unsafe_names_before_io() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("workspace");
    fs::create_dir(&cwd).unwrap();
    for name in [
        "",
        " ",
        ".",
        "..",
        ". ",
        ".. ",
        "../escape",
        "a/b",
        r"a\b",
        r"C:\escape",
        r"C:escape",
        r"\\server\share",
        "CON",
        "NUL",
        "AUX",
        "PRN",
        "COM1",
        "COM9.txt",
        "LPT1",
        "LPT9.txt",
        "con.txt",
        "a?b",
        "a*b",
        "a<b",
        "a>b",
        "a|b",
        "a\"b",
        "a\u{0001}b",
        "a\nb",
        "a\u{007f}b",
    ] {
        for (operation, result) in public_change_operations(&cwd, name) {
            let error = result.expect_err(&format!("{operation} 不得接受 {name:?}"));
            assert!(
                error.to_string().contains("invalid change name"),
                "{operation}: {error:#}"
            );
        }
    }
    assert!(!cwd.join(".kcoder").exists(), "非法名称不得先创建目录");
}

#[cfg(unix)]
#[test]
fn public_change_operations_reject_posix_absolute_path() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("workspace");
    fs::create_dir(&cwd).unwrap();
    let external = root.path().join("external");
    fs::create_dir(&external).unwrap();
    let sentinel = external.join("verification.md");
    fs::write(&sentinel, "untouched").unwrap();
    for (operation, result) in public_change_operations(&cwd, external.to_str().unwrap()) {
        let error = result.expect_err(&format!("{operation} 不得接受 POSIX 绝对路径"));
        assert!(
            error.to_string().contains("invalid change name"),
            "{operation}: {error:#}"
        );
    }
    assert!(!cwd.join(".kcoder").exists(), "非法名称不得先创建目录");
    assert_eq!(fs::read_to_string(sentinel).unwrap(), "untouched");
}

#[cfg(unix)]
#[test]
fn public_change_operations_reject_existing_change_symlink() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("workspace");
    let external = root.path().join("external");
    fs::create_dir(&cwd).unwrap();
    fs::create_dir(&external).unwrap();
    let change = new_change(&external, "target", None).unwrap();
    let sentinel = change.join("verification.md");
    fs::write(&sentinel, "untouched").unwrap();
    let changes = cwd.join(SPECS_DIR).join("changes");
    fs::create_dir_all(&changes).unwrap();
    std::os::unix::fs::symlink(&change, changes.join("linked")).unwrap();
    for (operation, result) in public_change_operations(&cwd, "linked") {
        let error = result.expect_err(&format!("{operation} 不得接受 change symlink"));
        assert!(
            error.to_string().contains("symlink"),
            "{operation}: {error:#}"
        );
    }
    assert_eq!(fs::read_to_string(sentinel).unwrap(), "untouched");
}

#[cfg(unix)]
#[test]
fn new_change_rejects_symlinked_changes_parent() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("workspace");
    let specs = cwd.join(SPECS_DIR);
    fs::create_dir_all(&specs).unwrap();
    let external = root.path().join("external");
    fs::create_dir(&external).unwrap();
    std::os::unix::fs::symlink(&external, specs.join("changes")).unwrap();
    assert!(new_change(&cwd, "escape", None).is_err());
    assert!(!external.join("escape").exists());
}

#[test]
fn unicode_change_name_keeps_normal_lifecycle() {
    let root = tempfile::tempdir().unwrap();
    init(root.path()).unwrap();
    let name = "修复-记忆";
    let change = new_change(root.path(), name, None).unwrap();
    apply_plan(root.path(), Some(name), "- [x] done").unwrap();
    assert_eq!(status(root.path(), name).unwrap().name, name);
    validate(root.path(), Some(name)).unwrap();
    let archived = archive(root.path(), name).unwrap();
    assert!(archived.is_dir());
    assert!(!change.exists());
}
