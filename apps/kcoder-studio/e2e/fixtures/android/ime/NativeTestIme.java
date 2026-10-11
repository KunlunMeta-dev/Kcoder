package dev.kcoder.e2e.ime;
import android.inputmethodservice.InputMethodService;
import android.view.View;
import android.widget.TextView;

/** Owned SDK fixture, enabled only on this run's emulator. No network or persistent user data. */
public final class NativeTestIme extends InputMethodService {
  static NativeTestIme current;
  @Override public void onCreate() { super.onCreate(); current = this; }
  @Override public void onDestroy() { current = null; super.onDestroy(); }
  @Override public View onCreateInputView() {
    TextView view = new TextView(this); view.setText("KCoder native composition fixture");
    view.setTextColor(0xff111111); view.setBackgroundColor(0xffdddddd); view.setHeight(240);
    return view;
  }
}
