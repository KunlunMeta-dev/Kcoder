//! Platform tray icon pixel composition and usage/status glyph geometry.

use crate::*;

#[cfg(desktop)]
pub(crate) fn tray_usage_glyph(character: char) -> Option<[u8; 5]> {
    match character {
        '0' => Some([0b111, 0b101, 0b101, 0b101, 0b111]),
        '1' => Some([0b010, 0b110, 0b010, 0b010, 0b111]),
        '2' => Some([0b111, 0b001, 0b111, 0b100, 0b111]),
        '3' => Some([0b111, 0b001, 0b111, 0b001, 0b111]),
        '4' => Some([0b101, 0b101, 0b111, 0b001, 0b001]),
        '5' => Some([0b111, 0b100, 0b111, 0b001, 0b111]),
        '6' => Some([0b111, 0b100, 0b111, 0b101, 0b111]),
        '7' => Some([0b111, 0b001, 0b010, 0b010, 0b010]),
        '8' => Some([0b111, 0b101, 0b111, 0b101, 0b111]),
        '9' => Some([0b111, 0b101, 0b111, 0b001, 0b111]),
        '%' => Some([0b101, 0b001, 0b010, 0b100, 0b101]),
        '+' => Some([0b000, 0b010, 0b111, 0b010, 0b000]),
        '-' => Some([0b000, 0b000, 0b111, 0b000, 0b000]),
        'd' | 'D' => Some([0b001, 0b001, 0b111, 0b101, 0b111]),
        'h' | 'H' => Some([0b100, 0b100, 0b111, 0b101, 0b101]),
        _ => None,
    }
}

#[cfg(desktop)]
pub(crate) fn tray_usage_line_width(line: &str) -> u32 {
    let glyph_count = line.chars().count() as u32;
    if glyph_count == 0 {
        return 1;
    }
    line.chars()
        .map(|character| {
            if character == ' ' {
                TRAY_USAGE_SPACE_WIDTH * TRAY_USAGE_ICON_SCALE
            } else {
                TRAY_USAGE_GLYPH_WIDTH * TRAY_USAGE_ICON_SCALE
            }
        })
        .sum::<u32>()
        + glyph_count.saturating_sub(1) * TRAY_USAGE_GLYPH_GAP * TRAY_USAGE_ICON_SCALE
}

#[cfg(desktop)]
pub(crate) fn tray_status_meter_slot_width(icon_size: u32) -> u32 {
    if icon_size == 0 {
        0
    } else {
        TRAY_STATUS_METER_WIDTH + TRAY_STATUS_METER_GAP - TRAY_STATUS_METER_TEXT_GAP_OFFSET
    }
}

#[cfg(desktop)]
pub(crate) fn tray_usage_text_x(icon_size: u32) -> u32 {
    icon_size
        + tray_status_meter_slot_width(icon_size)
        + TRAY_USAGE_ICON_TEXT_GAP
        + TRAY_USAGE_TEXT_LEFT_EXTRA_GAP
}

#[cfg(desktop)]
pub(crate) fn tray_usage_canvas_width(icon_size: u32) -> u32 {
    tray_usage_text_x(icon_size)
        + tray_usage_line_width(TRAY_USAGE_MAX_LINE)
        + TRAY_USAGE_ICON_LEFT_PADDING
}

#[cfg(desktop)]
pub(crate) fn draw_tray_usage_text(buffer: &mut [u8], width: u32, x: u32, y: u32, line: &str) {
    let mut cursor_x = x;
    for character in line.chars() {
        if character == ' ' {
            cursor_x += (TRAY_USAGE_SPACE_WIDTH + TRAY_USAGE_GLYPH_GAP) * TRAY_USAGE_ICON_SCALE;
            continue;
        }
        if let Some(glyph) = tray_usage_glyph(character) {
            for (row_index, row) in glyph.iter().enumerate() {
                for column in 0..TRAY_USAGE_GLYPH_WIDTH {
                    if row & (1 << (TRAY_USAGE_GLYPH_WIDTH - column - 1)) == 0 {
                        continue;
                    }
                    for dy in 0..TRAY_USAGE_ICON_SCALE {
                        for dx in 0..TRAY_USAGE_ICON_SCALE {
                            let pixel_x = cursor_x + column * TRAY_USAGE_ICON_SCALE + dx;
                            let pixel_y = y + row_index as u32 * TRAY_USAGE_ICON_SCALE + dy;
                            let offset = ((pixel_y * width + pixel_x) * 4) as usize;
                            if offset + 3 < buffer.len() {
                                buffer[offset..offset + 4]
                                    .copy_from_slice(&tray_foreground_rgba(255));
                            }
                        }
                    }
                }
            }
        }
        cursor_x += (TRAY_USAGE_GLYPH_WIDTH + TRAY_USAGE_GLYPH_GAP) * TRAY_USAGE_ICON_SCALE;
    }
}

