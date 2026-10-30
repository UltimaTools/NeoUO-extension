const vscode = require('vscode');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const { NeoUODapAdapter } = require('./debug');

const PROTO_PATH = __dirname + '/ProtoControl.proto';

// Enum values from ProtoMessageType in ProtoControl.proto
const ProtoMessageType = {
    PlayResponseType: 1,
    PlayRequestType: 2,
    StopPlayRequestType: 3,
    StopPlayResponseType: 4,
    RecordResponseType: 10,
    RecordRequestType: 11,
    StopRecordRequestType: 12,
    StopRecordResponseType: 13
};

const CONNECT_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 5000;

let protoRoot = null;
let protoRootPromise = null;
let playSession = null;
let recordSession = null;
let outputChannel;

function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('NeoUO Results');
    }
    return outputChannel;
}

function loadProto() {
    if (!protoRootPromise) {
        protoRootPromise = protobuf.load(PROTO_PATH).then((root) => {
            protoRoot = root.lookup('protocontrol');
            return protoRoot;
        });
    }
    return protoRootPromise;
}

function encode(typeName, payload) {
    const Type = protoRoot.lookupType(typeName);
    return Type.encode(Type.create(payload)).finish();
}

function decode(typeName, data) {
    const Type = protoRoot.lookupType(typeName);
    return Type.decode(new Uint8Array(data));
}

function setPlaying(value) {
    return vscode.commands.executeCommand('setContext', 'neoUO.isPlaying', value);
}

function setRecording(value) {
    return vscode.commands.executeCommand('setContext', 'neoUO.isRecording', value);
}

function getPort() {
    return vscode.workspace.getConfiguration('neoUO').get('serverPort', 15454);
}

// Stable 31-bit session id derived from the document path, so a Stop issued
// after a window reload can still address the same server-side session.
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return (hash & 0x7fffffff) || 1;
}

function getSessionId(document) {
    return simpleHash(document.uri.fsPath || document.uri.toString());
}

function connectWebSocket(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { ws.terminate(); } catch { /* ignore */ }
            reject(new Error(`Cannot connect to NeoUO at ${url} (is the client running and ProtoControl enabled?)`));
        }, CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(ws);
        };
        ws.onerror = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`Cannot connect to NeoUO at ${url} (is the client running and ProtoControl enabled?)`));
        };
    });
}

function closeSocket(ws) {
    if (!ws) return;
    try { ws.close(); } catch { /* ignore */ }
}

async function sendOneShotStop(typeName, type, sessionid) {
    let ws;
    try {
        ws = await connectWebSocket(`ws://localhost:${getPort()}/proto`);
    } catch (error) {
        vscode.window.showErrorMessage(error.message);
        return;
    }
    try {
        ws.send(encode(typeName, { type, sessionid }));
    } catch { /* ignore */ }
    setTimeout(() => closeSocket(ws), 1500);
}

function playLanguage(languageId) {
    switch (languageId) {
        case 'python': return 1;
        case 'csharp': return 2;
        case 'uos': return 3;
        default: return 0;
    }
}

function finishPlay(session, message) {
    if (session.finished) return;
    session.finished = true;
    if (playSession === session) playSession = null;
    closeSocket(session.ws);
    setPlaying(false);
    if (message) {
        getOutputChannel().appendLine(message);
        vscode.window.showErrorMessage(`NeoUO: ${message}`);
    }
}

function finishRecord(session, message) {
    if (session.finished) return;
    session.finished = true;
    if (recordSession === session) recordSession = null;
    closeSocket(session.ws);
    setRecording(false);
    getOutputChannel().appendLine('Recording stopped.');
    if (message) {
        getOutputChannel().appendLine(message);
        vscode.window.showErrorMessage(`NeoUO: ${message}`);
    }
}

