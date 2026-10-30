const vscode = require('vscode');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const { NeoUODapAdapter } = require('./debug');
//const UOSIndentationRule = require('./uosIndentationRule');

const PROTO_PATH = __dirname + '/ProtoControl.proto';
let ProtoControl; // stores the loaded .proto definitions
let isRecording = false;
let isPlaying = false;

// Enum values from ProtoMessageType in your .proto file
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

let outputChannel;

function getOutputChannel() {
    if (!outputChannel) {
        // Create the output channel only once
        outputChannel = vscode.window.createOutputChannel("NeoUO Results");
    }
    return outputChannel;
}

function connectWebSocket(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);

        ws.onopen = () => {
            console.log("WebSocket connected");
            resolve(ws);
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            reject(error);
        };

        ws.onclose = () => {
            console.log("WebSocket closed");
        };
    });
}

async function disconnectWebSocket(ws) {
    return new Promise((resolve, _) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
            ws.onclose = () => {
                console.log("WebSocket disconnected");
                resolve();
            };
        } else {
            resolve(); // Already closed
        }
    });
}

// Simple hash function to generate a 32-bit integer from a string
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

function getSessionId(document) {
    // Use the full path of the file as the unique identifier
    return simpleHash(document.uri.fsPath);
}

function serializeMessage(messageType, messageObject) {
    if (!ProtoControl) {
        throw new Error("ProtoControl is not loaded");
    }
    
    const MessageType = ProtoControl.lookupType(messageType);
    const message = MessageType.create(messageObject);
    return MessageType.encode(message).finish();
}

