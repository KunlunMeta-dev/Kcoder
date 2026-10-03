#![allow(dead_code)]

//! Key binding primitives and hint rendering for the TUI.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Span;

#[cfg(test)]
const ALT_PREFIX: &str = "⌥ + ";
#[cfg(all(not(test), target_os = "macos"))]
const ALT_PREFIX: &str = "⌥ + ";
#[cfg(all(not(test), not(target_os = "macos")))]
const ALT_PREFIX: &str = "alt + ";
const CTRL_PREFIX: &str = "ctrl + ";
const SHIFT_PREFIX: &str = "shift + ";

/// One concrete key event that can trigger a TUI action.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct KeyBinding {
    key: KeyCode,
    modifiers: KeyModifiers,
}

impl KeyBinding {
    pub(crate) const fn new(key: KeyCode, modifiers: KeyModifiers) -> Self {
        Self { key, modifiers }
    }

    pub(crate) fn from_event(event: KeyEvent) -> Self {
        let (key, modifiers) = normalize_key_parts(event.code, event.modifiers);
        Self { key, modifiers }
    }

    pub(crate) fn is_press(&self, event: KeyEvent) -> bool {
        normalize_key_parts(self.key, self.modifiers)
            == normalize_key_parts(event.code, event.modifiers)
            && (event.kind == KeyEventKind::Press || event.kind == KeyEventKind::Repeat)
    }

    pub(crate) const fn parts(&self) -> (KeyCode, KeyModifiers) {
        (self.key, self.modifiers)
    }

    pub(crate) fn display_label(&self) -> String {
        let modifiers = modifiers_to_string(self.modifiers);
        let key = match self.key {
            KeyCode::Enter => "enter".to_string(),
            KeyCode::Esc => "esc".to_string(),
            KeyCode::Backspace => "backspace".to_string(),
            KeyCode::Char(' ') => "space".to_string(),
            KeyCode::Up => "↑".to_string(),
            KeyCode::Down => "↓".to_string(),
            KeyCode::Left => "←".to_string(),
            KeyCode::Right => "→".to_string(),
            KeyCode::PageUp => "pgup".to_string(),
            KeyCode::PageDown => "pgdn".to_string(),
            _ => self.key.to_string().to_ascii_lowercase(),
        };
        format!("{modifiers}{key}")
    }
}

pub(crate) fn normalize_key_parts(
    key: KeyCode,
    mut modifiers: KeyModifiers,
) -> (KeyCode, KeyModifiers) {
    let KeyCode::Char(ch) = key else {
        return (key, modifiers);
    };
    if modifiers.is_empty()
        && let Some(ctrl_char) = c0_control_char_to_ctrl_char(ch)
    {
        return (KeyCode::Char(ctrl_char), KeyModifiers::CONTROL | modifiers);
    }
    if ch.is_ascii_uppercase() {
        modifiers.insert(KeyModifiers::SHIFT);
        return (KeyCode::Char(ch.to_ascii_lowercase()), modifiers);
    }
    (key, modifiers)
}

fn c0_control_char_to_ctrl_char(ch: char) -> Option<char> {
    let code = u32::from(ch);
    match code {
        0x00 => Some(' '),
        0x01..=0x1a => char::from_u32(code - 0x01 + u32::from('a')),
        0x1c..=0x1f => char::from_u32(code - 0x1c + u32::from('4')),
        _ => None,
    }
}

pub(crate) trait KeyBindingListExt {
    fn is_pressed(&self, event: KeyEvent) -> bool;
}

impl KeyBindingListExt for [KeyBinding] {
    fn is_pressed(&self, event: KeyEvent) -> bool {
        self.iter().any(|binding| binding.is_press(event))
    }
}

pub(crate) fn is_plain_text_key_event(event: KeyEvent) -> bool {
    matches!(
        event,
        KeyEvent {
            code: KeyCode::Char(ch),
            modifiers,
            ..
        } if !ch.is_ascii_control()
            && !modifiers.contains(KeyModifiers::CONTROL)
            && !modifiers.contains(KeyModifiers::ALT)
    )
}

pub(crate) const fn plain(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::NONE)
}

pub(crate) const fn alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::ALT)
}

pub(crate) const fn shift(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::SHIFT)
}

pub(crate) const fn ctrl(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL)
}

pub(crate) const fn ctrl_alt(key: KeyCode) -> KeyBinding {
    KeyBinding::new(key, KeyModifiers::CONTROL.union(KeyModifiers::ALT))
}

fn modifiers_to_string(modifiers: KeyModifiers) -> String {
    let mut result = String::new();
    if modifiers.contains(KeyModifiers::CONTROL) {
        result.push_str(CTRL_PREFIX);
    }
    if modifiers.contains(KeyModifiers::SHIFT) {
        result.push_str(SHIFT_PREFIX);
    }
    if modifiers.contains(KeyModifiers::ALT) {
        result.push_str(ALT_PREFIX);
    }
    result
}

impl From<KeyBinding> for Span<'static> {
    fn from(binding: KeyBinding) -> Self {
        (&binding).into()
    }
}

impl From<&KeyBinding> for Span<'static> {
    fn from(binding: &KeyBinding) -> Self {
        Span::styled(binding.display_label(), key_hint_style())
    }
}

fn key_hint_style() -> Style {
    Style::default().dim()
}

pub(crate) fn has_ctrl_or_alt(mods: KeyModifiers) -> bool {
    (mods.contains(KeyModifiers::CONTROL) || mods.contains(KeyModifiers::ALT)) && !is_altgr(mods)
}

#[cfg(windows)]
#[inline]
pub(crate) fn is_altgr(mods: KeyModifiers) -> bool {
    mods.contains(KeyModifiers::ALT) && mods.contains(KeyModifiers::CONTROL)
}

#[cfg(not(windows))]
#[inline]
pub(crate) fn is_altgr(_mods: KeyModifiers) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_label_uses_expected_shape() {
        assert_eq!(plain(KeyCode::Enter).display_label(), "enter");
        assert_eq!(plain(KeyCode::Esc).display_label(), "esc");
        assert_eq!(ctrl(KeyCode::Char('j')).display_label(), "ctrl + j");
        assert_eq!(alt(KeyCode::Char(',')).display_label(), "⌥ + ,");
    }

    #[test]
    fn uppercase_letters_match_shift_binding() {
        let binding = shift(KeyCode::Char('a'));
        let event = KeyEvent::new(KeyCode::Char('A'), KeyModifiers::NONE);

        assert!(binding.is_press(event));
    }

    #[test]
    fn raw_control_char_matches_ctrl_binding() {
        let binding = ctrl(KeyCode::Char('j'));
        let event = KeyEvent::new(KeyCode::Char('\n'), KeyModifiers::NONE);

        assert!(binding.is_press(event));
    }

    #[cfg(windows)]
    #[test]
    fn ctrl_alt_is_treated_as_altgr_on_windows() {
        let modifiers = KeyModifiers::CONTROL | KeyModifiers::ALT;

        assert!(is_altgr(modifiers));
        assert!(!has_ctrl_or_alt(modifiers));
    }

    #[cfg(not(windows))]
    #[test]
    fn ctrl_alt_remains_a_shortcut_modifier_off_windows() {
        let modifiers = KeyModifiers::CONTROL | KeyModifiers::ALT;

        assert!(!is_altgr(modifiers));
        assert!(has_ctrl_or_alt(modifiers));
    }
}
