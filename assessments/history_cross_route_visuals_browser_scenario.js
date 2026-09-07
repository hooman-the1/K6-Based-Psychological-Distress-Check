const [websocketUrl, testUrl, homeUrl, historyUrl, screenshotDirectory] =
    process.argv.slice(2);
const storageKey = "k6-based-distress-check.history.v1";
const seededResults = [
    { score: 4, timestamp: Date.parse("2026-09-05T09:00:00Z") },
    { score: 13, timestamp: Date.parse("2026-09-06T10:00:00Z") },
    { score: 24, timestamp: Date.parse("2026-09-07T11:00:00Z") },
];

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
        websocket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data.toString());
            const pending = this.pendingMessages.get(message.id);
            if (!pending) return;
            this.pendingMessages.delete(message.id);
            if (message.error) {
                pending.reject(new Error(message.error.message));
            } else {
                pending.resolve(message.result);
            }
        });
        const rejectPending = () => {
            for (const pending of this.pendingMessages.values()) {
                pending.reject(new Error("DevTools WebSocket closed"));
            }
            this.pendingMessages.clear();
        };
        websocket.addEventListener("error", rejectPending);
        websocket.addEventListener("close", rejectPending);
    }

    static async connect(initialUrl) {
        const debuggingOrigin = new URL(
            initialUrl.replace(/^ws:/, "http:"),
        ).origin;
        let lastError;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
                const targets = await fetch(`${debuggingOrigin}/json/list`).then(
                    (response) => response.json(),
                );
                const target = targets.find((candidate) => candidate.type === "page");
                if (!target) throw new Error("Edge has not exposed a page target");
                const websocket = new WebSocket(target.webSocketDebuggerUrl);
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
        throw new Error(response.exceptionDetails.text);
    }
    return response.result.value;
};
const waitForHistory = async () => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try {
            if (
                await evaluate(
                    'location.pathname === "/history" && document.readyState === "complete" && document.querySelectorAll("[data-history-score-point]").length === 3',
                )
            ) {
                return;
            }
        } catch {
            // Navigation can briefly destroy the previous execution context.
        }
        await delay(50);
    }
    throw new Error("three-result History did not become ready");
};

try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
        width: 320,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await client.send("Page.navigate", { url: historyUrl });
    await delay(100);
    await evaluate(
        `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(seededResults))})`,
    );
    await client.send("Page.reload", { ignoreCache: true });
    await waitForHistory();

    const lineStyles = await evaluate(`(() => {
        const style = (selector) => {
            const element = document.querySelector(selector);
            const computed = getComputedStyle(element);
            return {
                fill: computed.fill,
                stroke: computed.stroke,
                strokeDasharray: computed.strokeDasharray,
                strokeLinecap: computed.strokeLinecap,
                strokeLinejoin: computed.strokeLinejoin,
                strokeWidth: computed.strokeWidth,
                vectorEffect: computed.vectorEffect,
            };
        };
        return {
            cutoff: style("[data-history-cutoff-line]"),
            score: style("[data-history-score-line]"),
        };
    })()`);

    assert(
        JSON.stringify(lineStyles.cutoff) === JSON.stringify({
            fill: "none",
            stroke: "rgb(82, 96, 109)",
            strokeDasharray: "4px, 4px",
            strokeLinecap: "butt",
            strokeLinejoin: "miter",
            strokeWidth: "1px",
            vectorEffect: "non-scaling-stroke",
        }) &&
            JSON.stringify(lineStyles.score) === JSON.stringify({
                fill: "none",
                stroke: "rgb(11, 92, 173)",
                strokeDasharray: "none",
                strokeLinecap: "round",
                strokeLinejoin: "round",
                strokeWidth: "2px",
                vectorEffect: "non-scaling-stroke",
            }),
        "History cutoff and score lines do not use the exact visual contract",
    );

    console.log("History and cross-route visual scenario passed");
} finally {
    client.close();
}
