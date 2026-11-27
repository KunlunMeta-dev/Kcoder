//! Launch spelling only; canonical resource identities and their leases stay unchanged.
use std::path::Path;

pub(crate) fn office_node_launch_path(path: &Path) -> &Path {
    #[cfg(windows)]
    {
        dunce::simplified(path)
    }
    #[cfg(not(windows))]
    {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_launch_paths_keep_their_identity() {
        let path = Path::new("office/components/src/cli.mjs");
        assert_eq!(office_node_launch_path(path), path);
    }

    #[cfg(windows)]
    #[test]
    fn safe_disk_paths_use_win32_spelling_without_changing_canonical_storage() {
        for (canonical, expected) in [
            (
                r"\\?\C:\Owned Studio\src\cli.mjs",
                r"C:\Owned Studio\src\cli.mjs",
            ),
            (
                r"\\?\D:\Owned Studio\src\cli.mjs",
                r"D:\Owned Studio\src\cli.mjs",
            ),
        ] {
            let retained = std::path::PathBuf::from(canonical);
            assert_eq!(office_node_launch_path(&retained), Path::new(expected));
            assert_eq!(retained, Path::new(canonical));
        }
    }

    #[cfg(windows)]
    #[test]
    fn unc_and_verbatim_only_names_are_never_arbitrarily_trimmed() {
        for value in [
            r"\\server\share\src\cli.mjs",
            r"\\?\UNC\server\share\src\cli.mjs",
            r"\\?\C:\Owned\CON\cli.mjs",
            r"\\?\D:\Owned.\cli.mjs",
        ] {
            assert_eq!(office_node_launch_path(Path::new(value)), Path::new(value));
        }
        let long = format!(r"\\?\D:\{}\cli.mjs", "segment\\".repeat(40));
        assert_eq!(office_node_launch_path(Path::new(&long)), Path::new(&long));
    }
}
