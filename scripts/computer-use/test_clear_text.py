import ast
import sys
import types
import unittest
from types import SimpleNamespace
from clear_text import ClearTextOutcomeUnknown, ClearTextUnavailable, clear_text_field
from patch_clear_text import ANCHOR, OLD, patch


class Pattern:
    IsReadOnly = False
    def __init__(self, value="old"):
        self.value = value
        self.writes = []
        self.failure = None
        self.after = None
    @property
    def Value(self):
        if self.failure == "read" and self.writes:
            raise TimeoutError("untrusted provider detail")
        return self.value
    def SetValue(self, value, waitTime):
        self.writes.append(value)
        if self.failure == "unchanged": return True
        self.value = value
        if self.after: self.after()
        if self.failure == "exception": raise TimeoutError("private provider detail")
        return self.failure != "false"


class Target:
    ControlType = 50004
    IsPassword = False
    IsEnabled = True
    HasKeyboardFocus = True
    ProcessId = 4
    def __init__(self, pattern): self.pattern = pattern
    def GetRuntimeId(self): return [4, 9]
    def GetTopLevelControl(self): return SimpleNamespace(NativeWindowHandle=100,ProcessId=4)
    def GetValuePattern(self): return self.pattern


def fixture(pattern=None):
    pattern = pattern or Pattern()
    target = Target(pattern)
    target.Element=SimpleNamespace(GetCurrentPropertyValue=lambda _:True)
    uia = SimpleNamespace(ControlType=SimpleNamespace(EditControl=50004),
        PropertyId=SimpleNamespace(IsValuePatternAvailableProperty=30043,IsTextPatternAvailableProperty=30040),
        TextAttributeId=SimpleNamespace(IsReadOnlyAttribute=40015),
        ControlFromPoint=lambda *loc: target, GetFocusedControl=lambda: target,
        GetForegroundControl=lambda: SimpleNamespace(NativeWindowHandle=100, ProcessId=4))
    return uia, target, pattern


