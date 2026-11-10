"""Bound desktop images before MCP serialization and map their pixel space."""

from dataclasses import dataclass, field
from io import BytesIO
import json
import os
from uuid import uuid4

from PIL.Image import Image, Resampling

LEGACY_BASE64_BYTES = 1024 * 1024
# The host selects the budget. Older hosts do not set it and still admit 1 MiB.
DESKTOP_BASE64_BYTES = min(1536 * 1024, max(LEGACY_BASE64_BYTES, int(
    os.environ.get("KCODER_DESKTOP_SCREENSHOT_BASE64_BYTES", LEGACY_BASE64_BYTES)
)))
MAX_SNAPSHOT_TEXT_BYTES = 256 * 1024


def encode_screenshot(
    image: Image, *, base64_budget: int = DESKTOP_BASE64_BYTES,
) -> tuple[bytes, str, tuple[int, int]]:
    """Return the bytes, format and actual pixel dimensions of the delivered image."""
    compressed_budget = (base64_budget // 4) * 3
    numerator, denominator = (3, 4) if base64_budget == LEGACY_BASE64_BYTES else (5, 6)
    with BytesIO() as buffer:
        image.save(buffer, format="PNG")
        if buffer.tell() <= compressed_budget:
            return buffer.getvalue(), "png", image.size

        if image.mode != "RGB":
            image = image.convert("RGB")
        while True:
            buffer.seek(0)
            buffer.truncate()
            image.save(buffer, format="JPEG", quality=85)
            if buffer.tell() <= compressed_budget:
                return buffer.getvalue(), "jpeg", image.size
            width, height = image.size
            image = image.resize(
                (max(1, width * numerator // denominator), max(1, height * numerator // denominator)),
                Resampling.LANCZOS,
            )


def bound_screenshot_text(text: str) -> str:
    """Leave room for the image and the desktop broker's serialized envelope."""
    def size(value: str) -> int:
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))

    if len(text) <= MAX_SNAPSHOT_TEXT_BYTES and size(text) <= MAX_SNAPSHOT_TEXT_BYTES:
        return text
    suffix = "\n[Snapshot text shortened to fit the screenshot reply; use a text-only Snapshot for more detail.]"
    budget = MAX_SNAPSHOT_TEXT_BYTES - size(suffix) + 2  # Shared JSON quotes.
    lo, hi = 0, min(len(text), budget)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if size(text[:mid]) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + suffix


@dataclass(frozen=True)
class ScreenshotFrame:
    origin: tuple[int, int]
    desktop_size: tuple[int, int]
    image_size: tuple[int, int]
    id: str = field(default_factory=lambda: uuid4().hex)

    def to_desktop(self, pixel: list[int], display_bounds=None) -> list[int]:
        point = []
        for offset, original, shown, coordinate in zip(
            self.origin, self.desktop_size, self.image_size, pixel, strict=True
        ):
            if not 0 <= coordinate < shown:
                raise ValueError("Screenshot coordinate is outside the image")
            # Map the center of the delivered pixel to its native pixel, without
            # rounding either axis's ratio or stepping outside the captured rect.
            point.append(offset + (2 * coordinate + 1) * original // (2 * shown))
        if display_bounds is not None and not any(
            bounds.left <= point[0] < bounds.right and bounds.top <= point[1] < bounds.bottom
            for bounds in display_bounds
        ):
            raise ValueError("Screenshot coordinate does not fall on a display")
        return point

    def describe(self) -> str:
        return (
            f"Screenshot ID: {self.id}\n"
            f"Screenshot Image Size: {self.image_size[0]}x{self.image_size[1]} pixels\n"
            f"Screenshot Desktop Origin: {self.origin}\n"
            f"Screenshot Desktop Size: {self.desktop_size[0]}x{self.desktop_size[1]} pixels\n"
            "For Click, Move, Scroll or Type using this image, pass screenshot_id "
            "and loc=[x,y] in image pixels (top left is 0,0). For Move drag, "
            "from_loc also uses image pixels. Do not pre-scale or add the origin. "
            "Omit screenshot_id for UIA labels or native desktop coordinates.\n"
        )
