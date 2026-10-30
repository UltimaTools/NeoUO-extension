const vscode = require('vscode');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const path = require('path');
const fs = require('fs');

const PROTO_PATH = path.join(__dirname, 'ProtoControl.proto');

const MSG = {
    PlayResponseType: 1,
    PlayRequestType: 2,
    StopPlayRequestType: 3,
    StopPlayResponseType: 4,
    RecordResponseType: 10,
    RecordRequestType: 11,
    StopRecordRequestType: 12,
    StopRecordResponseType: 13,
    DebugStartRequestType: 20,
    DebugEventType: 21,
    SetBreakpointsRequestType: 22,
    SetBreakpointsResponseType: 23,
    DebugContinueRequestType: 24,
    DebugContinueResponseType: 25,
    DebugStepRequestType: 26,
    DebugStepResponseType: 27,
    DebugStackTraceRequestType: 28,
    DebugStackTraceResponseType: 29,
    DebugScopesRequestType: 30,
    DebugScopesResponseType: 31,
    DebugVariablesRequestType: 32,
    DebugVariablesResponseType: 33,
    DebugEvaluateRequestType: 34,
    DebugEvaluateResponseType: 35,
    DebugDisconnectRequestType: 36,
    DebugDisconnectResponseType: 37
};

// Maps the type field (field 1 of every message) to its proto message name.
const TYPE_TO_PROTO = {};
TYPE_TO_PROTO[MSG.PlayResponseType] = 'protocontrol.PlayResponse';
TYPE_TO_PROTO[MSG.StopPlayResponseType] = 'protocontrol.StopPlayResponse';
TYPE_TO_PROTO[MSG.RecordResponseType] = 'protocontrol.RecordResponse';
TYPE_TO_PROTO[MSG.StopRecordResponseType] = 'protocontrol.StopRecordResponse';
TYPE_TO_PROTO[MSG.DebugEventType] = 'protocontrol.DebugEvent';
TYPE_TO_PROTO[MSG.SetBreakpointsResponseType] = 'protocontrol.SetBreakpointsResponse';
TYPE_TO_PROTO[MSG.DebugContinueResponseType] = 'protocontrol.DebugContinueResponse';
TYPE_TO_PROTO[MSG.DebugStepResponseType] = 'protocontrol.DebugStepResponse';
TYPE_TO_PROTO[MSG.DebugStackTraceResponseType] = 'protocontrol.DebugStackTraceResponse';
TYPE_TO_PROTO[MSG.DebugScopesResponseType] = 'protocontrol.DebugScopesResponse';
TYPE_TO_PROTO[MSG.DebugVariablesResponseType] = 'protocontrol.DebugVariablesResponse';
TYPE_TO_PROTO[MSG.DebugEvaluateResponseType] = 'protocontrol.DebugEvaluateResponse';
TYPE_TO_PROTO[MSG.DebugDisconnectResponseType] = 'protocontrol.DebugDisconnectResponse';

const REASON = { DebugStep: 0, DebugBp: 1, DebugException: 2, DebugEntry: 3, DebugOutput: 4, DebugStderr: 5 };
const STEP = { StepInto: 0, StepOver: 1, StepOut: 2 };

const REQUEST_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 5000;
const ENTRY_WATCHDOG_MS = 12000;

let protoRootPromise = null;
function protoRoot() {
    if (!protoRootPromise) {
        protoRootPromise = protobuf.load(PROTO_PATH).then((root) => root.lookup('protocontrol'));
    }
    return protoRootPromise;
}

// Every proto message starts with field 1 (type) as a varint; read it without decoding.
function peekType(buf) {
    if (buf.length < 2 || buf[0] !== 0x08) return 0;
    let value = 0;
    let shift = 1;
    for (let i = 1; i < buf.length; i++) {
        const b = buf[i];
        value += (b & 0x7f) * shift;
        if (!(b & 0x80)) return value;
        shift *= 128;
    }
    return 0;
}

let outputChannel;
function log(msg) {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('NeoUO Debug');
    }
    outputChannel.appendLine(msg);
}

class NeoUODapAdapter {
    constructor(session) {
        this._session = session;
        this._seq = 1;
        this._sendEmitter = new vscode.EventEmitter();
        this.onDidSendMessage = this._sendEmitter.event;
        this._waiters = new Map();
        this._queuedEvents = [];
        this._ready = false;
        this._terminated = false;
        this._firstStop = true;
        this._stoppedOnce = false;
        this._ws = null;
        this._root = null;
        this._disposed = false;
        this._watchdog = null;
        this._sessionid = 0;
        this._programPath = '';
        this._port = 0;
    }

    handleMessage(message) {
        if (this._disposed || !message || message.type !== 'request') return;
        this._dispatch(message);
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        if (this._watchdog) clearTimeout(this._watchdog);
        this._closeSocket();
    }

