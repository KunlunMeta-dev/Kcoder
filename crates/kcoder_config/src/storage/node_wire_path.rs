//! Typed paths in the private offline Node protocol. Persisted locations and
//! held Native paths retain their original representation and identity.
use anyhow::Result;
use std::path::{Path, PathBuf};

pub fn node_storage_path(path: &Path) -> Result<PathBuf> {
    let path = super::resolve::absolute(path)?;
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        anyhow::ensure!(
            matches!(path.components().next(), Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::UNC(_, _)
                    | Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _))),
            "STORAGE_PATH_INVALID"
        );
        // Keep extended namespace semantics (including long paths and literal
        // trailing dots/spaces). Node resolves separators even for these paths.
        let text = path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("STORAGE_PATH_INVALID"))?;
        Ok(PathBuf::from(text.replace('/', "\\")))
    }
    #[cfg(not(windows))]
    {
        Ok(path)
    }
}

/// Compare only typed protocol paths. The caller must still validate the actual
/// directory/file handles; namespace spelling is not a persistent identity.
pub fn node_storage_relative_path(path: &Path, root: &Path) -> Result<PathBuf> {
    let path = node_storage_path(path)?;
    let root = node_storage_path(root)?;
    #[cfg(windows)]
    let (path, root) = {
        fn namespaced(path: PathBuf) -> PathBuf {
            let text = path.to_str().expect("validated wire path");
            if text.starts_with(r"\\?\") {
                path
            } else if let Some(unc) = text.strip_prefix(r"\\") {
                PathBuf::from(format!(r"\\?\UNC\{unc}"))
            } else {
                PathBuf::from(format!(r"\\?\{text}"))
            }
        }
        (namespaced(path), namespaced(root))
    };
    Ok(path.strip_prefix(root)?.to_owned())
}

pub(super) fn serialize<S: serde::Serializer>(
    path: &Path,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::{Serialize, ser::Error};
    node_storage_path(path)
        .map_err(S::Error::custom)?
        .serialize(serializer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_paths_are_lexical_and_do_not_require_existing_targets() {
        let root = std::env::temp_dir();
        let path = root.join("not-created").join("..").join("目标-🦀");
        assert_eq!(node_storage_path(&path).unwrap(), root.join("目标-🦀"));
        assert!(node_storage_path(Path::new("relative/path")).is_err());
    }

    #[test]
    fn fence_serialization_changes_only_the_wire_path() {
        let original = std::env::temp_dir()
            .join("original")
            .join("..")
            .join("目标-🦀");
        let fence = crate::storage::StorageOfflineChildFence {
            root: original.clone(),
            directory_identity: "opaque/directory\\identity".into(),
            primary_identity: "opaque/primary\\identity".into(),
            secondary_identity: "opaque/secondary\\identity".into(),
        };
        let value = serde_json::to_value(&fence).unwrap();
        assert_eq!(
            value["root"],
            serde_json::json!(node_storage_path(&original).unwrap())
        );
        assert_eq!(fence.root.as_os_str(), original.as_os_str());
        assert_eq!(value["directoryIdentity"], fence.directory_identity);
        assert_eq!(value["primaryIdentity"], fence.primary_identity);
        assert_eq!(value["secondaryIdentity"], fence.secondary_identity);
        assert_eq!(serde_json::to_value(&fence).unwrap(), value);
    }

    #[test]
    fn wire_paths_reject_controls_and_relative_inputs_without_repair() {
        let root = std::env::temp_dir();
        for name in ["line\nfeed", "carriage\rreturn", "null\0byte"] {
            assert!(node_storage_path(&root.join(name)).is_err());
        }
        for path in ["", ".", "..", "relative/path"] {
            assert!(node_storage_path(Path::new(path)).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_wire_paths_preserve_literal_backslashes_and_unicode() {
        let path = Path::new("/not-created/目标-🦀/literal\\component");
        assert_eq!(
            node_storage_path(path).unwrap().as_os_str(),
            path.as_os_str()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_wire_paths_match_node_separators_without_changing_namespace() {
        for (input, expected) in [
            (r"C:\Users\u/.config/kcoder", r"C:\Users\u\.config\kcoder"),
            (
                r"C:\Data\studio/gateway\relay/client-identity.json",
                r"C:\Data\studio\gateway\relay\client-identity.json",
            ),
            (r"c:\MiXeD\目标-🦀", r"c:\MiXeD\目标-🦀"),
            (r"C:\Data\\Child\", r"C:\Data\Child"),
            (r"C:\Users\u\", r"C:\Users\u"),
            (r"C:\", r"C:\"),
            (r"c:\", r"c:\"),
            (r"\\server\share", r"\\server\share\"),
            (r"\\server\share\", r"\\server\share\"),
            (r"\\server\share\目标/x", r"\\server\share\目标\x"),
            (r"\\?\C:\", r"\\?\C:\"),
            (r"\\?\C:\目录/原名. \x", r"\\?\C:\目录\原名. \x"),
            (
                r"\\?\UNC\server\share\目录/x",
                r"\\?\UNC\server\share\目录\x",
            ),
        ] {
            assert_eq!(
                node_storage_path(Path::new(input)).unwrap().as_os_str(),
                expected
            );
        }
        let long = format!(r"\\?\C:\{}目标-🦀", "part\\".repeat(80));
        assert_eq!(
            node_storage_path(Path::new(&long)).unwrap().as_os_str(),
            long.as_str()
        );
        let ordinary_long = format!(r"C:\{}目标-🦀", "part\\".repeat(80));
        assert_eq!(
            node_storage_path(Path::new(&ordinary_long))
                .unwrap()
                .as_os_str(),
            ordinary_long.as_str()
        );
        for invalid in [
            r"C:relative",
            r"\root-relative",
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\Data",
        ] {
            assert!(node_storage_path(Path::new(invalid)).is_err(), "{invalid}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_wire_paths_reject_unpaired_surrogates_without_lossy_conversion() {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt};
        let path = PathBuf::from(OsString::from_wide(&[
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            0xd800,
        ]));
        assert!(node_storage_path(&path).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_relative_paths_accept_only_equivalent_declared_namespaces() {
        for (path, root, expected) in [
            (
                r"C:\Source\MiXeD-目标\entry.json",
                r"\\?\C:\Source",
                r"MiXeD-目标\entry.json",
            ),
            (
                r"\\?\C:\Source\MiXeD-目标\entry.json",
                r"C:\Source",
                r"MiXeD-目标\entry.json",
            ),
            (
                r"\\server\share\Source\epoch",
                r"\\?\UNC\server\share\Source",
                "epoch",
            ),
            (
                r"\\?\UNC\server\share\Source\epoch",
                r"\\server\share\Source",
                "epoch",
            ),
            (r"C:\Source", r"\\?\C:\Source", ""),
        ] {
            assert_eq!(
                node_storage_relative_path(Path::new(path), Path::new(root))
                    .unwrap()
                    .as_os_str(),
                expected,
            );
        }
        for (path, root) in [
            (r"C:\SourcePeer\epoch", r"\\?\C:\Source"),
            (r"C:\Source\..\Elsewhere\epoch", r"\\?\C:\Source"),
            (r"D:\Source\epoch", r"\\?\C:\Source"),
            (
                r"\\server\other\Source\epoch",
                r"\\?\UNC\server\share\Source",
            ),
        ] {
            assert!(
                node_storage_relative_path(Path::new(path), Path::new(root)).is_err(),
                "{path} must stay outside {root}",
            );
        }
    }
}
