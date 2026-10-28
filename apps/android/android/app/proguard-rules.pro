# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# JNA / lazysodium (reflection over native structures)
-keep class com.sun.jna.** { *; }
-keep class com.goterl.lazysodium.** { *; }
# tor-android, jtorctl and the gomobile IPtProxy bindings
-keep class org.torproject.jni.** { *; }
-keep class net.freehaven.tor.control.** { *; }
-keep class IPtProxy.** { *; }
-keep class go.** { *; }
