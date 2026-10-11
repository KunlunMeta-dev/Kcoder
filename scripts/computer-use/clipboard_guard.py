"""Read-only paste from the native recovery owner's prepared clipboard.
Never snapshots, clears, writes, or logs the user's clipboard in the worker.
"""
import ctypes
import os
import time

OWNER_FORMAT = 'KCoder.DesktopPaste.Owner.v1'


def paste_prepared(text, send_keys, *, expected_pid=None, api=None,
                   owner_pid=None, sequence=None, pause=time.sleep):
    if expected_pid is None:
        expected_pid = int(os.environ.get('KCODER_DESKTOP_RECOVERY_PID', '0'))
    if expected_pid <= 0:
        raise RuntimeError('Native clipboard recovery identity is missing')
    if api is None:
        import win32clipboard
        api = win32clipboard
    if owner_pid is None:
        import win32process
        owner_pid = lambda window: win32process.GetWindowThreadProcessId(window)[1]
    if sequence is None:
        sequence = ctypes.windll.user32.GetClipboardSequenceNumber
        sequence.restype = ctypes.c_uint32
    prepared = False
    observed = None
    try:
        api.OpenClipboard(None)
        try:
            window = api.GetClipboardOwner()
            marker = api.RegisterClipboardFormat(OWNER_FORMAT)
            if window and owner_pid(window) == expected_pid and api.IsClipboardFormatAvailable(marker):
                prepared = api.GetClipboardData(13) == text
                observed = sequence()
        finally:
            api.CloseClipboard()
    except Exception:
        prepared = False
    if not prepared or sequence() != observed:
        # Unsupported original formats or an external copy select keyboard input
        # without destroying that clipboard. This path receives plain text only.
        send_keys(text)
        return
    send_keys('{Ctrl}v')
    pause(0.05)
    if sequence() != observed:
        raise RuntimeError('Clipboard changed during paste; outcome is unknown. Do not automatically retry.')
