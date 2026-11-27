import ctypes
import ctypes.wintypes
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from patch_input_tagging import HELPER


class InputTaggingTests(unittest.TestCase):
    def namespace(self):
        scope = {'ctypes': ctypes}
        exec(HELPER, scope)
        return scope

    def test_marker_is_required_and_bounded(self):
        scope = self.namespace()
        for marker in ['', '0', '-1', '2147483648']:
            with self.subTest(marker=marker), patch.dict(os.environ, {'KCODER_DESKTOP_INPUT_TAG':marker}):
                with self.assertRaises((ValueError, RuntimeError)):
                    scope['_kcoder_input_tag']()

    def test_keyboard_and_mouse_carry_the_exact_host_marker(self):
        scope = self.namespace()
        with patch.dict(os.environ, {'KCODER_DESKTOP_INPUT_TAG':'123456'}):
            for kind, field in [(0,'mi'),(1,'ki')]:
                event = SimpleNamespace(type=kind, union=SimpleNamespace(**{field:SimpleNamespace(dwExtraInfo=None)}))
                scope['_kcoder_tag_input'](event)
                pointer = getattr(event.union, field).dwExtraInfo
                self.assertEqual(ctypes.cast(pointer, ctypes.c_void_p).value, 123456)
            with self.assertRaises(RuntimeError):
                scope['_kcoder_tag_input'](SimpleNamespace(type=2))

    def test_rejected_input_is_an_error_and_is_never_replayed(self):
        for accepted in [0, 1]:
            calls = []
            tags = []
            event = object()
            fake_ctypes = SimpleNamespace(
                byref=lambda value:value,
                sizeof=lambda _:40,
                windll=SimpleNamespace(user32=SimpleNamespace(
                    SendInput=lambda *args:calls.append(args) or accepted)),
            )
            scope = self.namespace()
            scope.update(ctypes=fake_ctypes, INPUT=object(), _kcoder_tag_input=tags.append)
            if accepted:
                self.assertEqual(scope['_kcoder_send_checked'](event), 1)
            else:
                with self.assertRaisesRegex(RuntimeError, 'do not automatically retry'):
                    scope['_kcoder_send_checked'](event)
            self.assertEqual(tags, [event])
            self.assertEqual(calls, [(1, event, 40)])
