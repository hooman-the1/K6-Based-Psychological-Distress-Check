const [websocketUrl, testUrl, homeUrl, historyUrl] = process.argv.slice(2);
const unavailableNotice = "Saved history is unavailable in this browser.";

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
        this.exceptions = [];
        websocket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data.toString());
            if (message.method === "Network.requestWillBeSent") {
                this.networkRequests.push(message.params.request);
                return;
            }
            if (message.method === "Runtime.exceptionThrown") {
                this.exceptions.push(message.params.exceptionDetails);
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
let boundaryInjectionIdentifier = null;

const evaluate = async (expression) => {
    const response = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(
            response.exceptionDetails.exception?.description ??
                response.exceptionDetails.text,
        );
    }
    return response.result.value;
};

const installBoundaryMode = async (mode) => {
    if (boundaryInjectionIdentifier !== null) {
        await client.send("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: boundaryInjectionIdentifier,
        });
    }
    const source = `(() => {
        const mode = ${JSON.stringify(mode)};
        let exposedBoundary;
        window.__issue16GetResultsCalls = 0;
        window.__issue16SaveResultCalls = 0;
        window.__issue16MarkupReadyAtRead = false;
        Object.defineProperty(window, "AssessmentHistory", {
            configurable: true,
            get() {
                return exposedBoundary;
            },
            set(boundary) {
                window.__issue16OriginalBoundary = boundary;
                if (mode === "missing") {
                    exposedBoundary = undefined;
                    return;
                }
                exposedBoundary = Object.freeze({
                    getResults() {
                        window.__issue16GetResultsCalls += 1;
                        window.__issue16MarkupReadyAtRead = Boolean(document.querySelector("h1"));
                        if (mode === "storage-unavailable") {
                            return { ok: false, reason: "storage-unavailable" };
                        }
                        if (mode === "invalid-stored-data") {
                            return { ok: false, reason: "invalid-stored-data" };
                        }
                        if (mode === "arbitrary-non-success") {
                            return { ok: false, reason: "unexpected-failure" };
                        }
                        if (mode === "invalid-success-shape") {
                            return { ok: true, results: "not-an-array" };
                        }
                        if (mode === "throw") {
                            throw new Error("injected application history failure");
                        }
                        return boundary.getResults();
                    },
                    saveResult(result) {
                        window.__issue16SaveResultCalls += 1;
                        return boundary.saveResult(result);
                    },
                });
            },
        });
    })()`;
    const installed = await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source,
    });
    boundaryInjectionIdentifier = installed.identifier;
};

const expectedReadCount = (mode) => (mode === "missing" ? 0 : 1);

const waitForInitializedPage = async (pathname, heading, mode) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            if (
                await evaluate(`
                    document.readyState === "complete" &&
                    location.pathname === ${JSON.stringify(pathname)} &&
                    document.querySelector("h1")?.textContent.trim() === ${JSON.stringify(heading)} &&
                    typeof window.__issue16GetResultsCalls === "number"
                `)
            ) {
                return;
            }
        } catch {
            // Navigation can briefly destroy the previous execution context.
        }
        await delay(50);
    }
    throw new Error(`${pathname} did not initialize in ${mode} mode`);
};

const navigate = async (url, pathname, heading, mode) => {
    await client.send("Page.navigate", { url });
    await waitForInitializedPage(pathname, heading, mode);
};

