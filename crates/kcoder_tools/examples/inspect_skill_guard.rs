//! Read-only inspection of explicitly supplied, bounded skill text for verification harnesses.
use std::io::Read;

fn main() -> anyhow::Result<()> {
    let path = std::env::args_os().nth(1).ok_or_else(|| {
        anyhow::anyhow!(
            "usage: cargo run -p kcoder_tools --example inspect_skill_guard -- <skill-text-file>"
        )
    })?;
    let file = std::fs::File::open(path)?;
    anyhow::ensure!(file.metadata()?.is_file(), "input must be a regular file");
    let mut bytes = Vec::new();
    file.take(5 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 5 * 1024 * 1024,
        "input exceeds skill guard byte budget"
    );
    let report = kcoder_tools::skill_guard::scan_skill_content(&String::from_utf8_lossy(&bytes));
    println!("risk={:?}, findings={}", report.risk, report.finding_count);
    for finding in report.findings.iter().take(8) {
        println!(
            "{:?}/{:?}: {}",
            finding.level, finding.category, finding.pattern
        );
    }
    Ok(())
}
