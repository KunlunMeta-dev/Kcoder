//! Passive development timing. No paths, configuration, or error contents.
use std::time::Duration;

#[derive(Clone, Copy)]
pub(super) enum Phase {
    Manifest,
    Inventory,
    Enumeration,
    ResourcePaths,
    ResourceOpen,
    ResourceHash,
    Recipe,
    ResourceOpenCall,
    ResourceMetadata,
    #[cfg(windows)]
    FinalNamespace = 9,
    #[cfg(windows)]
    FinalFiles = 10,
    #[cfg(windows)]
    ResourceIdentity = 11,
    #[cfg(windows)]
    ResourceBasicInfo = 12,
    #[cfg(windows)]
    ResourceOpenWall = 13,
}

/// Only aggregate counts and durations; this cannot change verification policy.
#[derive(Default)]
pub struct VerifyMetrics {
    elapsed: [Duration; 14],
    counts: [u64; 14],
    pub(super) directories: u64,
    pub(super) inventory_files: u64,
    pub(super) hashed_bytes: u64,
}

impl VerifyMetrics {
    pub(super) fn record(&mut self, phase: Phase, elapsed: Duration, count: u64) {
        let index = phase as usize;
        self.elapsed[index] += elapsed;
        self.counts[index] = self.counts[index].saturating_add(count);
    }

    /// Fixed diagnostic labels, never manifest names or underlying errors.
    pub fn json(&self) -> serde_json::Value {
        let labels = [
            "manifest",
            "inventory",
            "enumeration",
            "resource_paths",
            "resource_open",
            "resource_hash",
            "recipe",
            "resource_open_call",
            "resource_metadata",
            "final_namespace",
            "final_files",
            "resource_identity",
            "resource_basic_info",
            "resource_open_pool_wall",
        ];
        let phases = labels
            .iter()
            .enumerate()
            .map(|(index, phase)| {
                serde_json::json!({"phase":phase,"count":self.counts[index],
                "timingScope":if [4,7,8,11,12].contains(&index) { "operation_sum" } else { "wall" },
                "nestedIn":if (7..=8).contains(&index) { Some("resource_open") }
                    else if (11..=12).contains(&index) { Some("resource_metadata") } else { None },
                "elapsedMs":self.elapsed[index].as_millis().min(u64::MAX as u128) as u64})
            })
            .collect::<Vec<_>>();
        serde_json::json!({"phases":phases,"directories":self.directories,
            "inventoryFiles":self.inventory_files,"hashedBytes":self.hashed_bytes})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submillisecond_operations_accumulate_before_rounding() {
        let mut metrics = VerifyMetrics::default();
        for _ in 0..10 {
            metrics.record(Phase::ResourcePaths, Duration::from_micros(200), 1);
        }
        let json = metrics.json();
        let paths = &json["phases"][3];
        assert_eq!(paths["phase"], "resource_paths");
        assert_eq!(paths["count"], 10);
        assert_eq!(paths["elapsedMs"], 2);
    }

    #[test]
    fn open_subphases_are_explicitly_nested_in_the_unchanged_group() {
        let mut metrics = VerifyMetrics::default();
        metrics.record(Phase::ResourceOpen, Duration::from_millis(9), 1);
        metrics.record(Phase::ResourceOpenCall, Duration::from_millis(7), 1);
        metrics.record(Phase::ResourceMetadata, Duration::from_millis(2), 1);
        let output = metrics.json();
        assert_eq!(output["phases"][4]["elapsedMs"], 9);
        assert_eq!(output["phases"][7]["nestedIn"], "resource_open");
        assert_eq!(output["phases"][8]["nestedIn"], "resource_open");
    }
}
