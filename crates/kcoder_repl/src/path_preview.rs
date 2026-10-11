/// Bounded, turn-scoped presentation state; never part of a transcript.
#[derive(Default)]
pub(crate) struct PathPreviews {
    generation: u64,
    active: bool,
    entries: Vec<(String, String, String)>,
}

impl PathPreviews {
    pub(crate) fn next_generation(&self) -> u64 {
        self.generation
            .checked_add(1)
            .expect("turn generation exhausted")
    }

    pub(crate) fn begin(&mut self) -> u64 {
        self.clear();
        self.generation = self.next_generation();
        self.active = true;
        self.generation
    }

    pub(crate) fn clear(&mut self) {
        self.active = false;
        self.entries.clear();
    }

    pub(crate) fn update(
        &mut self,
        generation: u64,
        attempt: String,
        id: String,
        path: Option<String>,
    ) {
        if !self.active || generation != self.generation || attempt.len() > 1024 || id.len() > 1024
        {
            return;
        }
        if let Some(path) = path {
            if path.is_empty() || path.len() > 4096 {
                return;
            }
            self.entries.retain(|(_, existing, _)| existing != &id);
            if self.entries.len() == 64 {
                self.entries.remove(0);
            }
            self.entries.push((attempt, id, path_label(&path)));
        } else {
            self.entries.retain(|(a, i, _)| a != &attempt || i != &id);
        }
    }

    pub(crate) fn label(&self) -> Option<String> {
        self.entries.last().map(|(_, _, label)| label.clone())
    }
}

fn path_label(path: &str) -> String {
    let mut label = String::from("Preparing ");
    let mut shown = 0;
    let mut chars = path.chars().peekable();
    while let Some(c) = chars.next() {
        let escaped = c.is_control()
            || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}');
        let width = if escaped {
            c.escape_default().count()
        } else {
            1
        };
        let limit = if chars.peek().is_some() { 159 } else { 160 };
        if shown + width > limit {
            label.push('…');
            break;
        }
        if escaped {
            label.extend(c.escape_default());
        } else {
            label.push(c);
        }
        shown += width;
    }
    label
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn path_preview_attempt_and_turn_isolation() {
        let mut state = PathPreviews::default();
        let old = state.begin();
        state.update(old, "old".into(), "id".into(), Some("old".into()));
        state.update(old, "new".into(), "id".into(), Some("new".into()));
        state.update(old, "old".into(), "id".into(), None);
        assert_eq!(state.label().as_deref(), Some("Preparing new"));
        state.clear();
        state.update(old, "late".into(), "id".into(), Some("late".into()));
        assert!(state.label().is_none());
        state.begin();
        state.update(old, "late".into(), "id".into(), Some("late".into()));
        assert!(state.label().is_none());
    }
    #[test]
    fn path_preview_bounds_and_safe_single_line() {
        let mut state = PathPreviews::default();
        let generation = state.begin();
        for i in 0..100 {
            state.update(generation, "a".into(), i.to_string(), Some("file".into()));
        }
        assert_eq!(state.entries.len(), 64);
        state.update(
            generation,
            "a".repeat(1025),
            "bad".into(),
            Some("bad".into()),
        );
        state.update(generation, "a".into(), "bad".into(), Some("a".repeat(4097)));
        state.update(generation, "a".into(), "b".repeat(1025), Some("bad".into()));
        assert_eq!(state.entries.len(), 64);
        assert_eq!(state.label().as_deref(), Some("Preparing file"));
        state.update(
            generation,
            "a".into(),
            "safe".into(),
            Some("a\n\r\u{1b}\u{85}\u{202e}".into()),
        );
        assert_eq!(
            state.label().unwrap(),
            "Preparing a\\n\\r\\u{1b}\\u{85}\\u{202e}"
        );
        state.update(
            generation,
            "a".into(),
            "safe".into(),
            Some("界".repeat(200)),
        );
        assert_eq!(state.label().unwrap().chars().count(), 170);
        assert_eq!(
            path_label(&"x".repeat(160)),
            format!("Preparing {}", "x".repeat(160))
        );
    }
}