#[cfg(desktop)]
pub(crate) fn tray_foreground_rgba(alpha: u8) -> [u8; 4] {
    if cfg!(target_os = "macos") {
        [0, 0, 0, alpha]
    } else {
        [255, 255, 255, alpha]
    }
}

#[cfg(desktop)]
pub(crate) fn tray_template_pixel(source: [u8; 4]) -> [u8; 4] {
    if !cfg!(target_os = "macos") {
        return source;
    }
    let mask = 255_u16.saturating_sub(source[0].min(source[1]).min(source[2]) as u16);
    let alpha = (source[3] as u16 * mask / 255) as u8;
    [0, 0, 0, alpha]
}

#[cfg(desktop)]
pub(crate) fn copy_tray_icon_pixel(
    buffer: &mut [u8],
    target_offset: usize,
    source: &[u8],
    source_offset: usize,
) {
    if source_offset + 3 >= source.len() || target_offset + 3 >= buffer.len() {
        return;
    }
    let pixel = tray_template_pixel([
        source[source_offset],
        source[source_offset + 1],
        source[source_offset + 2],
        source[source_offset + 3],
    ]);
    buffer[target_offset..target_offset + 4].copy_from_slice(&pixel);
}

#[cfg(desktop)]
pub(crate) fn set_tray_pixel(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    rgba: [u8; 4],
) {
    if x < 0 || y < 0 || x as u32 >= width || y as u32 >= height {
        return;
    }
    let offset = ((y as u32 * width + x as u32) * 4) as usize;
    if offset + 3 < buffer.len() {
        buffer[offset] = rgba[0];
        buffer[offset + 1] = rgba[1];
        buffer[offset + 2] = rgba[2];
        buffer[offset + 3] = rgba[3];
    }
}

pub(crate) fn scaled_tray_text_width(text: &str, numerator: u32, denominator: u32) -> u32 {
    let glyph_count = text.chars().count() as u32;
    if glyph_count == 0 {
        return 0;
    }
    let source_width =
        glyph_count * TRAY_USAGE_GLYPH_WIDTH + glyph_count.saturating_sub(1) * TRAY_USAGE_GLYPH_GAP;
    (source_width * numerator).div_ceil(denominator)
}

#[cfg(desktop)]
pub(crate) fn draw_tray_text_scaled(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    origin: (u32, u32),
    text: &str,
    scale: (u32, u32),
    rgba: [u8; 4],
) {
    let (x, y) = origin;
    let (numerator, denominator) = scale;
    let mut source_cursor_x = 0;
    for character in text.chars() {
        if let Some(glyph) = tray_usage_glyph(character) {
            for (row_index, row) in glyph.iter().enumerate() {
                for column in 0..TRAY_USAGE_GLYPH_WIDTH {
                    if row & (1 << (TRAY_USAGE_GLYPH_WIDTH - column - 1)) == 0 {
                        continue;
                    }
                    let source_x = source_cursor_x + column;
                    let source_y = row_index as u32;
                    let target_x_start = x + source_x * numerator / denominator;
                    let target_x_end = x + ((source_x + 1) * numerator).div_ceil(denominator);
                    let target_y_start = y + source_y * numerator / denominator;
                    let target_y_end = y + ((source_y + 1) * numerator).div_ceil(denominator);
                    for target_y in target_y_start..target_y_end {
                        for target_x in target_x_start..target_x_end {
                            set_tray_pixel(
                                buffer,
                                width,
                                height,
                                target_x as i32,
                                target_y as i32,
                                rgba,
                            );
                        }
                    }
                }
            }
        }
        source_cursor_x += TRAY_USAGE_GLYPH_WIDTH + TRAY_USAGE_GLYPH_GAP;
    }
}

