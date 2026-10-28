import java.util.zip.ZipFile

plugins {
  kotlin("jvm") version "2.2.0"
  java
}

val androidJar = file(providers.gradleProperty("androidJar").getOrElse("android.jar"))
val app = file("../app/src/main/java/org/azaadawaaz/app")
/** Need androidx (Google Maven only): BiometricPrompt, FileProvider, FragmentActivity, AppCompatActivity. */
/**
 * -Preact=true also compiles the TurboModules and generated specs against react-android. Its AAR is served from
 * repo.reactnative.dev (Maven Central redirects there); without it only React-independent files are checked.
 */
val withReact = providers.gradleProperty("react").map { it == "true" }.getOrElse(false)
val needsReact = listOf("modules/**", "AzaadPackage.kt", "MainApplication.kt", "MainActivity.kt")
val needsAndroidx = setOf("BiometricGate.kt", "ShareUris.kt", "modules/VaultModule.kt", "modules/FilesModule.kt", "modules/UpdateModule.kt", "MainActivity.kt", "AzaadPackage.kt", "MainApplication.kt")

val aars by configurations.creating {
  isTransitive = false
  // react-android publishes debug/debugOptimized/release variants keyed by AGP's build-type attribute.
  attributes { attribute(Attribute.of("com.android.build.api.attributes.BuildTypeAttr", String::class.java), "release") }
}
val jars by configurations.creating { isTransitive = false }

dependencies {
  if (withReact) aars("com.facebook.react:react-android:0.88.1@aar")
  if (withReact) aars("info.guardianproject:tor-android:0.4.9.14@aar")
  if (withReact) aars("com.netzarchitekten:IPtProxy:5.7.0@aar")
  aars("com.goterl:lazysodium-android:5.2.0@aar")
  if (withReact) jars("info.guardianproject:jtorctl:0.4.5.7")
  if (withReact) jars("com.facebook.fbjni:fbjni:0.7.0@aar")
  if (withReact) jars("com.google.code.findbugs:jsr305:3.0.2")
  if (withReact) jars("javax.inject:javax.inject:1")
  jars("net.java.dev.jna:jna:5.19.1")
  jars("com.squareup.okhttp3:okhttp:4.12.0")
  jars("com.squareup.okhttp3:okhttp-dnsoverhttps:4.12.0")
  jars("com.squareup.okio:okio-jvm:3.6.0")
}

/** classes.jar out of each AAR. */
val extract by tasks.registering {
  val out = layout.buildDirectory.dir("aar-classes")
  inputs.files(aars, jars)
  outputs.dir(out)
  doLast {
    val dir = out.get().asFile.apply { mkdirs() }
    (aars.files + jars.files.filter { it.name.endsWith(".aar") }).forEach { aar ->
      ZipFile(aar).use { z -> z.getEntry("classes.jar")?.let { e -> z.getInputStream(e).use { File(dir, aar.nameWithoutExtension + ".jar").outputStream().use { o -> it.copyTo(o) } } } }
    }
  }
}

sourceSets {
  main {
    if (withReact) java.srcDir("../../build/codegen/android/java")
    kotlin.srcDir(app)
    kotlin.exclude(needsAndroidx.toList())
    if (!withReact) kotlin.exclude(needsReact)
  }
}

val cp = files(androidJar) + files(extract.map { fileTree(it.outputs.files.singleFile) }) + jars.filter { it.name.endsWith(".jar") }

dependencies {
  compileOnly(cp)
  implementation("org.json:json:20240303")
}

java {
  sourceCompatibility = JavaVersion.VERSION_17
  targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
tasks.named("compileKotlin") { dependsOn(extract) }
tasks.named("compileJava") { dependsOn(extract) }
