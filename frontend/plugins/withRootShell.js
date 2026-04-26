/**
 * Expo config plugin that wires the RootShellModule into MainApplication.kt
 * during `npx expo prebuild --platform android`.
 *
 * Usage in app.json:
 *   "plugins": ["./root-bridge/plugin/withRootShell.js"]
 *
 * What it does:
 *   1. Copies android/RootShellModule.kt + RootShellPackage.kt into
 *      android/app/src/main/java/com/wifienforcer/rootshell/
 *   2. Patches MainApplication.kt to register RootShellPackage in the
 *      getPackages() list.
 */

const { withDangerousMod, withMainApplication } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const KOTLIN_FILES = ["RootShellModule.kt", "RootShellPackage.kt"];

function withRootShellSources(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const targetDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/java/com/wifienforcer/rootshell",
      );
      fs.mkdirSync(targetDir, { recursive: true });
      const srcDir = path.join(projectRoot, "..", "root-bridge", "android");
      for (const f of KOTLIN_FILES) {
        const src = path.join(srcDir, f);
        const dst = path.join(targetDir, f);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          console.log(`[withRootShell] copied ${f}`);
        } else {
          console.warn(`[withRootShell] MISSING ${src}`);
        }
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
      src = src.replace(
        /(package [^\n]+\n)/,
        `$1\n${importLine}\n`,
      );
    }
    // add to packages list — supports the standard PackageList(this).packages pattern
    if (!src.includes("RootShellPackage()")) {
      src = src.replace(
        /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
        `$1            packages.add(RootShellPackage())\n`,
      );
    }
    config.modResults.contents = src;
    return config;
  });
}

module.exports = function withRootShell(config) {
  config = withRootShellSources(config);
  config = withRootShellRegistered(config);
  return config;
};
