const [websocketUrl, pageUrl] = process.argv.slice(2);

const storageKey = "k6-based-distress-check.history.v1";
const unrelatedStorageKey = "unrelated.application.preference";

const assert = (condition, message) => {
    if (!condition) {
        throw new Error(message);
    }
};

const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

class DevToolsClient {
    constructor(websocket) {
        this.websocket = websocket;
        this.nextMessageId = 1;
        this.pendingMessages = new Map();
        this.networkRequests = [];
        websocket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data.toString());
            if (message.method === "Network.requestWillBeSent") {
                this.networkRequests.push(message.params.request);
                return;
            }
            const pendingMessage = this.pendingMessages.get(message.id);
            if (!pendingMessage) {
                return;
            }
            this.pendingMessages.delete(message.id);
            if (message.error) {
                pendingMessage.reject(new Error(message.error.message));
            } else {
                pendingMessage.resolve(message.result);
            }
        });
        const rejectPendingMessages = () => {
            for (const pendingMessage of this.pendingMessages.values()) {
                pendingMessage.reject(new Error("DevTools WebSocket closed"));
            }
            this.pendingMessages.clear();
        };
        websocket.addEventListener("error", rejectPendingMessages);
        websocket.addEventListener("close", rejectPendingMessages);
    }

    static async connect(initialUrl) {
        const debuggingOrigin = new URL(initialUrl.replace(/^ws:/, "http:")).origin;
        let lastError;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
                const targets = await fetch(`${debuggingOrigin}/json/list`).then(
                    (response) => response.json(),
                );
                const pageTarget = targets.find((target) => target.type === "page");
                if (!pageTarget) {
                    throw new Error("Edge has not exposed a page target");
                }
                const websocket = new WebSocket(pageTarget.webSocketDebuggerUrl);
                websocket.addEventListener("error", () => {});
                await new Promise((resolve, reject) => {
                    websocket.addEventListener("open", resolve, { once: true });
                    websocket.addEventListener("error", reject, { once: true });
                });
                return new DevToolsClient(websocket);
            } catch (error) {
                lastError = error;
                await delay(50);
            }
        }
        throw lastError;
    }

    send(method, params = {}) {
        const id = this.nextMessageId;
        this.nextMessageId += 1;
        return new Promise((resolve, reject) => {
            this.pendingMessages.set(id, { resolve, reject });
            this.websocket.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        this.websocket.close();
    }
}

const client = await DevToolsClient.connect(websocketUrl);

const evaluate = async (expression) => {
    const response = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
};

const waitForHistory = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            if (
                await evaluate(
                    'document.readyState === "complete" && Boolean(window.AssessmentHistory)',
                )
            ) {
                return;
            }
        } catch {
            // Navigation briefly destroys the previous JavaScript execution context.
        }
        await delay(50);
    }
    throw new Error("AssessmentHistory did not become ready");
};

