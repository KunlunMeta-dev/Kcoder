//! The learnable-target interface (plan section 3.1).
//!
//! Recording, signals, statistics, distillation, safety, rollout and UI
//! only know [`TargetKey`]; each target type plugs in through
//! [`LearnableTarget`]. Overlay storage is shared by every type
//! ([`crate::EvolutionStore`] overlay slots), so the interface exposes how a
//! served overlay is injected and which writes are allowed rather than a
//! per-type store. The implemented-types registry is
//! [`crate::IMPLEMENTED_TARGET_TYPES`].

use kcoder_types::evolution::{OverlayContent, ProposalLocation, TargetKey, TargetRevision};

/// Signal adapters a target uses by default (plan section 7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SignalProfile {
    Artifact,
    Procedure,
    Conversation,
    Explicit,
}

/// Where injected text enters the context. Never the system prompt
/// (plan section 3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectionPlacement {
    /// Appended to the target's own tool result (skills).
    ToolResult,
    /// Session-level relevant context (global preferences).
    SessionContext,
    /// Stored for user review only; never injected automatically.
    ReviewOnly,
    /// Delivered with the launch parameters of a newly started run
    /// (workflow and sub-agent templates); existing runs keep theirs.
    LaunchParameters,
}

/// Text produced for one served overlay revision, carrying the target key
/// and revision markers for attribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Injection {
    pub placement: InjectionPlacement,
    pub text: String,
}

/// What automatic changes a target accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WritePolicy {
    pub location: ProposalLocation,
    /// Every proposal needs explicit user confirmation, whatever the mode.
    pub always_requires_confirmation: bool,
    /// Character ceiling of the learned content.
    pub max_chars: usize,
}

/// One learnable object.
pub trait LearnableTarget: Send + Sync {
    fn key(&self) -> &TargetKey;
    /// Base revision plus the served overlay revision.
    fn revision(&self) -> TargetRevision;
    fn signal_profiles(&self) -> &[SignalProfile];
    /// Render a served overlay revision for injection.
    fn inject(&self, overlay: &OverlayContent, overlay_revision: u64) -> Injection;
    /// Whether an offline evaluator exists (`None` evaluators canary at
    /// reduced traffic, plan section 9). No type has one before phase 4.
    fn has_offline_evaluator(&self) -> bool {
        false
    }
    fn write_policy(&self) -> WritePolicy;
}

/// Opening marker of injected overlay text. Restored transcripts already
/// contain it, which is how re-injection is avoided.
pub fn overlay_marker(key: &TargetKey, overlay_revision: u64) -> String {
    format!(
        "<evolution_overlay target=\"{}\" revision=\"{overlay_revision}\">",
        escape_attribute(&key.to_string())
    )
}

/// Render overlay content as a marked block. Lessons, checklist and
/// examples keep their order; empty sections are omitted.
pub fn render_overlay_block(
    key: &TargetKey,
    base_revision: &str,
    overlay_revision: u64,
    content: &OverlayContent,
) -> String {
    let mut text = overlay_marker(key, overlay_revision);
    text.push('\n');
    text.push_str(&format!(
        "Learned notes for this target (base revision {}). They come from this user's past \
         feedback; follow the user's current instructions when they differ.\n",
        escape_attribute(base_revision)
    ));
    if !content.lessons.trim().is_empty() {
        text.push_str("\n## Lessons\n");
        text.push_str(content.lessons.trim());
        text.push('\n');
    }
    if !content.checklist.trim().is_empty() {
        text.push_str("\n## Checklist\n");
        text.push_str(content.checklist.trim());
        text.push('\n');
    }
    for example in &content.examples {
        text.push_str(&format!("\n## Example: {}\n", example.name.trim()));
        text.push_str(example.text.trim());
        text.push('\n');
    }
    text.push_str("</evolution_overlay>");
    text
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
