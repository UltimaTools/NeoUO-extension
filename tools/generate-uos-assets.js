#!/usr/bin/env node
/**
 * Generates the UOS language assets from the NeoUO UOS engine command catalog.
 *
 * Usage:
 *   node tools/generate-uos-assets.js [--source <path to UOSteamEngine.cs>]
 *
 * The engine source is parsed when available; otherwise the checked-in catalog
 * (tools/uos-commands.json) is used, so the assets can be regenerated anywhere.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(__dirname, 'uos-commands.json');
const TEMPLATES_PATH = path.join(__dirname, 'uos-templates.json');
const DEFAULT_ENGINE = path.resolve(__dirname, '..', '..', 'NeoUO', 'NeoUO', 'Scripting', 'UOSteamEngine.cs');

const ENTITY_CONSTANTS = ['any', 'backpack', 'bank', 'enemy', 'friend', 'ground', 'last',
    'lasttarget', 'lastobject', 'lefthand', 'mount', 'righthand', 'self'];

const KEYWORDS = ['if', 'elseif', 'else', 'endif', 'while', 'endwhile', 'for', 'to', 'in',
    'endfor', 'return', 'pause', 'break', 'continue', 'stop', 'replay', 'not', 'and', 'or'];

const SKIP_NAMES = new Set(['true', 'false', 'undefined']);

function readArgs(argv) {
    const args = { source: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--source' && argv[i + 1]) {
            args.source = argv[++i];
        }
    }
    return args;
}

function decodeXml(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function cleanDocText(text) {
    return decodeXml(text.replace(/<[^>]+>/g, ' '))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractSummary(docLines) {
    const joined = docLines.join('\n');
    const match = joined.match(/<summary>([\s\S]*?)<\/summary>/);
    return cleanDocText(match ? match[1] : joined);
}

function parseMethodDocs(lines) {
    const docs = new Map();
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*\/\//.test(lines[i])) continue;
        const docLines = [];
        while (i < lines.length && /^\s*\/\//.test(lines[i])) {
            docLines.push(lines[i].replace(/^\s*\/\/\/?\s?/, ''));
            i++;
        }
        while (i < lines.length && (/^\s*\[/.test(lines[i]) || /^\s*$/.test(lines[i]))) i++;
        if (i >= lines.length) break;
        let declaration = '';
        for (let k = i; k < Math.min(i + 4, lines.length); k++) {
            declaration += ' ' + lines[k];
            if (/\(/.test(lines[k])) break;
        }
        const method = declaration.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (!method) continue;
        const name = method[1];
        if (!docs.has(name)) {
            const summary = extractSummary(docLines);
            if (summary) docs.set(name, summary);
        }
        i -= 1;
    }
    return docs;
}

function parseEngine(source) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const docs = parseMethodDocs(lines);

    const entries = new Map();
    const add = (kind, name, method) => {
        if (SKIP_NAMES.has(name.toLowerCase())) return;
        const existing = entries.get(name);
        if (existing && existing.kind === 'command') return;
        entries.set(name, {
            name,
            kind,
            usage: method && docs.has(method) ? docs.get(method) : ''
        });
    };

    const methodGroup = /Register(Command|Expression)Handler\(\s*"([^"]+)"\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
    let match;
    while ((match = methodGroup.exec(source)) !== null) {
        add(match[1] === 'Command' ? 'command' : 'expression', match[2], match[3]);
    }
    const lambda = /Register(Command|Expression)Handler\(\s*"([^"]+)"\s*,\s*\([^)]*\)\s*=>/g;
    while ((match = lambda.exec(source)) !== null) {
        add(match[1] === 'Command' ? 'command' : 'expression', match[2], null);
    }

    return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeUsage(name, usage) {
    let text = (usage || '').trim()
        .replace(/\s*-?\s*NOT IMPLEMENT(?:ED)?\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp('^if\\s+' + escaped + '\\b', 'i'), name);
    return text;
}

function buildUsageBody(name, rawUsage) {
    const usage = sanitizeUsage(name, rawUsage);
    if (!usage) return `${name} $0`;
    const lowerUsage = usage.toLowerCase();
    const lowerName = name.toLowerCase();
    const startsWithName = lowerUsage === lowerName
        || lowerUsage.startsWith(lowerName + ' ')
        || lowerUsage.startsWith(lowerName + '(');
    const hasGroups = /[\(\[]/.test(usage);
    const rest = startsWithName ? usage.slice(name.length).trim() : '';
    const firstToken = rest.split(/\s+/)[0] || '';
    const looksLikeProse = startsWithName && !hasGroups && /^[a-z]/.test(firstToken);

    if ((!startsWithName && !hasGroups) || looksLikeProse) return `${name} $0`;

    let text = startsWithName ? usage : `${name} ${usage}`;
    let index = 0;
    let position = 0;

    const parseSequence = (stopChars) => {
        let buffer = '';
        while (position < text.length) {
            const char = text[position];
            if (stopChars.includes(char)) break;
            if (char === '(' || char === '[') {
                const close = char === '(' ? ')' : ']';
                position++;
                const inner = parseSequence(close);
                if (text[position] === close) position++;
                const placeholder = inner.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ');
                if (placeholder) {
                    if (buffer && !/\s$/.test(buffer)) buffer += ' ';
                    if (placeholder.includes('$')) {
                        buffer += placeholder;
                    } else {
                        index++;
                        buffer += '${' + index + ':' + placeholder + '}';
                    }
                }
                continue;
            }
            buffer += char;
            position++;
        }
        return buffer;
    };

    let body = parseSequence('').replace(/\s+/g, ' ').trim();
    if (!body) body = name;
    if (!body.includes('$0')) body += ' $0';
    return body;
}

function loadCatalog(args) {
    const sourcePath = args.source || DEFAULT_ENGINE;
    if (fs.existsSync(sourcePath)) {
        const entries = parseEngine(fs.readFileSync(sourcePath, 'utf8'));
        if (!entries.length) throw new Error('No UOS handlers found in ' + sourcePath);
        fs.writeFileSync(CATALOG_PATH, JSON.stringify({
            source: path.basename(sourcePath),
            entries
        }, null, 4) + '\n');
        console.log(`catalog: ${entries.length} entries from ${sourcePath}`);
        return entries;
    }
    if (!fs.existsSync(CATALOG_PATH)) {
        throw new Error(`Engine source not found (${sourcePath}) and no catalog at ${CATALOG_PATH}`);
    }
    const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    console.log(`catalog: ${catalog.entries.length} entries from ${CATALOG_PATH}`);
    return catalog.entries;
}

function loadTemplates() {
    return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
}

function generateSnippets(entries, templates) {
    const snippets = {};
    for (const entry of entries) {
        if (entry.kind === 'expression') {
            const takesArguments = /[\(\[]/.test(entry.usage || '');
            if (!takesArguments || entry.name.length < 2) continue;
        }
        snippets[entry.name] = {
            prefix: entry.name,
            body: [buildUsageBody(entry.name, entry.usage)],
            description: sanitizeUsage(entry.name, entry.usage) || entry.name
        };
    }
    for (const [name, template] of Object.entries(templates)) {
        snippets[name] = {
            prefix: name,
            body: template.body,
            description: template.description || name
        };
    }
    const sorted = {};
    for (const name of Object.keys(snippets).sort()) sorted[name] = snippets[name];
    fs.writeFileSync(path.join(ROOT, 'snippets', 'uos.json'), JSON.stringify(sorted, null, 4) + '\n');
    return Object.keys(sorted).length;
}

function generateGrammar(entries) {
    const keywords = new Set(KEYWORDS);
    const functions = entries
        .map((entry) => entry.name)
        .filter((name) => !keywords.has(name.toLowerCase()) && !ENTITY_CONSTANTS.includes(name))
        .sort();

    const functionPattern = '\\b(' + functions.join('|') + ')[!]?\\b';
    const grammar = {
        $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
        name: 'UOSteam',
        patterns: [
            { include: '#keywords' }
        ],
        repository: {
            keywords: {
                patterns: [
                    { name: 'keyword.control.uos', match: '\\b(if|elseif|else|endif|while|endwhile|for|to|in|endfor|return)\\b' },
                    { name: 'keyword.control.uos', match: '\\b(pause|break|continue|stop|replay|not|and|or)\\b' },
                    { name: 'keyword.operator.comparison.uos', match: '\\b(==|!=|>=|<=|<|>|\\[|\\])\\b' },
                    { name: 'keyword.operator.at.uos', match: '@' },
                    { name: 'support.function.uos', match: functionPattern },
                    { name: 'support.constant.uos', match: '\\b(' + ENTITY_CONSTANTS.join('|') + ')\\b' },
                    { name: 'comment.line.uos', match: '//.*' },
                    { name: 'constant.language.uos', match: '\\b(?i:(true|false))\\b' },
                    { name: 'constant.numeric.hexadecimal.uos', match: '\\b0(x|X)[0-9a-fA-F]+\\b' },
                    { name: 'constant.numeric.uos', match: '\\b[0-9]{1,16}\\b' },
                    {
                        name: 'string.quoted.single.uos',
                        begin: "'",
                        end: "'",
                        patterns: [
                            { name: 'support.constant.uos', match: '\\b(' + ENTITY_CONSTANTS.join('|') + ')\\b' }
                        ]
                    },
                    { name: 'string.quoted.double.uos', begin: '"', end: '"' }
                ]
            }
        },
        scopeName: 'source.uos'
    };
    fs.writeFileSync(path.join(ROOT, 'syntaxes', 'uos.tmLanguage.json'), JSON.stringify(grammar, null, 4) + '\n');
    return functions.length;
}

function generateLanguageConfiguration() {
    const configuration = {
        comments: {
            lineComment: '//',
            blockComment: ['/*', '*/']
        },
        brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')']
        ],
        autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: "'", close: "'" }
        ],
        surroundingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' },
            { open: "'", close: "'" }
        ],
        indentationRules: {
            increaseIndentPattern: '^\\s*(while|for|if|else)\\b',
            decreaseIndentPattern: '^\\s*(endwhile|endfor|else|endif)\\b'
        },
        onEnterRules: [
            {
                beforeText: '^\\s*if.*$',
                afterText: '^.*$',
                action: { indent: 'indent' }
            },
            {
                beforeText: '^\\s*else.*$',
                afterText: '^.*$',
                action: { indent: 'indentOutdent' }
            },
            {
                beforeText: '^\\s*endif.*$',
                afterText: '^.*$',
                action: { indent: 'outdent' }
            }
        ]
    };
    fs.writeFileSync(path.join(ROOT, 'language-configuration.json'), JSON.stringify(configuration, null, 4) + '\n');
}

function main() {
    const args = readArgs(process.argv.slice(2));
    const entries = loadCatalog(args);
    const templates = loadTemplates();
    const snippetCount = generateSnippets(entries, templates);
    const functionCount = generateGrammar(entries);
    generateLanguageConfiguration();
    console.log(`snippets: ${snippetCount}`);
    console.log(`grammar functions: ${functionCount}`);
    console.log('language configuration written');
}

main();
