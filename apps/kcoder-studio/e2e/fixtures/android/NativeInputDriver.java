package dev.kcoder.e2e;

import android.app.Instrumentation;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.view.MotionEvent;
import android.view.InputDevice;
import android.view.KeyEvent;

/** SDK-only accessibility driver. No app test hooks, shared device state or third-party keyboard. */
public final class NativeInputDriver extends Instrumentation {
  private Bundle arguments;
  @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
  @Override public void onStart() {
    Bundle result = new Bundle();
    try {
      AccessibilityServiceInfo service = getUiAutomation().getServiceInfo();
      service.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      service.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
      getUiAutomation().setServiceInfo(service);
      String action = arguments.getString("action", "wait");
      String selector = arguments.getString("selector", "");
      long deadline = SystemClock.uptimeMillis() + 30000;
      AccessibilityNodeInfo node = null;
      while (SystemClock.uptimeMillis() < deadline) {
        node = find(getUiAutomation().getRootInActiveWindow(), selector);
        if (node != null && (!action.equals("wait-editable") || node.isEnabled())) break;
        SystemClock.sleep(100);
      }
      if (node == null || (action.equals("wait-editable") && !node.isEnabled())) throw new IllegalStateException("Native selector not ready: " + selector);
      if (action.equals("set")) {
        Bundle input = new Bundle();
        input.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, arguments.getString("value", ""));
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, input)) throw new IllegalStateException("Native set-text action rejected");
      } else if (action.equals("choose-file")) {
        AccessibilityNodeInfo target = node;
        while (!target.isFocusable() && target.getParent() != null) target = target.getParent();
        if (!target.isFocused() && !target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)) throw new IllegalStateException("Native file focus rejected");
        sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_CENTER);
      } else if (action.equals("tap")) {
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        long time = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(time, time, MotionEvent.ACTION_DOWN, bounds.centerX(), bounds.centerY(), 0);
        MotionEvent up = MotionEvent.obtain(time, time + 50, MotionEvent.ACTION_UP, bounds.centerX(), bounds.centerY(), 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
          if (!getUiAutomation().injectInputEvent(down, true) || !getUiAutomation().injectInputEvent(up, true)) throw new IllegalStateException("Native touch injection rejected");
        } finally { down.recycle(); up.recycle(); }
      } else if (action.equals("click")) {
        AccessibilityNodeInfo target = node;
        while (!target.isClickable() && target.getParent() != null) target = target.getParent();
        if (!target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) throw new IllegalStateException("Native click action rejected");
      } else if (action.equals("keyboard-safe")) {
        Rect input = new Rect(); node.getBoundsInScreen(input);
        boolean keyboard = false;
        for (AccessibilityWindowInfo window : getUiAutomation().getWindows()) {
          if (window.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
          Rect bounds = new Rect(); window.getBoundsInScreen(bounds); keyboard = true;
          if (input.bottom > bounds.top) throw new IllegalStateException("Native keyboard overlaps composer");
        }
        if (!keyboard) throw new IllegalStateException("Native keyboard is not visible");
      } else if (action.equals("keyboard-layout")) {
        String requested = arguments.getString("value", "");
        if (!requested.equals("visible") && !requested.equals("hidden")) throw new IllegalArgumentException("Expected keyboard visibility must be visible or hidden");
        boolean expectedVisible = requested.equals("visible");
        Rect imeBounds = null, previousImeBounds = null, inputBounds = null, appWindowBounds = null;
        int stableSamples = 0;
        long stableDeadline = SystemClock.uptimeMillis() + 30000;
        while (SystemClock.uptimeMillis() < stableDeadline) {
          imeBounds = findInputMethodBounds();
          AccessibilityNodeInfo currentRoot = getUiAutomation().getRootInActiveWindow();
          AccessibilityNodeInfo currentInput = find(currentRoot, selector);
          if (currentInput == null) {
            stableSamples = 0;
            SystemClock.sleep(100);
            continue;
          }
          Rect nextInputBounds = new Rect(); currentInput.getBoundsInScreen(nextInputBounds);
          Rect nextAppWindowBounds = new Rect(); currentRoot.getBoundsInScreen(nextAppWindowBounds);
          boolean visibilityMatches = (imeBounds != null) == expectedVisible;
          boolean imeBoundsStable = imeBounds == null
            ? previousImeBounds == null
            : imeBounds.equals(previousImeBounds);
          if (visibilityMatches && imeBoundsStable && inputBounds != null && appWindowBounds != null && nextInputBounds.equals(inputBounds) && nextAppWindowBounds.equals(appWindowBounds)) stableSamples++;
          else stableSamples = 0;
          inputBounds = nextInputBounds;
          appWindowBounds = nextAppWindowBounds;
          previousImeBounds = imeBounds == null ? null : new Rect(imeBounds);
          if (stableSamples >= 3) break;
          SystemClock.sleep(100);
        }
        if ((imeBounds != null) != expectedVisible || stableSamples < 3 || inputBounds == null || appWindowBounds == null) {
          throw new IllegalStateException("Native keyboard/layout did not settle in requested state: " + requested);
        }
        result.putString("layout", "{\"imeVisible\":" + expectedVisible + ",\"input\":" + rectJson(inputBounds) + ",\"appWindow\":" + rectJson(appWindowBounds) + ",\"ime\":" + (imeBounds == null ? "null" : rectJson(imeBounds)) + "}");
      } else if (action.equals("assert-readonly")) {
        // Android EditText reports editable by class even when React Native disables it.
        if (node.isEnabled()) throw new IllegalStateException("Disconnected native control is enabled");
      } else if (action.equals("assert")) {
        String value = arguments.getString("value", "");
        if (!value.contentEquals(node.getText() == null ? "" : node.getText())) throw new IllegalStateException("Native text mismatch: " + selector);
      }
      result.putString("result", "PASS");
      finish(0, result);
    } catch (Throwable error) {
      result.putString("result", "FAIL " + error);
      finish(1, result);
    }
  }
  private Rect findInputMethodBounds() {
    for (AccessibilityWindowInfo window : getUiAutomation().getWindows()) {
      if (window.getType() != AccessibilityWindowInfo.TYPE_INPUT_METHOD) continue;
      Rect bounds = new Rect(); window.getBoundsInScreen(bounds); return bounds;
    }
    return null;
  }
  private String rectJson(Rect rect) {
    return "[" + rect.left + "," + rect.top + "," + rect.right + "," + rect.bottom + "]";
  }
  private AccessibilityNodeInfo find(AccessibilityNodeInfo node, String selector) {
    if (node == null) return null;
    String id = node.getViewIdResourceName();
    CharSequence text = node.getText(), description = node.getContentDescription();
    if ((id != null && (id.equals(selector) || id.endsWith(":id/" + selector))) ||
        (text != null && (text.toString().equals(selector) || text.toString().contains(selector))) ||
        (description != null && description.toString().equals(selector))) return node;
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo found = find(node.getChild(i), selector);
      if (found != null) return found;
    }
    return null;
  }
}