async function playCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('NeoUO: no active editor.');
        return;
    }
    if (playSession) {
        vscode.window.showWarningMessage('NeoUO: a script is already playing. Stop it first.');
        return;
    }

    const document = editor.document;
    const language = playLanguage(document.languageId);
    if (!language) {
        vscode.window.showErrorMessage(`NeoUO: cannot play '${document.languageId}' files (supported: Python, C#, UOS).`);
        return;
    }

    await loadProto();

    const channel = getOutputChannel();
    channel.show(true);

    let ws;
    try {
        ws = await connectWebSocket(`ws://localhost:${getPort()}/proto`);
    } catch (error) {
        vscode.window.showErrorMessage(error.message);
        return;
    }

    const session = {
        ws,
        sessionid: getSessionId(document),
        documentUri: document.uri.toString(),
        finished: false
    };
    playSession = session;

    ws.onmessage = (event) => {
        let response;
        try {
            response = decode('protocontrol.PlayResponse', event.data);
        } catch {
            return;
        }
        if (response.type === ProtoMessageType.PlayResponseType) {
            if (response.more) {
                channel.appendLine(response.result);
            } else {
                finishPlay(session);
            }
        }
    };
    ws.onclose = () => {
        if (!session.finished) finishPlay(session, 'NeoUO closed the play connection.');
    };

    setPlaying(true);
    channel.appendLine(`Playing ${vscode.workspace.asRelativePath(document.uri)} on port ${getPort()}...`);

    try {
        ws.send(encode('protocontrol.PlayRequest', {
            type: ProtoMessageType.PlayRequestType,
            sessionid: session.sessionid,
            language,
            commands: document.getText().split(/\r?\n/)
        }));
    } catch (error) {
        finishPlay(session, `Failed to start script: ${error.message}`);
    }
}

async function stopPlayCommand() {
    if (!playSession) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await loadProto();
            await sendOneShotStop('protocontrol.StopPlayRequest', ProtoMessageType.StopPlayRequestType, getSessionId(editor.document));
        }
        setPlaying(false);
        return;
    }

    const session = playSession;
    try {
        session.ws.send(encode('protocontrol.StopPlayRequest', {
            type: ProtoMessageType.StopPlayRequestType,
            sessionid: session.sessionid
        }));
    } catch (error) {
        finishPlay(session, `Failed to stop script: ${error.message}`);
        return;
    }
    setTimeout(() => {
        if (playSession === session) finishPlay(session);
    }, STOP_TIMEOUT_MS);
}

function appendRecordedCode(documentUri, code) {
    if (!code) return;
    const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === documentUri);
    if (!document) return;

    const edit = new vscode.WorkspaceEdit();
    const text = document.getText();
    const end = document.lineAt(document.lineCount - 1).range.end;
    const prefix = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    edit.insert(document.uri, end, prefix + code + '\n');
    vscode.workspace.applyEdit(edit).then(undefined, (error) => {
        getOutputChannel().appendLine(`Failed to append recorded code: ${error.message || error}`);
    });
}

async function recordCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('NeoUO: no active editor.');
        return;
    }
    if (recordSession) {
        vscode.window.showWarningMessage('NeoUO: already recording. Stop the current recording first.');
        return;
    }

    const document = editor.document;
    const language = document.languageId === 'python' ? 1 : document.languageId === 'uos' ? 3 : 0;
    if (!language) {
        vscode.window.showErrorMessage(`NeoUO: cannot record '${document.languageId}' files (supported: Python, UOS).`);
        return;
    }

    await loadProto();

    const channel = getOutputChannel();
    channel.show(true);

    let ws;
    try {
        ws = await connectWebSocket(`ws://localhost:${getPort()}/proto`);
    } catch (error) {
        vscode.window.showErrorMessage(error.message);
        return;
    }

    const session = {
        ws,
        sessionid: getSessionId(document),
        documentUri: document.uri.toString(),
        finished: false
    };
    recordSession = session;

    ws.onmessage = (event) => {
        let response;
        try {
            response = decode('protocontrol.RecordResponse', event.data);
        } catch {
            return;
        }
        if (response.type === ProtoMessageType.RecordResponseType) {
            if (response.more) {
                appendRecordedCode(session.documentUri, response.data);
            } else {
                finishRecord(session);
            }
        } else if (response.type === ProtoMessageType.StopRecordResponseType) {
            finishRecord(session);
        }
    };
    ws.onclose = () => {
        if (!session.finished) finishRecord(session, 'NeoUO closed the recording connection.');
    };

    setRecording(true);
    channel.appendLine(`Recording into ${vscode.workspace.asRelativePath(document.uri)} on port ${getPort()}...`);

    try {
        ws.send(encode('protocontrol.RecordRequest', {
            type: ProtoMessageType.RecordRequestType,
            sessionid: session.sessionid,
            language
        }));
    } catch (error) {
        finishRecord(session, `Failed to start recording: ${error.message}`);
    }
}

