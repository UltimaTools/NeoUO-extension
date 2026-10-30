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
VERSION := $(shell sed -n 's/.*"version": "\(.*\)",/\1/p' package.json)
VSIX_FILE := $(EXTENSION_NAME)-$(VERSION).vsix

# Default target
all: npm-install package

# Install dependencies
npm-install:
	@echo "Installing dependencies..."
	npm install ws protobufjs vscode

npm-eslint:
	@echo "Installing eslint for dev only"
	npm install eslint --silent --dev

lint: npm-eslint
	npx eslint .

# Package the extension into a .vsix file
package: npm-install  lint  
	@echo "Packaging the extension into a .vsix file..."
	vsce package 

# Clean the project
clean:
	@echo "Cleaning the project..."
	rm -rf node_modules
	rm -f $(VSIX_FILE)

# Install the extension in VS Code/VSCodium
install: package
	@echo "Installing the extension..."
	$(Code) --install-extension $(VSIX_FILE)

# Uninstall the extension
uninstall:
	@echo "Uninstalling the extension..."
	$(Code) --uninstall-extension $(PUBLISHER).$(EXTENSION_NAME)

# Open the project in VSCodium
open:
	@echo "Opening the project in VSCodium

protobuf:
	protoc -I ./proto --python_out=./test/ ProtoControl.proto

test: protobuf 
	python3 test/test.py

get-version:
	@node -p "require('./package.json').version"

increment-version:
	@current_version=$$(node -p "require('./package.json').version"); \
	IFS='.' read -ra version_parts <<< "$$current_version"; \
	new_patch=$$((version_parts[2] + 1)); \
	new_version="$${version_parts[0]}.$${version_parts[1]}.$$new_patch"; \
	sed -i 's/"version": "'$$current_version'"/"version": "'$$new_version'"/' package.json; \
	echo "$$new_version" > .version

tag-version:
	@new_version=$$(cat .version); \
	#git add package.json; \
	#git commit -m "Bump version to $$new_version"; \
	#git tag v$$new_version; \
	#git push && git push --tags

