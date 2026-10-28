// Standalone JVM build for the app's platform-independent Kotlin (app/src/main/java/org/azaadawaaz/app/core):
// it compiles exactly those sources and runs JUnit tests without the Android SDK or Android Gradle Plugin.
pluginManagement {
  repositories {
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositories { mavenCentral() }
}
rootProject.name = "azaad-core-jvm-tests"
