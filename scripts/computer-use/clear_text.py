"""Clear one focused editable target; never replay an uncertain UIA write.

Imported only by the already authorized desktop Type tool. No input injection,
clipboard access, tree enumeration, or provider import occurs in this helper.
"""


class ClearTextUnavailable(RuntimeError):
    """A target or capability could not be verified before any clear write."""


class ClearTextOutcomeUnknown(RuntimeError):
    """A clear write may have happened; no fallback or subsequent typing is safe."""


def _target_context(uia, target, binding=None):
    if target is None or target.ControlType != uia.ControlType.EditControl:
        raise ClearTextUnavailable("Clear requires an editable target; no clear or typing started")
    if target.IsPassword is not False or target.IsEnabled is not True:
        raise ClearTextUnavailable("Protected or disabled edit target; no clear or typing started")
    if target.HasKeyboardFocus is not True:
        raise ClearTextUnavailable("Edit target lost focus; no clear or typing started")
    focused = uia.GetFocusedControl()
    identity = tuple(target.GetRuntimeId())
    if not identity or focused is None or tuple(focused.GetRuntimeId()) != identity:
        raise ClearTextUnavailable("Focused element does not match the clear target")
    top = target.GetTopLevelControl()
    foreground = uia.GetForegroundControl()
    if top is None or foreground is None:
        raise ClearTextUnavailable("Edit target window could not be verified")
    handle = top.NativeWindowHandle
    if not handle or handle != foreground.NativeWindowHandle or top.ProcessId != foreground.ProcessId:
        raise ClearTextUnavailable("Edit target is outside the foreground window")
    current = (identity, handle, top.ProcessId, target.ProcessId)
    if binding is not None and current != binding:
        raise ClearTextUnavailable("Edit target identity changed")
    return current


def _available(target, property_id):
    # Unlike the pinned GetPattern wrapper, the raw availability query does not
    # turn arbitrary COM errors into an apparent unsupported capability.
    value = target.Element.GetCurrentPropertyValue(property_id)
    if not isinstance(value, bool):
        raise ClearTextUnavailable("Pattern availability could not be established")
    return value


def clear_text_field(uia, loc):
    """Return a guard to recheck an empty bound target immediately before typing.

    TextPattern is used only after explicit ValuePattern-unavailable metadata,
    writable document metadata, and confirmed full-document selection. It never
    follows a failed ValuePattern write. No blind select-all keyboard shortcut.
No read-only/password value is read and no exception includes target text.
"""
    try:
        target = uia.ControlFromPoint(*loc)
        binding = _target_context(uia, target)
        use_value = _available(target, uia.PropertyId.IsValuePatternAvailableProperty)
        if use_value:
            pattern = target.GetValuePattern()
            if pattern is None or pattern.IsReadOnly is not False:
                raise ClearTextUnavailable("Writable ValuePattern could not be verified")
            read = lambda: pattern.Value
        else:
            if not _available(target, uia.PropertyId.IsTextPatternAvailableProperty):
                raise ClearTextUnavailable("No inspectable editable text pattern; clear and typing not started")
            pattern = target.GetTextPattern()
            if pattern is None or pattern.SupportedTextSelection is not True:
                raise ClearTextUnavailable("Document selection capability could not be verified")
            document = pattern.DocumentRange
            if document.GetAttributeValue(uia.TextAttributeId.IsReadOnlyAttribute) is not False:
                raise ClearTextUnavailable("Text document is read-only or writability is unknown")
            read = lambda: pattern.DocumentRange.GetText(-1)
        value = read()
        if not isinstance(value, str):
            raise ClearTextUnavailable("Edit value could not be verified")
        _target_context(uia, target, binding)
    except ClearTextUnavailable:
        raise
    except Exception:
        raise ClearTextUnavailable("Edit target inspection failed; no clear or typing started") from None

    def verify_empty():
        try:
            _target_context(uia, target, binding)
            readonly = pattern.IsReadOnly if use_value else pattern.DocumentRange.GetAttributeValue(uia.TextAttributeId.IsReadOnlyAttribute)
            if readonly is not False or read() != "":
                raise RuntimeError("bound target is not an empty writable edit")
        except Exception:
            raise ClearTextOutcomeUnknown(
                "Clear outcome or target changed; typing was not started. Observe the target before another action; do not replay clear."
            ) from None

    if value:
        try:
            # From here an exception/False/timeout is an uncertain mutation.
            # Never retry SetValue, fall back to keystrokes, or continue typing.
            if use_value:
                if pattern.SetValue("", waitTime=0.05) is not True:
                    raise RuntimeError("clear write not confirmed")
            else:
                # Select affects the target. Any later error is uncertain and
                # must stop this call without switching clear strategies.
                if document.Select(waitTime=0.05) is not True:
                    raise RuntimeError("document selection not confirmed")
                _target_context(uia, target, binding)
                selection = pattern.GetSelection()
                if len(selection) != 1 or selection[0].Compare(document) is not True or document.Compare(pattern.DocumentRange) is not True:
                    raise RuntimeError("full unchanged document selection not confirmed")
                uia.SendKeys("{Back}", waitTime=0.05)
        except Exception:
            raise ClearTextOutcomeUnknown(
                "Clear may have changed the target; typing was not started. Observe before another action; do not replay or fall back."
            ) from None
    verify_empty()
    return verify_empty