#[cfg(desktop)]
pub(crate) fn draw_tray_running_meter(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    running_count: usize,
) {
    let meter_height = 22_u32.min(height);
    if meter_height < 10 {
        return;
    }
    let y = (height - meter_height) / 2;
    let border = tray_foreground_rgba(120);
    for dy in 0..meter_height {
        for dx in 0..TRAY_STATUS_METER_WIDTH {
            let edge =
                dx == 0 || dx == TRAY_STATUS_METER_WIDTH - 1 || dy == 0 || dy == meter_height - 1;
            if edge {
                set_tray_pixel(
                    buffer,
                    width,
                    height,
                    (x + dx) as i32,
                    (y + dy) as i32,
                    border,
                );
            }
        }
    }

    let segment_count = running_count.min(4);
    let fill = tray_foreground_rgba(235);
    for index in 0..segment_count {
        let segment_y = y + meter_height - 4 - index as u32 * 4;
        for dy in 0..3 {
            for dx in 0..3 {
                set_tray_pixel(
                    buffer,
                    width,
                    height,
                    (x + 2 + dx) as i32,
                    (segment_y + dy) as i32,
                    fill,
                );
            }
        }
    }
}

#[cfg(desktop)]
pub(crate) fn draw_tray_unread_badge(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    icon_size: u32,
    icon_y: u32,
    unread_count: usize,
) {
    if unread_count == 0 || icon_size < 10 {
        return;
    }

    let badge = if cfg!(target_os = "macos") {
        tray_foreground_rgba(255)
    } else {
        [13, 148, 136, 255]
    };
    let outline_x = 0_i32;
    let outline_y = icon_y as i32;
    let outline_size = icon_size as i32;
    for offset in 0..2 {
        for x in outline_x - offset..outline_x + outline_size + offset {
            set_tray_pixel(buffer, width, height, x, outline_y - offset, badge);
            set_tray_pixel(
                buffer,
                width,
                height,
                x,
                outline_y + outline_size - 1 + offset,
                badge,
            );
        }
        for y in outline_y - offset..outline_y + outline_size + offset {
            set_tray_pixel(buffer, width, height, outline_x - offset, y, badge);
            set_tray_pixel(
                buffer,
                width,
                height,
                outline_x + outline_size - 1 + offset,
                y,
                badge,
            );
        }
    }

    let text = if unread_count > 9 {
        "+".to_string()
    } else {
        unread_count.to_string()
    };
    let badge_width = if text.len() > 1 { 14_u32 } else { 12_u32 };
    let badge_height = 10_u32;
    let badge_x = icon_size.saturating_sub(badge_width);
    let badge_y = icon_y + icon_size.saturating_sub(badge_height);
    for dy in 0..badge_height {
        for dx in 0..badge_width {
            let radius = badge_height as i32 / 2;
            let left_cap_center_x = radius - 1;
            let right_cap_center_x = badge_width as i32 - radius;
            let center_y = radius - 1;
            let pixel_x = dx as i32;
            let pixel_y = dy as i32;
            let inside_rect = pixel_x >= left_cap_center_x && pixel_x <= right_cap_center_x;
            let inside_left = {
                let x = pixel_x - left_cap_center_x;
                let y = pixel_y - center_y;
                x * x + y * y <= radius * radius
            };
            let inside_right = {
                let x = pixel_x - right_cap_center_x;
                let y = pixel_y - center_y;
                x * x + y * y <= radius * radius
            };
            if !inside_rect && !inside_left && !inside_right {
                continue;
            }
            set_tray_pixel(
                buffer,
                width,
                height,
                (badge_x + dx) as i32,
                (badge_y + dy) as i32,
                badge,
            );
        }
    }
    let text_width = scaled_tray_text_width(&text, 3, 2);
    let text_x = badge_x + (badge_width.saturating_sub(text_width)) / 2;
    let text_y = badge_y + 1;
    draw_tray_text_scaled(
        buffer,
        width,
        height,
        (text_x, text_y),
        &text,
        (3, 2),
        if cfg!(target_os = "macos") {
            [0, 0, 0, 0]
        } else {
            [255, 255, 255, 255]
        },
    );
}