try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Page.navigate", { url: pageUrl });
    await waitForHistory();
    await evaluate(`(() => {
        localStorage.clear();
        localStorage.setItem(
            ${JSON.stringify(unrelatedStorageKey)},
            "preserve this value",
        );
    })()`);

    const requestsBeforeOperations = client.networkRequests.length;
    const firstSnapshot = await evaluate(`(() => {
        const apiKeys = Object.keys(window.AssessmentHistory);
        const candidates = [
            { score: 0, timestamp: 3000 },
            { score: 1, timestamp: 1000 },
            { score: 2, timestamp: 1000 },
            ...Array.from({ length: 17 }, (_, index) => ({
                score: index + 3,
                timestamp: (index + 4) * 1000,
            })),
            { score: 20, timestamp: 21000 },
        ];
        const saves = candidates.map((candidate) =>
            window.AssessmentHistory.saveResult(candidate),
        );
        return {
            apiKeys,
            saves,
            results: window.AssessmentHistory.getResults(),
            raw: localStorage.getItem(${JSON.stringify(storageKey)}),
            localStorageKeys: Object.keys(localStorage),
            sessionStorageLength: sessionStorage.length,
            cookie: document.cookie,
            historyState: history.state,
        };
    })()`);
    await delay(100);

    const expectedRecords = [
        { score: 2, timestamp: 1000 },
        { score: 0, timestamp: 3000 },
        ...Array.from({ length: 17 }, (_, index) => ({
            score: index + 3,
            timestamp: (index + 4) * 1000,
        })),
        { score: 20, timestamp: 21000 },
    ];
    const expectedResults = {
        ok: true,
        results: expectedRecords,
    };
    assert(
        JSON.stringify(firstSnapshot.apiKeys) ===
            JSON.stringify(["getResults", "saveResult", "clearResults"]),
        "window.AssessmentHistory exposes the wrong API",
    );
    assert(
        firstSnapshot.saves.every((result) => JSON.stringify(result) === '{"ok":true}'),
        "a real localStorage save did not report success",
    );
    assert(
        JSON.stringify(firstSnapshot.results) === JSON.stringify(expectedResults),
        "real localStorage results are not oldest-first with stable ties",
    );
    assert(
        firstSnapshot.raw === JSON.stringify(expectedRecords),
        "real localStorage did not retain exact canonical 20-result JSON",
    );
    assert(
        JSON.stringify(firstSnapshot.localStorageKeys.sort()) ===
            JSON.stringify([storageKey, unrelatedStorageKey].sort()),
        "history wrote an unexpected localStorage key",
    );
    assert(firstSnapshot.sessionStorageLength === 0, "history wrote sessionStorage");
    assert(firstSnapshot.cookie === "", "history wrote a cookie");
    assert(firstSnapshot.historyState === null, "history wrote browser history state");
    assert(
        client.networkRequests.length === requestsBeforeOperations,
        "history operations caused a post-load network request",
    );

    await client.send("Page.reload", { ignoreCache: true });
    await waitForHistory();
    const requestsAfterReload = client.networkRequests.length;
    const reloadedSnapshot = await evaluate(`(() => ({
        apiKeys: Object.keys(window.AssessmentHistory),
        results: window.AssessmentHistory.getResults(),
        raw: localStorage.getItem(${JSON.stringify(storageKey)}),
        resultFields: window.AssessmentHistory.getResults().results.map(Object.keys),
    }))()`);
    await delay(100);

    assert(
        JSON.stringify(reloadedSnapshot.results) === JSON.stringify(expectedResults),
        "history did not persist across a real page reload",
    );
    assert(reloadedSnapshot.raw === firstSnapshot.raw, "reload changed persisted history");
    assert(
        reloadedSnapshot.resultFields.every(
            (fields) => JSON.stringify(fields) === JSON.stringify(["score", "timestamp"]),
        ),
        "a returned browser result contains extra fields",
    );
    assert(
        client.networkRequests.length === requestsAfterReload,
        "history read caused a post-load network request after reload",
    );

    const requestsBeforeClear = client.networkRequests.length;
    const clearedSnapshot = await evaluate(`(() => {
        const clearResult = window.AssessmentHistory.clearResults();
        return {
            clearResult,
            results: window.AssessmentHistory.getResults(),
            raw: localStorage.getItem(${JSON.stringify(storageKey)}),
            unrelatedValue: localStorage.getItem(
                ${JSON.stringify(unrelatedStorageKey)},
            ),
            localStorageKeys: Object.keys(localStorage),
            sessionStorageLength: sessionStorage.length,
            cookie: document.cookie,
            historyState: history.state,
        };
    })()`);
    await delay(100);

    assert(
        JSON.stringify(clearedSnapshot.clearResult) === '{"ok":true}',
        "real localStorage clear did not report exact success",
    );
    assert(
        JSON.stringify(clearedSnapshot.results) ===
            JSON.stringify({ ok: true, results: [] }),
        "getResults did not return empty success after clear",
    );
    assert(clearedSnapshot.raw === null, "clear left the history key present");
    assert(
        clearedSnapshot.unrelatedValue === "preserve this value",
        "clear changed an unrelated localStorage value",
    );
    assert(
        JSON.stringify(clearedSnapshot.localStorageKeys) ===
            JSON.stringify([unrelatedStorageKey]),
        "clear removed or created an unexpected localStorage key",
    );
    assert(clearedSnapshot.sessionStorageLength === 0, "clear wrote sessionStorage");
    assert(clearedSnapshot.cookie === "", "clear wrote a cookie");
    assert(clearedSnapshot.historyState === null, "clear wrote browser history state");
    assert(
        client.networkRequests.length === requestsBeforeClear,
        "clear caused a post-load network request",
    );

    await client.send("Page.reload", { ignoreCache: true });
    await waitForHistory();
    const requestsAfterClearReload = client.networkRequests.length;
    const clearedReloadSnapshot = await evaluate(`(() => ({
        results: window.AssessmentHistory.getResults(),
        raw: localStorage.getItem(${JSON.stringify(storageKey)}),
        unrelatedValue: localStorage.getItem(
            ${JSON.stringify(unrelatedStorageKey)},
        ),
    }))()`);
    await delay(100);

    assert(
        JSON.stringify(clearedReloadSnapshot.results) ===
            JSON.stringify({ ok: true, results: [] }),
        "cleared history did not stay empty after reload",
    );
    assert(
        clearedReloadSnapshot.raw === null,
        "reload restored the cleared history key",
    );
    assert(
        clearedReloadSnapshot.unrelatedValue === "preserve this value",
        "reload lost the unrelated localStorage value",
    );
    assert(
        client.networkRequests.length === requestsAfterClearReload,
        "cleared-history read caused a post-load network request after reload",
    );

    console.log("assessment history browser scenario passed");
} finally {
    client.close();
}
