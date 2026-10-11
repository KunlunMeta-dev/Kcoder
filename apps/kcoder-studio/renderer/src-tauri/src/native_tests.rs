#[cfg(target_os = "macos")]
use super::process_diagnostics::{
    classify_process, collect_descendant_pids, parse_launch_services_processes,
    parse_process_snapshot_line, process_physical_footprint_kib, related_macos_webkit_process_ids,
    LaunchServicesProcess, RawProcessInfo,
};
#[cfg(desktop)]
use super::should_probe_frontend_after_focus;
#[cfg(target_os = "macos")]
use super::tray_template_pixel;
#[cfg(all(desktop, target_os = "macos"))]
use super::{can_replace_studio_cli_path, install_studio_cli_impl, studio_cli_launcher_content};
use super::{
    executor_home_attachment_root, inspect_workspace_path_candidates,
    local_workspace_opener_app_name, normalized_browser_link_target,
    parse_local_workspace_open_request, tray_usage_icon,
};
#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(desktop)]
use std::time::Duration;

fn test_temp_dir(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("studio-cli-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("test temp dir should be created");
    path
}

#[cfg(target_os = "macos")]
#[test]
fn converts_macos_tray_pixels_to_a_template_mask() {
    assert_eq!(tray_template_pixel([255, 255, 255, 255]), [0, 0, 0, 0]);
    assert_eq!(tray_template_pixel([0, 0, 0, 255]), [0, 0, 0, 255]);
    assert_eq!(tray_template_pixel([20, 120, 220, 128]), [0, 0, 0, 117]);
}

#[test]
fn inspects_clipboard_paths_without_reading_file_contents() {
    let root = test_temp_dir("clipboard-paths");
    let folder = root.join("folder");
    let file = root.join("context.md");
    std::fs::create_dir_all(&folder).expect("clipboard folder should be created");
    std::fs::write(&file, "# Context\n").expect("clipboard file should be created");

    let selected = inspect_workspace_path_candidates(vec![
        folder.to_string_lossy().into_owned(),
        file.to_string_lossy().into_owned(),
        file.to_string_lossy().into_owned(),
        root.join("missing").to_string_lossy().into_owned(),
    ]);

    assert_eq!(selected.len(), 2);
    assert_eq!(selected[0].path, folder.to_string_lossy());
    assert!(selected[0].is_directory);
    assert_eq!(selected[1].path, file.to_string_lossy());
    assert!(!selected[1].is_directory);
}

#[cfg(desktop)]
#[test]
fn probes_frontend_only_after_a_meaningful_unfocused_interval() {
    assert!(!should_probe_frontend_after_focus(Duration::from_secs(59)));
    assert!(should_probe_frontend_after_focus(Duration::from_secs(60)));
    assert!(should_probe_frontend_after_focus(Duration::from_secs(120)));
}

#[test]
fn keeps_tray_usage_canvas_stable_across_usage_and_running_states() {
    let base_icon = tauri::image::Image::new_owned(vec![255; 32 * 32 * 4], 32, 32);
    let compact =
        tray_usage_icon("5h 9%\n7d --", Some(&base_icon), 0, false, 0).expect("compact usage icon");
    let full =
        tray_usage_icon("5h 100%\n7d 100%", Some(&base_icon), 3, true, 7).expect("full usage icon");

    assert_eq!(compact.width(), full.width());
    assert_eq!(compact.height(), full.height());
}

#[test]
fn maps_local_workspace_openers_to_macos_app_names() {
    assert_eq!(
        local_workspace_opener_app_name("vscode"),
        Some("Visual Studio Code")
    );
    assert_eq!(
        local_workspace_opener_app_name("vscode-insiders"),
        Some("Visual Studio Code - Insiders")
    );
    assert_eq!(local_workspace_opener_app_name("iterm2"), Some("iTerm"));
    assert_eq!(
        local_workspace_opener_app_name("android-studio"),
        Some("Android Studio")
    );
    assert_eq!(
        local_workspace_opener_app_name("intellij-idea"),
        Some("IntelliJ IDEA")
    );
    assert_eq!(local_workspace_opener_app_name("unknown"), None);
}

#[test]
fn places_local_attachment_drafts_under_executor_home() {
    assert_eq!(
        executor_home_attachment_root(std::path::Path::new("/Users/me/.wegent-executor")),
        std::path::PathBuf::from("/Users/me/.wegent-executor/workspace/attachments/draft")
    );
}

#[test]
fn parses_local_workspace_open_request_from_argv() {
    let request = parse_local_workspace_open_request(&[
        "WeWork".to_string(),
        "--open-workspace".to_string(),
        "/Users/me/project".to_string(),
        "--workspace-label".to_string(),
        "Project".to_string(),
    ])
    .expect("workspace request should parse");

    assert_eq!(request.path, "/Users/me/project");
    assert_eq!(request.label.as_deref(), Some("Project"));
}

#[test]
fn ignores_blank_local_workspace_open_path() {
    assert!(parse_local_workspace_open_request(&[
        "WeWork".to_string(),
        "--open-workspace".to_string(),
        "   ".to_string(),
    ])
    .is_none());
}

#[test]
fn normalizes_browser_link_targets() {
    assert_eq!(
        normalized_browser_link_target("studio".to_string(), "system"),
        "studio"
    );
    assert_eq!(
        normalized_browser_link_target("  system  ".to_string(), "studio"),
        "system"
    );
    // Historical values persisted by older installs are not recognized; fall back to the caller-provided default target.
    assert_eq!(
        normalized_browser_link_target("wework".to_string(), "studio"),
        "studio"
    );
    assert_eq!(
        normalized_browser_link_target("chrome".to_string(), "system"),
        "system"
    );
}

#[cfg(all(desktop, target_os = "macos"))]
#[test]
fn renders_wework_cli_launcher_for_app_bundle() {
    let content = studio_cli_launcher_content(
        std::path::Path::new("/Applications/WeWork.app/Contents/MacOS/WeWork"),
        Some(std::path::Path::new("/Applications/WeWork.app")),
    );

    assert!(content.contains("# Wework CLI launcher"));
    assert!(content.contains("APP_BUNDLE='/Applications/WeWork.app'"));
    assert!(content.contains("KCODER_STUDIO_EXECUTOR_SIDECAR=''"));
    assert!(content.contains("export KCODER_STUDIO_EXECUTOR_SIDECAR"));
    assert!(content.contains("\"$KCODER_STUDIO_EXECUTABLE\" --open-workspace \"$ABSOLUTE_PATH\""));
    assert!(content.contains("exec open \"$APP_BUNDLE\" --args --open-workspace"));
}

#[cfg(all(desktop, target_os = "macos"))]
#[test]
fn bakes_configured_executor_sidecar_into_cli_launcher() {
    let previous = std::env::var_os("KCODER_STUDIO_EXECUTOR_SIDECAR");
    std::env::set_var(
        "KCODER_STUDIO_EXECUTOR_SIDECAR",
        "/repo/renderer/scripts/dev-executor-sidecar.sh",
    );

    let content = studio_cli_launcher_content(std::path::Path::new("/tmp/debug/app"), None);

    assert!(content.contains(
        "KCODER_STUDIO_EXECUTOR_SIDECAR='/repo/renderer/scripts/dev-executor-sidecar.sh'"
    ));
    assert!(content.contains("export KCODER_STUDIO_EXECUTOR_SIDECAR"));

    match previous {
        Some(value) => std::env::set_var("KCODER_STUDIO_EXECUTOR_SIDECAR", value),
        None => std::env::remove_var("KCODER_STUDIO_EXECUTOR_SIDECAR"),
    }
}

#[cfg(all(desktop, target_os = "macos"))]
#[test]
fn installs_wework_cli_launcher_and_replaces_managed_files() {
    let temp_dir = test_temp_dir("install");
    let executable_path = temp_dir.join("debug").join("app");
    std::fs::create_dir_all(executable_path.parent().expect("executable has parent"))
        .expect("executable dir should be created");
    std::fs::write(&executable_path, b"app").expect("executable should be written");

    let installed_path =
        install_studio_cli_impl(&temp_dir, &executable_path).expect("launcher should be installed");
    let content = std::fs::read_to_string(&installed_path).expect("launcher should be read");
    assert!(content.contains("# Wework CLI launcher"));
    assert!(content.contains("KCODER_STUDIO_EXECUTABLE="));

    std::fs::write(&installed_path, "# Wework CLI launcher\nold")
        .expect("managed launcher should be overwritten");
    install_studio_cli_impl(&temp_dir, &executable_path)
        .expect("managed launcher should be replaced");
    let replaced_content =
        std::fs::read_to_string(&installed_path).expect("launcher should be read again");
    assert!(replaced_content.contains("Open a local workspace in the KCoder Studio desktop app."));

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[cfg(all(desktop, target_os = "macos"))]
#[test]
fn refuses_to_replace_unmanaged_wework_cli_file() {
    let temp_dir = test_temp_dir("unmanaged");
    let install_dir = temp_dir.join(".local/bin");
    std::fs::create_dir_all(&install_dir).expect("install dir should be created");
    let installed_path = install_dir.join("wework");
    std::fs::write(&installed_path, "#!/bin/sh\necho custom")
        .expect("custom command should be written");

    assert!(
        !can_replace_studio_cli_path(&installed_path).expect("existing file should be inspected")
    );
    assert!(
        install_studio_cli_impl(&temp_dir, std::path::Path::new("/tmp/app"))
            .expect_err("unmanaged file should not be replaced")
            .contains("not managed by Wework")
    );

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[cfg(target_os = "macos")]
#[test]
fn parses_process_snapshot_lines_with_spaced_commands() {
    let process = parse_process_snapshot_line(" 123  45 6789  12.5 /Applications/WeWork.app/a b c")
        .expect("process line should parse");

    assert_eq!(process.pid, 123);
    assert_eq!(process.ppid, 45);
    assert_eq!(process.rss_kib, 6789);
    assert_eq!(process.cpu_percent, 12.5);
    assert_eq!(process.command, "/Applications/WeWork.app/a b c");
}

#[cfg(target_os = "macos")]
#[test]
fn collects_descendant_processes() {
    let processes = vec![
        raw_process(1, 0, "main"),
        raw_process(2, 1, "child"),
        raw_process(3, 2, "grandchild"),
        raw_process(4, 0, "other"),
    ];

    let descendants = collect_descendant_pids(&processes, &[1]);

    assert!(descendants.contains(&1));
    assert!(descendants.contains(&2));
    assert!(descendants.contains(&3));
    assert!(!descendants.contains(&4));
}

#[cfg(target_os = "macos")]
#[test]
fn parses_launch_services_webkit_processes() {
    let output = r#"
192) "app" ASN:0x0-0x3f38f35:
    bundleID=[ NULL ]
    pid = 40739 type="Foreground"
193) "app Networking" ASN:0x0-0x3f39f36:
    bundleID="com.apple.WebKit.Networking"
    pid = 41055 type="UIElement"
194) "app Graphics and Media" ASN:0x0-0x3f3af37:
    bundleID="com.apple.WebKit.GPU"
    pid = 41054 type="UIElement"
195) "app Web Content" ASN:0x0-0x3f3bf38:
    bundleID="com.apple.WebKit.WebContent"
    pid = 41056 type="UIElement"
