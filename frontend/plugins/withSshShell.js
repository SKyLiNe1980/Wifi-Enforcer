/**
 * Expo config plugin that wires SshShellModule (JSch-based SSH transport) into
 * the Android app during prebuild.
 *
 * What it does:
 *   1. Adds the maintained JSch fork (com.github.mwiede:jsch) to app/build.gradle.
 *   2. Copies SshShellModule.kt + SshShellPackage.kt into
 *      android/app/src/main/java/com/wifienforcer/sshshell/
 *   3. Registers SshShellPackage in MainApplication's package list.
 *   4. Appends proguard keep rules (module @ReactMethods + JSch classes) so R8
 *      doesn't strip the reflection-invoked bridge methods in release builds.
 */

const {
  withDangerousMod,
  withMainApplication,
  withAppBuildGradle,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const KOTLIN_FILES = ["SshShellModule.kt", "SshShellPackage.kt"];
const JSCH_DEP = `    implementation("com.github.mwiede:jsch:0.2.17")`;

// JSch + its transitive jspecify both ship META-INF/versions/9/OSGI-INF/
// MANIFEST.MF, which makes AGP's mergeJavaResource task fail on a duplicate.
// Append a packaging exclude so the merge picks one and moves on.
const PACKAGING_BLOCK = `
// === added by withSshShell: dedupe JSch/jspecify OSGI manifests ===
android {
    packaging {
        resources {
            excludes += ["META-INF/versions/9/OSGI-INF/MANIFEST.MF"]
            excludes += ["META-INF/versions/9/OSGI-INF/**"]
        }
    }
}
// ===================================================================
`;

const PROGUARD_RULES = `
# === SshShell native module + JSch (added by withSshShell config plugin) ===
-keep class com.wifienforcer.sshshell.** { *; }
-keep class com.jcraft.jsch.** { *; }
-dontwarn com.jcraft.jsch.**
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod *;
}
# ============================================================
`;

function withJschDependency(config) {
  return withAppBuildGradle(config, (config) => {
    let src = config.modResults.contents;
    if (!src.includes("com.github.mwiede:jsch")) {
      // Insert into the first dependencies { } block.
      src = src.replace(/dependencies\s*\{/, (m) => `${m}\n${JSCH_DEP}`);
      console.log("[withSshShell] ✓ added JSch dependency");
    } else {
      console.log("[withSshShell] JSch dependency already present");
    }
    // Append the packaging dedupe block (a second android {} block merges into
    // the existing extension — valid Gradle).
    if (!src.includes("dedupe JSch/jspecify OSGI manifests")) {
      src = `${src}\n${PACKAGING_BLOCK}`;
      console.log("[withSshShell] ✓ added packaging exclude for JSch manifests");
    }
    config.modResults.contents = src;
    return config;
  });
}

function withSshShellSources(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const targetDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/java/com/wifienforcer/sshshell",
      );
      fs.mkdirSync(targetDir, { recursive: true });
      const srcDir = path.join(__dirname, "android");
      let copied = 0;
      for (const f of KOTLIN_FILES) {
        const src = path.join(srcDir, f);
        const dst = path.join(targetDir, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          console.log(`[withSshShell] ✓ copied ${f}`);
          copied++;
        } else {
          console.warn(`[withSshShell] ✗ MISSING ${src}`);
        }
      }
      if (copied !== KOTLIN_FILES.length) {
        throw new Error(
          `[withSshShell] FATAL: copied ${copied}/${KOTLIN_FILES.length} Kotlin files.`,
        );
      }
      return config;
    },
  ]);
}

function withSshShellProguard(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const proguardPath = path.join(
        config.modRequest.platformProjectRoot,
        "app/proguard-rules.pro",
      );
      try {
        let existing = "";
        if (fs.existsSync(proguardPath)) existing = fs.readFileSync(proguardPath, "utf8");
        if (!existing.includes("SshShell native module")) {
          fs.writeFileSync(proguardPath, existing + PROGUARD_RULES, "utf8");
          console.log("[withSshShell] ✓ appended proguard keep rules");
        }
      } catch (e) {
        console.warn(`[withSshShell] could not write proguard rules: ${e.message}`);
      }
      return config;
    },
  ]);
}

function withSshShellRegistered(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;
    const importLine = "import com.wifienforcer.sshshell.SshShellPackage";
    if (!src.includes(importLine)) {
      src = src.replace(/(package [^\n]+\n)/, `$1\n${importLine}\n`);
    }
    if (!src.includes("SshShellPackage()")) {
      const patterns = [
        { re: /(PackageList\(this\)\.packages\.apply\s*\{\s*\n)/, inj: `$1            add(SshShellPackage())\n` },
        { re: /(val packages = PackageList\(this\)\.packages[^\n]*\n)/, inj: `$1            packages.add(SshShellPackage())\n` },
        { re: /(List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);\n)/, inj: `$1      packages.add(new SshShellPackage());\n` },
        { re: /(\n\s+)(return packages\n\s+\})/, inj: `$1packages.add(SshShellPackage())$1$2` },
      ];
      let injected = false;
      for (const p of patterns) {
        if (p.re.test(src)) { src = src.replace(p.re, p.inj); injected = true; break; }
      }
      if (injected) console.log("[withSshShell] ✓ patched MainApplication");
      else console.warn("[withSshShell] ⚠️ could not auto-patch MainApplication — add SshShellPackage() manually");
    }
    config.modResults.contents = src;
    return config;
  });
}

module.exports = function withSshShell(config) {
  console.log("[withSshShell] plugin invoked");
  config = withJschDependency(config);
  config = withSshShellSources(config);
  config = withSshShellProguard(config);
  config = withSshShellRegistered(config);
  return config;
};
