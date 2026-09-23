//! Asynchronous conversation-navigation layout, semantic review, and TUI integration. The viewport remains the final scroll-state owner.

use super::*;
use crate::navigation_render::{
    MessageSourceTarget, NavigationMessageWindow, render_message_navigation_window,
};
use crate::transcript_identity::{EntryId, TranscriptAnchor};
use crate::transcript_outline::OutlineHeading;
use crate::widgets::outline::{OutlineHitKind, render_outline};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};

type HeadingResult = (
    EntryId,
    u64,
    Result<Vec<crate::navigation_render::NavigationHeading>, String>,
);
struct HeadingJob {
    receiver: Receiver<HeadingResult>,
    cancelled: Arc<AtomicBool>,
    entry: EntryId,
    revision: u64,
}
impl Drop for HeadingJob {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

struct NavigationJob {
    receiver: Receiver<Result<NavigationLayout, String>>,
    cancelled: Arc<AtomicBool>,
    started: Instant,
}

impl Drop for NavigationJob {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

struct NavigationLayout {
    index: usize,
    entry: EntryId,
    revision: u64,
    prefix_revision: u64,
    source_bytes: usize,
    width: u16,
    height: usize,
    markdown: bool,
    theme: String,
    window: NavigationMessageWindow,
    leading: Vec<Line<'static>>,
    neighbor_rows: Vec<(usize, usize)>,
    neighbor_versions: Vec<(usize, EntryId, u64)>,
    tail_count: Option<usize>,
    restore_offset: Option<usize>,
    following: Vec<Line<'static>>,
}

#[derive(Default)]
pub(super) struct NavigationState {
    pub(super) anchor: Option<TranscriptAnchor>,
    requested: Option<MessageSourceTarget>,
    job: Option<NavigationJob>,
    layout: Option<NavigationLayout>,
    settle_delta: Option<isize>,
    pub(super) inline: bool,
    highlight_until: Option<Instant>,
    headings: Option<HeadingJob>,
    pub(super) wait_answer: Option<TranscriptAnchor>,
    pending_jump: Option<String>,
    index_hint: Option<usize>,
    pub(super) displaying: bool,
    last_prefix: usize,
    relayout_from: Option<(u16, usize)>,
    pub(super) inline_previous_position: Option<TranscriptScroll>,
}

impl std::fmt::Debug for NavigationState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NavigationState")
            .field("anchor", &self.anchor)
            .finish_non_exhaustive()
    }
}

impl NavigationState {
    pub(super) fn cancel_heading_work(&mut self) {
        self.headings = None;
    }
    pub(super) fn pending(&self) -> bool {
        self.job.is_some()
            || self.requested.is_some()
            || self.headings.is_some()
            || self.pending_jump.is_some()
    }
}

