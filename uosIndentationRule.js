const vscode = require('vscode');

class UOSIndentationRule {
    constructor() {
        this.decreaseIndentPattern = /^\s*(endwhile|endfor|endif|else)\b/;
        this.increaseIndentPattern = /^\s*(if|while|for)\b/;
        this.updateIndentationSettings();
        
        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(this.updateIndentationSettings.bind(this));
    }

    updateIndentationSettings() {
        const config = vscode.workspace.getConfiguration('editor');
        this.tabSize = config.get('tabSize', 4);
        this.insertSpaces = config.get('insertSpaces', true);
        this.indentString = this.insertSpaces ? ' '.repeat(this.tabSize) : '\t';

        // Update onEnterRules with new indentation
        this.onEnterRules = this.createOnEnterRules();
    }

    createOnEnterRules() {
        return [
            {
                beforeText: /^\s*(if|while|for).*$/,
                action: { indentAction: vscode.IndentAction.Indent }
            },
            {
                beforeText: /^\s*(endwhile|endfor|endif).*$/,
                action: { indentAction: vscode.IndentAction.Outdent }
            },
            {
                // This rule handles the 'else' keyword
                beforeText: /^\s+else\s*$/,
                action: {
                    indentAction: vscode.IndentAction.Outdent,
                    removeText: new RegExp(`^${this.indentString}`)
                }
            }
        ];
    }

    getIndentationForLine(document, lineNumber, previousIndentation) {
        if (document.languageId !== 'uos') {
            return null; // Only apply this rule to UOS files
        }

        const line = document.lineAt(lineNumber);
        const text = line.text.trim();

        if (this.decreaseIndentPattern.test(text)) {
            return Math.max(0, previousIndentation - 1);
        }

        if (this.increaseIndentPattern.test(text)) {
            return previousIndentation;
        }

        // Check if we're inside a block (if, else, while, for)
        if (lineNumber > 0) {
            const previousLine = document.lineAt(lineNumber - 1).text.trim();
            if (this.increaseIndentPattern.test(previousLine) || previousLine === 'else') {
                return previousIndentation + 1;
            }
        }

        return null; // Use default indentation
    }
}

module.exports = UOSIndentationRule;

