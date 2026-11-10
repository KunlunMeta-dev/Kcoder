package dev.kcoder.updates

import java.net.URI

internal const val MAX_APK_BYTES = 512L * 1024 * 1024

internal data class PackageIdentity(
  val name: String,
  val version: String,
  val code: Long,
  val signers: Set<String>
)

internal object UpdatePolicy {
  fun allowedDownload(url: String): Boolean = try {
    val uri = URI(url)
    uri.scheme == "https" && uri.userInfo == null && uri.port in listOf(-1, 443) &&
      (uri.host == "github.com" || uri.host == "release-assets.githubusercontent.com" ||
        uri.host == "objects.githubusercontent.com")
  } catch (_: Exception) { false }

  fun validSize(bytes: Long) = bytes in 1..MAX_APK_BYTES

  fun accepts(installed: PackageIdentity, candidate: PackageIdentity, expectedCode: Long, expectedVersion: String): Boolean =
    candidate.name == installed.name && candidate.code == expectedCode && candidate.code > installed.code &&
      candidate.version == expectedVersion && installed.signers.isNotEmpty() && candidate.signers == installed.signers
}