#[cfg(desktop)]
pub(crate) fn tray_usage_icon(
    title: &str,
    base_icon: Option<&tauri::image::Image<'_>>,
    running_count: usize,
    show_running_status: bool,
    unread_count: usize,
) -> Option<tauri::image::Image<'static>> {
    let lines = title
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(2)
        .collect::<Vec<_>>();
    if lines.len() != 2 {
        return None;
    }

    let text_height = TRAY_USAGE_GLYPH_HEIGHT * TRAY_USAGE_ICON_SCALE * 2 + TRAY_USAGE_LINE_GAP;
    let base_icon_size = base_icon
        .map(|icon| icon.width().min(icon.height()).min(TRAY_USAGE_ICON_HEIGHT))
        .unwrap_or(0);
    let text_x = tray_usage_text_x(base_icon_size);
    let width = tray_usage_canvas_width(base_icon_size);
    let height = TRAY_USAGE_ICON_HEIGHT.max(text_height);
    let mut buffer = vec![0; (width * height * 4) as usize];
    let first_y = (height - text_height) / 2;
    let second_y = first_y + TRAY_USAGE_GLYPH_HEIGHT * TRAY_USAGE_ICON_SCALE + TRAY_USAGE_LINE_GAP;
    let mut icon_y = 0;

    if let Some(icon) = base_icon {
        let source_width = icon.width();
        let source_height = icon.height();
        let source_size = source_width.min(source_height);
        if source_size > 0 && base_icon_size > 0 {
            let source_x = (source_width - source_size) / 2;
            let source_y = (source_height - source_size) / 2;
            let target_y = (height - base_icon_size) / 2;
            icon_y = target_y;
            let rgba = icon.rgba();
            for y in 0..base_icon_size {
                for x in 0..base_icon_size {
                    let sample_x = source_x + x * source_size / base_icon_size;
                    let sample_y = source_y + y * source_size / base_icon_size;
                    let source_offset = ((sample_y * source_width + sample_x) * 4) as usize;
                    let target_offset = (((target_y + y) * width + x) * 4) as usize;
                    copy_tray_icon_pixel(&mut buffer, target_offset, rgba, source_offset);
                }
            }
        }
    }
    if base_icon_size > 0 {
        draw_tray_unread_badge(
            &mut buffer,
            width,
            height,
            base_icon_size,
            icon_y,
            unread_count,
        );
        if show_running_status {
            draw_tray_running_meter(
                &mut buffer,
                width,
                height,
                base_icon_size + TRAY_STATUS_METER_GAP / 2 + 1,
                running_count,
            );
        }
    }

    for (line_index, line) in lines.iter().enumerate() {
        let y = if line_index == 0 { first_y } else { second_y };
        draw_tray_usage_text(&mut buffer, width, text_x, y, line);
    }

    Some(tauri::image::Image::new_owned(buffer, width, height))
}

#[cfg(desktop)]
pub(crate) fn tray_status_icon(
    base_icon: Option<&tauri::image::Image<'_>>,
    running_count: usize,
    show_running_status: bool,
    unread_count: usize,
) -> Option<tauri::image::Image<'static>> {
    let base_icon = base_icon?;
    let source_width = base_icon.width();
    let source_height = base_icon.height();
    let source_size = source_width.min(source_height);
    let icon_size = source_size.min(TRAY_STATUS_ICON_SIZE);
    let meter_width = if show_running_status {
        TRAY_STATUS_METER_WIDTH + TRAY_STATUS_METER_GAP
    } else {
        0
    };
    let (width, height) = if cfg!(target_os = "macos") {
        (
            icon_size + meter_width,
            TRAY_USAGE_ICON_HEIGHT.max(icon_size),
        )
    } else {
        (icon_size + meter_width, icon_size)
    };
    let mut buffer = vec![0; (width * height * 4) as usize];
    let source_x = (source_width - source_size) / 2;
    let source_y = (source_height - source_size) / 2;
    let icon_y = (height - icon_size) / 2;
    let rgba = base_icon.rgba();
    for y in 0..icon_size {
        for x in 0..icon_size {
            let sample_x = source_x + x * source_size / icon_size;
            let sample_y = source_y + y * source_size / icon_size;
            let source_offset = ((sample_y * source_width + sample_x) * 4) as usize;
            let target_offset = (((icon_y + y) * width + x) * 4) as usize;
            copy_tray_icon_pixel(&mut buffer, target_offset, rgba, source_offset);
        }
    }
    draw_tray_unread_badge(&mut buffer, width, height, icon_size, icon_y, unread_count);
    if show_running_status {
        draw_tray_running_meter(
            &mut buffer,
            width,
            height,
            icon_size + TRAY_STATUS_METER_GAP / 2 + 1,
            running_count,
        );
    }
    Some(tauri::image::Image::new_owned(buffer, width, height))
}