"#;

    assert_eq!(
        parse_launch_services_processes(output),
        vec![
            LaunchServicesProcess {
                display_name: "app".to_owned(),
                bundle_id: None,
                pid: 40739,
            },
            LaunchServicesProcess {
                display_name: "app Networking".to_owned(),
                bundle_id: Some("com.apple.WebKit.Networking".to_owned()),
                pid: 41055,
            },
            LaunchServicesProcess {
                display_name: "app Graphics and Media".to_owned(),
                bundle_id: Some("com.apple.WebKit.GPU".to_owned()),
                pid: 41054,
            },
            LaunchServicesProcess {
                display_name: "app Web Content".to_owned(),
                bundle_id: Some("com.apple.WebKit.WebContent".to_owned()),
                pid: 41056,
            },
        ]
    );
}

#[cfg(target_os = "macos")]
#[test]
fn associates_webkit_processes_with_the_nearest_matching_app_instance() {
    let processes = parse_launch_services_processes(
        r#"
1) "app" ASN:1:
    bundleID=[ NULL ]
    pid = 100 type="Foreground"
2) "app Networking" ASN:2:
    bundleID="com.apple.WebKit.Networking"
    pid = 101 type="UIElement"
3) "app Graphics and Media" ASN:3:
    bundleID="com.apple.WebKit.GPU"
    pid = 102 type="UIElement"
