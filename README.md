# Build Nigeria 🇳🇬 Smart Sockets (React Web + Capacitor)

A modern, responsive React web application and native mobile app (powered by Capacitor) for controlling and monitoring Build Nigeria Smart Energy Sockets.

---

## 🌟 Features

- **Real-Time MQTT Cloud Telemetry**: Connects via secure WebSockets (`wss://broker.emqx.io:8084/mqtt`).
- **Live Electrical Telemetry**: Displays AC Grid Voltage (V), Real Power (W), Load Current (A), Accumulated Energy (kWh), and DS18B20 Temperature (°C).
- **Outage Detection**: Instant detection of grid failure (0V / heartbeat watchdog timeout) with outage duration tracking.
- **Smart Countdown Off-Timer**: Presets (15m, 30m pump, 45m tank, 1h, 2h) or custom minutes for automatic appliance cutoff.
- **Appliance Voltage Guard**: Real-time surge (≥250V) and brownout (≤175V) disconnect alerts with 10s recovery stabilization countdown.
- **Safety Alarms**: High temperature warning notifications when socket temperature exceeds 50°C.
- **Device Discovery & Manual Linking**: Scan network/cloud for broadcasting sockets or manually link by ID (e.g. `SOCKET-01`).
- **Cross-Platform**: Runs in any desktop/mobile web browser and packages into a native Android APK via Capacitor.

---

## 🚀 Running as a Web Page

### 1. Development Server
Start the Vite local development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser. On phones connected to the same Wi-Fi, open the displayed network IP.

### 2. Production Web Build
Build optimized production web assets:
```bash
npm run build
```
The compiled files will be located in the `dist/` directory.

---

## 📱 Installing to Phone (Capacitor Android)

### Prerequisites
- [Android Studio](https://developer.android.com/studio) installed.
- Android phone with **USB Debugging** enabled (Settings → Developer Options → USB Debugging) OR an Android Virtual Device (AVD).

### Step 1: Build & Sync Web Assets to Android
Whenever you make changes to the React app, run:
```bash
npm run build
npm run cap:sync
```

### Step 2: Open in Android Studio
```bash
npm run cap:open:android
```
Once Android Studio opens:
1. Connect your phone via USB cable.
2. Select your device in the top target selector.
3. Click the green **Run (▶)** button.
4. Android Studio will build and install the app directly to your phone!

### Step 3: Or Generate an Installable APK File (.apk)
To create an APK file that you can transfer to any phone (via WhatsApp, Google Drive, or Bluetooth):

```bash
cd android
./gradlew assembleDebug
```
(On Windows Command Prompt / PowerShell, run: `.\gradlew assembleDebug`)

Your installable APK will be generated at:
```
android/app/build/outputs/apk/debug/app-debug.apk
```
Copy `app-debug.apk` to your phone and tap it to install!

---

## 🛠 Available NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts the Vite web development server |
| `npm run build` | Compiles TypeScript and builds the production web app into `dist/` |
| `npm run preview` | Locally preview the production build |
| `npm run cap:sync` | Copies web build assets and syncs plugins to the native Android project |
| `npm run cap:open:android` | Opens the native Android project in Android Studio |
| `npm run cap:run:android` | Builds and installs directly to a connected phone using ADB |