async function stopRecordCommand() {
    if (!recordSession) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            await loadProto();
            await sendOneShotStop('protocontrol.StopRecordRequest', ProtoMessageType.StopRecordRequestType, getSessionId(editor.document));
        }
        setRecording(false);
        return;
    }

    const session = recordSession;
    try {
        session.ws.send(encode('protocontrol.StopRecordRequest', {
            type: ProtoMessageType.StopRecordRequestType,
            sessionid: session.sessionid
        }));
    } catch (error) {
        finishRecord(session, `Failed to stop recording: ${error.message}`);
        return;
    }
    setTimeout(() => {
        if (recordSession === session) finishRecord(session);
    }, STOP_TIMEOUT_MS);
}

async function runSafely(label, fn) {
    try {
        await fn();
    } catch (error) {
        console.error(`NeoUO ${label} error:`, error);
        vscode.window.showErrorMessage(`NeoUO ${label} error: ${error.message || error}`);
    }
}

function activate(context) {
    loadProto().catch((error) => {
        console.error('NeoUO: failed to load ProtoControl.proto', error);
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('neoUO.play', () => runSafely('play', playCommand)),
        vscode.commands.registerCommand('neoUO.stopPlaying', () => runSafely('stop play', stopPlayCommand)),
        vscode.commands.registerCommand('neoUO.record', () => runSafely('record', recordCommand)),
        vscode.commands.registerCommand('neoUO.stopRecording', () => runSafely('stop record', stopRecordCommand))
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider('uos', {
            provideDocumentFormattingEdits(document) {
                const text = document.getText();
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(text.length)
                );
                return [vscode.TextEdit.replace(fullRange, formatText(text))];
            }
        })
    );

    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('neouo', {
            createDebugAdapterDescriptor(session) {
                return new vscode.DebugAdapterInlineImplementation(new NeoUODapAdapter(session));
            }
        })
    );

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('neouo', {
            resolveDebugConfiguration(folder, config) {
                if (!config.type) config.type = 'neouo';
                if (!config.request) config.request = 'launch';
                if (!config.name) config.name = 'NeoUO: Debug current file';
                if (!config.program && vscode.window.activeTextEditor) {
                    config.program = vscode.window.activeTextEditor.document.uri.fsPath;
                }
                if (config.port === undefined || config.port === null) {
                    config.port = getPort();
                }
                return config;
            }
        })
    );
}

function formatText(text) {
    const increaseIndentPattern = /^\s*(while|for|if|else)\b/;
    const decreaseIndentPattern = /^\s*(endwhile|endfor|else|endif)\b/;
    const lines = text.split('\n');
    let indentLevel = 0;
    const indentSize = 4;

    return lines.map(line => {
        if (decreaseIndentPattern.test(line)) {
            indentLevel = Math.max(indentLevel - 1, 0);
        }

        const trimmedLine = line.trim();
        const indentedLine = ' '.repeat(indentLevel * indentSize) + trimmedLine;

        if (increaseIndentPattern.test(line)) {
            indentLevel++;
        }

        return indentedLine;
    }).join('\n');
}

function deactivate() {
    if (playSession) {
        const session = playSession;
        playSession = null;
        session.finished = true;
        closeSocket(session.ws);
    }
    if (recordSession) {
        const session = recordSession;
        recordSession = null;
        session.finished = true;
        closeSocket(session.ws);
    }
}

module.exports = {
    activate,
    deactivate
};
