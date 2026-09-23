use anyhow::{Context, Result};
use std::path::Path;

pub(crate) const INPUT_HISTORY_MAX_ENTRIES: usize = 1000;

pub(crate) fn load_input_history_file(path: &Path) -> Result<Vec<String>> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read input history from {:?}", path))?;
    let mut history: Vec<String> = content
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str::<String>(line).unwrap_or_else(|_| line.to_string()))
        .collect();
    if history.len() > INPUT_HISTORY_MAX_ENTRIES {
        let start = history.len() - INPUT_HISTORY_MAX_ENTRIES;
        history = history.split_off(start);
    }
    Ok(history)
}

pub(crate) fn save_input_history_file(path: &Path, history: &[String]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create history directory {:?}", parent))?;
    }
    let mut content = String::new();
    for entry in history {
        content.push_str(
            &serde_json::to_string(entry).context("failed to serialize input history entry")?,
        );
        content.push('\n');
    }
    std::fs::write(path, content)
        .with_context(|| format!("failed to write input history to {:?}", path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_history_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "kcoder_repl_input_history_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn save_creates_parent_directory_and_round_trips_entries() {
        let dir = temp_history_path("roundtrip");
        let path = dir.join("nested").join("input_history.txt");
        let history = vec!["first".to_string(), "second".to_string()];

        save_input_history_file(&path, &history).unwrap();

        assert_eq!(load_input_history_file(&path).unwrap(), history);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn multiline_and_unicode_entries_round_trip_as_single_items() {
        let dir = temp_history_path("multiline");
        let path = dir.join("input_history.jsonl");
        let history = vec!["first\nsecond\n".to_string(), "中文🙂\n下一行".to_string()];

        save_input_history_file(&path, &history).unwrap();

        assert_eq!(load_input_history_file(&path).unwrap(), history);
        let persisted = std::fs::read_to_string(&path).unwrap();
        assert_eq!(persisted.lines().count(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_plain_line_history_remains_readable() {
        let path = temp_history_path("legacy");
        std::fs::write(&path, "first\nsecond\n").unwrap();
        assert_eq!(load_input_history_file(&path).unwrap(), ["first", "second"]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn load_filters_empty_lines_and_keeps_recent_entries() {
        let path = temp_history_path("trim");
        let mut content = String::from("\n\n");
        for idx in 0..(INPUT_HISTORY_MAX_ENTRIES + 2) {
            content.push_str(&format!("entry-{idx}\n"));
        }
        std::fs::write(&path, content).unwrap();

        let history = load_input_history_file(&path).unwrap();

        assert_eq!(history.len(), INPUT_HISTORY_MAX_ENTRIES);
        assert_eq!(history.first().unwrap(), "entry-2");
        assert_eq!(
            history.last().unwrap(),
            &format!("entry-{}", INPUT_HISTORY_MAX_ENTRIES + 1)
        );
        let _ = std::fs::remove_file(path);
    }
}