function activate(context) {
    console.log("Beginning activation");
    
    // Load the ProtoControl.proto file
    protobuf.load(PROTO_PATH, (err, root) => {
        if (err) {
            console.error("Error loading proto file:", err);
            return;
        }
        ProtoControl = root.lookup('protocontrol'); // Load the root of your proto package
        console.log("ProtoControl definitions loaded");
    });

    // Register UOS indentation rule
    //console.log("Registering uos indention");
    //const uosIndentationRule = new UOSIndentationRule();
    //vscode.languages.setLanguageConfiguration('uos', {
    //    onEnterRules: uosIndentationRule.onEnterRules
    //});

    context.subscriptions.push(
        vscode.commands.registerCommand('neoUO.play', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor!');
                return;
            }
            if (!ProtoControl) {
                console.error("ProtoControl is not loaded");
                return;
            }

            const document = editor.document;
            const text = document.getText();
            const language = document.languageId === 'python' ? 1 :
                 document.languageId === 'csharp' ? 2 :
                 document.languageId === 'uos' ? 3 : 0; // Default to 0 if none match
            const sessionid = getSessionId(document);        

            // Start Recording
            isPlaying = true;
            vscode.commands.executeCommand('setContext', 'neoUO.isPlaying', isPlaying);

            const playRequest = {
                type: ProtoMessageType.PlayRequestType,
                sessionid: sessionid, 
                language: language,
                commands: text.split('\n')
            };
            
            // Retrieve the port number from the settings
            const config = vscode.workspace.getConfiguration('neoUO');
            const port = config.get('serverPort', 15454); // Default to 15454 if not set        
            const wsUrl = `ws://localhost:${port}/proto`; // Dynamically constructed server address
            
            // Create an OutputChannel instance
            
            const outputChannel = getOutputChannel();
            outputChannel.show();
            try {
                const ws = await connectWebSocket(wsUrl);
                const requestBuffer = serializeMessage("protocontrol.PlayRequest", playRequest);
                ws.send(requestBuffer);

                ws.onmessage = (event) => {
                    const responseBuffer = new Uint8Array(event.data);
                    const PlayResponse = ProtoControl.lookupType('protocontrol.PlayResponse');
                    const playResponse = PlayResponse.decode(responseBuffer);

                    if (playResponse.type === ProtoMessageType.PlayResponseType) {
                        if (playResponse.more) {
                            outputChannel.appendLine(playResponse.result);
                        } else {
                            isPlaying = false;
                            vscode.commands.executeCommand('setContext', 'neoUO.isPlaying', isPlaying);
                            // Disconnect WebSocket when done
                            disconnectWebSocket(ws);
                        }
                    }
                };
                
                // Disconnect WebSocket when done
                ws.onclose = () => {
                    console.log("WebSocket connection closed");
                };

            } catch (error) {
                console.error("Error in play command:", error);
            }
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('neoUO.stopPlaying', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor!');
                return;
            }
            if (!ProtoControl) {
                console.error("ProtoControl is not loaded");
                return;
            }
            // Stop Playing
            isPlaying = false;
            vscode.commands.executeCommand('setContext', 'neoUO.isPlaying', isPlaying);
            
            const document = editor.document;
            const sessionid = getSessionId(document);        

            const stopPlayRequest = {
                type: ProtoMessageType.StopPlayRequestType,
                sessionid: sessionid
            };
            try {       
                // Retrieve the port number from the settings
                const config = vscode.workspace.getConfiguration('neoUO');
                const port = config.get('serverPort', 15454); // Default to 15454 if not set    
                const wsUrl = `ws://localhost:${port}/proto`; // Dynamically constructed server address 
                
                const ws = await connectWebSocket(wsUrl);

                // Serialize and send RecordRequest
                const requestBuffer = serializeMessage("protocontrol.StopPlayRequest", stopPlayRequest);
                ws.send(requestBuffer);
                
                ws.onmessage = (event) => {
                    const responseBuffer = new Uint8Array(event.data);
                    const RecordResponse = ProtoControl.lookupType('protocontrol.StopPlayResponse');
                    const response = RecordResponse.decode(responseBuffer);

                    if (response.type === ProtoMessageType.StopPlayResponseType) {
                        const outputChannel = getOutputChannel();
                        outputChannel.show();
                        outputChannel.appendLine('Play stopped successfully');
                        isPlaying = false;
                        vscode.commands.executeCommand('setContext', 'neoUO.isPlaying', isPlaying);
                        disconnectWebSocket(ws);                        
                    }
                };
            } catch (error) {
                console.error("Error in stopPlay command:", error);
            }
        })      
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('neoUO.record', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor!');
                return;
            }
            if (!ProtoControl) {
                console.error("ProtoControl is not loaded");
                return;
            }

            const document = editor.document;
            const language = document.languageId === 'python' ? 1 :
                 document.languageId === 'uos' ? 3 : 0; // Default to 0 if none match
            
            const sessionid = getSessionId(document);        
            
            // Start Recording
            isRecording = true;
            vscode.commands.executeCommand('setContext', 'neoUO.isRecording', isRecording);

            const recordRequest = {
                type: ProtoMessageType.RecordRequestType,  // Use the numeric value for RecordRequestType
                sessionid: sessionid,
                language: language
            };

            try {
                const outputChannel = getOutputChannel();
                outputChannel.show();

                // Retrieve the port number from the settings
                const config = vscode.workspace.getConfiguration('neoUO');
                const port = config.get('serverPort', 15454); // Default to 15454 if not set    
                const wsUrl = `ws://localhost:${port}/proto`; // Dynamically constructed server address 

                const ws = await connectWebSocket(wsUrl);

                // Serialize and send RecordRequest
                const requestBuffer = serializeMessage('protocontrol.RecordRequest', recordRequest);
                ws.send(requestBuffer);

                ws.onmessage = (event) => {
                    const responseBuffer = new Uint8Array(event.data);
                    const RecordResponse = ProtoControl.lookupType('protocontrol.RecordResponse');
                    const recordResponse = RecordResponse.decode(responseBuffer);

                    // Create an OutputChannel instance
                    outputChannel.appendLine(`Type: ${recordResponse.type} More: ${recordResponse.more} Data: ${recordResponse.data}`);
                    if (recordResponse.type === ProtoMessageType.RecordResponseType) {
                        if (recordResponse.more) {
                            editor.edit(editBuilder => {
                                editBuilder.insert(new vscode.Position(editor.document.lineCount, 0), recordResponse.data + '\n');
                            });
                        } else {
                            isRecording = false;
                            vscode.commands.executeCommand('setContext', 'neoUO.isRecording', isRecording);
                            disconnectWebSocket(ws);
                        }
                    }
                };

                // Disconnect WebSocket when done
                ws.onclose = () => {
                    console.log("WebSocket connection closed");
                };
                
            } catch (error) {
                console.error("Error in record command:", error);
            }
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('neoUO.stopRecording', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor!');
                return;
            }
            if (!ProtoControl) {
                console.error("ProtoControl is not loaded");
                return;
            }
            // Stop Recording
            isRecording = false;
            vscode.commands.executeCommand('setContext', 'neoUO.isRecording', isRecording);
            
            const document = editor.document;
            const sessionid = getSessionId(document);        

            const stopRecordRequest = {
                type: ProtoMessageType.StopRecordRequestType,
                sessionid: sessionid
            };
            try {       
                // Retrieve the port number from the settings
                const config = vscode.workspace.getConfiguration('neoUO');
                const port = config.get('serverPort', 15454); // Default to 15454 if not set    
                const wsUrl = `ws://localhost:${port}/proto`; // Dynamically constructed server address 
                
                const ws = await connectWebSocket(wsUrl);

                // Serialize and send RecordRequest
                const requestBuffer = serializeMessage("protocontrol.StopRecordRequest", stopRecordRequest);
                ws.send(requestBuffer);
                
                ws.onmessage = (event) => {
                    const responseBuffer = new Uint8Array(event.data);
                    const RecordResponse = ProtoControl.lookupType('protocontrol.StopRecordResponse');
                    const response = RecordResponse.decode(responseBuffer);

                    if (response.type === ProtoMessageType.StopRecordResponseType) {
                        const outputChannel = getOutputChannel();
                        outputChannel.show();
                        outputChannel.appendLine('Recording stopped successfully');
                        isRecording = false;
                        vscode.commands.executeCommand('setContext', 'neoUO.isRecording', isRecording);
                        disconnectWebSocket(ws);                        
                    }
                };
            } catch (error) {
                console.error("Error in stopRecord command:", error);
            }
        })      
    );

    let disposable = vscode.languages.registerDocumentFormattingEditProvider('uos', {
        provideDocumentFormattingEdits(document) {
            const edits = [];
            const text = document.getText();
            const formattedText = formatText(text);
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(text.length)
            );
            edits.push(vscode.TextEdit.replace(fullRange, formattedText));
            return edits;
        }
    });

    context.subscriptions.push(disposable);

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
                    config.port = vscode.workspace.getConfiguration('neoUO').get('serverPort', 15454);
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
    const indentSize = 4; // Number of spaces for each indent level

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
}

module.exports = {
    activate,
    deactivate
};
