"""Temporary paste with format preservation and external-change protection.

Clipboard data stays in memory and is never logged or returned to the model.
This module handles ordinary exceptions; process termination requires host-side
recovery and must not be described as a completed clipboard rollback.
"""
import time
import uuid
import ctypes
import struct

MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
OWNER_FORMAT = "KCoder.DesktopPaste.Owner.v1"


class ClipboardRestoreError(RuntimeError):
    pass


class UnsupportedSnapshot(Exception):
    pass


class WindowsClipboard:
    def __init__(self):
        import win32clipboard
        import win32gui
        import win32con
        self.api = win32clipboard
        self.gui = win32gui
        self.owner_format = self.api.RegisterClipboardFormat(OWNER_FORMAT)
        self.window = win32gui.CreateWindowEx(
            0, "STATIC", "KCoder clipboard transaction", 0,
            0, 0, 0, 0, win32con.HWND_MESSAGE, 0, 0, None,
        )

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.gui.DestroyWindow(self.window)

    def open(self):
        self.api.OpenClipboard(self.window)

    def close(self):
        self.api.CloseClipboard()

    def formats(self):
        current = 0
        while True:
            current = self.api.EnumClipboardFormats(current)
            if not current:
                return
            yield current

    def get(self, kind):
        return self.api.GetClipboardData(kind)

    def sequence(self):
        function = ctypes.windll.user32.GetClipboardSequenceNumber
        function.restype = ctypes.c_uint32
        return function()

    def empty(self):
        self.api.EmptyClipboard()

    def set(self, kind, value):
        self.api.SetClipboardData(kind, value)

    def publish_text(self, value):
        # CloseClipboard synthesizes these formats when only Unicode is set,
        # advancing the sequence after we release the clipboard lock. Publish
        # them explicitly so the sequence can be captured without a race with
        # another application's copy operation.
        self.set(13, value)
        self.set(1, value.encode("mbcs", errors="replace") + b"\0")
        self.set(7, value.encode("oem", errors="replace") + b"\0")
        self.set(16, struct.pack("<I", ctypes.windll.kernel32.GetSystemDefaultLCID()))


def snapshot(clipboard, limit=MAX_SNAPSHOT_BYTES):
    """Only independent Python copies are restorable after EmptyClipboard.

    GDI handles, file-drop tuples and other non-copyable representations must not
    be borrowed across clearing the clipboard. They select keyboard fallback.
    """
    result = []
    size = 0
    for kind in clipboard.formats():
        value = clipboard.get(kind)
        if isinstance(value, str) and kind == 13:  # CF_UNICODETEXT
            size += len(value.encode("utf-16-le")) + 2
        elif isinstance(value, bytes):
            size += len(value)
        else:
            raise UnsupportedSnapshot()
        if size > limit:
            raise UnsupportedSnapshot()
        result.append((kind, value))
    return result


def restore_locked(clipboard, values):
    clipboard.empty()
    for kind, value in values:
        clipboard.set(kind, value)


def paste_text(text, send_keys, *, clipboard=None, pause=time.sleep):
    """send_keys is the existing tagged UIA sender, accepting plain text or Ctrl+V."""
    if clipboard is None:
        # Production clipboard ownership belongs to the independent native
        # recovery process. Explicit clipboard injection below is retained only
        # for the isolated legacy/native API fixture.
        from windows_mcp.kcoder_clipboard_guard import paste_prepared
        return paste_prepared(text, send_keys, pause=pause)
    try:
        clipboard.open()
    except Exception:
        send_keys(text)
        return
    prior = None
    published = False
    owned_sequence = None
    token = uuid.uuid4().hex.encode("ascii")
    try:
        try:
            prior = snapshot(clipboard)
        except Exception:
            # Preserve data we cannot faithfully snapshot; no clipboard write.
            prior = None
        if prior is not None:
            try:
                clipboard.empty()
                clipboard.publish_text(text)
                clipboard.set(clipboard.owner_format, token)
                owned_sequence = clipboard.sequence()
                published = True
            except Exception:
                try:
                    restore_locked(clipboard, prior)
                except Exception as error:
                    raise ClipboardRestoreError("Clipboard restoration failed before paste") from error
                raise
    finally:
        clipboard.close()
    if not published:
        send_keys(text)
        return
    try:
        pause(0.05)
        send_keys("{Ctrl}v")
        pause(0.05)
    finally:
        try:
            clipboard.open()
            try:
                # A user/other application may have copied something meanwhile.
                # Only restore while our unpredictable transaction marker survives.
                if clipboard.sequence() == owned_sequence and clipboard.owner_format in clipboard.formats():
                    marker = clipboard.get(clipboard.owner_format)
                    if isinstance(marker, bytes) and marker.rstrip(b"\0") == token:
                        restore_locked(clipboard, prior)
            finally:
                clipboard.close()
        except Exception as error:
            raise ClipboardRestoreError("Clipboard restoration failed after paste") from error
