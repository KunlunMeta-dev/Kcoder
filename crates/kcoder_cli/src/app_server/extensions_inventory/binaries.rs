//! CLI binaries on the `PATH` this app-server process sees. Runs only for
//! `includeBinaries`, with a bounded `--version` probe per binary.
use super::shared::{display_path, item};
use kcoder_app_protocol::{
    ExtensionConflict, ExtensionConflictReason, ExtensionInventoryItem, ExtensionItemKind,
    ExtensionLayer, ExtensionSourceRef, ExtensionUpstream,
};
use kcoder_cli_commands::extension_binaries::{self, BinaryProbe};

fn layer(probe: &BinaryProbe, index: usize) -> ExtensionLayer {
    if index == 0 && probe.bundled {
        ExtensionLayer::Bundled
    } else {
        ExtensionLayer::External
    }
}

pub(super) fn project(
    items: &mut Vec<ExtensionInventoryItem>,
    conflicts: &mut Vec<ExtensionConflict>,
) {
    let path = std::env::var_os("PATH");
    let pin = extension_binaries::bundled_lark_cli_version();
    for (name, role) in extension_binaries::INVENTORY_BINARIES {
        let probe = extension_binaries::probe(
            name,
            path.as_deref(),
            extension_binaries::VERSION_PROBE_TIMEOUT,
        );
        project_probe(&probe, role, pin.as_deref(), items, conflicts);
    }
}

pub(super) fn project_probe(
    probe: &BinaryProbe,
    role: &str,
    pin: Option<&str>,
    items: &mut Vec<ExtensionInventoryItem>,
    conflicts: &mut Vec<ExtensionConflict>,
) {
    if probe.copies.is_empty() {
        let mut entry = item(
            ExtensionItemKind::Binary,
            &probe.name,
            ExtensionLayer::External,
        );
        entry.enabled = false;
        entry.effective = false;
        entry.detail = Some(format!("not found on PATH; {role}"));
        items.push(entry);
        return;
    }
    let refs: Vec<ExtensionSourceRef> = probe
        .copies
        .iter()
        .enumerate()
        .map(|(index, copy)| ExtensionSourceRef {
            layer: layer(probe, index),
            owner_plugin_id: None,
            path: Some(display_path(copy)),
        })
        .collect();
    for (index, copy) in probe.copies.iter().enumerate() {
        let mut entry = item(ExtensionItemKind::Binary, &probe.name, layer(probe, index));
        entry.path = Some(display_path(copy));
        entry.effective = index == 0;
        entry.bundled = Some(index == 0 && probe.bundled);
        entry.detail = Some(match (index, &probe.probe_error) {
            (0, Some(error)) => format!("{role}; version unavailable: {error}"),
            _ => role.to_owned(),
        });
        if index == 0 {
            entry.version = probe
                .version
                .clone()
                .or(probe.bundled_marker_version.clone());
            entry.shadows = refs[1..].to_vec();
            if probe.name == "lark-cli" {
                entry.upstream = Some(ExtensionUpstream {
                    repository: Some("https://github.com/larksuite/cli".into()),
                    git_ref: None,
                    version: entry.version.clone(),
                });
            }
        } else {
            entry.shadowed_by = Some(refs[0].clone());
        }
        items.push(entry);
    }
    if probe.copies.len() > 1 {
        conflicts.push(ExtensionConflict {
            kind: ExtensionItemKind::Binary,
            reason: ExtensionConflictReason::MultipleBinaries,
            name: probe.name.clone(),
            effective: Some(refs[0].clone()),
            shadowed: refs[1..].to_vec(),
            same_upstream: false,
            plugin_id: None,
            provided: Vec::new(),
            missing: Vec::new(),
            effective_from_plugin: Vec::new(),
        });
    }
    if probe.name == "lark-cli"
        && let (Some(pin), Some(version)) = (pin, probe.version.as_deref())
        && pin != version
    {
        conflicts.push(ExtensionConflict {
            kind: ExtensionItemKind::Binary,
            reason: ExtensionConflictReason::VersionMismatch,
            name: probe.name.clone(),
            effective: Some(refs[0].clone()),
            shadowed: Vec::new(),
            same_upstream: true,
            plugin_id: None,
            provided: vec![version.to_owned()],
            missing: vec![pin.to_owned()],
            effective_from_plugin: Vec::new(),
        });
    }
}
