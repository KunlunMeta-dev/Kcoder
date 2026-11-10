//! Pinned structural comparisons do not grant vendor execution or continuation authority.
use kcoder_migration::history_records::{
    CLAUDE_TRANSCRIPT_BASELINE, CODEX_ROLLOUT_BASELINE, parse_reader,
};
use kcoder_types::{imported_transcript::*, migration::MigrationSourceKind};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs};

fn matrix() -> Value {
    serde_json::from_str(include_str!(
        "../fixtures/versioned-history-support-matrix.json"
    ))
    .unwrap()
}

fn fixture(row: &Value) -> Vec<u8> {
    fs::read(
        std::path::PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT").expect("current workspace root"),
        )
        .join("crates/kcoder_migration")
        .join(row["fixture"].as_str().unwrap()),
    )
    .unwrap()
}

#[test]
fn support_matrix_pins_each_fixture_and_covers_both_vendor_version_rosters() {
    let matrix = matrix();
    assert_eq!(matrix["nativeVendorAcceptance"], false);
    let observations = matrix["observations"].as_array().unwrap();
    let ids: BTreeSet<_> = observations
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), observations.len());
    for row in observations {
        let commit = row["commit"].as_str().unwrap();
        let sha = row["sha256"].as_str().unwrap();
        assert_eq!(commit.len(), 40);
        assert_eq!(sha.len(), 64);
        assert!(
            commit
                .bytes()
                .chain(sha.bytes())
                .all(|b| b.is_ascii_hexdigit())
        );
        assert!(row["url"].as_str().unwrap().contains(commit));
        assert!(
            row["retrievedAtUtc"]
                .as_str()
                .unwrap()
                .starts_with("2026-10-18T")
        );
    }
    let rows = matrix["fixtures"].as_array().unwrap();
    assert_eq!(rows.len(), 6);
    let mut roster = BTreeSet::new();
    for row in rows {
        let data = fixture(row);
        assert_eq!(row["bytes"].as_u64().unwrap(), data.len() as u64);
        assert_eq!(row["sha256"], format!("{:x}", Sha256::digest(&data)));
        let vendor = row["vendor"].as_str().unwrap();
        let structure = row["structure"].as_str().unwrap();
        assert!(roster.insert((vendor, structure)));
        if structure == "unknown" {
            assert!(row["references"].as_array().unwrap().is_empty());
        } else {
            assert!(!row["references"].as_array().unwrap().is_empty());
            for reference in row["references"].as_array().unwrap() {
                assert!(ids.contains(reference.as_str().unwrap()));
            }
        }
        if structure == "current" {
            assert_eq!(
                row["version"],
                if vendor == "codex" {
                    CODEX_ROLLOUT_BASELINE
                } else {
                    CLAUDE_TRANSCRIPT_BASELINE
                }
            );
        }
    }
    for vendor in ["claude-code", "codex"] {
        for structure in ["current", "old", "unknown"] {
            assert!(roster.contains(&(vendor, structure)));
        }
    }
}

fn verify_vendor(vendor: &str, source: MigrationSourceKind) {
    for row in matrix()["fixtures"].as_array().unwrap() {
        if row["vendor"] != vendor {
            continue;
        }
        let bytes = fixture(row);
        let mut tags = Vec::new();
        let mut diagnostics = BTreeSet::new();
        let mut tool_calls = 0;
        let mut tool_results = 0;
        let mut previous_id = None;
        for (ordinal, line) in bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .enumerate()
        {
            let raw: Value = serde_json::from_slice(line).unwrap();
            let record = parse_reader(source, ordinal as u64, line, |_| true).unwrap();
            assert_eq!(record.record, ordinal as u64);
            for diagnostic in &record.diagnostics {
                assert!(diagnostic.blocks_continuation);
                diagnostics.insert(diagnostic.code.clone());
            }
            let tag = match &record.data {
                HistoricalRecordData::Session { version, .. } => {
                    assert_eq!(version.as_deref(), row["version"].as_str());
                    "session"
                }
                HistoricalRecordData::Message { role, blocks, .. } => {
                    if vendor == "claude-code" {
                        assert_eq!(record.source_id.as_deref(), raw["uuid"].as_str());
                        assert_eq!(record.parent_id, previous_id);
                        previous_id = record.source_id.clone();
                    }
                    for block in blocks {
                        match block {
                            HistoricalBlock::ToolCall { call_id, input, .. } => {
                                assert_eq!(call_id, "read-1");
                                assert_eq!(input.record, ordinal as u64);
                                assert!(input.offset + input.bytes <= line.len() as u64);
                                tool_calls += 1;
                            }
                            HistoricalBlock::ToolResult {
                                call_id,
                                output,
                                outcome,
                            } => {
                                assert_eq!(call_id, "read-1");
                                assert_eq!(*outcome, HistoricalToolOutcome::RecordedResult);
                                assert!(output.offset + output.bytes <= line.len() as u64);
                                tool_results += 1;
                            }
                            _ => {}
                        }
                    }
                    match role {
                        HistoricalRole::User => "user",
                        HistoricalRole::Assistant => "assistant",
                        HistoricalRole::Tool => "tool",
                        _ => panic!("unexpected structural role"),
                    }
                }
                HistoricalRecordData::Unknown { payload, .. } => {
                    assert!(
                        payload
                            .as_ref()
                            .is_some_and(|value| value.preview.is_none())
                    );
                    assert!(
                        !serde_json::to_string(&record)
                            .unwrap()
                            .contains("SYNTHETIC_OPAQUE_PAYLOAD")
                    );
                    "unknown"
                }
                _ => panic!("unexpected structural record"),
            };
            tags.push(tag);
        }
        assert_eq!(serde_json::to_value(&tags).unwrap(), row["sequence"]);
        let expected: BTreeSet<String> = row["expectedDiagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(diagnostics, expected, "{}", row["id"]);
        if row["unknownMustRemainOpaque"] == true {
            assert!(diagnostics.contains("unknown_source_record"));
            assert_eq!((tool_calls, tool_results), (0, 0));
        } else {
            assert_eq!((tool_calls, tool_results), (1, 1));
        }
        assert_eq!(fixture(row), bytes, "fixture bytes must remain unchanged");
    }
}

#[test]
fn valid_claude_record_shapes_are_readable_regardless_of_product_version() {
    verify_vendor("claude-code", MigrationSourceKind::ClaudeCode);
}

#[test]
fn valid_codex_record_shapes_are_readable_regardless_of_product_version() {
    verify_vendor("codex", MigrationSourceKind::Codex);
}
