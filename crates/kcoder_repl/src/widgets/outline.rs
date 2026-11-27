//! Outline drawing and current-frame hit geometry without accessing ReplApp, Engine, or the transcript viewport.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    widgets::{Block, Borders, Widget},
};
use unicode_width::UnicodeWidthStr;

use crate::theme::KCODER_UI_THEME;
use crate::transcript_outline::{OutlineKey, OutlineModel};
use crate::widgets::{clear_area, truncate_to_width};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutlineHitKind {
    Toggle,
    Activate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OutlineHit {
    pub(crate) key: OutlineKey,
    pub(crate) kind: OutlineHitKind,
    pub(crate) version: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct OutlineGeometry {
    pub(crate) bounds: Rect,
    pub(crate) list: Rect,
    pub(crate) query: Rect,
    pub(crate) version: u64,
    hits: Vec<(Rect, OutlineHit)>,
}

impl OutlineGeometry {
    pub(crate) fn hit_test(&self, x: u16, y: u16) -> Option<OutlineHit> {
        self.hits
            .iter()
            .find(|(rect, _)| rect.contains((x, y).into()))
            .map(|(_, hit)| *hit)
    }

    pub(crate) fn confirm_click(&self, down: OutlineHit, x: u16, y: u16) -> Option<OutlineHit> {
        self.hit_test(x, y)
            .filter(|up| *up == down && up.version == self.version)
    }
}

pub(crate) fn render_outline(
    area: Rect,
    buf: &mut Buffer,
    model: &mut OutlineModel,
    scope_label: &str,
) -> OutlineGeometry {
    let theme = &KCODER_UI_THEME;
    clear_area(area, buf, theme.panel_bg);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme.border))
        .title(truncate_to_width(
            &format!(" Conversation outline · {scope_label} "),
            area.width.saturating_sub(2) as usize,
        ));
    let inner = block.inner(area);
    block.render(area, buf);
    let query = Rect::new(inner.x, inner.y, inner.width, u16::from(inner.height > 0));
    let footer_height = u16::from(inner.height > 1);
    let list = Rect::new(
        inner.x,
        inner.y.saturating_add(query.height),
        inner.width,
        inner.height.saturating_sub(query.height + footer_height),
    );
    model.prepare_viewport(list.height as usize);
    let mut hasher = DefaultHasher::new();
    (
        area.x,
        area.y,
        area.width,
        area.height,
        model.view_revision(),
        model.scroll_offset(),
    )
        .hash(&mut hasher);
    let version = hasher.finish();
    let mut geometry = OutlineGeometry {
        bounds: area,
        list,
        query,
        version,
        hits: Vec::with_capacity(list.height as usize * 2),
    };
    if query.height > 0 {
        let focus = if model.search_focus() { "▶" } else { " " };
        let label = truncate_to_width(
            &format!("{focus} Search: {}", model.query),
            query.width as usize,
        );
        buf.set_string(
            query.x,
            query.y,
            label,
            Style::default().fg(theme.text_body),
        );
    }
    let selected = model.selected_key();
    for (offset, row) in model
        .visible_rows()
        .iter()
        .skip(model.scroll_offset())
        .take(list.height as usize)
        .enumerate()
    {
        let y = list.y.saturating_add(offset as u16);
        let indentation = (row.depth * 2).min(list.width as usize);
        let x = list.x.saturating_add(indentation as u16);
        let width = list.width.saturating_sub(indentation as u16);
        if width == 0 {
            continue;
        }
        let selected = selected == Some(row.key);
        let row_key = OutlineKey {
            anchor: row.anchor,
            kind: row.kind,
        };
        let style = Style::default()
            .fg(if selected {
                theme.accent_primary
            } else {
                theme.text_body
            })
            .bg(if selected {
                theme.selection_bg
            } else {
                theme.panel_bg
            })
            .add_modifier(if selected {
                Modifier::BOLD
            } else {
                Modifier::empty()
            });
        if selected {
            for x in list.x..list.right() {
                buf[(x, y)].set_style(style);
            }
        }
        let arrow = if row.expandable {
            if row.expanded { "▾ " } else { "▸ " }
        } else {
            "  "
        };
        let arrow = truncate_to_width(arrow, width as usize);
        buf.set_string(x, y, &arrow, style);
        let prefix_width = UnicodeWidthStr::width(arrow.as_str()) as u16;
        if row.expandable {
            geometry.hits.push((
                Rect::new(x, y, prefix_width, 1),
                OutlineHit {
                    key: row_key,
                    kind: OutlineHitKind::Toggle,
                    version,
                },
            ));
        }
        let label = truncate_to_width(&row.label, width.saturating_sub(prefix_width) as usize);
        let label_width = UnicodeWidthStr::width(label.as_str()) as u16;
        buf.set_string(x.saturating_add(prefix_width), y, &label, style);
        if label_width > 0 {
            geometry.hits.push((
                Rect::new(x.saturating_add(prefix_width), y, label_width, 1),
                OutlineHit {
                    key: row_key,
                    kind: OutlineHitKind::Activate,
                    version,
                },
            ));
        }
    }
    if model.visible_rows().is_empty() && list.height > 0 {
        let label = if model.is_indexing() {
            "Building outline…"
        } else {
            "No matching tasks or headings"
        };
        buf.set_string(
            list.x,
            list.y,
            truncate_to_width(label, list.width as usize),
            Style::default().fg(theme.text_muted),
        );
    }
    if footer_height > 0 {
        let state = if model.is_indexing() {
            "Indexing · "
        } else if model.has_pending_headings() {
            "Some headings are still loading · "
        } else if model.headings_unavailable() {
            "Some headings exceed the budget · "
        } else {
            ""
        };
        let text = format!("{state}↑↓ select  Enter open  ←→ fold  Tab search  Esc close");
        buf.set_string(
            inner.x,
            inner.bottom() - 1,
            truncate_to_width(&text, inner.width as usize),
            Style::default().fg(theme.text_muted),
        );
    }
    geometry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript_store::TranscriptStore;
    use kcoder_types::{DisplayMessage, MessageRole};

    fn model() -> OutlineModel {
        let store: TranscriptStore = vec![
            DisplayMessage {
                role: MessageRole::User,
                text: "中文任务".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "answer".to_string(),
            },
        ]
        .into();
        let mut model = OutlineModel::default();
        model.sync(&store);
        model.open_at(None);
        model
    }

    #[test]
    fn outline_does_not_inherit_underlying_markdown_styles() {
        let area = Rect::new(0, 0, 50, 12);
        let mut model = model();
        let mut expected = Buffer::empty(area);
        render_outline(area, &mut expected, &mut model, "主对话");
        let mut actual = Buffer::empty(area);
        for y in area.top()..area.bottom() {
            for x in area.left()..area.right() {
                actual[(x, y)].set_symbol("x").set_style(
                    Style::default()
                        .fg(ratatui::style::Color::Cyan)
                        .add_modifier(Modifier::UNDERLINED | Modifier::ITALIC | Modifier::BOLD),
                );
            }
        }
        render_outline(area, &mut actual, &mut model, "主对话");
        assert_eq!(actual, expected, "目录文字、空白、边框都不应继承下层样式");
    }

    #[test]
    fn blank_and_border_clicks_are_ignored_and_resize_invalidates_click() {
        let mut model = model();
        let area = Rect::new(0, 0, 50, 12);
        let mut buf = Buffer::empty(area);
        let geometry = render_outline(area, &mut buf, &mut model, "主对话");
        assert!(geometry.hit_test(0, 0).is_none());
        assert!(geometry.hit_test(48, 3).is_none());
        let hit = geometry.hit_test(3, 2).unwrap();
        assert_eq!(hit.kind, OutlineHitKind::Activate);
        assert_eq!(geometry.confirm_click(hit, 3, 2), Some(hit));
        let resized = render_outline(Rect::new(0, 0, 49, 12), &mut buf, &mut model, "主对话");
        assert!(resized.confirm_click(hit, 3, 2).is_none());
    }

    #[test]
    fn every_tiny_geometry_is_safe_and_only_visible_rows_have_hits() {
        let mut model = model();
        for width in 0..8 {
            for height in 0..6 {
                let area = Rect::new(0, 0, width, height);
                let mut buf = Buffer::empty(area);
                let geometry = render_outline(area, &mut buf, &mut model, "主对话");
                assert!(geometry.hits.len() <= geometry.list.height as usize * 2);
            }
        }
    }

    #[test]
    fn query_change_invalidates_mouse_down_and_arrows_have_distinct_hits() {
        let mut model = model();
        let area = Rect::new(0, 0, 50, 12);
        let mut buf = Buffer::empty(area);
        let before = render_outline(area, &mut buf, &mut model, "主对话");
        assert_eq!(before.hit_test(1, 2).unwrap().kind, OutlineHitKind::Toggle);
        let down = before.hit_test(3, 2).unwrap();
        model.set_query("no matching row");
        let after = render_outline(area, &mut buf, &mut model, "主对话");
        assert!(after.confirm_click(down, 3, 2).is_none());
    }
}
