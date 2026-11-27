import unittest
from clipboard_paste import paste_text, ClipboardRestoreError


class Clipboard:
    owner_format = 49001

    def __init__(self, values):
        self.values = dict(values)
        self.opened = False
        self.writes = 0
        self.fail_write = None
        self.version = 0

    def sequence(self):
        return self.version

    def open(self):
        assert not self.opened
        self.opened = True

    def close(self):
        assert self.opened
        self.opened = False

    def formats(self):
        assert self.opened
        return list(self.values)

    def get(self, kind):
        assert self.opened
        return self.values[kind]

    def empty(self):
        assert self.opened
        self.writes += 1
        self.version += 1
        self.values.clear()

    def set(self, kind, value):
        assert self.opened
        if self.fail_write == kind:
            self.fail_write = None
            raise RuntimeError('injected write failure')
        self.values[kind] = value
        self.version += 1

    def publish_text(self, value):
        self.set(13, value)


class PasteTests(unittest.TestCase):
    def test_preserves_rich_formats_and_empty_clipboard(self):
        for prior in [{}, {13: '原来的文本', 49002: b'<b>HTML</b>', 8: b'DIB bytes'}]:
            clipboard = Clipboard(prior)
            observed = []
            def send(keys):
                observed.append((keys, clipboard.values[13]))
            paste_text('new long text', send, clipboard=clipboard, pause=lambda _: None)
            self.assertEqual(observed, [('{Ctrl}v', 'new long text')])
            self.assertEqual(clipboard.values, prior)
            self.assertFalse(clipboard.opened)

    def test_input_exception_restores_all_formats(self):
        prior = {13: 'before', 49002: b'custom bytes'}
        clipboard = Clipboard(prior)
        def fail(_):
            raise RuntimeError('injected input failure')
        with self.assertRaisesRegex(RuntimeError, 'input failure'):
            paste_text('new', fail, clipboard=clipboard, pause=lambda _: None)
        self.assertEqual(clipboard.values, prior)

    def test_failed_publication_restores_without_sending_input(self):
        clipboard = Clipboard({13: 'before'})
        clipboard.fail_write = clipboard.owner_format
        sent = []
        with self.assertRaisesRegex(RuntimeError, 'write failure'):
            paste_text('new', sent.append, clipboard=clipboard, pause=lambda _: None)
        self.assertEqual(clipboard.values, {13: 'before'})
        self.assertEqual(sent, [])

    def test_external_copy_is_not_overwritten(self):
        clipboard = Clipboard({13: 'before'})
        def external_copy(_):
            clipboard.values = {13: 'new user copy', 49002: b'new rich data'}
        paste_text('new', external_copy, clipboard=clipboard, pause=lambda _: None)
        self.assertEqual(clipboard.values, {13: 'new user copy', 49002: b'new rich data'})

    def test_borrowed_gdi_handles_select_non_clipboard_input(self):
        clipboard = Clipboard({2: 12345, 8: b'DIB bytes'})
        sent = []
        paste_text('plain text', sent.append, clipboard=clipboard, pause=lambda _: None)
        self.assertEqual(sent, ['plain text'])
        self.assertEqual(clipboard.values, {2: 12345, 8: b'DIB bytes'})
        self.assertEqual(clipboard.writes, 0)

    def test_external_update_retaining_marker_is_not_overwritten(self):
        clipboard = Clipboard({13: 'before'})
        def external_change(_):
            clipboard.open()
            clipboard.set(13, 'user replacement preserving other formats')
            clipboard.close()
        paste_text('new', external_change, clipboard=clipboard, pause=lambda _: None)
        self.assertEqual(clipboard.values[13], 'user replacement preserving other formats')

    def test_restore_failure_is_not_reported_as_success(self):
        clipboard = Clipboard({13: 'before'})
        def send(_):
            clipboard.fail_write = 13
        with self.assertRaises(ClipboardRestoreError):
            paste_text('new', send, clipboard=clipboard, pause=lambda _: None)


if __name__ == '__main__':
    unittest.main()
