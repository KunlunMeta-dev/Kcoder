package dev.kcoder.updates

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import javax.net.ssl.HttpsURLConnection

class KCoderAppUpdatesModule : Module() {
  private val lock = ReentrantLock()
  private val activeRequest = AtomicReference<String?>(null)
  private val cancelled = AtomicBoolean(false)
  @Volatile private var connection: HttpsURLConnection? = null
  @Volatile private var verified: VerifiedUpdate? = null
  private data class VerifiedUpdate(val requestId: String, val digest: String, val size: Long, val code: Long, val version: String)

  override fun definition() = ModuleDefinition {
    Name("KCoderAppUpdates")
    Events("onDownloadProgress")
    AsyncFunction("getInstalledInfo") {
      val context = context()
      val info = installed(context)
      mapOf("packageName" to info.name, "versionName" to info.version, "versionCode" to info.code,
        "abis" to Build.SUPPORTED_ABIS.toList())
    }
    Function("prepareDownload") { requestId: String ->
      if (requestId.length !in 1..128) fail("INVALID_RELEASE")
      if (!activeRequest.compareAndSet(null, requestId)) fail("BUSY")
      cancelled.set(false)
    }
    AsyncFunction("canInstall") { canInstall(context()) }
    AsyncFunction("openInstallPermission") {
      val context = context()
      if (Build.VERSION.SDK_INT >= 26 && !canInstall(context)) {
        try {
          context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) { fail("PERMISSION") }
      }
    }
    AsyncFunction("downloadUpdate") { url: String, digest: String, bytes: Double, code: Double, version: String, requestId: String ->
      val context = context()
      if (activeRequest.get() != requestId) fail("NOT_READY")
      if (!lock.tryLock()) { activeRequest.compareAndSet(requestId, null); fail("BUSY") }
      val directory = File(context.cacheDir, "kcoder-updates")
      val partial = File(directory, "update.apk.part")
      val apk = File(directory, "update.apk")
      try {
        if (!UpdatePolicy.allowedDownload(url) || !digest.matches(Regex("[a-f0-9]{64}")) ||
          bytes != bytes.toLong().toDouble() || !UpdatePolicy.validSize(bytes.toLong()) ||
          code != code.toLong().toDouble() || code.toLong() !in 1..2_147_483_647L) fail("INVALID_RELEASE")
        checkCancelled()
        verified = null
        if (!directory.exists() && !directory.mkdirs()) fail("STORAGE")
        partial.delete()
        apk.delete()
        val hash = MessageDigest.getInstance("SHA-256")
        val started = SystemClock.elapsedRealtime()
        var current = url
        var received = 0L
        for (redirects in 0..5) {
          checkCancelled()
          if (!UpdatePolicy.allowedDownload(current)) fail("INVALID_RELEASE")
          val http = URL(current).openConnection() as HttpsURLConnection
          connection = http
          http.instanceFollowRedirects = false
          http.connectTimeout = 15_000
          http.readTimeout = 15_000
          http.setRequestProperty("Accept-Encoding", "identity")
          try {
            val status = http.responseCode
            if (status in listOf(301, 302, 303, 307, 308)) {
              val location = http.getHeaderField("Location") ?: fail("NETWORK")
              current = URL(URL(current), location).toString()
              if (redirects == 5) fail("NETWORK")
              continue
            }
            if (status != 200) fail("NETWORK")
            var lastProgress = 0L
            http.inputStream.use { input ->
              val destination = try { partial.outputStream() } catch (_: Exception) { fail("STORAGE") }
              destination.use { output ->
              val buffer = ByteArray(64 * 1024)
              while (true) {
                checkCancelled()
                if (SystemClock.elapsedRealtime() - started > 10 * 60_000) fail("NETWORK")
                val count = input.read(buffer)
                if (count < 0) break
                received += count
                if (received > bytes.toLong()) fail("INTEGRITY")
                hash.update(buffer, 0, count)
                try { output.write(buffer, 0, count) } catch (_: Exception) { fail("STORAGE") }
                val now = SystemClock.elapsedRealtime()
                if (now - lastProgress >= 250) {
                  sendEvent("onDownloadProgress", mapOf("requestId" to requestId, "received" to received, "total" to bytes))
                  lastProgress = now
                }
              }
            } }
            break
          } finally { http.disconnect(); connection = null }
        }
        checkCancelled()
        if (received != bytes.toLong() || hex(hash.digest()) != digest) fail("INTEGRITY")
        if (!partial.renameTo(apk)) fail("STORAGE")
        verifyPackage(context, apk, code.toLong(), version)
        verified = VerifiedUpdate(requestId, digest, received, code.toLong(), version)
        sendEvent("onDownloadProgress", mapOf("requestId" to requestId, "received" to received, "total" to bytes))
      } catch (error: Exception) {
        if (cancelled.get()) fail("CANCELLED")
        if (error is CodedException) throw error
        fail("NETWORK")
      } finally {
        partial.delete()
        if (verified?.requestId != requestId) apk.delete()
        activeRequest.compareAndSet(requestId, null)
        lock.unlock()
      }
    }
    Function("cancelDownload") { requestId: String ->
      if (activeRequest.get() == requestId) { cancelled.set(true); connection?.disconnect() }
    }
    AsyncFunction("installUpdate") { requestId: String ->
      val context = context()
      val receipt = verified?.takeIf { it.requestId == requestId } ?: fail("NOT_READY")
      val apk = File(context.cacheDir, "kcoder-updates/update.apk")
      if (!apk.isFile || apk.length() != receipt.size || hashFile(apk) != receipt.digest) fail("INTEGRITY")
      verifyPackage(context, apk, receipt.code, receipt.version)
      if (!canInstall(context)) fail("PERMISSION")
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.kcoder.updates", apk)
      try {
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION))
      } catch (_: Exception) { fail("INSTALLER") }
    }
    OnDestroy { cancelled.set(true); connection?.disconnect() }
  }

  private fun context(): Context = appContext.reactContext ?: fail("UNAVAILABLE")
  private fun canInstall(context: Context) = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
  private fun checkCancelled() { if (cancelled.get()) fail("CANCELLED") }
  private fun fail(reason: String): Nothing = throw CodedException("ERR_UPDATE_$reason", reason, null)
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
  private fun hashFile(file: File): String {
    val hash = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input -> val buffer = ByteArray(64 * 1024)
      while (true) { val size = input.read(buffer); if (size < 0) break; hash.update(buffer, 0, size) } }
    return hex(hash.digest())
  }
  @Suppress("DEPRECATION")
  private fun flags() = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
  @Suppress("DEPRECATION")
  private fun identity(info: PackageInfo): PackageIdentity {
    val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
    val signers = signatures?.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }?.toSet() ?: emptySet()
    return PackageIdentity(info.packageName, info.versionName ?: "", if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong(), signers)
  }
  @Suppress("DEPRECATION")
  private fun installed(context: Context) = identity(context.packageManager.getPackageInfo(context.packageName, flags()))
  @Suppress("DEPRECATION")
  private fun verifyPackage(context: Context, file: File, code: Long, version: String) {
    val archive = context.packageManager.getPackageArchiveInfo(file.path, flags()) ?: fail("INVALID_APK")
    if (!UpdatePolicy.accepts(installed(context), identity(archive), code, version) ||
      (archive.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) > Build.VERSION.SDK_INT) fail("INVALID_APK")
  }
}
