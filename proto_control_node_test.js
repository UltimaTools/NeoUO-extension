const WebSocket = require('ws');
const protobuf = require('protobufjs');

const PORT = process.argv[2] ? parseInt(process.argv[2], 10) : 15454;
const MODE = process.argv[3] || 'play'; // play | record | debug
const PROTO_PATH = __dirname + '/ProtoControl.proto';

const T = {
    PlayResponseType: 1, PlayRequestType: 2, StopPlayRequestType: 3, StopPlayResponseType: 4,
    RecordResponseType: 10, RecordRequestType: 11, StopRecordRequestType: 12, StopRecordResponseType: 13,
    DebugStartRequestType: 20, DebugEventType: 21, SetBreakpointsRequestType: 22, SetBreakpointsResponseType: 23,
    DebugContinueRequestType: 24, DebugContinueResponseType: 25, DebugStepRequestType: 26, DebugStepResponseType: 27,
    DebugStackTraceRequestType: 28, DebugStackTraceResponseType: 29, DebugScopesRequestType: 30, DebugScopesResponseType: 31,
    DebugVariablesRequestType: 32, DebugVariablesResponseType: 33, DebugEvaluateRequestType: 34, DebugEvaluateResponseType: 35,
    DebugDisconnectRequestType: 36, DebugDisconnectResponseType: 37,
};

let root;
const enc = (type, obj) => { const T2 = root.lookupType(type); return T2.encode(T2.create(obj)).finish(); };
const dec = (type, buf) => root.lookupType(type).decode(new Uint8Array(buf));

