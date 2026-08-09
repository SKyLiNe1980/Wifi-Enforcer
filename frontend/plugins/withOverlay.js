/**
 * Expo config plugin: wires the system-wide floating Command Overlay into the
 * Android build during `expo prebuild` (run automatically by EAS Build).
 *
 * What it does:
 *   1. Copies OverlayModule.kt / OverlayPackage.kt / OverlayService.kt into
 *      android/app/src/main/java/com/wifienforcer/overlay/
 *   2. Registers OverlayPackage in MainApplication.kt getPackages().
 *   3. Adds SYSTEM_ALERT_WINDOW + FOREGROUND_SERVICE(+SPECIAL_USE) permissions
 *      and declares <service android:name=".overlay.OverlayService" ...> with a
 *      specialUse foreground-service type.
 *   4. Appends R8/Proguard keep rules for the native module methods.
 */
const {
  withDangerousMod,
  withMainApplication,
  withAndroidManifest,
  AndroidConfig,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const KOTLIN_FILES = ["OverlayModule.kt", "OverlayPackage.kt", "OverlayService.kt"];

const PROGUARD_RULES = `
# === Overlay native module (added by withOverlay config plugin) ===
-keep class com.wifienforcer.overlay.** { *; }
-keepclassmembers class com.wifienforcer.overlay.** {
    @com.facebook.react.bridge.ReactMethod *;
}
# ==================================================================
`;

function withOverlaySources(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const targetDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/java/com/wifienforcer/overlay",
      );
      fs.mkdirSync(targetDir, { recursive: true });
      const srcDir = path.join(__dirname, "android");
      let copied = 0;
      console.log("[withOverlay] ============================================");
      for (const f of KOTLIN_FILES) {
        const src = path.join(srcDir, f);
        const dst = path.join(targetDir, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          console.log(`[withOverlay] \u2713 copied ${f} (${fs.statSync(src).size} bytes)`);
          copied++;
        } else {
          console.warn(`[withOverlay] \u2717 MISSING ${src}`);
        }
      }
      console.log("[withOverlay] ============================================");
      if (copied !== KOTLIN_FILES.length) {
        throw new Error(
          `[withOverlay] FATAL: only copied ${copied}/${KOTLIN_FILES.length} Kotlin files.`,
        );
      }
      // proguard
      const proguardPath = path.join(cfg.modRequest.platformProjectRoot, "app/proguard-rules.pro");
      try {
        let existing = fs.existsSync(proguardPath) ? fs.readFileSync(proguardPath, "utf8") : "";
        if (!existing.includes("Overlay native module")) {
          fs.writeFileSync(proguardPath, existing + PROGUARD_RULES, "utf8");
          console.log("[withOverlay] \u2713 appended proguard keep rules");
        }
      } catch (e) {
        console.warn(`[withOverlay] could not write proguard rules: ${e.message}`);
      }
      return cfg;
    },
  ]);
}

function withOverlayRegistered(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    const importLine = "import com.wifienforcer.overlay.OverlayPackage";
    if (!src.includes(importLine)) {
      src = src.replace(/(package [^\n]+\n)/, `$1\n${importLine}\n`);
    }
    if (!src.includes("OverlayPackage()")) {
      const patterns = [
        { re: /(PackageList\(this\)\.packages\.apply\s*\{\s*\n)/, inj: `$1            add(OverlayPackage())\n` },
        { re: /(val packages = PackageList\(this\)\.packages[^\n]*\n)/, inj: `$1            packages.add(OverlayPackage())\n` },
        { re: /(List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);\n)/, inj: `$1      packages.add(new OverlayPackage());\n` },
        { re: /(\n\s+)(return packages\n\s+\})/, inj: `$1packages.add(OverlayPackage())$1$2` },
      ];
      let injected = false;
      for (const p of patterns) {
        if (p.re.test(src)) { src = src.replace(p.re, p.inj); injected = true; break; }
      }
      if (injected) console.log("[withOverlay] \u2713 patched MainApplication");
      else console.warn("[withOverlay] \u26a0 could not auto-patch MainApplication — add OverlayPackage() manually");
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

function withOverlayManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // permissions
    const perms = [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    ];
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    for (const name of perms) {
      const exists = manifest["uses-permission"].some((p) => p.$ && p.$["android:name"] === name);
      if (!exists) manifest["uses-permission"].push({ $: { "android:name": name } });
    }

    // <service>
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    const svcName = "com.wifienforcer.overlay.OverlayService";
    if (!app.service.some((s) => s.$ && s.$["android:name"] === svcName)) {
      app.service.push({
        $: {
          "android:name": svcName,
          "android:exported": "false",
          "android:foregroundServiceType": "specialUse",
        },
        property: [
          {
            $: {
              "android:name": "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
              "android:value": "Persistent floating operator command overlay",
            },
          },
        ],
      });
      console.log("[withOverlay] \u2713 registered OverlayService in manifest");
    }
    return cfg;
  });
}

module.exports = function withOverlay(config) {
  console.log("[withOverlay] plugin invoked");
  config = withOverlaySources(config);
  config = withOverlayRegistered(config);
  config = withOverlayManifest(config);
  return config;
};
