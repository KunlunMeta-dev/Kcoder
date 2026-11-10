use super::*;
use kcoder_types::{migration::MigrationSourceKind, migration_source_upload::SourceUploadFile};
use serde_json::json;

fn fixture(paths: &[&str]) -> SourceUploadManifest {
    SourceUploadManifest {
        version: 1,
        source: MigrationSourceKind::Codex,
        files: paths
            .iter()
            .map(|path| SourceUploadFile {
                relative_path: (*path).into(),
                bytes: 0,
                sha256: format!("{:x}", Sha256::digest([])),
            })
            .collect(),
    }
}

#[test]
fn configuration_names_unicode_and_canonical_file_order_are_preserved() {
    let paths = [
        "config.toml",
        "settings.json",
        "settings.local.json",
        ".mcp.json",
        "skills/资料/SKILL.md",
    ];
    let validated = validate_manifest(fixture(&paths)).unwrap();
    assert_eq!(
        validated
            .manifest()
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect::<Vec<_>>(),
        paths
    );
    let spaced = serde_json::to_vec_pretty(validated.manifest()).unwrap();
    let parsed = parse_manifest(&spaced).unwrap();
    assert_eq!(parsed.canonical_json(), validated.canonical_json());
    assert_eq!(parsed.sha256(), validated.sha256());
    let mut changed = fixture(&paths);
    changed.files.swap(0, 1);
    assert_ne!(
        validate_manifest(changed).unwrap().sha256(),
        parsed.sha256()
    );
}

#[test]
fn sensitive_authentication_environment_and_generated_entries_are_excluded_at_any_depth() {
    for name in [
        "auth.json",
        ".credentials.json",
        "credentials.json",
        "credentials.toml",
        ".env",
        ".env.local",
        ".envrc",
        ".ssh",
        ".aws",
        ".git",
        "node_modules",
        ".venv",
        "__pycache__",
        "id_rsa",
        "id_ed25519",
        "server.pem",
        "server.key",
        "oauth.json",
        "oauth_tokens.json",
        "tokens.json",
        ".netrc",
        ".npmrc",
        "cookies.sqlite",
    ] {
        for path in [
            name.to_owned(),
            format!("safe/{}/child", name.to_uppercase()),
        ] {
            assert!(
                validate_manifest(fixture(&[&path])).is_err(),
                "excluded test fixture accepted"
            );
        }
    }
}

#[test]
fn portable_paths_reject_escapes_windows_aliases_and_unsafe_components() {
    for path in [
        "",
        "/absolute",
        "//server/share",
        "a/../b",
        "../a",
        "./a",
        "a//b",
        "a/",
        "C:/a",
        "a\\b",
        "a:b",
        "a\0b",
        "a\nb",
        "a\u{0085}b",
        "a<z",
        "a>z",
        "a\"z",
        "a|z",
        "a?z",
        "a*z",
        "trailing.",
        "trailing ",
        "CON",
        "NUL.txt",
        "con .json",
        "lpt9.LOG",
        "COM1",
        "LPT¹.txt",
        "COM²",
        "ConIn$",
        "conout$.txt",
        "clock$",
    ] {
        assert!(
            validate_relative_path(path).is_err(),
            "unsafe test fixture accepted"
        );
    }
    assert!(validate_relative_path(&"a".repeat(255)).is_ok());
    assert!(validate_relative_path(&"a".repeat(256)).is_err());
    assert!(validate_relative_path(&"中".repeat(85)).is_ok());
    assert!(validate_relative_path(&"中".repeat(86)).is_err());
    assert!(validate_relative_path(&vec!["a"; 16].join("/")).is_ok());
    assert!(validate_relative_path(&vec!["a"; 17].join("/")).is_err());
    let longest = vec!["a".repeat(255); 16].join("/");
    assert_eq!(longest.len(), 4095);
    assert!(validate_relative_path(&longest).is_ok());
    assert!(validate_relative_path(&(longest + "a")).is_err());
}

#[test]
fn collisions_include_directory_spelling_unicode_case_and_parent_file_conflicts() {
    for paths in [
        ["one", "one"],
        ["ONE", "one"],
        ["A/one", "a/two"],
        ["a", "a/b"],
        ["a/b", "a"],
        ["Σ/file", "ς/other"],
        ["K/file", "k/other"],
        ["Straße/file", "STRASSE/other"],
    ] {
        assert!(
            validate_manifest(fixture(&paths)).is_err(),
            "ambiguous test fixture accepted"
        );
    }
    assert!(validate_manifest(fixture(&["same/one", "same/two", "same/deeper/three"])).is_ok());
}

#[test]
fn payload_count_digest_and_manifest_encoding_have_independent_budgets() {
    let mut manifest = fixture(&["config.toml"]);
    manifest.files[0].bytes = SOURCE_UPLOAD_MAX_BYTES;
    assert_eq!(
        validate_manifest(manifest.clone()).unwrap().total_bytes(),
        SOURCE_UPLOAD_MAX_BYTES
    );
    manifest.files[0].bytes += 1;
    assert!(validate_manifest(manifest.clone()).is_err());
    manifest.files[0].bytes = u64::MAX;
    assert!(validate_manifest(manifest).is_err());
    for sha in ["A".repeat(64), "x".repeat(64), "a".repeat(63)] {
        let mut manifest = fixture(&["config.toml"]);
        manifest.files[0].sha256 = sha;
        assert!(validate_manifest(manifest).is_err());
    }
    let mut empty = fixture(&[]);
    assert!(validate_manifest(empty.clone()).is_err());
    empty.files = (0..SOURCE_UPLOAD_MAX_FILES)
        .map(|index| SourceUploadFile {
            relative_path: format!("file-{index}"),
            bytes: 0,
            sha256: "a".repeat(64),
        })
        .collect();
    assert!(validate_manifest(empty.clone()).is_ok());
    empty.files.push(empty.files[0].clone());
    assert!(validate_manifest(empty).is_err());
    let prefix = vec!["d".repeat(250); 5].join("/");
    let mut large = fixture(&[]);
    large.files = (0..1024)
        .map(|index| SourceUploadFile {
            relative_path: format!("{prefix}/file-{index}"),
            bytes: 0,
            sha256: "a".repeat(64),
        })
        .collect();
    assert!(validate_manifest(large).is_err());
    assert!(parse_manifest(&vec![b' '; SOURCE_UPLOAD_MANIFEST_MAX_BYTES + 1]).is_err());
}

#[test]
fn unknown_link_authority_duplicate_fields_and_versions_are_rejected_without_echo() {
    let base = serde_json::to_value(fixture(&["config.toml"])).unwrap();
    for name in ["symlink", "hardlink", "target", "executable", "type"] {
        let mut value = base.clone();
        value["files"][0][name] = json!("UNTRUSTED_SECRET_SENTINEL");
        let error = parse_manifest(&serde_json::to_vec(&value).unwrap())
            .err()
            .unwrap();
        assert!(!format!("{error:#}").contains("UNTRUSTED_SECRET_SENTINEL"));
    }
    let mut authority = base.clone();
    authority["sourceAuthority"] = json!("forged");
    assert!(parse_manifest(&serde_json::to_vec(&authority).unwrap()).is_err());
    let mut version = fixture(&["config.toml"]);
    version.version = 2;
    assert!(validate_manifest(version).is_err());
    let duplicate = serde_json::to_string(&base)
        .unwrap()
        .replacen("{", "{\"version\":1,", 1);
    assert!(parse_manifest(duplicate.as_bytes()).is_err());
}
