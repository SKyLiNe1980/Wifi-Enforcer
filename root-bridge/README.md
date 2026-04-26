# WiFi Enforcer — Real Root Bridge

This folder contains everything you need to turn the **mocked preview** into a **real APK** that runs `su -c <command>` on your rooted Galaxy S10+ (LineageOS 23.2 + Magisk).

It is **not used** in the Expo Go preview (the bridge is invisible there → app stays in MOCK mode automatically).

---

## What's inside

```
root-bridge/
├── android/
│   ├── RootShellModule.kt    # Native module — does Runtime.exec(["su","-c", …])
│   └── RootShellPackage.kt   # Registers RootShellModule with React Native
├── plugin/
│   └── withRootShell.js      # Expo config-plugin: copies sources & patches MainApplication
├── eas.json                  # EAS Build profiles (dev / preview / production)
└── README.md                 # ← you are here
```

---

## One-time setup (on your dev machine — not in this preview)

```bash
# 1. Clone or pull the project locally
git clone <your repo>  &&  cd <project>/frontend
yarn install

# 2. Install EAS CLI globally
npm i -g eas-cli
eas login        # use your Expo account

# 3. Initialize EAS for this project (creates a project ID)
eas init
```

---

## Wire the plugin into `app.json`

Open `frontend/app.json` and add `"./root-bridge/plugin/withRootShell"` to `expo.plugins`, set the Android package & permissions:

```jsonc
{
  "expo": {
    "name": "WiFi Enforcer",
    "slug": "wifi-enforcer",
    "android": {
      "package": "com.wifienforcer",
      "permissions": [
        "android.permission.INTERNET",
        "android.permission.ACCESS_WIFI_STATE",
        "android.permission.CHANGE_WIFI_STATE",
        "android.permission.ACCESS_NETWORK_STATE"
      ]
    },
    "plugins": [
      "expo-router",
      "./root-bridge/plugin/withRootShell"
    ]
  }
}
```

> Note: **root** itself is not declared as an Android permission. Magisk grants it at runtime when `su` is invoked.

---

## Copy `eas.json` to your project root

```bash
cp root-bridge/eas.json ./eas.json
```

---

## Build the APK

### Option A — Cloud build (easiest, free tier)
```bash
cd frontend
eas build --platform android --profile preview
```
That kicks off a build on Expo's cloud. After ~10 min you'll get a download URL for the APK.

### Option B — Local build (faster, no quota)
```bash
cd frontend
npx expo prebuild --platform android --clean
cd android
./gradlew assembleDebug
# APK lands in android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Install & run on your S10+

1. Transfer the APK to your phone (Syncthing / ADB / Telegram / whatever).
2. `adb install -r app-debug.apk`  (or tap it in the file manager).
3. Launch **WiFi Enforcer**.
4. Tap any quick action → Magisk should pop a **"Grant root?"** prompt → **Allow**.
5. Open the **Settings** tab → toggle **exec mode → REAL**.
6. Run commands. They now go through `Runtime.exec({"su", "-c", cmd})` for real.

---

## Verifying the bridge

In **Settings**, the `root` row will show:

| State                                    | Meaning                                                               |
|------------------------------------------|------------------------------------------------------------------------|
| `MOCK` (yellow)                          | Bridge not present (Expo Go / web). Commands simulated.               |
| `BRIDGE LOADED · root: GRANTED` (green)  | Native module bound, Magisk granted root. REAL mode available.        |
| `BRIDGE LOADED · root: DENIED` (red)     | Module bound, but Magisk denied. Open Magisk → grant for the app.     |

---

## What the native module exposes to JS

```ts
import { RootShell, checkRoot, execReal } from "@/lib/rootShell";

await checkRoot();                      // boolean — Magisk granted?
await execReal("svc wifi disable");     // { command, output, exit_code, duration_ms }
await RootShell?.execBatch([            // run a profile in ONE su session
  "svc wifi disable",
  "iw reg set US",
  "setprop wifi.country US",
  "cmd wifi force-country-code enabled US",
  "svc wifi enable",
]);
```

---

## Troubleshooting

- **"native root module not available"** → you're in Expo Go or the plugin didn't run. Re-run `npx expo prebuild --clean`.
- **Build fails: `RootShellPackage not found`** → the plugin couldn't patch `MainApplication.kt`. Open `android/app/src/main/java/com/wifienforcer/MainApplication.kt` and add manually:
  ```kotlin
  import com.wifienforcer.rootshell.RootShellPackage
  // …
  override fun getPackages(): List<ReactPackage> {
      val packages = PackageList(this).packages
      packages.add(RootShellPackage())
      return packages
  }
  ```
- **Magisk never prompts** → check `Magisk → Settings → Superuser → ensure the app isn't blocked`. Tap the action again.
- **`isRoot()` returns false but I am rooted** → some kernels have `su` in `/system/xbin/`; the module uses `Runtime.exec(["su","-c","id"])` which is PATH-based. Check `which su` on adb shell.

---

## Safety reminder

These commands modify regulatory/global wifi state. Misusing `iw reg set` or `cmd wifi force-country-code` outside your actual jurisdiction can violate radio regulations. You're a sysadmin/pentester with NetHunter, so you know — but worth a line. 🫡
