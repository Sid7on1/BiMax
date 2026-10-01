#!/bin/bash
# Build build/BimaxTodo.app from Sources/. The app reads its to-dos from data/todos.json in this folder.
set -euo pipefail
cd "$(dirname "$0")"
# Command Line Tools work without accepting the Xcode license; use them when present.
if [ -d /Library/Developer/CommandLineTools ]; then export DEVELOPER_DIR=/Library/Developer/CommandLineTools; fi
here="$(pwd)"
app="build/BimaxTodo.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -parse-as-library Sources/TodoCore.swift Sources/App.swift -o "$app/Contents/MacOS/BimaxTodo"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>ai.bimax.cu.x01-todo</string>
  <key>CFBundleName</key><string>BimaxTodo</string>
  <key>CFBundleExecutable</key><string>BimaxTodo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>BimaxTodoData</key><string>$here/data/todos.json</string>
</dict></plist>
PLIST
codesign --force --sign - "$app" >/dev/null 2>&1
echo "built $app"
shasum -a 256 "$app/Contents/MacOS/BimaxTodo"