function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${PORT}/proto`);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(e);
    });
}

async function testPlay(ws) {
    const sessionid = 424242;
    ws.send(enc('protocontrol.PlayRequest', {
        type: T.PlayRequestType, sessionid, language: 1,
        commands: ["print('play-test-line-1')", "print('play-test-line-2')", "print(Player.Name)"],
    }));
    await new Promise((resolve) => {
        const timer = setTimeout(() => { console.log('PLAY: timeout after 15s'); resolve(); }, 15000);
        ws.onmessage = (ev) => {
            const r = dec('protocontrol.PlayResponse', ev.data);
            console.log(`PLAY response: type=${r.type} more=${r.more} result=${JSON.stringify(r.result)}`);
            if (r.type === T.PlayResponseType && !r.more) { clearTimeout(timer); resolve(); }
        };
    });
}

async function testPlayStop(ws) {
    const sessionid = 424244;
    ws.send(enc('protocontrol.PlayRequest', {
        type: T.PlayRequestType, sessionid, language: 1,
        commands: ['import time', 'for i in range(200):', '    time.sleep(0.05)'],
    }));
    await new Promise((resolve) => setTimeout(resolve, 1500));

    console.log('PLAY-STOP: sending StopPlay on the same socket');
    ws.send(enc('protocontrol.StopPlayRequest', { type: T.StopPlayRequestType, sessionid }));

    await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('no final PlayResponse more=false after StopPlay')),
            8000
        );
        ws.onmessage = (ev) => {
            const r = dec('protocontrol.PlayResponse', ev.data);
            console.log(`PLAY-STOP response: type=${r.type} more=${r.more} result=${JSON.stringify(r.result)}`);
            if (r.type === T.PlayResponseType && !r.more) {
                clearTimeout(timer);
                resolve();
            }
        };
    });
    console.log('PLAY-STOP: stop acknowledged on the play socket');
}

async function testRecord(ws) {
    const sessionid = 525252;
    ws.send(enc('protocontrol.RecordRequest', { type: T.RecordRequestType, sessionid, language: 1 }));
    console.log('RECORD: request sent, capturing 10s of events (move your character/cursor in game)...');
    await new Promise((resolve) => {
        setTimeout(() => {
            ws.send(enc('protocontrol.StopRecordRequest', { type: T.StopRecordRequestType, sessionid }));
            console.log('RECORD: stop sent');
            setTimeout(resolve, 3000);
        }, 10000);
        ws.onmessage = (ev) => {
            const raw = new Uint8Array(ev.data);
            // Two possible response types on this socket
            try {
                const rr = dec('protocontrol.RecordResponse', raw);
                if (rr.type === T.RecordResponseType) {
                    console.log(`RECORD response: more=${rr.more} data=${JSON.stringify(rr.data)}`);
                    return;
                }
            } catch { /* not RecordResponse */ }
            try {
                const sr = dec('protocontrol.StopRecordResponse', raw);
                console.log(`RECORD stop ack: type=${sr.type} success=${sr.success}`);
            } catch { console.log('RECORD: undecodable message, bytes=' + raw.length); }
        };
    });
}

async function testDebug(ws) {
    const sessionid = 636363;
    const script = [
        "x = 1",
        "y = x + 41",
        "print('breakpoint target', y)",
        "z = y * 2",
        "print('done', z)",
    ];
    let eventCount = 0;
    const pending = [];
    let waiter = null;
    ws.onmessage = (ev) => {
        const raw = new Uint8Array(ev.data);
        // Try each response type by type-field sniffing is hard; decode by trying DebugEvent first
        for (const [name, expect] of [
            ['protocontrol.DebugEvent', T.DebugEventType],
            ['protocontrol.SetBreakpointsResponse', T.SetBreakpointsResponseType],
            ['protocontrol.DebugContinueResponse', T.DebugContinueResponseType],
            ['protocontrol.DebugStepResponse', T.DebugStepResponseType],
            ['protocontrol.DebugStackTraceResponse', T.DebugStackTraceResponseType],
            ['protocontrol.DebugScopesResponse', T.DebugScopesResponseType],
            ['protocontrol.DebugVariablesResponse', T.DebugVariablesResponseType],
            ['protocontrol.DebugEvaluateResponse', T.DebugEvaluateResponseType],
            ['protocontrol.DebugDisconnectResponse', T.DebugDisconnectResponseType],
        ]) {
            try {
                const m = dec(name, raw);
                if (m.type !== expect) continue;
                console.log(`DEBUG <- ${name}: ${JSON.stringify(m.toJSON ? m.toJSON() : m)}`);
                if (waiter) { const w = waiter; waiter = null; w(m); }
                else pending.push(m);
                return;
            } catch { /* next */ }
        }
        console.log('DEBUG <- unknown message, bytes=' + raw.length);
    };
    const next = (ms = 8000) => new Promise((res, rej) => {
        if (pending.length) return res(pending.shift());
        waiter = res;
        setTimeout(() => { if (waiter === res) { waiter = null; rej(new Error('response timeout')); } }, ms);
    });

    console.log('DEBUG: starting session');
    ws.send(enc('protocontrol.DebugStartRequest', {
        type: T.DebugStartRequestType, sessionid, language: 1, commands: script, filepath: 'test_debug.py',
    }));

    // Wait for entry/output events briefly
    await new Promise(r => setTimeout(r, 1500));

    console.log('DEBUG: setting breakpoint at line 4');
    ws.send(enc('protocontrol.SetBreakpointsRequest', {
        type: T.SetBreakpointsRequestType, sessionid, file: 'test_debug.py', lines: [4],
    }));
    const bpResp = await next();
    console.log('DEBUG: breakpoints verified:', JSON.stringify(bpResp.breakpoints ? bpResp.breakpoints.map(b => ({ v: b.verified, l: b.line })) : bpResp));

    console.log('DEBUG: continue');
    ws.send(enc('protocontrol.DebugContinueRequest', { type: T.DebugContinueRequestType, sessionid }));
    await next();

    // Should hit breakpoint -> DebugEvent
    console.log('DEBUG: waiting for breakpoint hit event...');
    await next(15000);

    console.log('DEBUG: stack trace');
    ws.send(enc('protocontrol.DebugStackTraceRequest', { type: T.DebugStackTraceRequestType, sessionid }));
    const trace = await next();
    console.log('DEBUG: frames:', JSON.stringify(trace.frames ? trace.frames.map(f => ({ id: f.id, name: f.name, file: f.file, line: f.line })) : trace));

    const frameId = trace.frames && trace.frames.length ? trace.frames[0].id : 1;
    console.log('DEBUG: scopes for frame', frameId);
    ws.send(enc('protocontrol.DebugScopesRequest', { type: T.DebugScopesRequestType, sessionid, frameId: frameId }));
    const scopes = await next();
    console.log('DEBUG: scopes:', JSON.stringify(scopes.scopes || scopes));

    if (scopes.scopes && scopes.scopes.length) {
        const ref = scopes.scopes[0].variables_reference;
        console.log('DEBUG: variables for ref', ref);
        ws.send(enc('protocontrol.DebugVariablesRequest', { type: T.DebugVariablesRequestType, sessionid, variablesReference: ref }));
        const vars = await next();
        console.log('DEBUG: variables:', JSON.stringify(vars.variables || vars));
    }

    console.log('DEBUG: evaluate "x + y"');
    ws.send(enc('protocontrol.DebugEvaluateRequest', { type: T.DebugEvaluateRequestType, sessionid, expression: 'x + y', frameId: frameId }));
    const ev2 = await next();
    console.log('DEBUG: evaluate result:', JSON.stringify(ev2));

    console.log('DEBUG: step over');
    ws.send(enc('protocontrol.DebugStepRequest', { type: T.DebugStepRequestType, sessionid, stepType: 1 }));
    await next();
    await new Promise(r => setTimeout(r, 1000));

    console.log('DEBUG: disconnect');
    ws.send(enc('protocontrol.DebugDisconnectRequest', { type: T.DebugDisconnectRequestType, sessionid }));
    await next();
    console.log('DEBUG: done, events received:', eventCount);
}

async function main() {
    root = await protobuf.load(PROTO_PATH);
    root = root.lookup('protocontrol');
    console.log(`Connected mode=${MODE} port=${PORT}` .replace('Connected mode', 'mode'));
    const ws = await connect();
    console.log(`websocket connected to ws://localhost:${PORT}/proto`);
    if (MODE === 'play') await testPlay(ws);
    else if (MODE === 'play-stop') await testPlayStop(ws);
    else if (MODE === 'record') await testRecord(ws);
    else if (MODE === 'debug') await testDebug(ws);
    ws.close();
    process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
