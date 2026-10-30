class EventEmitter {
    constructor() {
        this._listeners = [];
    }

    get event() {
        const listeners = this._listeners;
        return (listener) => {
            listeners.push(listener);
            return { dispose: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
        };
    }

    fire(value) {
        for (const listener of [...this._listeners]) listener(value);
    }

    dispose() {
        this._listeners = [];
    }
}

module.exports = {
    EventEmitter,
    window: {
        createOutputChannel: () => ({
            appendLine: (msg) => console.log(`[neouo-debug] ${msg}`),
            show: () => {},
            dispose: () => {}
        })
    },
    workspace: {
        textDocuments: [],
        getConfiguration: () => ({ get: (_key, fallback) => fallback })
    }
};