4) "app Web Content" ASN:4:
    bundleID="com.apple.WebKit.WebContent"
    pid = 103 type="UIElement"
5) "app" ASN:5:
    bundleID=[ NULL ]
    pid = 200 type="Foreground"
6) "app Networking" ASN:6:
    bundleID="com.apple.WebKit.Networking"
    pid = 201 type="UIElement"
7) "app Graphics and Media" ASN:7:
    bundleID="com.apple.WebKit.GPU"
    pid = 202 type="UIElement"
8) "app Web Content" ASN:8:
    bundleID="com.apple.WebKit.WebContent"
    pid = 203 type="UIElement"
9) "app Web Content" ASN:9:
    bundleID="com.apple.WebKit.WebContent"
    pid = 204 type="UIElement"
"#,
    );

    assert_eq!(
        related_macos_webkit_process_ids(&processes, 200),
        Ok(HashSet::from([201, 202, 203, 204]))
    );
}

#[cfg(target_os = "macos")]
#[test]
fn reads_current_process_physical_footprint() {
    assert!(process_physical_footprint_kib(std::process::id()).is_some_and(|value| value > 0));
}

#[cfg(target_os = "macos")]
#[test]
fn classifies_wework_process_groups() {
    let terminal_roots = HashSet::from([3]);
    let terminal_descendants = HashSet::from([3, 4]);

    assert_eq!(
        classify_process(
            &raw_process(1, 0, "Wework"),
            1,
            &terminal_roots,
            &terminal_descendants
        ),
        Some("main".to_string())
    );
    assert_eq!(
        classify_process(
            &raw_process(2, 1, "com.apple.WebKit.WebContent"),
            1,
            &terminal_roots,
            &terminal_descendants
        ),
        Some("webkit-webcontent".to_string())
    );
    assert_eq!(
        classify_process(
            &raw_process(4, 3, "/bin/zsh"),
            1,
            &terminal_roots,
            &terminal_descendants
        ),
        Some("terminal".to_string())
    );
    assert_eq!(
        classify_process(
            &raw_process(5, 1, "/Applications/KCoder Studio.app/wegent-executor"),
            1,
            &terminal_roots,
            &terminal_descendants
        ),
        Some("executor".to_string())
    );
    assert_eq!(
        classify_process(
            &raw_process(6, 5, "/Applications/KCoder Studio.app/codex app-server"),
            1,
            &terminal_roots,
            &terminal_descendants
        ),
        Some("codex-app-server".to_string())
    );
}

#[cfg(target_os = "macos")]
fn raw_process(pid: u32, ppid: u32, command: &str) -> RawProcessInfo {
    RawProcessInfo {
        pid,
        ppid,
        rss_kib: 0,
        cpu_percent: 0.0,
        command: command.to_string(),
    }
}
