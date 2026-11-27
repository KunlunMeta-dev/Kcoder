"""Adapt the pinned Windows-MCP capture and input paths to one screenshot space."""

import ast
from pathlib import Path
import sys


def replace(source, old, new, count=1):
    if source.count(old) != count:
        raise ValueError(f"Pinned screenshot integration changed near {old.splitlines()[0]!r}")
    return source.replace(old, new)


def patch_desktop(source):
    # Record the full virtual bounds without changing backend selection or UIA scope.
    source = replace(source, '''        if use_vision:
            if use_annotation:
''', '''        if use_vision:
            if screenshot_region is None:
                left, top, width, height = uia.GetVirtualScreenRect()
                screenshot_region = self._rect_to_bounding_box(
                    uia.Rect(left, top, left + width, top + height),
                )
            if use_annotation:
''')
    source = replace(source, '            screenshot_original_size = Size(width=screenshot.width, height=screenshot.height)', '''            if screenshot.size != (screenshot_region.width, screenshot_region.height):
                raise ValueError("Captured image size does not match desktop bounds")
            screenshot_original_size = Size(width=screenshot.width, height=screenshot.height)''')
    return replace(source,
                   '(int(screenshot.width * scale), int(screenshot.height * scale)),',
                   '(max(1, int(screenshot.width * scale)), max(1, int(screenshot.height * scale))),')


def patch_response(source):
    source = replace(source, 'import io\n', '')
    source = replace(source, 'from windows_mcp.desktop.service import Desktop, Size\n',
                     'from windows_mcp.desktop.service import Desktop, Size\n'
                     'from windows_mcp.kcoder_screenshot_frame import ScreenshotFrame, bound_screenshot_text, encode_screenshot\n')
    source = replace(source, '    desktop_state = desktop.get_state(\n', '''    if desktop.desktop_state is not None:
        desktop.desktop_state.screenshot_frame = None
    desktop_state = desktop.get_state(
''')
    source = replace(source, '''    screenshot_bytes = None
    if use_vision and desktop_state.screenshot is not None:
        buffered = io.BytesIO()
        desktop_state.screenshot.save(buffered, format="PNG")
        screenshot_bytes = buffered.getvalue()
        buffered.close()
''', '''    screenshot_image = None
    if desktop_state.screenshot is not None:
        image_bytes, image_format, image_size = encode_screenshot(desktop_state.screenshot)
        bounds = desktop_state.screenshot_region
        desktop_state.screenshot_frame = ScreenshotFrame(
            (bounds.left, bounds.top), (bounds.width, bounds.height), image_size,
        )
        screenshot_image = Image(data=image_bytes, format=image_format)
''')
    source = replace(source, 'png_encode_ms=', 'image_encode_ms=')
    source = replace(source, '"screenshot_bytes": screenshot_bytes', '"screenshot_image": screenshot_image')
    source = replace(source, '    screenshot_bytes = capture_result["screenshot_bytes"]\n', '')
    start = source.index('    if desktop_state.screenshot_original_size:\n')
    end = source.index('    if desktop_state.available_displays:\n', start)
    source = source[:start] + '''    if desktop_state.screenshot_frame:
        metadata_text += desktop_state.screenshot_frame.describe()
''' + source[end:]
    return replace(source, '''    response = [response_text]
    if screenshot_bytes:
        response.append(Image(data=screenshot_bytes, format="png"))
''', '''    screenshot_image = capture_result["screenshot_image"]
    if screenshot_image is None:
        return [response_text]
    response = [bound_screenshot_text(response_text), screenshot_image]
''')


