#!/usr/bin/env bash
# Freeze the real upstream driver with Python + PyObjC; installed Bimax needs no Python installation.
set -euo pipefail
cd "$(dirname "$0")/../.."
ARCH="${1:-arm64}"
# Use the installed standalone SDK when Xcode is awaiting its interactive license.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"
case "$ARCH" in arm64) NATIVE=arm64 ;; x64) NATIVE=x86_64 ;; *) exit 1 ;; esac
[ "$(uname -m)" = "$NATIVE" ] || { echo 'Build Bimax CU on the target architecture; cross-freezing Python is unsupported.' >&2; exit 1; }
ENV_DIR="${BIMAX_ARC_BUILD_ENV:-/private/tmp/bimax-arc-build-env}"
[ -x "$ENV_DIR/bin/python" ] || python3 -m venv "$ENV_DIR"
node app/scripts/computer-source.mjs app/native/computer/vendor/arc-cua app/native/computer/vendor/arc-cua.BIMAX_IMPORT.json
"$ENV_DIR/bin/pip" install -r app/native/computer/requirements.lock.txt './app/native/computer/vendor/arc-cua[macos,browser]'
"$ENV_DIR/bin/python" - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path('app/native/computer/vendor/arc-cua')
for f in json.loads(pathlib.Path('app/native/computer/vendor/arc-cua.BIMAX_IMPORT.json').read_text())['files']:
    assert hashlib.sha256((root / f['path']).read_bytes()).hexdigest() == f['sha256'], f['path']
PY
BUILD_DIR=$(mktemp -d /private/tmp/bimax-arc-freeze.XXXXXX)
trap 'rm -rf "$BUILD_DIR"' EXIT
"$ENV_DIR/bin/python" -m PyInstaller --noconfirm --onedir --name bimax-cu \
  --distpath "$BUILD_DIR/dist" --workpath "$BUILD_DIR/work" --specpath "$BUILD_DIR" \
  --collect-submodules arc_cua --collect-data arc_cua --copy-metadata arc-cua \
  --hidden-import AppKit --hidden-import ApplicationServices --hidden-import Quartz --hidden-import Vision \
  app/native/computer/entry.py
"$BUILD_DIR/dist/bimax-cu/bimax-cu" --identity
"$BUILD_DIR/dist/bimax-cu/bimax-cu" --operations > "$BUILD_DIR/dist/operations.json"
cp app/native/computer/vendor/arc-cua/LICENSE "$BUILD_DIR/dist/LICENSE.arc-cua"
cp app/native/computer/vendor/arc-cua.BIMAX_IMPORT.json "$BUILD_DIR/dist/provenance.json"
cp -R app/native/computer/vendor/arc-cua "$BUILD_DIR/dist/upstream-source"
# Source/tests/docs are data; only Bimax's private entry is launched. All package modules are frozen.
node app/scripts/computer-source.mjs "$BUILD_DIR/dist/upstream-source" "$BUILD_DIR/dist/provenance.json"
"$BUILD_DIR/dist/bimax-cu/bimax-cu" --components > "$BUILD_DIR/dist/components.json"
node --input-type=module - "$BUILD_DIR/dist" <<'JS'
import { readFileSync } from 'node:fs';
import { verifyArcSource } from './app/scripts/computer-source.mjs';
const dir = process.argv[2];
const source = verifyArcSource(`${dir}/upstream-source`, JSON.parse(readFileSync(`${dir}/provenance.json`, 'utf8')));
const compiled = JSON.parse(readFileSync(`${dir}/components.json`, 'utf8'));
if (JSON.stringify(compiled.modules) !== JSON.stringify(source.modules)) throw new Error('Frozen Arc module inventory is incomplete');
JS
cp app/native/computer/requirements.lock.txt "$BUILD_DIR/dist/requirements.lock.txt"
"$ENV_DIR/bin/python" - "$BUILD_DIR/dist" <<'PYCODE'
import importlib.metadata, json, pathlib, shutil, sys
out = pathlib.Path(sys.argv[1]) / 'licenses'; out.mkdir()
index = []
for dist in importlib.metadata.distributions():
    name = dist.metadata['Name']; target = out / name; target.mkdir(exist_ok=True)
    (target / 'METADATA').write_text(dist.read_text('METADATA') or json.dumps(dict(dist.metadata.items())))
    copied = []
    for file in dist.files or []:
        if any(token in file.name.lower() for token in ['license', 'copying', 'notice']):
            source = dist.locate_file(file)
            if source.is_file():
                dest = target / file.name
                shutil.copyfile(source, dest); copied.append(file.name)
    index.append({'name': name, 'version': dist.version, 'licenseFiles': copied})
(out / 'index.json').write_text(json.dumps(index, indent=2))
PYCODE
# Existing staging stays intact until the new executable has run.
if [ -d app/cu-runtime ]; then mv app/cu-runtime "$BUILD_DIR/previous"; fi
mv "$BUILD_DIR/dist" app/cu-runtime
