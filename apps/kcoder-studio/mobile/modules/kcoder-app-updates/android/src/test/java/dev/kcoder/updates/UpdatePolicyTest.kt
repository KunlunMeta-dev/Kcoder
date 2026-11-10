package dev.kcoder.updates

import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
  private val installed = PackageIdentity("dev.kcoder.studio", "2.0.1", 20, setOf("original-signer"))
  private val candidate = installed.copy(version = "2.0.2", code = 21)

  @Test fun onlyGithubHttpsDownloadsAndRedirectsAreAllowed() {
    assertTrue(UpdatePolicy.allowedDownload("https://github.com/owner/repo/releases/download/v1/app.apk"))
    assertTrue(UpdatePolicy.allowedDownload("https://release-assets.githubusercontent.com/a/b?signature=public-download"))
    for (url in listOf("http://github.com/a", "https://github.com.evil.test/a", "https://127.0.0.1/a", "file:///a.apk", "https://user:secret@github.com/a", "https://github.com:444/a"))
      assertFalse(url, UpdatePolicy.allowedDownload(url))
  }
  @Test fun packageMustMatchTheInstalledApplicationAndSignedRelease() {
    assertTrue(UpdatePolicy.accepts(installed, candidate, 21, "2.0.2"))
    assertFalse(UpdatePolicy.accepts(installed, candidate.copy(name = "other.app"), 21, "2.0.2"))
    assertFalse(UpdatePolicy.accepts(installed, candidate.copy(signers = setOf("other-signer")), 21, "2.0.2"))
    assertFalse(UpdatePolicy.accepts(installed.copy(signers = emptySet()), candidate.copy(signers = emptySet()), 21, "2.0.2"))
    assertFalse(UpdatePolicy.accepts(installed, candidate, 22, "2.0.2"))
    assertFalse(UpdatePolicy.accepts(installed, candidate, 21, "3.0.0"))
    assertFalse(UpdatePolicy.accepts(installed, installed, 20, "2.0.1"))
  }
  @Test fun apkSizeIsBounded() {
    assertFalse(UpdatePolicy.validSize(0))
    assertTrue(UpdatePolicy.validSize(MAX_APK_BYTES))
    assertFalse(UpdatePolicy.validSize(MAX_APK_BYTES + 1))
  }
}
