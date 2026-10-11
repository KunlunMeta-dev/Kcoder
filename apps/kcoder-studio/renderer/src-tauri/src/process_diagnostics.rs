use crate::local_terminal;
#[cfg(target_os = "macos")]
use std::collections::{HashMap, HashSet};

#[derive(serde::Serialize, Clone)]
struct ProcessDiagnosticsProcess {
    pid: u32,
    ppid: u32,
    group: String,
    rss_kib: u64,
    physical_footprint_kib: u64,
    cpu_percent: f64,
    command: String,
}

#[derive(serde::Serialize, Clone)]
struct ProcessDiagnosticsGroup {
    group: String,
    process_count: usize,
    rss_kib: u64,
    physical_footprint_kib: u64,
    cpu_percent: f64,
    pids: Vec<u32>,
}

#[derive(serde::Serialize, Clone)]
pub(super) struct ProcessDiagnosticsSnapshot {
    timestamp_ms: u64,
    main_pid: u32,
    groups: Vec<ProcessDiagnosticsGroup>,
    processes: Vec<ProcessDiagnosticsProcess>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
pub(super) struct RawProcessInfo {
    pub(super) pid: u32,
    pub(super) ppid: u32,
    pub(super) rss_kib: u64,
    pub(super) cpu_percent: f64,
    pub(super) command: String,
}

#[cfg(target_os = "macos")]
pub(super) fn parse_process_snapshot_line(line: &str) -> Option<RawProcessInfo> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse::<u32>().ok()?;
    let ppid = parts.next()?.parse::<u32>().ok()?;
    let rss_kib = parts.next()?.parse::<u64>().ok()?;
    let cpu_percent = parts.next()?.parse::<f64>().ok()?;
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }

    Some(RawProcessInfo {
        pid,
        ppid,
        rss_kib,
        cpu_percent,
        command,
    })
}

#[cfg(target_os = "macos")]
pub(super) fn collect_descendant_pids(processes: &[RawProcessInfo], roots: &[u32]) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for process in processes {
        children_by_parent
            .entry(process.ppid)
            .or_default()
            .push(process.pid);
    }

    let mut descendants = HashSet::new();
    let mut stack = roots.to_vec();
    while let Some(pid) = stack.pop() {
        if !descendants.insert(pid) {
            continue;
        }
        if let Some(children) = children_by_parent.get(&pid) {
            stack.extend(children);
        }
    }

    descendants
}

#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
pub(super) struct LaunchServicesProcess {
    pub(super) display_name: String,
    pub(super) bundle_id: Option<String>,
    pub(super) pid: u32,
}

#[cfg(target_os = "macos")]
pub(super) fn parse_launch_services_processes(output: &str) -> Vec<LaunchServicesProcess> {
    let mut processes = Vec::new();
    let mut display_name = None;
    let mut bundle_id = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((_, value)) = trimmed.split_once(") \"") {
            if let Some((name, _)) = value.split_once("\" ASN:") {
                display_name = Some(name.to_owned());
                bundle_id = None;
                continue;
            }
        }
        if let Some(value) = trimmed.strip_prefix("bundleID=\"") {
            bundle_id = value.strip_suffix('"').map(str::to_owned);
            continue;
        }
        let Some(value) = trimmed.strip_prefix("pid = ") else {
            continue;
        };
        let Some(pid) = value
            .split_whitespace()
            .next()
            .and_then(|candidate| candidate.parse::<u32>().ok())
        else {
            continue;
        };
        if let Some(display_name) = display_name.take() {
            processes.push(LaunchServicesProcess {
                display_name,
                bundle_id: bundle_id.take(),
                pid,
            });
        }
    }
    processes
}

