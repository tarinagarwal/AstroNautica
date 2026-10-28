// Compile check of the app's Android-specific Kotlin (native modules, media provider) against android.jar, the
// React Native AAR, the generated TurboModule specs and the Maven Central libraries, without the Android Gradle
// Plugin (which, like androidx, is only published on Google's Maven repository). Files that need androidx are
// listed in build.gradle.kts and left out. Run scripts/run-codegen.mjs first; pass -PandroidJar=<path>.
pluginManagement { repositories { mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { mavenCentral() } }
rootProject.name = "azaad-android-compile-check"
