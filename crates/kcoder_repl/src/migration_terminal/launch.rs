//! Explicit startup overlays retain their original workspace interpretation after navigation.
use super::*;
use std::{ffi::OsString, sync::OnceLock};
static OVERLAYS: OnceLock<Vec<PathBuf>> = OnceLock::new();

pub(super) fn capture(cwd: &std::path::Path) {
    OVERLAYS.get_or_init(|| paths(std::env::args_os().skip(1), cwd));
}
fn paths(args: impl Iterator<Item = OsString>, cwd: &std::path::Path) -> Vec<PathBuf> {
    let mut args = args;
    let mut result = Vec::new();
    while let Some(arg) = args.next() {
        if arg == "--" {
            break;
        }
        let path = if arg == "--settings-file" {
            args.next().map(PathBuf::from)
        } else {
            arg.to_str()
                .and_then(|s| s.strip_prefix("--settings-file="))
                .map(PathBuf::from)
        };
        if let Some(path) = path {
            result.push(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            });
        }
    }
    result
}
pub(super) fn apply(command: &mut tokio::process::Command) {
    if let Some(paths) = OVERLAYS.get() {
        for path in paths {
            command.arg("--settings-file").arg(path);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlays_are_fixed_before_later_navigation_and_stop_at_literal_arguments() {
        let cwd = std::env::current_dir().unwrap();
        let args = [
            "--settings-file",
            "selected.json",
            "--settings-file=second.json",
            "--",
            "--settings-file",
            "not-an-overlay.json",
        ];
        assert_eq!(
            paths(args.into_iter().map(OsString::from), &cwd),
            vec![cwd.join("selected.json"), cwd.join("second.json")]
        );
    }
}
