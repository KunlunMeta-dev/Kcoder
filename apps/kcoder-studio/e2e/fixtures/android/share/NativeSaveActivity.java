package dev.kcoder.e2e.share;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Actual Android share consumer: asynchronously reads the granted URI and saves owned bytes. */
public final class NativeSaveActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    TextView result = new TextView(this); result.setText("Reading native attachment…"); setContentView(result);
    new Handler(Looper.getMainLooper()).postDelayed(() -> {
      try {
        Uri uri = getIntent().getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) throw new IllegalStateException("Missing granted stream URI");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream input = getContentResolver().openInputStream(uri)) {
          byte[] buffer = new byte[4096]; int count;
          while ((count = input.read(buffer)) != -1) {
            bytes.write(buffer, 0, count);
            if (bytes.size() > 65536) throw new IllegalStateException("Native fixture content limit exceeded");
          }
        }
        if (!"NATIVE_ATTACHMENT_CONTENT 中文附件\n".equals(bytes.toString(StandardCharsets.UTF_8.name()))) throw new IllegalStateException("Native downloaded bytes mismatch");
        Files.write(getFilesDir().toPath().resolve("native-note.txt"), bytes.toByteArray());
        result.setText("PASS_NATIVE_DOWNLOAD_CONTENT");
      } catch (Throwable error) { result.setText("FAIL_NATIVE_DOWNLOAD_CONTENT " + error); }
    }, 300);
  }
}
