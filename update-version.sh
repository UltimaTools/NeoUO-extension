#!/bin/bash

# Get the short Git hash
HASH=$(git rev-parse --short HEAD)

# Extract the current version from package.json
VERSION=$(awk -F': ' '/"version":/ {gsub(/"|,/, "", $2); print $2}' package.json)

# Update the version field in package.json
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}-${HASH}\"/" package.json
