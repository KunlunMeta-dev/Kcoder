use super::*;
use tempfile::TempDir;

#[test]
fn key_formats_are_pinned_because_they_name_persisted_directories() {
    let path = Path::new("/foo bar/baz");
    assert_eq!(project_key(path), "_foo_bar_baz-d8189c9b53582a01");
    assert_eq!(previous_project_key(path), "_foo_bar_baz-74ee3e41");
    assert_eq!(legacy_project_key(path), "_foo_bar_baz");
}

#[test]
fn project_key_normalizes_path() {
    let key = project_key(Path::new("/foo bar/baz"));
    assert!(key.starts_with("_foo_bar_baz-"), "unexpected key: {key}");
    assert_eq!(key.rsplit_once('-').unwrap().1.len(), 16);
}

#[test]
fn project_key_does_not_fold_distinct_paths_together() {
    let with_space = project_key(Path::new("/foo bar/baz"));
    let nested = project_key(Path::new("/foo/bar/baz"));
    assert_ne!(
        with_space, nested,
        "paths that sanitize to the same form must not share a key"
    );
}

#[test]
fn long_unicode_paths_stay_bounded_and_distinct() {
    let temp = TempDir::new().unwrap();
    let cwd = temp.path().join("项目".repeat(20)).join("目录".repeat(20));
    std::fs::create_dir_all(&cwd).unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .arg(&cwd)
            .status()
            .unwrap()
            .success()
    );
    let key = project_key(&cwd);
    assert!(key.len() <= 217);
    assert_ne!(key, project_key(&cwd.join("another")));
    assert_eq!(project_key_for_path(&cwd), key);
}

#[cfg(windows)]
#[test]
fn project_keys_are_valid_windows_filename_components() {
    for key in [
        project_key(Path::new(r"\\?\C:\work\project")),
        previous_project_key(Path::new(r"\\?\C:\work\project")),
        legacy_project_key(Path::new(r"\\?\C:\work\project")),
    ] {
        assert!(
            !key.chars().any(|ch| ch.is_control()
                || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')),
            "{key}"
        );
    }
}

#[cfg(unix)]
#[test]
fn git_root_uses_clean_environment() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = TempDir::new().unwrap();
    let fake_git = tmp.path().join("git");
    std::fs::write(
        &fake_git,
        "#!/bin/sh\nif [ \"${HOME-unset}\" != \"unset\" ]; then exit 2; fi\nif [ \"$GIT_TERMINAL_PROMPT\" != \"0\" ]; then exit 3; fi\nif [ \"${GIT_ASKPASS-unset}\" != \"\" ]; then exit 4; fi\nprintf '%s\\n' \"$PWD\"\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&fake_git).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_git, permissions).unwrap();

    let root = git_root_with_program(tmp.path(), &fake_git).unwrap();

    assert_eq!(root, tmp.path());
}

#[cfg(windows)]
#[test]
fn git_root_keeps_required_windows_runtime_environment() {
    let tmp = TempDir::new().unwrap();
    let fake_git = tmp.path().join("git.cmd");
    let capture = tmp.path().join("git-environment.txt");
    let escaped_capture = capture.display().to_string().replace('%', "%%");
    std::fs::write(
        &fake_git,
        format!(
            "@echo off\r\n> \"{escaped_capture}\" echo root=%SystemRoot%\r\n>> \"{escaped_capture}\" echo path=%PATH%\r\n>> \"{escaped_capture}\" echo user=%USERPROFILE%\r\necho %CD%\r\n"
        ),
    )
    .unwrap();

    let root = git_root_with_program(tmp.path(), &fake_git).unwrap();
    let environment = std::fs::read_to_string(capture).unwrap();

    assert_eq!(root, tmp.path());
    assert!(
        environment.contains(&format!("root={}", std::env::var("SystemRoot").unwrap())),
        "{environment}"
    );
    assert!(
        environment.contains(&format!("path={}", std::env::var("PATH").unwrap())),
        "{environment}"
    );
    assert!(
        environment.contains(&format!("user={}", std::env::var("USERPROFILE").unwrap())),
        "{environment}"
    );
}

#[test]
fn project_key_uses_git_root_for_unicode_repository_path() {
    if which::which("git").is_err() {
        return;
    }
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("仓库 昆仑");
    let nested = root.join("子目录 你好");
    std::fs::create_dir_all(&nested).unwrap();
    let status = Command::new("git")
        .arg("init")
        .arg(&root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success());

    assert_eq!(project_key_for_path(&nested), project_key_for_path(&root));
    assert!(project_key_for_path(&nested).contains("仓库_昆仑"));
    assert_eq!(
        dunce::canonicalize(project_root_for_path(&nested)).unwrap(),
        dunce::canonicalize(&root).unwrap()
    );
}