const pointerClickLink = async (linkText) => {
    const bounds = await evaluate(`(() => {
        const element = Array.from(document.querySelectorAll("a")).find(
            (link) => link.textContent.trim() === ${JSON.stringify(linkText)}
        );
        if (!element || element.hidden) return null;
        element.scrollIntoView({ block: "center" });
        const bounds = element.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    assert(bounds, `missing visible link for pointer click: ${linkText}`);
    await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: bounds.x,
        y: bounds.y,
        button: "left",
        clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: bounds.x,
        y: bounds.y,
        button: "left",
        clickCount: 1,
    });
};

const snapshot = () =>
    evaluate(`(() => {
        const isVisible = (element) => Boolean(
            element &&
            !element.hidden &&
            getComputedStyle(element).display !== "none" &&
            getComputedStyle(element).visibility !== "hidden"
        );
        const links = Array.from(document.querySelectorAll("a"));
        const historyLinks = links.filter((link) => link.textContent.trim() === "View History");
        const historyLink = historyLinks[0];
        const startTestLink = links.find((link) => link.textContent.trim() === "Start Test");
        const takeTestLinks = links.filter((link) => link.textContent.trim() === "Take Test");
        const emptyMessages = Array.from(document.querySelectorAll("p")).filter(
            (message) => message.textContent.trim() === "No saved results yet."
        );
        const notices = Array.from(document.querySelectorAll("p")).filter(
            (notice) => notice.textContent.trim() === ${JSON.stringify(unavailableNotice)}
        );
        return {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            heading: document.querySelector("h1")?.textContent.trim() ?? null,
            historyLinkCount: historyLinks.length,
            historyLinkVisible: isVisible(historyLink),
            historyLinkHref: historyLink?.href ?? null,
            startTestVisible: isVisible(startTestLink),
            startTestHref: startTestLink?.href ?? null,
            visibleEmptyMessageCount: emptyMessages.filter(isVisible).length,
            visibleTakeTestHrefs: takeTestLinks.filter(isVisible).map((link) => link.href),
            visibleNoticeTexts: notices.filter(isVisible).map((notice) => notice.textContent.trim()),
            visibleResultListCount: Array.from(
                document.querySelectorAll("[data-history-results]")
            ).filter(isVisible).length,
            visibleResultRowCount: Array.from(
                document.querySelectorAll("[data-history-result]")
            ).filter(isVisible).length,
            visibleChartCount: Array.from(
                document.querySelectorAll("canvas, svg, [data-history-chart]")
            ).filter(isVisible).length,
            visibleClearHistoryCount: Array.from(
                document.querySelectorAll("button, a")
            ).filter(
                (control) => isVisible(control) &&
                    control.textContent.trim() === "Clear All History"
            ).length,
            dialogCount: document.querySelectorAll("dialog, [role='dialog'], [role='alertdialog']").length,
            getResultsCalls: window.__issue16GetResultsCalls,
            saveResultCalls: window.__issue16SaveResultCalls,
            markupReadyAtRead: window.__issue16MarkupReadyAtRead,
        };
    })()`);

const assertSettledWithoutSideEffects = async (context, readCount) => {
    const requestCount = client.networkRequests.length;
    await delay(100);
    assert(
        client.networkRequests.length === requestCount,
        `${context} caused a post-load network request`,
    );
    assert(
        (await evaluate("window.__issue16GetResultsCalls")) === readCount,
        `${context} retried its availability read`,
    );
    assert(
        (await evaluate("window.__issue16SaveResultCalls")) === 0,
        `${context} performed a delayed write probe`,
    );
};

const assertAvailableHome = (state, context) => {
    assert(state.pathname === "/", `${context}: Home pathname changed`);
    assert(state.search === "" && state.hash === "", `${context}: Home URL has extra data`);
    assert(state.historyLinkCount === 1, `${context}: missing View History link`);
    assert(state.historyLinkVisible, `${context}: View History is hidden`);
    assert(state.historyLinkHref === historyUrl, `${context}: wrong View History destination`);
    assert(state.startTestVisible, `${context}: Start Test is hidden`);
    assert(state.startTestHref === testUrl, `${context}: wrong Start Test destination`);
    assert(state.visibleNoticeTexts.length === 0, `${context}: unavailable notice is visible`);
    assert(state.getResultsCalls === 1, `${context}: availability was not read exactly once`);
    assert(state.markupReadyAtRead, `${context}: availability was read before markup existed`);
    assert(state.saveResultCalls === 0, `${context}: availability performed a write probe`);
};

const assertUnavailableHome = (state, mode) => {
    assert(state.pathname === "/", `${mode}: Home pathname changed`);
    assert(state.heading === "K6-Based Psychological Distress Check", `${mode}: Home heading changed`);
    assert(!state.historyLinkVisible, `${mode}: View History remains visible`);
    assert(state.startTestVisible, `${mode}: Start Test is hidden`);
    assert(state.startTestHref === testUrl, `${mode}: wrong Start Test destination`);
    assert(
        JSON.stringify(state.visibleNoticeTexts) === JSON.stringify([unavailableNotice]),
        `${mode}: Home notice is missing, duplicated, or wrong`,
    );
    assert(state.dialogCount === 0, `${mode}: Home uses a blocking dialog`);
    assert(
        state.getResultsCalls === expectedReadCount(mode),
        `${mode}: Home availability read count is wrong`,
    );
    assert(
        mode === "missing" || state.markupReadyAtRead,
        `${mode}: Home availability was read before markup existed`,
    );
    assert(state.saveResultCalls === 0, `${mode}: Home performed a write probe`);
};

const assertUnavailableHistory = (state, mode) => {
    assert(state.pathname === "/history", `${mode}: History pathname changed`);
    assert(state.search === "" && state.hash === "", `${mode}: History URL has extra data`);
    assert(state.heading === "History", `${mode}: History heading changed`);
    assert(
        JSON.stringify(state.visibleNoticeTexts) === JSON.stringify([unavailableNotice]),
        `${mode}: History notice is missing, duplicated, or wrong`,
    );
    assert(state.dialogCount === 0, `${mode}: History uses a blocking dialog`);
    assert(
        state.getResultsCalls === expectedReadCount(mode),
        `${mode}: History availability read count is wrong`,
    );
    assert(
        mode === "missing" || state.markupReadyAtRead,
        `${mode}: History availability was read before markup existed`,
    );
    assert(state.saveResultCalls === 0, `${mode}: History performed a write probe`);
};

const assertEmptyHistory = (state) => {
    assert(state.pathname === "/history", "empty History pathname changed");
    assert(state.search === "" && state.hash === "", "empty History URL has extra data");
    assert(state.heading === "History", "empty History heading changed");
    assert(state.visibleEmptyMessageCount === 1, "empty History message is missing or duplicated");
    assert(
        JSON.stringify(state.visibleTakeTestHrefs) === JSON.stringify([testUrl]),
        "empty History Take Test action is missing, duplicated, or wrong",
    );
    assert(state.visibleNoticeTexts.length === 0, "empty History shows unavailable notice");
    assert(state.visibleResultListCount === 0, "empty History shows a result list");
    assert(state.visibleResultRowCount === 0, "empty History shows a result row");
    assert(state.visibleChartCount === 0, "empty History shows a chart");
    assert(state.visibleClearHistoryCount === 0, "empty History shows Clear All History");
    assert(state.getResultsCalls === 1, "empty History was not read exactly once");
    assert(state.saveResultCalls === 0, "empty History performed a write probe");
};

try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
        width: 320,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
    });

    await installBoundaryMode("storage-unavailable");
    await navigate(
        homeUrl,
        "/",
        "K6-Based Psychological Distress Check",
        "storage-unavailable",
    );
    let state = await snapshot();
    assertUnavailableHome(state, "storage-unavailable");
    await assertSettledWithoutSideEffects("storage-unavailable Home", 1);
    await pointerClickLink("Start Test");
    await waitForInitializedPage("/test", "Test", "storage-unavailable");
    state = await snapshot();
    assert(state.visibleNoticeTexts.length === 0, "Test shows a history notice");
    assert(state.getResultsCalls === 0, "Test checked history availability");
    assert(
        Boolean(await evaluate('document.querySelector("[data-questionnaire]")')),
        "Start Test did not reach the usable questionnaire",
    );
    await navigate(
        historyUrl,
        "/history",
        "History",
        "storage-unavailable",
    );
    state = await snapshot();
    assertUnavailableHistory(state, "storage-unavailable");
    await assertSettledWithoutSideEffects("storage-unavailable History", 1);

    await installBoundaryMode("available");
    await navigate(homeUrl, "/", "K6-Based Psychological Distress Check", "available");
    state = await snapshot();
    assertAvailableHome(state, "empty history");
    await assertSettledWithoutSideEffects("available Home", 1);

    await pointerClickLink("View History");
    await waitForInitializedPage("/history", "History", "available");
    state = await snapshot();
    assertEmptyHistory(state);
    await assertSettledWithoutSideEffects("empty History", 1);

    await pointerClickLink("Take Test");
    await waitForInitializedPage("/test", "Test", "available");
    state = await snapshot();
    assert(state.getResultsCalls === 0, "empty-state Take Test caused a history read");
    assert(state.saveResultCalls === 0, "empty-state Take Test created a history record");

    await evaluate(
        "window.__issue16OriginalBoundary.saveResult({ score: 12, timestamp: 1000 })",
    );
    await client.send("Page.navigate", { url: homeUrl });
    await waitForInitializedPage("/", "K6-Based Psychological Distress Check", "available");
    state = await snapshot();
    assertAvailableHome(state, "populated history");

    await pointerClickLink("View History");
    await waitForInitializedPage("/history", "History", "available");
    state = await snapshot();
    assert(state.pathname === "/history", "available History pathname changed");
    assert(state.heading === "History", "available History heading changed");
    assert(state.visibleNoticeTexts.length === 0, "available History shows a notice");
    assert(state.getResultsCalls === 1, "available History was not read exactly once");
    assert(state.markupReadyAtRead, "available History was read before markup existed");
    assert(state.saveResultCalls === 0, "available History performed a write probe");
    await assertSettledWithoutSideEffects("available History", 1);

    const unavailableModes = [
        "invalid-stored-data",
        "arbitrary-non-success",
        "invalid-success-shape",
        "throw",
        "missing",
    ];
    for (const mode of unavailableModes) {
        const exceptionsBefore = client.exceptions.length;
        await installBoundaryMode(mode);
        await navigate(homeUrl, "/", "K6-Based Psychological Distress Check", mode);
        state = await snapshot();
        assertUnavailableHome(state, mode);
        await assertSettledWithoutSideEffects(
            `${mode} Home`,
            expectedReadCount(mode),
        );
        assert(
            client.exceptions.length === exceptionsBefore,
            `${mode}: Home exposed an uncaught exception`,
        );

        await navigate(historyUrl, "/history", "History", mode);
        state = await snapshot();
        assertUnavailableHistory(state, mode);
        await assertSettledWithoutSideEffects(
            `${mode} History`,
            expectedReadCount(mode),
        );
        assert(
            client.exceptions.length === exceptionsBefore,
            `${mode}: History exposed an uncaught exception`,
        );
    }

    assert(
        client.networkRequests.every(
            (request) => request.method === "GET" && request.postData === undefined,
        ),
        "availability behavior caused a state-changing or data-bearing request",
    );
    console.log("history availability browser scenario passed");
} finally {
    client.close();
}
