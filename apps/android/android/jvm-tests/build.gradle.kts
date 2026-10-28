plugins {
  kotlin("jvm") version "2.2.0"
}

// lazysodium-java 5.2 needs Java 21 (tests only; the app compiles these sources for Java 17).
java {
  sourceCompatibility = JavaVersion.VERSION_21
  targetCompatibility = JavaVersion.VERSION_21
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }

sourceSets {
  main { kotlin.srcDir("../app/src/main/java/org/azaadawaaz/app/core") }
}

dependencies {
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.squareup.okhttp3:okhttp-dnsoverhttps:4.12.0")
  // Android ships org.json; on the JVM it comes from the reference implementation.
  implementation("org.json:json:20240303")
  // lazysodium-java: the same API and native libsodium as lazysodium-android on the phone.
  implementation("com.goterl:lazysodium-java:5.2.0")
  testImplementation("junit:junit:4.13.2")
  testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

tasks.test {
  useJUnit()
  testLogging {
    events("passed", "failed", "skipped")
    showStandardStreams = false
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
  }
  systemProperty("vectorsDir", layout.projectDirectory.dir("src/test/resources").asFile.absolutePath)
  systemProperty("outDir", layout.buildDirectory.dir("vectors").get().asFile.absolutePath)
  systemProperty("bridgesJson", file("../app/src/main/assets/builtin-bridges.json").absolutePath)
}
