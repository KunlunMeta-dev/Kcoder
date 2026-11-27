//! Redaction and per-item/per-turn caps. Applied by the target host before a result
//! leaves it and again by the tool; both passes are idempotent.
use super::*;

/// Keep at most `max_chars` trailing characters. Returns whether the front was dropped.
pub fn keep_tail(text: &str, max_chars: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max_chars {
        return (text.to_owned(), false);
    }
    (text.chars().skip(count - max_chars).collect(), true)
}

fn bound_item(item: &mut SessionReadItem, max_chars: usize) {
    let (redacted, _) = redact_secrets(&item.text);
    let (kept, cut) = keep_tail(&redacted, max_chars);
    item.text = kept;
    item.truncated_front |= cut;
    if let Some(name) = item.tool_name.as_mut() {
        *name = name.chars().filter(|c| !c.is_control()).take(128).collect();
    }
}

pub(crate) fn bound_turn(turn: &mut SessionReadTurn, max_chars: usize) {
    if turn.items.len() > MAX_ITEMS_PER_TURN {
        let dropped = turn.items.len() - MAX_ITEMS_PER_TURN;
        turn.items.drain(..dropped);
        turn.omitted_items = turn
            .omitted_items
            .saturating_add(u32::try_from(dropped).unwrap_or(u32::MAX));
    }
    for item in &mut turn.items {
        bound_item(item, max_chars);
    }
}

/// Redact every returned text and apply the per-item and per-turn caps.
pub fn bound_result(result: &mut SessionReadResult) {
    if let Some(title) = result.title.as_mut() {
        let (redacted, _) = redact_secrets(title);
        *title = redacted
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
    }
    for turn in &mut result.turns {
        bound_turn(turn, MAX_ITEM_CHARS);
    }
}

/// Bound a result before it leaves its owner over a router: redact and cap items, then
/// keep the newest turns whose serialized size fits `max_bytes`, halving per-item text
/// when even the newest turn alone is too large. Older turns stay reachable by paging.
pub fn fit_wire_result(result: &mut SessionReadResult, max_bytes: usize) -> bool {
    bound_result(result);
    let size =
        |result: &SessionReadResult| serde_json::to_vec(result).map_or(usize::MAX, |v| v.len());
    let mut cap = MAX_ITEM_CHARS;
    for _ in 0..256 {
        if size(result) <= max_bytes {
            return true;
        }
        if result.turns.len() > 1 {
            result.turns.remove(0);
            result.has_earlier_turns = true;
        } else if cap > 256 {
            cap = (cap / 2).max(256);
            for turn in &mut result.turns {
                bound_turn(turn, cap);
            }
        } else if let Some(turn) = result.turns.first_mut()
            && turn.items.len() > 1
        {
            turn.items.remove(0);
            turn.omitted_items = turn.omitted_items.saturating_add(1);
        } else {
            break;
        }
    }
    size(result) <= max_bytes
}