    // -- DAP plumbing ----------------------------------------------------------

    _send(message) {
        if (this._disposed) return;
        message.seq = this._seq++;
        this._sendEmitter.fire(message);
    }

    _respond(request, body) {
        this._send({ type: 'response', request_seq: request.seq, success: true, command: request.command, body });
    }

    _fail(request, message) {
        this._send({ type: 'response', request_seq: request.seq, success: false, command: request.command, message });
    }

    _emit(name, body) {
        const event = { type: 'event', event: name, body: body || {} };
        if (this._ready || name === 'initialized') {
            this._send(event);
        } else {
            this._queuedEvents.push(event);
        }
    }

    _flush() {
        this._ready = true;
        if (this._queuedEvents.length) {
            this._send({ type: 'event', event: 'thread', body: { reason: 'started', threadId: 1 } });
            for (const event of this._queuedEvents) this._send(event);
            this._queuedEvents = [];
        }
        if (!this._stoppedOnce && !this._terminated) {
            this._watchdog = setTimeout(() => {
                if (!this._stoppedOnce && !this._terminated && !this._disposed) {
                    this._emit('output', {
                        category: 'console',
                        output: '[NeoUO] No debug response received. Is a character logged in and the ProtoControl server enabled?\n'
                    });
                }
            }, ENTRY_WATCHDOG_MS);
        }
    }

    async _dispatch(request) {
        try {
            switch (request.command) {
                case 'initialize': return this._respond(request, this._capabilities());
                case 'launch': return await this._launch(request, request.arguments || {});
                case 'attach': return await this._launch(request, request.arguments || {});
                case 'configurationDone': return this._onConfigurationDone(request);
                case 'setBreakpoints': return await this._onSetBreakpoints(request, request.arguments || {});
                case 'setExceptionBreakpoints': return this._respond(request, { breakpoints: [] });
                case 'threads': return this._respond(request, { threads: [{ id: 1, name: 'Main Thread' }] });
                case 'stackTrace': return await this._onStackTrace(request, request.arguments || {});
                case 'scopes': return await this._onScopes(request, request.arguments || {});
                case 'variables': return await this._onVariables(request, request.arguments || {});
                case 'evaluate': return await this._onEvaluate(request, request.arguments || {});
                case 'continue': return await this._onContinue(request);
                case 'next': return await this._onStep(request, STEP.StepOver);
                case 'stepIn': return await this._onStep(request, STEP.StepInto);
                case 'stepOut': return await this._onStep(request, STEP.StepOut);
                case 'pause': return this._fail(request, 'Pause is not supported by the NeoUO debugger');
                case 'disconnect': return await this._shutdown(request);
                case 'terminate': return await this._shutdown(request);
                case 'cancel': return this._respond(request);
                default: return this._fail(request, `Unhandled request: ${request.command}`);
            }
        } catch (error) {
            log(`request '${request.command}' failed: ${error.message || error}`);
            this._fail(request, error.message || String(error));
        }
    }

    _capabilities() {
        return {
            supportsConfigurationDoneRequest: true,
            supportsTerminateRequest: true,
            supportsEvaluateForHovers: true,
            supportsConditionalBreakpoints: false,
            supportsHitConditionalBreakpoints: false,
            supportsLogPoints: false,
            supportsFunctionBreakpoints: false,
            supportsDataBreakpoints: false,
            supportsSetVariable: false,
            supportsRestartRequest: false,
            supportsStepBack: false,
            supportsDelayedStackTraceLoading: false,
            supportsBreakpointLocationsRequest: false,
            exceptionBreakpointFilters: []
        };
    }

    // -- Session lifecycle -----------------------------------------------------

    async _launch(request, args) {
        if (!args.program) {
            throw new Error('Missing "program" in launch configuration');
        }
        this._programPath = path.isAbsolute(args.program)
            ? args.program
            : path.join(this._session.workspaceFolder ? this._session.workspaceFolder.uri.fsPath : process.cwd(), args.program);

        const config = vscode.workspace.getConfiguration('neoUO');
        this._port = args.port || config.get('serverPort', 15454);
        this._sessionid = Math.floor(Math.random() * 1000000000) + 1;

        const source = this._readSource(this._programPath);
        this._root = await protoRoot();
        await this._connect();

        this._sendProto('protocontrol.DebugStartRequest', {
            type: MSG.DebugStartRequestType,
            sessionid: this._sessionid,
            language: 1, // Python
            commands: source.split(/\r?\n/),
            filepath: this._programPath
        });
        log(`debug session ${this._sessionid} started for ${this._programPath} (port ${this._port})`);

        this._emit('initialized', {});
        this._respond(request);
    }

