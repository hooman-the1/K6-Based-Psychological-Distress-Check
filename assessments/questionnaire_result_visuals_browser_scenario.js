const [websocketUrl, testUrl, homeUrl, screenshotDirectory] = process.argv.slice(2);

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
        const debuggingOrigin = new URL(
            initialUrl.replace(/^ws:/, "http:"),
        ).origin;
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
        throw new Error(response.exceptionDetails.text);
    }
    return response.result.value;
};

const waitForQuestionnaire = async () => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (
            await evaluate(
                'location.pathname === "/test" && document.readyState === "complete" && Boolean(document.querySelector("[data-questionnaire]"))',
            )
        ) {
            return;
        }
        await delay(50);
    }
    throw new Error("questionnaire did not become ready");
};

const pointerClick = async (selector) => {
    const point = await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)})
            .getBoundingClientRect();
        return { x: rect.right - 8, y: rect.top + rect.height / 2 };
    })()`);
    await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
    });
};

const cardStyle = (selector) =>
    evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
            backgroundColor: style.backgroundColor,
            borderColor: style.borderTopColor,
            borderRadius: style.borderRadius,
            borderWidth: style.borderTopWidth,
            boxShadow: style.boxShadow,
            color: style.color,
            height: rect.height,
            opacity: style.opacity,
            transform: style.transform,
            width: rect.width,
            x: rect.x,
            y: rect.y,
        };
    })()`);

try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
        width: 320,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await client.send("Page.navigate", { url: testUrl });
    await waitForQuestionnaire();

    const selectedCard = '[data-question-step="1"] .response-option:nth-of-type(2)';
    const before = await cardStyle(selectedCard);
    await pointerClick(selectedCard);
    const after = await cardStyle(selectedCard);

    assert(
        after.borderColor === "rgb(11, 92, 173)" &&
            after.borderWidth === "1px" &&
            JSON.stringify({ ...after, borderColor: before.borderColor }) ===
                JSON.stringify(before),
        "selected response card did not change only its 1px border to primary",
    );

    console.log("questionnaire and Result visual scenario passed");
} finally {
    client.close();
}
