/**
 * Expo config plugin that wires the RootShellModule into MainApplication.kt
 * during `npx expo prebuild --platform android` (run automatically by EAS Build).
 *
 * What it does:
 *   1. Copies android/RootShellModule.kt + RootShellPackage.kt into
 *      android/app/src/main/java/com/wifienforcer/rootshell/
 *   2. Patches MainApplication.kt to register RootShellPackage in the
 *      getPackages() list (or the `packages.add(...)` block in SDK 54+).
 */

const { withDangerousMod, withMainApplication } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const KOTLIN_FILES = ["RootShellModule.kt", "RootShellPackage.kt"];

// Proguard rules — appended to android/app/proguard-rules.pro at prebuild time.
// RN's stock proguard config does NOT explicitly keep @ReactMethod-annotated methods,
// so R8 in release builds can strip ones it doesn't see invoked from Java/Kotlin.
// JS calls them via reflection, so R8 has no idea they're reachable. This caused
// new streaming methods (executeStream/killSession/listSessions) to silently
// disappear from release APKs while older methods (exec/isRoot) survived.
const PROGUARD_RULES = `
# === RootShell native module (added by withRootShell config plugin) ===
# Keep the module class and ALL @ReactMethod-annotated methods.
# Without this, R8 in release builds strips streaming methods because JS
# invokes them via reflection — R8 can't see the call sites.
-keep class com.wifienforcer.rootshell.** { *; }
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod *;
}
-keepclassmembers class * extends com.facebook.react.bridge.ReactContextBaseJavaModule {
    public *;
}
# ============================================================
`;

function withRootShellProguard(config) {
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
        if (!existing.includes("RootShell native module")) {
          fs.writeFileSync(proguardPath, existing + PROGUARD_RULES, "utf8");
          console.log("[withRootShell] ✓ appended proguard keep rules");
        } else {
          console.log("[withRootShell] proguard rules already present");
        }
      } catch (e) {
        console.warn(`[withRootShell] could not write proguard rules: ${e.message}`);
      }
      return config;
    },
  ]);
}

function withRootShellSources(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const targetDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/java/com/wifienforcer/rootshell",
      );
      fs.mkdirSync(targetDir, { recursive: true });
      const srcDir = path.join(__dirname, "android");
      console.log(`[withRootShell] copying sources from ${srcDir} → ${targetDir}`);
      let copied = 0;
      for (const f of KOTLIN_FILES) {
        const src = path.join(srcDir, f);
        const dst = path.join(targetDir, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          console.log(`[withRootShell] ✓ copied ${f}`);
          copied++;
        } else {
          console.warn(`[withRootShell] ✗ MISSING ${src}`);
        }
      }
      if (copied !== KOTLIN_FILES.length) {
        throw new Error(
          `[withRootShell] FATAL: only copied ${copied}/${KOTLIN_FILES.length} Kotlin files. ` +
          `Native module will be missing from the APK. Check that ${srcDir} is included in the build.`,
        );
      }
      return config;
    },
  ]);
}

function withRootShellRegistered(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;
    const importLine = "import com.wifienforcer.rootshell.RootShellPackage";

    if (!src.includes(importLine)) {
      // Insert after the package declaration (handles both Kotlin & Java)
      src = src.replace(/(package [^\n]+\n)/, `$1\n${importLine}\n`);
    }

    if (!src.includes("RootShellPackage()")) {
      // Try multiple known patterns (SDK 53/54 use different MainApplication scaffolds)
      const patterns = [
        // Pattern A (SDK 54): inline `PackageList(this).packages.apply { ... }` — inject inside the apply block
        {
          re: /(PackageList\(this\)\.packages\.apply\s*\{\s*\n)/,
          inj: `$1            add(RootShellPackage())\n`,
        },
        // Pattern B (older SDK): `val packages = PackageList(this).packages`
        {
          re: /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
          inj: `$1            packages.add(RootShellPackage())\n`,
        },
        // Pattern C (Java-style): `List<ReactPackage> packages = new PackageList(this).getPackages();`
        {
          re: /(List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);\n)/,
          inj: `$1      packages.add(new RootShellPackage());\n`,
        },
        // Pattern D: `return packages` block — inject before the return
        {
          re: /(\n\s+)(return packages\n\s+\})/,
          inj: `$1packages.add(RootShellPackage())$1$2`,
        },
      ];
      let injected = false;
      for (const p of patterns) {
        if (p.re.test(src)) {
          src = src.replace(p.re, p.inj);
          injected = true;
          break;
        }
      }
      if (!injected) {
        console.warn(
          "[withRootShell] ⚠️  Could not auto-patch MainApplication. " +
          "Open android/app/src/main/java/com/wifienforcer/MainApplication.kt and add manually:\n" +
          "    import com.wifienforcer.rootshell.RootShellPackage\n" +
          "    add(RootShellPackage())   // inside the PackageList(this).packages.apply { } block",
        );
      } else {
        console.log("[withRootShell] ✓ patched MainApplication");
      }
    }

    config.modResults.contents = src;
    return config;
  });
}

module.exports = function withRootShell(config) {
  console.log("[withRootShell] plugin invoked");
  config = withRootShellSources(config);
  config = withRootShellProguard(config);
  config = withRootShellRegistered(config);
  return config;
};
