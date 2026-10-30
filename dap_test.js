// End-to-end DAP test: drives the real NeoUODapAdapter against a running NeoUO client.
const Module = require('module');
const path = require('path');
const fs = require('fs');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return path.join(__dirname, 'vscode_mock.js');
    return origResolve.call(this, request, ...rest);
};

const { NeoUODapAdapter } = require('./debug');

const PORT = process.argv[2] ? parseInt(process.argv[2], 10) : 15454;
const SCRIPT_PATH = path.join(__dirname, 'dap_test_script.py');
const SCRIPT = [
    'x = 1',
    'y = x + 41',
    "print('step-a', y)",
    'z = y * 2',
    "print('step-b', z)",
    ''
].join('\n');

fs.writeFileSync(SCRIPT_PATH, SCRIPT);

const responses = new Map();
const events = [];
const failures = [];
let seq = 1;

const adapter = new NeoUODapAdapter({ configuration: { type: 'neouo', request: 'launch', program: SCRIPT_PATH, port: PORT } });
adapter.onDidSendMessage((message) => {
    if (message.type === 'response') responses.set(message.request_seq, message);
    else if (message.type === 'event') events.push(message);
});

function sendRequest(command, args) {
    const request = { seq: seq++, type: 'request', command, arguments: args || {} };
    adapter.handleMessage(request);
    return request.seq;
}

async function waitFor(fn, description, timeoutMs = 15000) {
    const start = Date.now();
    for (;;) {
        const found = fn();
        if (found) return found;
        if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${description}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

const responseOf = (requestSeq) => () => responses.get(requestSeq);
function eventNamed(name, predicate) {
    return () => events.find((e) => e.event === name && (!predicate || predicate(e.body)));
}

function check(label, condition, detail) {
    if (condition) {
        console.log(`PASS: ${label}`);
    } else {
        failures.push(label);
        console.log(`FAIL: ${label}${detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''}`);
    }
}

async function main() {
    // 1. initialize
    let seqInit = sendRequest('initialize', { clientID: 'dap-test', adapterID: 'neouo', linesStartAt1: true, columnsStartAt1: true });
    let resp = await waitFor(responseOf(seqInit), 'initialize response');
    check('initialize success', resp.success === true, resp);
    check('capabilities: configurationDone', resp.body && resp.body.supportsConfigurationDoneRequest === true, resp.body);

    // 2. launch
    let seqLaunch = sendRequest('launch', { type: 'neouo', request: 'launch', program: SCRIPT_PATH, port: PORT });
    await waitFor(eventNamed('initialized'), 'initialized event');
    check('initialized event received', true);
    resp = await waitFor(responseOf(seqLaunch), 'launch response');
    check('launch success', resp.success === true, resp);

    // 3. breakpoints on line 4 (z = y * 2)
    let seqBp = sendRequest('setBreakpoints', {
        source: { path: SCRIPT_PATH, name: path.basename(SCRIPT_PATH) },
        breakpoints: [{ line: 4 }]
    });
    resp = await waitFor(responseOf(seqBp), 'setBreakpoints response');
    check(
        'breakpoint verified at line 4',
        resp.success && resp.body && resp.body.breakpoints && resp.body.breakpoints[0] && resp.body.breakpoints[0].verified === true,
        resp
    );

    // 4. configurationDone -> flush -> entry stop
    let seqCfg = sendRequest('configurationDone');
    resp = await waitFor(responseOf(seqCfg), 'configurationDone response');
    check('configurationDone success', resp.success === true, resp);

    const entryStop = await waitFor(
        eventNamed('stopped', (b) => b.reason === 'entry'),
        'stopped event with reason entry'
    );
    check('stopped on entry', entryStop.body.threadId === 1, entryStop.body);

    // 5. continue -> breakpoint hit at line 4
    let seqCont = sendRequest('continue', { threadId: 1 });
    resp = await waitFor(responseOf(seqCont), 'continue response');
    check('continue success', resp.success === true, resp);
    const bpStop = await waitFor(
        eventNamed('stopped', (b) => b.reason === 'breakpoint'),
        'stopped event with reason breakpoint'
    );
    check('breakpoint stop received', true, bpStop.body);

    // 6. stack trace
    let seqStack = sendRequest('stackTrace', { threadId: 1 });
    resp = await waitFor(responseOf(seqStack), 'stackTrace response');
    const frames = (resp.body && resp.body.stackFrames) || [];
    check('stackTrace has frames', frames.length > 0, resp.body);
    check('top frame at line 4', frames[0] && frames[0].line === 4, frames[0]);
    check('frame source path matches', frames[0] && frames[0].source && frames[0].source.path === SCRIPT_PATH, frames[0]);

    // 7. scopes + variables
    const frameId = frames[0].id;
    let seqScopes = sendRequest('scopes', { frameId });
    resp = await waitFor(responseOf(seqScopes), 'scopes response');
    const scopes = (resp.body && resp.body.scopes) || [];
    check('scopes returned', scopes.length > 0, resp.body);
    const varRef = scopes[0].variablesReference;

    let seqVars = sendRequest('variables', { variablesReference: varRef });
    resp = await waitFor(responseOf(seqVars), 'variables response');
    const variables = (resp.body && resp.body.variables) || [];
    const names = variables.map((v) => v.name);
    check('variables include x and y', names.includes('x') && names.includes('y'), names);
    const yVar = variables.find((v) => v.name === 'y');
    check('y == 42', yVar && yVar.value === '42', yVar);

    // 8. evaluate
    let seqEval = sendRequest('evaluate', { expression: 'x + y', frameId, context: 'repl' });
    resp = await waitFor(responseOf(seqEval), 'evaluate response');
    check('evaluate x + y == 43', resp.success && resp.body && resp.body.result === '43', resp.body);

    // 9. step over -> line 5
    let seqStep = sendRequest('next', { threadId: 1 });
    resp = await waitFor(responseOf(seqStep), 'next response');
    check('step success', resp.success === true, resp);
    const stepStop = await waitFor(
        eventNamed('stopped', (b) => b.reason === 'step'),
        'stopped event with reason step'
    );
    check('step stop at line 5', true, stepStop.body);

    let seqStack2 = sendRequest('stackTrace', { threadId: 1 });
    resp = await waitFor(responseOf(seqStack2), 'second stackTrace response');
    const frames2 = (resp.body && resp.body.stackFrames) || [];
    check('line advanced to 5', frames2[0] && frames2[0].line === 5, frames2[0]);

    // 10. evaluate after step (z now assigned)
    let seqEval2 = sendRequest('evaluate', { expression: 'z', frameId: frames2[0].id, context: 'watch' });
    resp = await waitFor(responseOf(seqEval2), 'second evaluate response');
    check('evaluate z == 84', resp.success && resp.body && resp.body.result === '84', resp.body);

    // 11. disconnect / terminate
    let seqDisc = sendRequest('disconnect', { terminateDebuggee: true });
    resp = await waitFor(responseOf(seqDisc), 'disconnect response');
    check('disconnect success', resp.success === true, resp);
    await waitFor(eventNamed('terminated'), 'terminated event');
    check('terminated event received', true);

    adapter.dispose();

    console.log('');
    if (failures.length) {
        console.log(`RESULT: ${failures.length} FAILED -> ${failures.join(' | ')}`);
        process.exit(1);
    }
    console.log('RESULT: ALL DAP TESTS PASSED');
    process.exit(0);
}

main().catch((e) => {
    console.error('TEST ERROR:', e.message || e);
    process.exit(1);
});
