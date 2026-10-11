from contextlib import contextmanager
from types import SimpleNamespace
import unittest
from patch_input_cleanup import HELPER


class ModifierCleanupTests(unittest.TestCase):
    def scope(self, held=False, fail_press=False):
        events = []
        def press(key, **kwargs):
            events.append(('down', key))
            if fail_press:
                raise RuntimeError('wait after key down failed')
        fake = SimpleNamespace(IsKeyPressed=lambda key: held, PressKey=press,
                               ReleaseKey=lambda key, **kwargs: events.append(('up', key)))
        namespace = {'uia': fake, 'contextmanager': contextmanager}
        exec(HELPER, namespace)
        return namespace['_kcoder_held_key'], events

    def test_wheel_exception_releases_owned_modifier(self):
        scope, events = self.scope()
        with self.assertRaisesRegex(RuntimeError, 'wheel'):
            with scope(16):
                raise RuntimeError('wheel failed')
        self.assertEqual(events, [('down', 16), ('up', 16)])

    def test_existing_user_modifier_is_never_released(self):
        scope, events = self.scope(held=True)
        with self.assertRaises(RuntimeError):
            with scope(16):
                raise RuntimeError('wheel failed')
        self.assertEqual(events, [])

    def test_press_wait_failure_still_releases_modifier(self):
        scope, events = self.scope(fail_press=True)
        with self.assertRaises(RuntimeError):
            with scope(16):
                self.fail('body must not run')
        self.assertEqual(events, [('down', 16), ('up', 16)])
