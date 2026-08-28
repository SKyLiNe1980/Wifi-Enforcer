/**
 * Config plugin: wires the SWAT background-connection foreground service into
 * the Android build. Copies SwatBusModule/Service/Package, registers the
 * package in MainApplication, adds FOREGROUND_SERVICE(+DATA_SYNC),
 * POST_NOTIFICATIONS, WAKE_LOCK, REQUEST_IGNORE_BATTERY_OPTIMIZATIONS perms and
 * the <service android:foregroundServiceType="dataSync"> declaration.
 */
const { withDangerousMod, withMainApplication, withAndroidManifest, AndroidConfig } =
  require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const FILES = ["SwatBusModule.kt", "SwatBusPackage.kt", "SwatBusService.kt"];
const PROGUARD = `
# === SwatBus native module (added by withSwatBus) ===
-keep class com.wifienforcer.swatbus.** { *; }
-keepclassmembers class com.wifienforcer.swatbus.** { @com.facebook.react.bridge.ReactMethod *; }
`;

function withSources(config) {
  return withDangerousMod(config, ["android", async (cfg) => {
    const dir = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/java/com/wifienforcer/swatbus");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(__dirname, "android");
    let n = 0;
    for (const f of FILES) {
      const s = path.join(src, f);
      if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(dir, f)); n += 1; console.log(`[withSwatBus] \u2713 ${f}`); }
      else console.warn(`[withSwatBus] \u2717 MISSING ${s}`);
    }
    if (n !== FILES.length) throw new Error(`[withSwatBus] copied ${n}/${FILES.length} files`);
    const pg = path.join(cfg.modRequest.platformProjectRoot, "app/proguard-rules.pro");
    try {
      const cur = fs.existsSync(pg) ? fs.readFileSync(pg, "utf8") : "";
      if (!cur.includes("SwatBus native module")) fs.writeFileSync(pg, cur + PROGUARD, "utf8");
    } catch (e) { console.warn(`[withSwatBus] proguard: ${e.message}`); }
    return cfg;
  }]);
}

function withRegistered(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;
    const imp = "import com.wifienforcer.swatbus.SwatBusPackage";
    if (!src.includes(imp)) src = src.replace(/(package [^\n]+\n)/, `$1\n${imp}\n`);
    if (!src.includes("SwatBusPackage()")) {
      const pats = [
        { re: /(PackageList\(this\)\.packages\.apply\s*\{\s*\n)/, inj: `$1            add(SwatBusPackage())\n` },
        { re: /(val packages = PackageList\(this\)\.packages[^\n]*\n)/, inj: `$1            packages.add(SwatBusPackage())\n` },
        { re: /(List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);\n)/, inj: `$1      packages.add(new SwatBusPackage());\n` },
      ];
      for (const p of pats) if (p.re.test(src)) { src = src.replace(p.re, p.inj); break; }
    }
    cfg.modResults.contents = src;
    return cfg;
  });
}

function withManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults.manifest;
    const perms = [
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.WAKE_LOCK",
      "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    ];
    m["uses-permission"] = m["uses-permission"] || [];
    for (const name of perms) {
      if (!m["uses-permission"].some((p) => p.$ && p.$["android:name"] === name))
        m["uses-permission"].push({ $: { "android:name": name } });
    }
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.service = app.service || [];
    const name = "com.wifienforcer.swatbus.SwatBusService";
    if (!app.service.some((s) => s.$ && s.$["android:name"] === name)) {
      app.service.push({ $: {
        "android:name": name, "android:exported": "false", "android:foregroundServiceType": "dataSync",
      } });
      console.log("[withSwatBus] \u2713 registered SwatBusService");
    }
    return cfg;
  });
}

module.exports = function withSwatBus(config) {
  console.log("[withSwatBus] plugin invoked");
  config = withSources(config);
  config = withRegistered(config);
  config = withManifest(config);
  return config;
};
