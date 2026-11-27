//! Bounded Markdown parser state shared with native navigation workers.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const MAX_NAVIGATION_LINE_BYTES: usize = 64 * 1024;

pub struct NavigationBudget<'a> {
    cancelled: &'a AtomicBool,
    deadline: Instant,
    events: usize,
}

impl<'a> NavigationBudget<'a> {
    pub fn new(text: &str, cancelled: &'a AtomicBool) -> Result<Self, NavigationRenderError> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(NavigationRenderError::Cancelled);
        }
        if text.len() > 16 * 1024 * 1024 {
            return Err(NavigationRenderError::BudgetExceeded("source bytes"));
        }
        Ok(Self {
            cancelled,
            deadline: Instant::now() + Duration::from_secs(10),
            events: 0,
        })
    }

    pub fn check(&mut self) -> Result<(), NavigationRenderError> {
        self.events += 1;
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(NavigationRenderError::Cancelled);
        }
        if self.events > 2_000_000 || Instant::now() >= self.deadline {
            return Err(NavigationRenderError::BudgetExceeded("parser work"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationRenderError {
    Cancelled,
    InvalidSource,
    UnsupportedMessage,
    BudgetExceeded(&'static str),
}

impl std::fmt::Display for NavigationRenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("navigation cancelled"),
            Self::InvalidSource => f.write_str(
                "the navigation target is stale or cannot be displayed at the current width",
            ),
            Self::UnsupportedMessage => f.write_str("this message has no navigable body"),
            Self::BudgetExceeded(kind) => {
                write!(f, "navigation reached the resource limit ({kind})")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavigationHeading {
    pub source_byte: usize,
    pub level: u8,
    pub label: String,
}
