package dev.kcoder.e2e.ime;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.view.KeyEvent;
import android.view.inputmethod.InputConnection;

public final class CompositionReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    InputConnection connection = NativeTestIme.current == null ? null : NativeTestIme.current.getCurrentInputConnection();
    if (connection == null) { setResultCode(1); setResultData("NO_FOCUSED_INPUT_CONNECTION"); return; }
    boolean success = connection.setComposingText("中", 1);
    success &= connection.setComposingText(intent.getStringExtra("value"), 1);
    success &= connection.finishComposingText();
    success &= connection.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER));
    success &= connection.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER));
    setResultCode(success ? 0 : 1); setResultData(success ? "PASS_COMPOSITION_AND_ENTER" : "INPUT_CONNECTION_REJECTED");
  }
}
