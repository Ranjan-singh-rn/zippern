-keep class com.zipper.app.data.** { *; }
-keep class io.agora.** { *; }
-keep class com.google.firebase.** { *; }
-dontwarn io.agora.**

# ── commons-compress ─────────────────────────────────────────────────────────
#
# Only BZip2CompressorInputStream is ever touched (util/BsPatch.kt), but the jar
# also carries XZ, Zstandard, Brotli, LZMA and Pack200 support that reference
# optional libraries this app deliberately does not depend on. R8 sees those
# references from classes it is about to discard and fails the RELEASE build with
# "Missing class ..." unless told they are expected.
#
# -dontwarn only, never -keep: the unreachable codecs should still be shrunk
# away, and keeping them would ship megabytes of archive formats an OTA patch
# has no use for.
-dontwarn org.tukaani.xz.**
-dontwarn com.github.luben.zstd.**
-dontwarn org.brotli.dec.**
-dontwarn org.apache.commons.compress.**
-dontwarn org.apache.commons.io.**
-dontwarn org.apache.commons.lang3.**
-dontwarn org.apache.commons.codec.**
