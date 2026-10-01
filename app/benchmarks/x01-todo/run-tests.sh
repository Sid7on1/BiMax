#!/bin/bash
# Compile TodoCore with the tests and run them. Exit status is the tests' result.
set -euo pipefail
cd "$(dirname "$0")"
# Command Line Tools work without accepting the Xcode license; use them when present.
if [ -d /Library/Developer/CommandLineTools ]; then export DEVELOPER_DIR=/Library/Developer/CommandLineTools; fi
mkdir -p build
swiftc -O -parse-as-library Sources/TodoCore.swift Tests/TodoCoreTests.swift -o build/todo-tests
./build/todo-tests
