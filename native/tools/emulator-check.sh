#!/usr/bin/env bash
# Installs the Shop APK (debug/test build) on a running emulator, launches it, and checks — from the real screen — that:
#   1. the app starts and shows its first-start screen ("Open my shop");
#   2. a link that is not a MyDukaPOS link is refused by the app's NATIVE check (the error text comes from LauncherBridge.java).
set -euo pipefail
dir="$1"; out=emulator-out; mkdir -p "$out"
apk=$(ls "$dir"/MyDukaPOS-*-debug-TEST-ONLY.apk | grep -v -E 'Hotel|HMIS|Production|Pharmacy|Services|AquaPOS' | head -1)
echo "installing $apk"
adb install -r "$apk"
adb shell pm list packages | grep com.mydukapos.shop
adb shell am start -W -n com.mydukapos.shop/com.mydukapos.app.MainActivity
dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true; adb pull /sdcard/ui.xml "$out/$1.xml" >/dev/null 2>&1 || true; adb exec-out screencap -p > "$out/$1.png" || true; }
found=0
for i in $(seq 1 30); do dump start; if grep -q "Open my shop" "$out/start.xml" 2>/dev/null; then found=1; break; fi; sleep 3; done
[ $found = 1 ] || { echo "FAIL: the first-start screen did not appear"; exit 1; }
echo "OK: app launched, first-start screen shown"
# type a foreign link and press the button (the field has focus)
adb shell input text "example.com"
adb shell input keyevent 66
refused=0
for i in $(seq 1 20); do dump refused; if grep -q "not a MyDukaPOS link" "$out/refused.xml" 2>/dev/null; then refused=1; break; fi; sleep 2; done
[ $refused = 1 ] || { echo "FAIL: the native link check did not answer"; exit 1; }
echo "OK: a non-MyDukaPOS link is refused by the native check"
adb shell dumpsys package com.mydukapos.shop | grep -E "versionName|versionCode" | head -2