#[cfg(target_os = "macos")]
pub(super) fn collect_macos_webkit_process_ids(main_pid: u32) -> Result<HashSet<u32>, String> {
    let output = std::process::Command::new("lsappinfo")
        .arg("list")
        .output()
        .map_err(|error| format!("Failed to run lsappinfo: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    related_macos_webkit_process_ids(
        &parse_launch_services_processes(&String::from_utf8_lossy(&output.stdout)),
        main_pid,
    )
}

#[cfg(target_os = "macos")]
pub(super) fn related_macos_webkit_process_ids(
    processes: &[LaunchServicesProcess],
    main_pid: u32,
) -> Result<HashSet<u32>, String> {
    let (main_index, display_name) = processes
        .iter()
        .enumerate()
        .find(|(_, process)| process.pid == main_pid)
        .map(|(index, process)| (index, process.display_name.as_str()))
        .ok_or_else(|| format!("LaunchServices entry missing for Wework pid {main_pid}"))?;
    let expected_processes = [
        ("Web Content", "com.apple.WebKit.WebContent"),
        ("Networking", "com.apple.WebKit.Networking"),
        ("Graphics and Media", "com.apple.WebKit.GPU"),
    ];
    let instance_end = processes[main_index + 1..]
        .iter()
        .position(|process| process.display_name == display_name)
        .map_or(processes.len(), |offset| main_index + 1 + offset);
    let instance_processes = &processes[main_index + 1..instance_end];

    Ok(expected_processes
        .into_iter()
        .flat_map(|(suffix, bundle_id)| {
            let expected_name = format!("{display_name} {suffix}");
            instance_processes
                .iter()
                .filter(move |process| {
                    process.display_name == expected_name
                        && process.bundle_id.as_deref() == Some(bundle_id)
                })
                .map(|process| process.pid)
        })
        .collect())
}

#[cfg(target_os = "macos")]
pub(super) fn process_physical_footprint_kib(pid: u32) -> Option<u64> {
    let mut usage = unsafe { std::mem::zeroed::<libc::rusage_info_v2>() };
    let usage_pointer = (&mut usage as *mut libc::rusage_info_v2).cast::<libc::rusage_info_t>();
    // SAFETY: proc_pid_rusage writes rusage_info_v2 in V2 format into the initialized buffer.
    let result =
        unsafe { libc::proc_pid_rusage(pid as libc::c_int, libc::RUSAGE_INFO_V2, usage_pointer) };
    (result == 0).then_some(usage.ri_phys_footprint / 1024)
}

#[cfg(target_os = "macos")]
pub(super) fn classify_process(
    process: &RawProcessInfo,
    main_pid: u32,
    terminal_process_ids: &HashSet<u32>,
    terminal_descendant_ids: &HashSet<u32>,
) -> Option<String> {
    if process.pid == main_pid {
        return Some("main".to_string());
    }
    if terminal_process_ids.contains(&process.pid) || terminal_descendant_ids.contains(&process.pid)
    {
        return Some("terminal".to_string());
    }
    if process.command.contains("wegent-executor") {
        return Some("executor".to_string());
    }
    if process.command.contains("codex") && process.command.contains("app-server") {
        return Some("codex-app-server".to_string());
    }
    if process.command.contains("com.apple.WebKit.WebContent") {
        return Some("webkit-webcontent".to_string());
    }
    if process.command.contains("com.apple.WebKit.GPU") {
        return Some("webkit-gpu".to_string());
    }
    if process.command.contains("com.apple.WebKit.Networking") {
        return Some("webkit-networking".to_string());
    }
    if process.command.contains("com.apple.WebKit") {
        return Some("webkit-other".to_string());
    }

    Some("child".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(super) fn get_wework_process_snapshot(
    local_terminal_state: tauri::State<'_, local_terminal::LocalTerminalState>,
) -> Result<ProcessDiagnosticsSnapshot, String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,pcpu=,command="])
        .output()
        .map_err(|error| format!("Failed to run ps: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let processes = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_process_snapshot_line)
        .collect::<Vec<_>>();
    let main_pid = std::process::id();
    let terminal_roots = local_terminal_state.active_process_ids()?;
    let mut app_process_ids = collect_descendant_pids(&processes, &[main_pid]);
    app_process_ids.extend(collect_macos_webkit_process_ids(main_pid)?);
    let terminal_process_ids = terminal_roots.iter().copied().collect::<HashSet<_>>();
    let terminal_descendant_ids = collect_descendant_pids(&processes, &terminal_roots);

    let mut related_processes = processes
        .iter()
        .filter(|process| app_process_ids.contains(&process.pid))
        .filter_map(|process| {
            let group = classify_process(
                process,
                main_pid,
                &terminal_process_ids,
                &terminal_descendant_ids,
            )?;
            Some(ProcessDiagnosticsProcess {
                pid: process.pid,
                ppid: process.ppid,
                group,
                rss_kib: process.rss_kib,
                physical_footprint_kib: process_physical_footprint_kib(process.pid).unwrap_or(0),
                cpu_percent: process.cpu_percent,
                command: process.command.clone(),
            })
        })
        .collect::<Vec<_>>();
    related_processes.sort_by(|left, right| {
        right
            .physical_footprint_kib
            .cmp(&left.physical_footprint_kib)
    });

    let mut groups_by_name = HashMap::<String, ProcessDiagnosticsGroup>::new();
    for process in &related_processes {
        let group = groups_by_name
            .entry(process.group.clone())
            .or_insert_with(|| ProcessDiagnosticsGroup {
                group: process.group.clone(),
                process_count: 0,
                rss_kib: 0,
                physical_footprint_kib: 0,
                cpu_percent: 0.0,
                pids: Vec::new(),
            });
        group.process_count += 1;
        group.rss_kib += process.rss_kib;
        group.physical_footprint_kib += process.physical_footprint_kib;
        group.cpu_percent += process.cpu_percent;
        group.pids.push(process.pid);
    }

    let mut groups = groups_by_name.into_values().collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        right
            .physical_footprint_kib
            .cmp(&left.physical_footprint_kib)
    });

    Ok(ProcessDiagnosticsSnapshot {
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("System clock is before UNIX epoch: {error}"))?
            .as_millis() as u64,
        main_pid,
        groups,
        processes: related_processes,
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(super) fn get_wework_process_snapshot(
    _local_terminal_state: tauri::State<'_, local_terminal::LocalTerminalState>,
) -> Result<ProcessDiagnosticsSnapshot, String> {
    Err("Process diagnostics are currently available only on macOS".to_string())
}