    _readSource(filePath) {
        const open = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.fsPath && doc.uri.fsPath.toLowerCase() === filePath.toLowerCase()
        );
        if (open) return open.getText();
        return fs.readFileSync(filePath, 'utf8');
    }

    _onConfigurationDone(request) {
        this._respond(request);
        this._flush();
    }

    async _shutdown(request) {
        this._ready = true;
        if (this._ws) {
            try {
                const pending = this._waitFor(MSG.DebugDisconnectResponseType, 3000);
                this._sendProto('protocontrol.DebugDisconnectRequest', {
                    type: MSG.DebugDisconnectRequestType,
                    sessionid: this._sessionid
                });
                await pending;
            } catch { /* best effort */ }
            this._closeSocket();
        }
        if (!this._terminated) {
            this._terminated = true;
            this._emit('terminated', {});
        }
        this._flush();
        this._respond(request);
    }

    // -- ProtoControl transport ------------------------------------------------

    _connect() {
        return new Promise((resolve, reject) => {
            const url = `ws://localhost:${this._port}/proto`;
            const ws = new WebSocket(url);
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                ws.terminate();
                reject(new Error(`Cannot connect to NeoUO at ${url} (is the client running and ProtoControl enabled?)`));
            }, CONNECT_TIMEOUT_MS);

            ws.onopen = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this._ws = ws;
                ws.onmessage = (event) => this._onProtoMessage(event.data);
                ws.onclose = () => {
                    if (this._ws === ws) {
                        this._ws = null;
                        if (!this._terminated && !this._disposed) {
                            log('connection to NeoUO closed unexpectedly');
                            this._terminated = true;
                            this._emit('terminated', {});
                        }
                    }
                };
                ws.onerror = () => { /* surfaced via close */ };
                resolve();
            };
            ws.onerror = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error(`Cannot connect to NeoUO at ${url} (is the client running and ProtoControl enabled?)`));
            };
        });
    }

    _closeSocket() {
        if (this._ws) {
            const ws = this._ws;
            this._ws = null;
            try { ws.close(); } catch { /* ignore */ }
        }
    }

    _sendProto(typeName, payload) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
            throw new Error('Not connected to NeoUO');
        }
        const Type = this._root.lookupType(typeName);
        this._ws.send(Type.encode(Type.create(payload)).finish());
    }

    _waitFor(typeValue, timeoutMs) {
        return new Promise((resolve, reject) => {
            let queue = this._waiters.get(typeValue);
            if (!queue) {
                queue = [];
                this._waiters.set(typeValue, queue);
            }
            const entry = { resolve, reject, timer: null };
            entry.timer = setTimeout(() => {
                const idx = queue.indexOf(entry);
                if (idx >= 0) queue.splice(idx, 1);
                reject(new Error(`NeoUO did not respond to ${TYPE_TO_PROTO[typeValue] || typeValue} within ${timeoutMs}ms`));
            }, timeoutMs);
            queue.push(entry);
        });
    }

    async _request(reqType, respType, typeName, payload) {
        const pending = this._waitFor(respType, REQUEST_TIMEOUT_MS);
        this._sendProto(typeName, payload);
        return pending;
    }

    _onProtoMessage(data) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const type = peekType(buf);
        const protoName = TYPE_TO_PROTO[type];
        if (!protoName) {
            log(`unknown message from NeoUO (${buf.length} bytes)`);
            return;
        }
        const Type = this._root.lookupType(protoName);
        const message = Type.decode(buf);

        if (type === MSG.DebugEventType) {
            this._onDebugEvent(message);
            return;
        }
        const queue = this._waiters.get(type);
        if (queue && queue.length) {
            const entry = queue.shift();
            clearTimeout(entry.timer);
            entry.resolve(message);
        }
    }

    // -- Debug events ----------------------------------------------------------

    _onDebugEvent(event) {
        switch (event.reason) {
            case REASON.DebugOutput:
                this._emit('output', { category: 'stdout', output: this._line(event.message) });
                break;
            case REASON.DebugStderr:
                this._emit('output', { category: 'stderr', output: this._line(event.message) });
                break;
            case REASON.DebugException:
                this._stoppedOnce = true;
                this._emit('stopped', {
                    reason: 'exception',
                    description: event.message || 'Exception',
                    text: event.message || 'Exception',
                    threadId: 1
                });
                break;
            case REASON.DebugEntry:
                if (event.message === 'terminated') {
                    this._onScriptTerminated();
                } else {
                    this._emitStopped('entry', undefined);
                }
                break;
            case REASON.DebugBp:
                this._emitStopped('breakpoint', undefined);
                break;
            case REASON.DebugStep:
            default:
                this._emitStopped(this._firstStop ? 'entry' : 'step', undefined);
                break;
        }
    }

    _emitStopped(reason, description) {
        this._firstStop = false;
        this._stoppedOnce = true;
        if (this._watchdog) {
            clearTimeout(this._watchdog);
            this._watchdog = null;
        }
        const body = { reason, threadId: 1 };
        if (description) body.description = description;
        this._emit('stopped', body);
    }

    _onScriptTerminated() {
        if (this._terminated) return;
        this._terminated = true;
        this._emit('output', { category: 'console', output: '[NeoUO] Script ended.\n' });
        this._emit('terminated', {});
    }

    _line(text) {
        const trimmed = (text || '').replace(/[\r\n]+$/, '');
        return trimmed + '\n';
    }

    // -- DAP request handlers --------------------------------------------------

    async _onSetBreakpoints(request, args) {
        const filePath = (args.source && args.source.path) || this._programPath;
        const requested = (args.breakpoints || []).map((bp) => bp.line);
        if (!this._ws) {
            this._respond(request, {
                breakpoints: requested.map((line) => ({ verified: false, line, message: 'Not connected to NeoUO' }))
            });
            return;
        }
        const resp = await this._request(
            MSG.SetBreakpointsRequestType,
            MSG.SetBreakpointsResponseType,
            'protocontrol.SetBreakpointsRequest',
            { type: MSG.SetBreakpointsRequestType, sessionid: this._sessionid, file: filePath, lines: requested }
        );
        const verified = new Set((resp.breakpoints || []).filter((bp) => bp.verified).map((bp) => bp.line));
        this._respond(request, {
            breakpoints: requested.map((line) => ({ verified: verified.has(line), line }))
        });
    }

    async _onStackTrace(request) {
        const resp = await this._request(
            MSG.DebugStackTraceRequestType,
            MSG.DebugStackTraceResponseType,
            'protocontrol.DebugStackTraceRequest',
            { type: MSG.DebugStackTraceRequestType, sessionid: this._sessionid }
        );
        const frames = (resp.frames || []).map((frame) => {
            const framePath = frame.file || this._programPath;
            return {
                id: frame.id,
                name: frame.name || '<module>',
                line: frame.line,
                column: 1,
                source: { name: path.basename(framePath), path: framePath }
            };
        });
        this._respond(request, { stackFrames: frames, totalFrames: frames.length });
    }

    async _onScopes(request, args) {
        const resp = await this._request(
            MSG.DebugScopesRequestType,
            MSG.DebugScopesResponseType,
            'protocontrol.DebugScopesRequest',
            { type: MSG.DebugScopesRequestType, sessionid: this._sessionid, frameId: args.frameId || 0 }
        );
        this._respond(request, {
            scopes: (resp.scopes || []).map((scope) => ({
                name: scope.name,
                variablesReference: scope.variablesReference,
                expensive: false
            }))
        });
    }

    async _onVariables(request, args) {
        const resp = await this._request(
            MSG.DebugVariablesRequestType,
            MSG.DebugVariablesResponseType,
            'protocontrol.DebugVariablesRequest',
            { type: MSG.DebugVariablesRequestType, sessionid: this._sessionid, variablesReference: args.variablesReference || 0 }
        );
        this._respond(request, {
            variables: (resp.variables || []).map((variable) => ({
                name: variable.name,
                value: variable.value,
                type: variable.type,
                variablesReference: variable.variablesReference
            }))
        });
    }

    async _onEvaluate(request, args) {
        const resp = await this._request(
            MSG.DebugEvaluateRequestType,
            MSG.DebugEvaluateResponseType,
            'protocontrol.DebugEvaluateRequest',
            {
                type: MSG.DebugEvaluateRequestType,
                sessionid: this._sessionid,
                expression: args.expression || '',
                frameId: typeof args.frameId === 'number' ? args.frameId : 0
            }
        );
        this._respond(request, { result: resp.result || '', variablesReference: 0 });
    }

    async _onContinue(request) {
        const resp = await this._request(
            MSG.DebugContinueRequestType,
            MSG.DebugContinueResponseType,
            'protocontrol.DebugContinueRequest',
            { type: MSG.DebugContinueRequestType, sessionid: this._sessionid }
        );
        if (!resp.success) throw new Error('NeoUO refused to continue');
        this._respond(request, { allThreadsContinued: true });
        this._emit('continued', { threadId: 1, allThreadsContinued: true });
    }

    async _onStep(request, stepType) {
        const resp = await this._request(
            MSG.DebugStepRequestType,
            MSG.DebugStepResponseType,
            'protocontrol.DebugStepRequest',
            { type: MSG.DebugStepRequestType, sessionid: this._sessionid, stepType: stepType }
        );
        if (!resp.success) throw new Error('NeoUO refused to step');
        this._respond(request);
    }
}

module.exports = { NeoUODapAdapter, MSG };