def patch_input(source):
    source = replace(source, 'def _text_matches(', '''def _desktop_point(desktop, value, name, screenshot_id, *, label=None, required=False):
    if label is not None:
        if screenshot_id is not None:
            raise ValueError("screenshot_id cannot be combined with a UIA label")
        return _resolve_label(desktop, label)
    value = _as_loc(value)
    if value is None:
        if required:
            raise ValueError(f"{name} or label is required")
        return None
    point = _as_point(value, name)
    if screenshot_id is None:
        return point
    state = desktop.desktop_state
    frame = getattr(state, "screenshot_frame", None)
    if frame is None or frame.id != screenshot_id:
        raise ValueError("Screenshot ID is stale or unknown; take a new screenshot")
    displays = [desktop._display_to_view(display) for display in desktop.get_displays()]
    if not displays or displays != state.available_displays:
        state.screenshot_frame = None
        raise ValueError("Display layout changed; take a new screenshot")
    return frame.to_desktop(point, [display.bounding_box for display in displays])


def _text_matches(''')
    source = replace(source,
                     '        label: int | None = None,\n',
                     '        label: int | None = None,\n        screenshot_id: str | None = None,\n',
                     count=4)
    source = replace(source, '''        loc = _as_loc(loc)
        if loc is None and label is None:
            raise ValueError("Either loc or label must be provided.")
        if label is not None:
            loc = _resolve_label(desktop, label)
        if len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
''', '        loc = _desktop_point(desktop, loc, "loc", screenshot_id, label=label, required=True)\n', count=2)
    source = replace(source, '''        loc = _as_loc(loc)
        if label is not None:
            loc = _resolve_label(desktop, label)
        if loc and len(loc) != 2:
            raise ValueError("Location must be a list of exactly 2 integers [x, y]")
''', '''        loc = _desktop_point(
            desktop, loc, "loc", screenshot_id, label=label, required=screenshot_id is not None,
        )
''')
    source = replace(source, '''        loc = _as_loc(loc)
        from_loc = _as_loc(from_loc)
        drag = _as_bool(drag, "drag")
        if loc is None and label is None:
            raise ValueError("Either loc or label must be provided.")
        if label is not None:
            loc = _resolve_label(desktop, label)
        if not isinstance(loc, list) or len(loc) != 2:
            raise ValueError("loc must be a list of exactly 2 integers [x, y]")
        if from_loc is not None and (not isinstance(from_loc, list) or len(from_loc) != 2):
            raise ValueError("from_loc must be a list of exactly 2 integers [x, y]")
        has_drag_only_options = any(
            value is not None
            for value in (
                from_loc,
                duration,
            )
        )
        if has_drag_only_options and not drag:
            raise ValueError("from_loc and duration require drag=True")
        if drag:
            loc = _as_point(loc, "loc")
            if from_loc is not None:
                from_loc = _as_point(from_loc, "from_loc")
''', '''        loc = _desktop_point(desktop, loc, "loc", screenshot_id, label=label, required=True)
        from_loc = _desktop_point(desktop, from_loc, "from_loc", screenshot_id)
        drag = _as_bool(drag, "drag")
        if not drag and (from_loc is not None or duration is not None):
            raise ValueError("from_loc and duration require drag=True")
''')
    return source


def patch_views(source):
    source = replace(source, "from dataclasses import dataclass\n",
                     "from dataclasses import dataclass\n"
                     "from windows_mcp.kcoder_screenshot_frame import ScreenshotFrame\n")
    return replace(source, "    screenshot_scale: float | None = None\n",
                   "    screenshot_scale: float | None = None\n"
                   "    screenshot_frame: ScreenshotFrame | None = None\n")


def apply(package):
    patches = {
        "desktop/service.py": patch_desktop,
        "desktop/views.py": patch_views,
        "tools/_snapshot_helpers.py": patch_response,
        "tools/snapshot.py": lambda source: replace(
            source,
            "Note: the returned image may be downscaled for efficiency; when it is, multiply image coordinates by the ratio of original size to displayed size to get the actual screen coordinates for mouse actions (Click, Move, etc.).",
            "Use the returned screenshot_id with image-pixel loc for input; the worker maps coordinates to the desktop.",
        ),
        "tools/input.py": patch_input,
    }
    updated = {package / path: patch((package / path).read_text(encoding="utf-8"))
               for path, patch in patches.items()}
    for path, source in updated.items():
        ast.parse(source, filename=str(path))
    for path, source in updated.items():
        path.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    apply(Path(sys.argv[1]))