class ClearTests(unittest.TestCase):
    def test_clears_once_and_rechecks_empty_before_typing(self):
        uia, target, pattern = fixture()
        guard = clear_text_field(uia, [10, 20])
        guard()
        self.assertEqual(pattern.writes, [""])
        self.assertEqual(pattern.Value, "")

    def test_empty_target_does_not_repeat_a_write(self):
        uia, target, pattern = fixture(Pattern(""))
        clear_text_field(uia, [10, 20])()
        self.assertEqual(pattern.writes, [])

    def test_target_guards_reject_before_write(self):
        for attribute, value in [("IsPassword", True), ("IsEnabled", False),
                ("HasKeyboardFocus", False), ("ControlType", 50000)]:
            with self.subTest(attribute=attribute):
                uia, target, pattern = fixture()
                setattr(target, attribute, value)
                with self.assertRaises(ClearTextUnavailable): clear_text_field(uia, [10, 20])
                self.assertEqual(pattern.writes, [])
        uia, target, pattern = fixture()
        pattern.IsReadOnly = True
        with self.assertRaises(ClearTextUnavailable): clear_text_field(uia, [10, 20])
        self.assertEqual(pattern.writes, [])

    def test_foreign_window_and_focus_reject_without_write(self):
        for change in [lambda u,t:setattr(u, "GetFocusedControl", lambda:None),
                lambda u,t:setattr(u, "GetForegroundControl", lambda:SimpleNamespace(NativeWindowHandle=999,ProcessId=4)),
                lambda u,t:setattr(u, "GetForegroundControl", lambda:SimpleNamespace(NativeWindowHandle=100,ProcessId=99))]:
            uia, target, pattern = fixture(); change(uia,target)
            with self.assertRaises(ClearTextUnavailable): clear_text_field(uia, [10,20])
            self.assertEqual(pattern.writes, [])

    def test_cross_renderer_edit_is_bound_to_window_and_own_runtime(self):
        uia, target, pattern=fixture();target.ProcessId=99
        clear_text_field(uia,[10,20])()
        self.assertEqual(pattern.writes,[""])

    def test_pattern_availability_failure_is_not_a_fallback_signal(self):
        for value in [None, 0, "false"]:
            uia,target,pattern=fixture();target.Element.GetCurrentPropertyValue=lambda _,v=value:v
            with self.assertRaises(ClearTextUnavailable):clear_text_field(uia,[10,20])
            self.assertEqual(pattern.writes,[])

    def text_fixture(self, failure=None):
        uia,target,value=fixture();events=[]
        state=SimpleNamespace(text="old",selected=False)
        class Range:
            def GetAttributeValue(self, _):return False
            def GetText(self, _):return state.text
            def Select(self,waitTime):
                events.append('select');state.selected=True
                if failure=='select-exception':raise TimeoutError()
                return failure!='select-false'
            def Compare(self,other):return failure!='partial-selection'
        doc=Range()
        text=SimpleNamespace(SupportedTextSelection=True,DocumentRange=doc,GetSelection=lambda:[doc])
        target.GetTextPattern=lambda:text
        target.Element.GetCurrentPropertyValue=lambda pid:pid==30040
        def send(keys,waitTime):
            events.append(keys)
            if failure=='input-exception':raise TimeoutError()
            if failure!='not-empty':state.text=''
        uia.SendKeys=send
        return uia,target,value,events

    def test_textpattern_selects_full_document_and_confirms_empty_before_type(self):
        uia,target,value,events=self.text_fixture()
        clear_text_field(uia,[10,20])()
        self.assertEqual(events,['select','{Back}'])
        self.assertEqual(value.writes,[])

    def test_textpattern_unknown_or_partial_selection_never_replays(self):
        for failure in ['select-exception','select-false','partial-selection','input-exception','not-empty']:
            with self.subTest(failure=failure):
                uia,target,value,events=self.text_fixture(failure)
                with self.assertRaises(ClearTextOutcomeUnknown):clear_text_field(uia,[10,20])
                self.assertEqual(events.count('select'),1)
                self.assertLessEqual(events.count('{Back}'),1)
                self.assertEqual(value.writes,[])

    def test_missing_pattern_never_blindly_uses_keyboard_fallback(self):
        uia, target, pattern = fixture(); target.pattern = None
        with self.assertRaises(ClearTextUnavailable): clear_text_field(uia,[10,20])
        self.assertEqual(pattern.writes, [])

    def test_false_exception_read_failure_and_nonempty_are_unknown_no_replay(self):
        for failure in ["false", "exception", "read", "unchanged"]:
            with self.subTest(failure=failure):
                uia, target, pattern = fixture(); pattern.failure = failure
                with self.assertRaises(ClearTextOutcomeUnknown) as raised:
                    clear_text_field(uia, [10,20])
                self.assertEqual(pattern.writes, [""])
                self.assertNotIn("private provider detail", str(raised.exception))

    def test_target_changes_after_write_or_before_typing_never_reclear(self):
        uia, target, pattern = fixture()
        pattern.after = lambda:setattr(target,"HasKeyboardFocus",False)
        with self.assertRaises(ClearTextOutcomeUnknown): clear_text_field(uia,[10,20])
        self.assertEqual(pattern.writes,[""])
        uia, target, pattern = fixture(); guard=clear_text_field(uia,[10,20]);pattern.value="external update"
        with self.assertRaises(ClearTextOutcomeUnknown):guard()
        self.assertEqual(pattern.writes,[""])

    def test_patch_matches_pinned_clear_and_preserves_normal_input_branches(self):
        source="class Desktop:\n    def type(self, loc, text, clear=False):\n"+OLD+ANCHOR+"        return text\n"
        result=patch(source);ast.parse(result)
        self.assertIn("clear_guard()",result)
        self.assertNotIn('SendKeys("{Back}"',result)
        with self.assertRaises(ValueError):patch(result)
        with self.assertRaises(ValueError):patch(source.replace('sleep(0.5)','sleep(0.6)'))

    def test_patched_type_boolean_string_clear_and_guard_failure_before_input(self):
        source = '''class Desktop:
    def type(self, loc, text, clear=False):
'''+OLD+ANCHOR+'''        uia.SendKeys(text)
'''
        result=patch(source);ast.parse(result)
        previous=sys.modules.get('windows_mcp.kcoder_clear')
        root_previous=sys.modules.get('windows_mcp')
        sys.modules['windows_mcp']=types.ModuleType('windows_mcp')
        module=types.ModuleType('windows_mcp.kcoder_clear')
        sys.modules['windows_mcp.kcoder_clear']=module
        try:
            for clear, expected in [(True,True),('true',True),('TRUE',True),(False,False),('false',False)]:
                with self.subTest(clear=clear):
                    calls=[]
                    module.clear_text_field=lambda uia,loc:calls.append(('clear',loc)) or (lambda:calls.append(('verify',)))
                    scope={'uia':SimpleNamespace(SendKeys=lambda text:calls.append(('type',text)))}
                    exec(result,scope);scope['Desktop']().type([10,20],'fresh',clear)
                    self.assertEqual(calls, [('clear',[10,20]),('verify',),('type','fresh')] if expected else [('type','fresh')])
            calls=[]
            def fail(uia,loc):
                calls.append(('clear',loc))
                raise ClearTextOutcomeUnknown('no replay')
            module.clear_text_field=fail
            scope={'uia':SimpleNamespace(SendKeys=lambda text:calls.append(('type',text)))}
            exec(result,scope)
            with self.assertRaises(ClearTextOutcomeUnknown):scope['Desktop']().type([10,20],'fresh',True)
            self.assertEqual(calls,[('clear',[10,20])])
        finally:
            if previous is None:sys.modules.pop('windows_mcp.kcoder_clear',None)
            else:sys.modules['windows_mcp.kcoder_clear']=previous
            if root_previous is None:sys.modules.pop('windows_mcp',None)
            else:sys.modules['windows_mcp']=root_previous


if __name__ == "__main__": unittest.main()
