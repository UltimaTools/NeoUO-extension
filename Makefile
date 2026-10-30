# Makefile for NeoUO-extension

# Variables
SHELL := /usr/bin/bash
ifeq ($(OS),Windows_NT)
    Code = /c/Program\ Files/Microsoft\ VS\ Code/Code.exe
else
    Code := /usr/bin/code
endif

PUBLISHER := neouo
EXTENSION_NAME := neouo
VERSION := $(shell node -p "require('./package.json').version")
VSIX_FILE := $(EXTENSION_NAME)-$(VERSION).vsix

# Default target
all: package

# Install dependencies from the lockfile
npm-install:
	@echo "Installing dependencies..."
	npm ci

lint: npm-install
	npx eslint .

# Validate the generated language assets
check-assets:
	@node -e "const fs=require('fs');for (const f of ['package.json','snippets/uos.json','syntaxes/uos.tmLanguage.json','language-configuration.json','tools/uos-commands.json','tools/uos-templates.json']) JSON.parse(fs.readFileSync(f,'utf8'));console.log('language assets valid');"

# Regenerate snippets, grammar and language configuration from the NeoUO catalog
gen-uos:
	node tools/generate-uos-assets.js

# Generate Python protobuf bindings for the protocol test client
protobuf:
	protoc -I . --python_out=./test/ ProtoControl.proto

# Package the extension into a .vsix file
package: lint check-assets
	@echo "Packaging the extension into a .vsix file..."
	npx --no-install vsce package

# Clean the project
clean:
	@echo "Cleaning the project..."
	rm -rf node_modules
	rm -f *.vsix

# Install the extension in VS Code/VSCodium
install: package
	@echo "Installing the extension..."
	$(Code) --install-extension $(VSIX_FILE)

# Uninstall the extension
uninstall:
	$(Code) --uninstall-extension $(PUBLISHER).$(EXTENSION_NAME)

# Open the project in VS Code
open:
	$(Code) .

get-version:
	@node -p "require('./package.json').version"

increment-version:
	@node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));const v=p.version.split('.');v[2]=String(Number(v[2])+1);p.version=v.join('.');fs.writeFileSync('package.json',JSON.stringify(p,null,4)+'\n');console.log(p.version)"

tag-version:
	@echo "Versions are tagged via GitHub releases; see .github/workflows/checkin.yml"
