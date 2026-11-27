import unittest
from clipboard_guard import paste_prepared


class Clipboard:
    def __init__(self, text='requested text', owner=42):
        self.text = text
        self.owner = owner
        self.opened = False
        self.reads = 0
        self.version = 1
    def OpenClipboard(self, _): self.opened = True
    def CloseClipboard(self): self.opened = False
    def GetClipboardOwner(self): return self.owner
    def RegisterClipboardFormat(self, _): return 49001
    def IsClipboardFormatAvailable(self, _): return True
    def GetClipboardData(self, kind):
        assert kind == 13 and self.opened
        self.reads += 1
        return self.text


class GuardTests(unittest.TestCase):
    def invoke(self, clipboard, send, **options):
        return paste_prepared('requested text', send, expected_pid=42, api=clipboard,
                              owner_pid=lambda window: window, sequence=lambda: clipboard.version,
                              pause=lambda _: None, **options)
    def test_only_prepared_owner_and_text_uses_paste(self):
        clipboard = Clipboard()
        sent = []
        def send(value):
            self.assertFalse(clipboard.opened)
            sent.append(value)
        self.invoke(clipboard, send)
        self.assertEqual(sent, ['{Ctrl}v'])
        self.assertEqual(clipboard.reads, 1)
    def test_foreign_clipboard_is_not_read_and_keyboard_fallback_preserves_it(self):
        clipboard = Clipboard('private external data', owner=99)
        sent = []
        self.invoke(clipboard, sent.append)
        self.assertEqual(sent, ['requested text'])
        self.assertEqual(clipboard.reads, 0)
        self.assertEqual(clipboard.text, 'private external data')
    def test_mismatched_preparation_does_not_paste(self):
        clipboard = Clipboard('different prepared text')
        sent = []
        self.invoke(clipboard, sent.append)
        self.assertEqual(sent, ['requested text'])
    def test_change_during_paste_reports_unknown_outcome_without_replay(self):
        clipboard = Clipboard()
        sent = []
        def send(value):
            sent.append(value)
            clipboard.version += 1
        with self.assertRaisesRegex(RuntimeError, 'outcome is unknown'):
            self.invoke(clipboard, send)
        self.assertEqual(sent, ['{Ctrl}v'])
    def test_missing_recovery_identity_is_not_silently_accepted(self):
        with self.assertRaisesRegex(RuntimeError, 'identity is missing'):
            paste_prepared('text', lambda _: None, expected_pid=0)


if __name__ == '__main__': unittest.main()
