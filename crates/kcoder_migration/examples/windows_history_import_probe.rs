//! Explicit native-host acceptance using only two selected JSONL copies in an owned directory.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_migration::{history_discovery::HistoryCatalog, history_jobs::HistoryJobStore};
use kcoder_types::{external_history::HistoryImportStage, migration::MigrationSourceKind};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::PathBuf, time::Instant};

fn run() -> Result<()> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .context("owned probe root required")?,
    );
    ensure!(root.is_absolute(), "owned probe root must be absolute");
    let source = root.join("source");
    let profile = root.join("profile");
    ensure!(!profile.exists(), "probe profile already exists");
    let selected = source.join("sessions");
    let mut originals = BTreeMap::new();
    for entry in fs::read_dir(&selected)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "unexpected source entry"
        );
        ensure!(metadata.len() <= 4 * 1024 * 1024, "source budget exceeded");
        let bytes = fs::read(entry.path())?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        ensure!(
            originals.insert(digest, (entry.path(), bytes)).is_none(),
            "duplicate source"
        );
    }
    ensure!(originals.len() == 2, "exactly two copied sources required");
    let _private_profile = PrivateDirectory::open_or_create(&profile)?;
    let catalog = HistoryCatalog::discover(&source, MigrationSourceKind::Codex, |_| true)?;
    let page = catalog.page(None, |_| true)?;
    ensure!(
        page.discovery_complete && page.next_cursor.is_none() && page.items.len() == 2,
        "incomplete discovery"
    );
    let jobs = HistoryJobStore::open(&profile)?;
    let mut results = Vec::new();
    for summary in page.items {
        let request = uuid::Uuid::new_v4().to_string();
        let selected = catalog.selection(&summary.source_handle)?.pin()?;
        let mut job = jobs.create_selected(&request, selected)?;
        let started = Instant::now();
        while job.stage != HistoryImportStage::Normalized {
            ensure!(
                started.elapsed().as_secs() < 120,
                "normalization deadline exceeded"
            );
            ensure!(
                !matches!(
                    job.stage,
                    HistoryImportStage::Failed | HistoryImportStage::Cancelled
                ),
                "history import failed"
            );
            job = jobs.step(&job.job_id, job.sequence, 10, |_| true)?;
        }
        ensure!(job.archived, "normalized archive missing");
        let reader = jobs.archive_reader(&job.job_id)?;
        let receipt = reader.receipt()?.context("archive receipt missing")?;
        let (source_path, source_bytes) = originals
            .get(&receipt.source_sha256)
            .context("archive digest mismatch")?;
        ensure!(
            receipt.source_bytes == source_bytes.len() as u64,
            "archive length mismatch"
        );
        let lines: Vec<_> = source_bytes
            .split_inclusive(|byte| *byte == b'\n')
            .collect();
        ensure!(
            receipt.record_count == lines.len() as u64,
            "record count mismatch"
        );
        for (index, line) in lines.iter().enumerate() {
            let mut observed = Vec::new();
            reader
                .open_record(index as u64)?
                .read_to_end(&mut observed)?;
            ensure!(observed == *line, "archived record content mismatch");
        }
        let progress = job
            .normalization
            .context("normalization progress missing")?;
        ensure!(
            progress.normalization_complete && progress.normalized_records == receipt.record_count,
            "normalization incomplete"
        );
        ensure!(
            fs::read(source_path)? == *source_bytes,
            "copied source changed"
        );
        results.push(json!({"stage":"normalized","sourceBytes":receipt.source_bytes,
            "sourceSha256":receipt.source_sha256,"records":receipt.record_count,
            "normalizedRecords":progress.normalized_records,"recordsWithDiagnostics":progress.records_with_diagnostics,
            "allArchivedRecordsMatch":true,"copiedSourceUnchanged":true}));
    }
    println!("{}", json!({"imports":results,"modelRequests":0}));
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("windows_history_import_probe_failed");
        std::process::exit(1);
    }
}