impl ReplApp {
    /// The caller is in the current draw scope and self.messages has already been exchanged with the sub-agent projection.
    pub(super) fn render_navigation_window(
        &mut self,
        width: u16,
        height: usize,
    ) -> Option<FullscreenTranscriptRender> {
        self.navigation.displaying = false;
        let anchor = self.navigation.anchor?;
        let resolved = self
            .navigation
            .index_hint
            .filter(|index| {
                self.messages
                    .identity(*index)
                    .is_some_and(|meta| meta.id == anchor.entry)
            })
            .map(|index| (index, anchor.source_byte))
            .or_else(|| self.messages.resolve_anchor(anchor));
        let Some((index, source_byte)) = resolved else {
            self.navigation = NavigationState::default();
            self.set_transient_status("Navigation target was removed; reopen the outline");
            return None;
        };
        let meta = self.messages.identity(index)?;
        self.navigation.index_hint = Some(index);
        let height = height.max(1);
        if self
            .navigation
            .job
            .as_ref()
            .is_some_and(|job| job.started.elapsed() > Duration::from_secs(10))
        {
            self.navigation.job = None;
            self.navigation.anchor = None;
            self.navigation.requested = None;
            self.set_transient_status("Navigation timed out; background layout stopped");
            return None;
        }
        if let Some(job) = &self.navigation.job {
            match job.receiver.try_recv() {
                Ok(result) => {
                    self.navigation.job = None;
                    match result {
                        Ok(mut layout)
                            if layout.entry == meta.id
                                && layout.prefix_revision == meta.prefix_revision
                                && layout.width == width
                                && layout.height == height
                                && self.navigation.requested.is_none() =>
                        {
                            if let Some(offset) = layout.restore_offset {
                                self.navigation.settle_delta = Some(offset as isize);
                            }
                            layout.revision = meta.revision;
                            self.navigation.anchor = Some(TranscriptAnchor {
                                entry: layout.entry,
                                source_byte: layout.window.source_byte,
                            });
                            self.navigation.layout = Some(layout);
                            self.navigation.highlight_until =
                                Some(Instant::now() + Duration::from_secs(1));
                            // Update the viewport only while the request owning this layout remains valid.
                            self.navigation.settle_delta =
                                Some(self.navigation.settle_delta.unwrap_or(0));
                        }
                        Ok(_) => {}
                        Err(error) if self.navigation.requested.is_none() => {
                            self.navigation.anchor = None;
                            self.set_transient_status(error);
                            return None;
                        }
                        Err(_) => {}
                    }
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.navigation.job = None;
                    self.navigation.anchor = None;
                    self.set_transient_status("Navigation task ended; try again");
                    return None;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        let stale = self.navigation.layout.as_ref().is_none_or(|layout| {
            layout.index != index
                || layout.entry != meta.id
                || layout.prefix_revision != meta.prefix_revision
                || layout.width != width
                || (!self.is_loading && layout.source_bytes != self.messages[index].text.len())
                || layout.height != height
                || layout.markdown != self.render_markdown
                || layout.theme != self.code_theme
                || layout
                    .tail_count
                    .is_some_and(|count| count != self.messages.len())
                || layout
                    .neighbor_versions
                    .iter()
                    .any(|(index, id, revision)| {
                        self.messages
                            .identity(*index)
                            .is_none_or(|meta| meta.id != *id || meta.revision != *revision)
                    })
        });
        if stale && self.navigation.requested.is_none() && self.navigation.job.is_none() {
            if let Some(old) = self.navigation.layout.as_ref()
                && old.entry == meta.id
                && old.revision == meta.revision
                && old.width != width
            {
                // begin_frame cleared row caches on resize; the raw Pinned position still belongs to the previous layout.
                let top = self
                    .transcript_viewport
                    .position()
                    .pinned_top()
                    .unwrap_or(self.navigation.last_prefix);
                let row = top.saturating_sub(self.navigation.last_prefix);
                if row != old.window.window_start_row + old.window.target_row {
                    self.navigation.relayout_from = Some((old.width, row));
                }
            }
            self.navigation.requested = Some(if source_byte == 0 {
                MessageSourceTarget::MessageStart
            } else {
                MessageSourceTarget::Byte(source_byte)
            });
        }

        self.transcript_row_index.rebuild_if_stale(
            &self.messages,
            width,
            self.messages.render_epoch(),
            is_tool_run_message,
            is_collapsible_tool_message,
            TURN_DIVIDER_PREFIX,
        );
        let welcome_lines = self.fullscreen_welcome_lines(width, !self.messages.is_empty());
        let welcome = paragraph_line_count(&welcome_lines, width);
        if !stale && self.navigation.requested.is_none() {
            let layout = self.navigation.layout.as_ref().unwrap();
            for &(neighbor, rows) in &layout.neighbor_rows {
                self.transcript_row_index
                    .correct_message_rows(neighbor, rows);
            }
            if layout.source_bytes == self.messages[index].text.len() {
                self.transcript_row_index
                    .correct_message_rows(index, layout.window.total_rows);
            }
            let prefix = welcome + self.transcript_row_index.prefix_rows_at(index);
            self.navigation.last_prefix = prefix;
            let total = welcome + self.transcript_row_index.total_rows();
            let target_top = prefix + layout.window.window_start_row + layout.window.target_row;
            // The first display of a new window must use the actual target rather than an uncalibrated old estimate.
            if let Some(delta) = self.navigation.settle_delta.take() {
                let top = target_top.saturating_add_signed(delta);
                self.transcript_viewport.begin_navigation(top);
            }
            let top = self.transcript_viewport.resolve_top(total, height);
            let message_row = top.saturating_sub(prefix);
            let mut window_origin = prefix
                .saturating_add(layout.window.window_start_row)
                .saturating_sub(layout.leading.len());
            let include_welcome = window_origin == welcome;
            if include_welcome {
                window_origin = 0;
            }
            if top < window_origin && index > 0 && layout.window.window_start_row == 0 {
                let previous = self.messages.identity(index - 1).unwrap();
                self.navigation.anchor = Some(TranscriptAnchor {
                    entry: previous.id,
                    source_byte: 0,
                });
                self.navigation.requested = Some(MessageSourceTarget::VisualRow(usize::MAX));
                self.navigation.settle_delta = Some(-((prefix - top) as isize).saturating_sub(1));
            } else if message_row >= layout.window.total_rows
                && layout.source_bytes == self.messages[index].text.len()
                && index + 1 < self.messages.len()
            {
                self.navigation.anchor = Some(TranscriptAnchor {
                    entry: self.messages.identity(index + 1).unwrap().id,
                    source_byte: 0,
                });
                self.navigation.requested = Some(MessageSourceTarget::MessageStart);
                self.navigation.settle_delta =
                    Some(message_row.saturating_sub(layout.window.total_rows) as isize);
            } else {
                let local_top = top.saturating_sub(window_origin);
                let available = (if include_welcome {
                    welcome_lines.len()
                } else {
                    0
                }) + layout.leading.len()
                    + layout.window.lines.len()
                    + layout.following.len();
                let covered = top >= window_origin
                    && local_top + height.min(total.saturating_sub(top)) <= available;
                let inside_known_prefix = layout.source_bytes == self.messages[index].text.len()
                    || message_row + height <= layout.window.total_rows;
                if covered && inside_known_prefix {
                    let mut lines = if include_welcome {
                        welcome_lines.clone()
                    } else {
                        Vec::new()
                    };
                    lines.extend(layout.leading.iter().cloned());
                    lines.extend(layout.window.lines.iter().cloned());
                    lines.extend(layout.following.iter().cloned());
                    if self
                        .navigation
                        .highlight_until
                        .is_some_and(|until| until > Instant::now())
                        && let Some(line) = lines.get_mut(
                            if include_welcome {
                                welcome_lines.len()
                            } else {
                                0
                            } + layout.leading.len()
                                + layout.window.target_row,
                        )
                    {
                        line.style = line
                            .style
                            .bg(KCODER_UI_THEME.panel_bg)
                            .add_modifier(Modifier::BOLD);
                    }
                    self.navigation.displaying = true;
                    return Some(FullscreenTranscriptRender {
                        lines,
                        total_rows: total,
                        top,
                        local_top,
                    });
                }
                self.navigation.requested = Some(MessageSourceTarget::VisualRow(message_row));
                self.navigation.settle_delta = Some(0);
            }
        }

        if self.navigation.job.is_none()
            && let Some(target) = self.navigation.requested.take()
        {
            let (job_index, _) = self.messages.resolve_anchor(self.navigation.anchor?)?;
            let job_meta = self.messages.identity(job_index)?;
            let message = self.messages[job_index].clone();
            let store_len = self.messages.len();
            let neighbor_versions = (job_index.saturating_sub(24)
                ..self.messages.len().min(job_index + 25))
                .filter_map(|index| {
                    self.messages
                        .identity(index)
                        .map(|meta| (index, meta.id, meta.revision))
                })
                .collect::<Vec<_>>();
            let mut preceding_bytes = 0usize;
            let preceding = self
                .messages
                .iter()
                .enumerate()
                .take(job_index)
                .rev()
                .take(24)
                .take_while(|(_, message)| {
                    preceding_bytes += message.text.len();
                    preceding_bytes <= 1024 * 1024
                })
                .map(|(index, message)| (index, message.clone()))
                .collect::<Vec<_>>();
            // Copy only neighboring messages with body size bounded by the work budget; never copy the entire session.
            let mut follow_bytes = 0usize;
            let following = self
                .messages
                .iter()
                .skip(job_index + 1)
                .take(24)
                .take_while(|message| {
                    follow_bytes += message.text.len();
                    follow_bytes <= 1024 * 1024
                })
                .cloned()
                .collect::<Vec<_>>();
            let theme = self.code_theme.clone();
            let markdown = self.render_markdown;
            let relayout_from = self.navigation.relayout_from.take();
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancel = cancelled.clone();
            let (tx, receiver) = mpsc::channel();
            let result = std::thread::Builder::new()
                .name("tui-navigation".into())
                .spawn(move || {
                    let options = MessageRenderOptions {
                        rail: None,
                        is_last_tool: false,
                        expanded: false,
                        render_markdown: markdown,
                        code_theme: &theme,
                        width: Some(width),
                        assistant_continuation: false,
                    };
                    let relocation = relayout_from
                        .map(|(old_width, row)| {
                            render_message_navigation_window(
                                &message,
                                MessageRenderOptions {
                                    width: Some(old_width),
                                    ..options
                                },
                                MessageSourceTarget::VisualRow(row),
                                1,
                                0,
                                &cancel,
                            )
                        })
                        .transpose();
                    let result = relocation
                        .and_then(|relocation| {
                            let target = relocation.as_ref().map_or(target, |old| {
                                if old.source_byte == 0 {
                                    MessageSourceTarget::MessageStart
                                } else {
                                    MessageSourceTarget::Byte(old.source_byte)
                                }
                            });
                            let restore_offset = relocation.map(|old| old.source_row_offset);
                            render_message_navigation_window(
                                &message, options, target, height, 120, &cancel,
                            )
                            .map(|window| (window, restore_offset))
                        })
                        .map(|(window, restore_offset)| {
                            let mut leading = Vec::new();
                            let mut neighbor_rows = Vec::new();
                            if window.window_start_row == 0 {
                                for (index, message) in &preceding {
                                    if leading.len() >= height + 120
                                        || cancel.load(Ordering::Relaxed)
                                    {
                                        break;
                                    }
                                    if let Ok(previous) = render_message_navigation_window(
                                        message,
                                        options,
                                        MessageSourceTarget::VisualRow(usize::MAX),
                                        height + 120,
                                        120,
                                        &cancel,
                                    ) {
                                        neighbor_rows.push((*index, previous.total_rows));
                                        let mut rows = previous.lines;
                                        rows.extend(leading);
                                        let excess = rows.len().saturating_sub(height + 120);
                                        leading = rows.into_iter().skip(excess).collect();
                                    }
                                }
                            }
                            let mut after = Vec::new();
                            let needs_following =
                                window.window_start_row + window.lines.len() >= window.total_rows;
                            for (offset, message) in following
                                .iter()
                                .enumerate()
                                .take(if needs_following { usize::MAX } else { 0 })
                            {
                                if after.len() >= height + 120 || cancel.load(Ordering::Relaxed) {
                                    break;
                                }
                                if let Ok(next) = render_message_navigation_window(
                                    message,
                                    options,
                                    MessageSourceTarget::MessageStart,
                                    height + 120 - after.len(),
                                    0,
                                    &cancel,
                                ) {
                                    neighbor_rows.push((job_index + 1 + offset, next.total_rows));
                                    after.extend(
                                        next.lines.into_iter().take(height + 120 - after.len()),
                                    );
                                }
                            }
                            let neighbor_versions = neighbor_versions
                                .into_iter()
                                .filter(|(index, _, _)| {
                                    neighbor_rows.iter().any(|(neighbor, _)| neighbor == index)
                                })
                                .collect();
                            let tail_count = (needs_following
                                && job_index + 1 + following.len() == store_len)
                                .then_some(store_len);
                            NavigationLayout {
                                index: job_index,
                                entry: job_meta.id,
                                revision: job_meta.revision,
                                prefix_revision: job_meta.prefix_revision,
                                source_bytes: message.text.len(),
                                width,
                                height,
                                markdown,
                                theme: theme.clone(),
                                window,
                                leading,
                                neighbor_rows,
                                neighbor_versions,
                                tail_count,
                                restore_offset,
                                following: after,
                            }
                        })
                        .map_err(|error| error.to_string());
                    let _ = tx.send(result);
                });
            match result {
                Ok(_) => {
                    self.navigation.job = Some(NavigationJob {
                        receiver,
                        cancelled,
                        started: Instant::now(),
                    })
                }
                Err(error) => {
                    self.navigation.anchor = None;
                    self.set_transient_status(format!("Could not start navigation: {error}"));
                }
            }
        }
        None
    }

    fn outline_store(&self) -> &TranscriptStore {
        self.agent_view
            .as_ref()
            .map_or(&self.messages, |view| &view.transcript)
    }

    pub(super) fn navigation_needs_tick(&self) -> bool {
        self.navigation.pending()
            || (self.outline_open && self.outline.has_pending_work())
            || self
                .navigation
                .highlight_until
                .is_some_and(|until| until > Instant::now())
    }

    pub(super) fn refresh_outline(&mut self) {
        if self.navigation.inline
            && self.navigation.anchor.is_some()
            && self.active_overlay.is_none()
        {
            self.transcript_overlay = Some(TranscriptOverlay::new_at_bottom());
            self.open_overlay_state(OverlayKind::Transcript);
        }
        if !self.outline_open
            && self.navigation.wait_answer.is_none()
            && self.navigation.pending_jump.is_none()
        {
            return;
        }
        let mut model = std::mem::take(&mut self.outline);
        model.sync(self.outline_store());
        model.set_streaming_turn(if self.is_loading && self.agent_view.is_none() {
            model.latest_turn()
        } else {
            None
        });
        if let Some(job) = &self.navigation.headings {
            match job.receiver.try_recv() {
                Ok((entry, revision, result)) => {
                    match result {
                        Ok(headings) => {
                            model.set_headings(
                                entry,
                                revision,
                                headings
                                    .into_iter()
                                    .map(|h| OutlineHeading {
                                        level: h.level,
                                        source_byte: h.source_byte,
                                        title: h.label,
                                    })
                                    .collect(),
                            );
                        }
                        Err(_) => model.mark_headings_unavailable(entry, revision),
                    }
                    self.navigation.headings = None;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    model.mark_headings_unavailable(job.entry, job.revision);
                    self.navigation.headings = None;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }
        if self.outline_open
            && self.navigation.headings.is_none()
            && let Some((entry, revision, index)) =
                model.next_missing_headings(self.outline_store())
        {
            // Do not publish temporary headings for an unfinished streaming paragraph; the answer start remains immediately navigable.
            let streaming = self.agent_view.is_none()
                && self.is_loading
                && self
                    .recent_turn_transcript_start
                    .is_some_and(|start| index >= start);
            if !streaming {
                let text = self.outline_store()[index].text.clone();
                let cancelled = Arc::new(AtomicBool::new(false));
                let cancel = cancelled.clone();
                let (tx, receiver) = mpsc::channel();
                match std::thread::Builder::new()
                    .name("tui-outline".into())
                    .spawn(move || {
                        let result = crate::navigation_render::extract_navigation_headings(
                            &text, true, &cancel,
                        )
                        .map_err(|error| error.to_string());
                        let _ = tx.send((entry, revision, result));
                    }) {
                    Ok(_) => {
                        self.navigation.headings = Some(HeadingJob {
                            receiver,
                            cancelled,
                            entry,
                            revision,
                        })
                    }
                    Err(_) => model.mark_headings_unavailable(entry, revision),
                }
            }
        }
        if let Some(wait) = self.navigation.wait_answer {
            if let Some(answer) = model.answer_start_for(wait)
                && answer.entry != wait.entry
            {
                self.navigation.wait_answer = None;
                self.start_navigation(answer);
            } else if !self.is_loading {
                self.navigation.wait_answer = None;
            }
        }
        self.outline = model;
        if !self.outline.is_indexing()
            && let Some(action) = self.navigation.pending_jump.take()
        {
            self.jump_transcript(&action);
        }
    }

    pub(crate) fn open_outline(&mut self, query: &str) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.outline_open = true;
        self.open_overlay_state(OverlayKind::Outline);
        self.refresh_outline();
        let selected = self
            .current_outline_anchor()
            .or_else(|| self.outline.latest_turn());
        self.outline.open_at(selected);
        self.outline.set_query(query);
        self.force_next_viewport_redraw();
    }

    pub(super) fn close_outline(&mut self) {
        if !self.outline_open {
            return;
        }
        self.outline_open = false;
        self.outline_geometry = None;
        self.outline_press = None;
        self.navigation.headings = None;
        self.close_overlay_state(OverlayKind::Outline);
        self.force_next_viewport_redraw();
    }

    pub(crate) fn jump_transcript(&mut self, direction: &str) {
        if direction == "latest" {
            self.close_outline();
            self.navigation = NavigationState::default();
            if self.transcript_overlay.is_some() {
                self.close_transcript_overlay();
            }
            self.snap_to_bottom();
            self.force_next_viewport_redraw();
            return;
        }
        // Fast commands build only a lightweight task index without Markdown layout.
        let mut model = std::mem::take(&mut self.outline);
        if !model.sync(self.outline_store()) {
            self.outline = model;
            self.navigation.pending_jump = Some(direction.into());
            self.force_next_viewport_redraw();
            return;
        }
        let current = self
            .current_outline_anchor()
            .or_else(|| model.latest_turn());
        let anchor = current.and_then(|current| match direction {
            "start" => model.answer_start_for(current),
            "prev" => model.previous_turn(current),
            "next" => model.next_turn(current),
            _ => None,
        });
        self.outline = model;
        if let Some(anchor) = anchor {
            let wait = direction == "start"
                && self.is_loading
                && self
                    .outline_store()
                    .resolve_anchor(anchor)
                    .is_some_and(|(index, _)| {
                        self.outline_store()[index].role == MessageRole::User
                    });
            self.start_navigation(anchor);
            if wait {
                self.navigation.wait_answer = Some(anchor);
            }
        } else {
            self.set_transient_status(match direction {
                "prev" => "Already at the first turn",
                "next" => "Already at the last turn",
                _ => "No navigable answer is available",
            });
        }
    }

    fn start_navigation(&mut self, anchor: TranscriptAnchor) {
        self.close_outline();
        self.navigation.wait_answer = None;
        self.navigation.anchor = Some(anchor);
        self.navigation.index_hint = None;
        self.navigation.relayout_from = None;
        self.navigation.requested = Some(if anchor.source_byte == 0 {
            MessageSourceTarget::MessageStart
        } else {
            MessageSourceTarget::Byte(anchor.source_byte)
        });
        if let Some(job) = &self.navigation.job {
            job.cancelled.store(true, Ordering::Relaxed);
        }
        self.navigation.layout = None;
        if !self.fullscreen_surface && !self.navigation.inline {
            self.navigation.inline_previous_position = Some(self.transcript_viewport.position());
        }
        self.navigation.inline = !self.fullscreen_surface;
        self.navigation.settle_delta = Some(0);
        let top = self.transcript_viewport.resolve_top(
            self.transcript_viewport.content_rows(),
            self.transcript_viewport.viewport_rows(),
        );
        self.transcript_viewport.begin_navigation(top);
        self.set_transient_status("Locating…");
        if !self.fullscreen_surface && self.transcript_overlay.is_none() {
            self.transcript_overlay = Some(TranscriptOverlay::new_at_bottom());
            self.open_overlay_state(OverlayKind::Transcript);
        }
        self.force_next_viewport_redraw();
    }

    fn current_outline_anchor(&self) -> Option<TranscriptAnchor> {
        if let Some(anchor) = self.navigation.anchor {
            return Some(anchor);
        }
        if self.transcript_viewport.is_at_tail() {
            return None;
        }
        let width = self
            .transcript_viewport
            .transcript_area()
            .map_or(80, |area| area.width);
        let welcome = paragraph_line_count(&self.fullscreen_welcome_lines(width, true), width);
        let top = self.transcript_viewport.resolve_top(
            self.transcript_viewport.content_rows(),
            self.transcript_viewport.viewport_rows(),
        );
        let store = self.outline_store();
        let index = self
            .transcript_row_index
            .message_at_row(top.saturating_sub(welcome))
            .min(store.len().saturating_sub(1));
        (0..=index).rev().find_map(|index| {
            store
                .get(index)
                .filter(|message| {
                    matches!(message.role, MessageRole::User | MessageRole::Assistant)
                })
                .and_then(|_| store.identity(index))
                .map(|meta| TranscriptAnchor {
                    entry: meta.id,
                    source_byte: 0,
                })
        })
    }

    pub(super) fn handle_outline_key(&mut self, key: KeyEvent) -> bool {
        if key.code == KeyCode::F(8) && key.modifiers.is_empty() {
            if self.outline_open {
                self.close_outline();
            } else {
                self.open_outline("");
            }
            return true;
        }
        if !self.outline_open {
            return false;
        }
        let page = self
            .outline_geometry
            .as_ref()
            .map_or(10, |geometry| geometry.list.height as usize)
            .max(1);
        match key.code {
            KeyCode::Esc => self.close_outline(),
            KeyCode::Enter => {
                if let Some(anchor) = self.outline.selected_anchor() {
                    self.start_navigation(anchor);
                }
            }
            KeyCode::Tab => self.outline.toggle_focus(),
            KeyCode::Up => self.outline.move_selection(-1, page),
            KeyCode::Down => self.outline.move_selection(1, page),
            KeyCode::PageUp => self.outline.move_selection(-(page as isize), page),
            KeyCode::PageDown => self.outline.move_selection(page as isize, page),
            KeyCode::Left if !self.outline.search_focus() => self.outline.collapse_selected(),
            KeyCode::Right if !self.outline.search_focus() => self.outline.expand_selected(),
            KeyCode::Backspace if self.outline.search_focus() => {
                let mut query = self.outline.query.clone();
                query.pop();
                self.outline.set_query(&query);
            }
            KeyCode::Char(ch)
                if self.outline.search_focus()
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.outline
                    .set_query(&format!("{}{ch}", self.outline.query));
            }
            _ => {}
        }
        self.outline_press = None;
        true
    }

    pub(super) fn handle_outline_mouse(&mut self, mouse: MouseEvent) -> bool {
        if self.has_active_modal() {
            return false;
        }
        if !self.outline_open && self.active_overlay.is_none() {
            let hit = self
                .navigation_footer
                .iter()
                .copied()
                .find(|(rect, _)| rect.contains((mouse.column, mouse.row).into()));
            match mouse.kind {
                MouseEventKind::Down(MouseButton::Left) if hit.is_some() => {
                    self.navigation_footer_press = hit;
                    return true;
                }
                MouseEventKind::Up(MouseButton::Left) if self.navigation_footer_press.is_some() => {
                    if let Some(pressed) = self.navigation_footer_press.take()
                        && Some(pressed) == hit
                    {
                        if pressed.1 == "outline" {
                            self.open_outline("");
                        } else if pressed.1 == "copy" {
                            self.open_copy_view();
                        } else {
                            self.jump_transcript(pressed.1);
                        }
                    }
                    return true;
                }
                MouseEventKind::Drag(_) => self.navigation_footer_press = None,
                _ => {}
            }
        }
        if !self.outline_open {
            return false;
        }
        let Some(geometry) = self.outline_geometry.clone() else {
            return true;
        };
        let page = usize::from(geometry.list.height).max(1);
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if !geometry.bounds.contains((mouse.column, mouse.row).into()) {
                    self.close_outline();
                } else if geometry.query.contains((mouse.column, mouse.row).into()) {
                    if !self.outline.search_focus() {
                        self.outline.toggle_focus();
                    }
                    self.outline_press = None;
                } else {
                    self.outline_press = geometry.hit_test(mouse.column, mouse.row);
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if let Some(down) = self.outline_press.take()
                    && let Some(hit) = geometry.confirm_click(down, mouse.column, mouse.row)
                {
                    match hit.kind {
                        OutlineHitKind::Toggle => self.outline.toggle_key(hit.key),
                        OutlineHitKind::Activate => self.start_navigation(hit.key.anchor),
                    }
                }
            }
            MouseEventKind::Drag(_) => self.outline_press = None,
            MouseEventKind::ScrollUp
                if geometry.bounds.contains((mouse.column, mouse.row).into()) =>
            {
                self.outline.scroll_list(-3, page);
                self.outline_press = None;
            }
            MouseEventKind::ScrollDown
                if geometry.bounds.contains((mouse.column, mouse.row).into()) =>
            {
                self.outline.scroll_list(3, page);
                self.outline_press = None;
            }
            _ => {}
        }
        true
    }

    pub(super) fn draw_outline(&mut self, frame: &mut Frame) {
        if !self.outline_open || self.has_active_modal() {
            return;
        }
        let area = frame.area();
        let rect = overlay_presenter::centered_rect(
            area,
            area.width.saturating_sub(4).min(90),
            area.height.saturating_sub(2).min(28),
        );
        let label = self
            .agent_view
            .as_ref()
            .map_or("Main conversation", |view| view.display_name.as_str());
        self.outline_geometry = Some(render_outline(
            rect,
            frame.buffer_mut(),
            &mut self.outline,
            label,
        ));
    }

    pub(super) fn draw_navigation_footer(&mut self, frame: &mut Frame, area: Rect) {
        self.navigation_footer.clear();
        if area.width == 0 || area.height == 0 {
            return;
        }
        let mut x = area.x;
        for (label, action) in [
            ("F8 outline", "outline"),
            ("F9 copy", "copy"),
            ("start", "start"),
            (
                if self.navigation.anchor.is_some() && self.is_loading {
                    "latest*"
                } else {
                    "latest"
                },
                "latest",
            ),
        ] {
            let width = unicode_width::UnicodeWidthStr::width(label) as u16;
            if x + width > area.right() {
                break;
            }
            let rect = Rect::new(x, area.y, width, 1);
            frame.render_widget(
                Paragraph::new(label).style(Style::default().fg(KCODER_UI_THEME.text_muted)),
                rect,
            );
            self.navigation_footer.push((rect, action));
            x += width + 2;
        }
    }

    pub(super) fn draw_navigation_overlay(&mut self, frame: &mut Frame) {
        let area = frame.area();
        let block = Block::default()
            .borders(Borders::ALL)
            .title("History · F8 outline · Esc close");
        let inner = block.inner(area);
        self.transcript_viewport.begin_frame(inner);
        let render = self.render_navigation_window(inner.width, inner.height as usize);
        frame.render_widget(ratatui::widgets::Clear, area);
        frame.render_widget(block, area);
        if let Some(render) = render {
            self.transcript_viewport
                .commit_render(render.total_rows, render.top);
            frame.render_widget(
                crate::navigation_render::NavigationLines {
                    lines: &render.lines,
                    local_top: render.local_top,
                },
                inner,
            );
        } else {
            frame.render_widget(Paragraph::new("Locating…"), inner);
        }
    }

    pub(super) fn cancel_pending_navigation_for_input(&mut self) {
        self.navigation.wait_answer = None;
        if self.navigation.job.is_some()
            || self.navigation.requested.is_some()
            || self.navigation.pending_jump.is_some()
        {
            self.navigation = NavigationState::default();
            self.set_transient_status("Navigation cancelled");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{buffer::Buffer, widgets::Widget};

    fn wait_view(app: &mut ReplApp, width: u16, height: usize) -> String {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            app.transcript_viewport
                .begin_frame(Rect::new(0, 0, width, height as u16));
            let render = app.render_fullscreen_transcript_window(width, height);
            app.transcript_viewport
                .commit_render(render.total_rows, render.top);
            if !app.navigation.pending() {
                let mut buffer = Buffer::empty(Rect::new(0, 0, width, height as u16));
                crate::navigation_render::NavigationLines {
                    lines: &render.lines,
                    local_top: render.local_top,
                }
                .render(buffer.area, &mut buffer);
                return crate::test_support::buffer_dump(&buffer);
            }
            assert!(
                Instant::now() < deadline,
                "navigation timeout {:?} requested={:?} hint={:?} pos={:?} layout={:?}",
                app.navigation.anchor,
                app.navigation.requested,
                app.navigation.index_hint,
                app.transcript_viewport.position(),
                app.navigation.layout.as_ref().map(|layout| (
                    layout.index,
                    layout.window.window_start_row,
                    layout.window.target_row,
                    layout.window.total_rows,
                    layout.leading.len(),
                    layout.following.len()
                ))
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn outline_keyboard_keeps_draft_and_does_not_cancel_running_turn() {
        let mut app = ReplApp::default();
        app.push_message(MessageRole::User, "任务");
        app.prefill_input("未提交的草稿".into());
        app.start_loading();
        assert!(
            app.handle_key(KeyEvent::new(KeyCode::F(8), KeyModifiers::NONE))
                .is_none()
        );
        assert!(app.outline_open);
        assert_eq!(app.input, "未提交的草稿");
        assert!(
            app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
                .is_none()
        );
        assert!(!app.outline_open);
        assert!(app.is_loading);
        assert_eq!(app.messages.len(), 1);
    }

    #[test]
    fn navigation_displays_second_heading_and_preserves_review_after_append_resize() {
        let mut app = ReplApp {
            fullscreen_surface: true,
            ..ReplApp::default()
        };
        app.push_message(MessageRole::User, "查看报告");
        let text = format!(
            "# Same\n\nfirst-sentinel\n\n{}\n# Same\n\nsecond-sentinel\n\n{}",
            "body\n\n".repeat(1200),
            "trailing\n\n".repeat(200)
        );
        let source_byte = text.rfind("# Same").unwrap();
        app.push_message(MessageRole::Assistant, text);
        let anchor = TranscriptAnchor {
            entry: app.messages.identity(1).unwrap().id,
            source_byte,
        };
        app.start_navigation(anchor);
        let screen = wait_view(&mut app, 80, 24);
        assert!(screen.contains("second-sentinel"), "{screen}");
        assert!(!screen.contains("first-sentinel"));
        app.push_message(MessageRole::Assistant, "new-output-sentinel");
        let screen = wait_view(&mut app, 50, 20);
        assert!(screen.contains("second-sentinel"), "{screen}");
        assert!(!app.transcript_viewport.is_at_tail());
        app.jump_transcript("latest");
        assert!(app.transcript_viewport.is_at_tail());
        assert!(app.navigation.anchor.is_none());
    }

    #[test]
    fn pinned_navigation_does_not_follow_a_short_answer_to_new_output() {
        let mut viewport = TranscriptViewport::default();
        viewport.begin_frame(Rect::new(0, 0, 80, 24));
        viewport.begin_navigation(0);
        viewport.commit_render(8, 0);
        assert!(!viewport.is_at_tail());
        viewport.commit_render(100, 0);
        assert_eq!(viewport.resolve_top(100, 24), 0);
    }

    #[test]
    fn pending_navigation_escape_does_not_interrupt_the_running_task() {
        let mut app = ReplApp {
            fullscreen_surface: true,
            ..ReplApp::default()
        };
        app.push_message(MessageRole::User, "task");
        app.push_message(MessageRole::Assistant, "answer");
        app.start_loading();
        app.start_navigation(TranscriptAnchor {
            entry: app.messages.identity(1).unwrap().id,
            source_byte: 0,
        });
        assert!(app.navigation.pending());
        assert!(
            app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
                .is_none()
        );
        assert!(app.is_loading);
        assert!(!app.navigation.pending());
    }

    #[test]
    fn explicit_navigation_replaces_waiting_for_a_new_answer() {
        let mut app = ReplApp {
            fullscreen_surface: true,
            ..ReplApp::default()
        };
        app.push_message(MessageRole::User, "old task");
        app.push_message(MessageRole::Assistant, "old answer");
        app.push_message(MessageRole::User, "new task");
        app.start_loading();
        app.jump_transcript("start");
        assert!(app.navigation.wait_answer.is_some());
        let old = TranscriptAnchor {
            entry: app.messages.identity(1).unwrap().id,
            source_byte: 0,
        };
        app.start_navigation(old);
        assert!(app.navigation.wait_answer.is_none());
        app.push_message(MessageRole::Assistant, "new answer");
        app.refresh_outline();
        assert_eq!(app.navigation.anchor, Some(old));
    }

    #[test]
    fn navigation_invalidates_deleted_neighbor_content() {
        let mut app = ReplApp {
            fullscreen_surface: true,
            ..ReplApp::default()
        };
        app.push_message(MessageRole::User, "task");
        app.push_message(MessageRole::Assistant, "anchor");
        app.push_message(MessageRole::Assistant, "deleted-neighbor-sentinel");
        app.start_navigation(TranscriptAnchor {
            entry: app.messages.identity(1).unwrap().id,
            source_byte: 0,
        });
        assert!(wait_view(&mut app, 80, 24).contains("deleted-neighbor-sentinel"));
        app.messages.truncate(2);
        let screen = wait_view(&mut app, 80, 24);
        assert!(!screen.contains("deleted-neighbor-sentinel"), "{screen}");
        assert!(screen.contains("anchor"), "{screen}");
    }

    #[test]
    fn manual_review_resize_keeps_the_current_paragraph() {
        let mut app = ReplApp {
            fullscreen_surface: true,
            ..ReplApp::default()
        };
        app.push_message(MessageRole::User, "task");
        app.push_message(
            MessageRole::Assistant,
            format!(
                "# Original heading\n\n{}",
                (0..200)
                    .map(|i| format!("paragraph-{i:03} readable sentence\n\n"))
                    .collect::<String>()
            ),
        );
        app.start_navigation(TranscriptAnchor {
            entry: app.messages.identity(1).unwrap().id,
            source_byte: 0,
        });
        wait_view(&mut app, 80, 24);
        app.transcript_viewport.begin_frame(Rect::new(0, 0, 80, 24));
        app.scroll_transcript_lines(30);
        let before = wait_view(&mut app, 80, 24);
        let paragraph = before
            .lines()
            .find_map(|line| {
                line.find("paragraph-")
                    .map(|start| line[start..start + 13].to_string())
            })
            .unwrap();
        let after = wait_view(&mut app, 50, 20);
        assert!(after.contains(&paragraph), "before={before}\nafter={after}");
        assert!(!after.contains("Original heading"), "{after}");
    }

    #[test]
    fn navigation_cannot_paint_a_late_result_after_manual_scroll() {
        let mut app = ReplApp {
            fullscreen_surface: true,
            ..ReplApp::default()
        };
        app.push_message(MessageRole::User, "task");
        app.push_message(MessageRole::Assistant, "answer");
        app.start_navigation(TranscriptAnchor {
            entry: app.messages.identity(1).unwrap().id,
            source_byte: 0,
        });
        app.scroll_transcript_lines(-3);
        assert!(app.navigation.anchor.is_none());
        assert!(!app.navigation.pending());
    }

    #[test]
    fn scrolling_a_growing_merged_message_does_not_skip_its_new_suffix() {
        let mut app = ReplApp {
            fullscreen_surface: true,
            render_markdown: false,
            ..ReplApp::default()
        };
        app.push_message(MessageRole::User, "task");
        app.push_message(MessageRole::Assistant, "A line\n".repeat(1000));
        app.push_message(
            MessageRole::Assistant,
            "B_MERGED_SUFFIX_SENTINEL\n".repeat(1000),
        );
        app.start_loading();
        let entry = app.messages.identity(1).unwrap().id;
        app.start_navigation(TranscriptAnchor {
            entry,
            source_byte: 0,
        });
        wait_view(&mut app, 80, 24);
        app.messages
            .consolidate_trailing_assistant_run_from(1)
            .unwrap();
        app.push_message(MessageRole::System, "✓ Tool succeeded: bash");
        app.transcript_viewport.scroll_lines(1200);
        let screen = wait_view(&mut app, 80, 24);
        assert!(screen.contains("B_MERGED_SUFFIX_SENTINEL"), "{screen}");
        assert_eq!(app.navigation.anchor.unwrap().entry, entry);
    }
}
