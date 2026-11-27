use std::sync::Mutex as StdMutex;

/// Cumulative real-user turns, independent of compacted model context.
/// The owning runtime's activity gate serializes reservations and rewinds.
pub struct ClientTurnCounter(StdMutex<Option<usize>>);

impl Default for ClientTurnCounter {
    fn default() -> Self {
        Self(StdMutex::new(Some(0)))
    }
}

impl ClientTurnCounter {
    pub fn get(&self) -> Option<usize> {
        *self.0.lock().unwrap()
    }

    pub fn reset(&self, count: usize) {
        *self.0.lock().unwrap() = Some(count);
    }

    pub fn invalidate(&self) {
        *self.0.lock().unwrap() = None;
    }

    pub fn increment(&self) -> anyhow::Result<usize> {
        let mut value = self.0.lock().unwrap();
        let count = value.as_mut().ok_or_else(|| {
            anyhow::anyhow!(
                "resident turn count is unavailable; resume the thread before starting another turn"
            )
        })?;
        *count = count.saturating_add(1);
        Ok(*count)
    }
}
