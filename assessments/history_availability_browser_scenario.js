const [websocketUrl, testUrl, homeUrl, historyUrl] = process.argv.slice(2);
const unavailableNotice = "Saved history is unavailable in this browser.";
const storageKey = "k6-based-distress-check.history.v1";
const unrelatedStorageKey = "unrelated.application.preference";
const olderTimestamp = Date.parse("2026-09-06T18:00:00Z");
const boundaryCrossingTimestamp = Date.parse("2026-09-07T00:30:00Z");
const newestTimestamp = Date.parse("2026-09-07T08:05:00Z");
const singleResult = { score: 13, timestamp: boundaryCrossingTimestamp };
const equalScoreResult = { score: 13, timestamp: boundaryCrossingTimestamp };
const additionalResults = [
    { score: 0, timestamp: olderTimestamp },
    { score: 12, timestamp: boundaryCrossingTimestamp },
    { score: 14, timestamp: boundaryCrossingTimestamp },
    { score: 13, timestamp: boundaryCrossingTimestamp },
    { score: 24, timestamp: newestTimestamp },
];
const seededResults = [
    singleResult,
    equalScoreResult,
    ...additionalResults,
];
const expectedNewestFirstRows = [
    ["Sep 7, 2026", "1:05 AM", "24 / 24", "At or above the cutoff"],
    ["Sep 6, 2026", "5:30 PM", "13 / 24", "At or above the cutoff"],
    ["Sep 6, 2026", "5:30 PM", "14 / 24", "At or above the cutoff"],
    ["Sep 6, 2026", "5:30 PM", "12 / 24", "Below the cutoff"],
    ["Sep 6, 2026", "5:30 PM", "13 / 24", "At or above the cutoff"],
    ["Sep 6, 2026", "5:30 PM", "13 / 24", "At or above the cutoff"],
    ["Sep 6, 2026", "11:00 AM", "0 / 24", "Below the cutoff"],
];
const expectedOldestFirstScores = [0, 13, 13, 12, 14, 13, 24];
const chartExplanation =
    "Scores are shown from oldest to newest. The horizontal line marks the cutoff score of 13.";

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
        this.dialogs = [];
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
            if (message.method === "Page.javascriptDialogOpening") {
                this.dialogs.push(message.params);
                this.send("Page.handleJavaScriptDialog", { accept: false }).catch(
                    () => {},
                );
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
        window.__issue19ClearResultsCalls = 0;
        window.__issue16MarkupReadyAtRead = false;
        window.__issue17ReturnedResults = null;
        window.__issue17ReturnedResultsBefore = null;
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
                        const readResult = boundary.getResults();
                        if (readResult?.ok === true && Array.isArray(readResult.results)) {
                            window.__issue17ReturnedResults = readResult.results;
                            window.__issue17ReturnedResultsBefore = JSON.stringify(
                                readResult.results,
                            );
                        }
                        return readResult;
                    },
                    saveResult(result) {
                        window.__issue16SaveResultCalls += 1;
                        return boundary.saveResult(result);
                    },
                    clearResults() {
                        window.__issue19ClearResultsCalls += 1;
                        if (mode === "clear-reentrant-success") {
                            const clearResult = boundary.clearResults();
                            document.querySelector("[data-clear-history]")?.click();
                            return clearResult;
                        }
                        if (mode === "clear-storage-unavailable") {
                            return { ok: false, reason: "storage-unavailable" };
                        }
                        if (mode === "clear-arbitrary-non-success") {
                            return { ok: false, reason: "unexpected-failure" };
                        }
                        if (mode === "clear-invalid-success") {
                            return { ok: true, extra: true };
                        }
                        if (mode === "clear-undefined") {
                            return undefined;
                        }
                        if (mode === "clear-throw") {
                            throw new Error("injected application clear failure");
                        }
                        return boundary.clearResults();
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

const pointerClickElement = async (selector) => {
    const bounds = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || element.hidden) return null;
        element.scrollIntoView({ block: "center" });
        const bounds = element.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    assert(bounds, `missing visible element for pointer click: ${selector}`);
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
            element.getClientRects().length > 0 &&
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
        const resultRows = Array.from(document.querySelectorAll("[data-history-result]"));
        const chartContainer = document.querySelector("[data-history-chart-container]");
        const chart = document.querySelector("[data-history-chart]");
        const cutoffLine = document.querySelector("[data-history-cutoff-line]");
        const scoreLine = document.querySelector("[data-history-score-line]");
        const scorePoints = Array.from(
            document.querySelectorAll("[data-history-score-point]")
        );
        const chartExplanation = document.querySelector(
            "[data-history-chart-explanation]"
        );
        const resultsList = document.querySelector("[data-history-results]");
        const clearControls = Array.from(
            document.querySelectorAll("[data-clear-history]")
        );
        const clearControl = clearControls[0];
        const chartRect = chart?.getBoundingClientRect();
        const shellRect = document.querySelector(".page-shell")?.getBoundingClientRect();
        const chartElements = chartContainer
            ? [chartContainer, ...chartContainer.querySelectorAll("*")]
            : [];
        return {
            url: location.href,
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            historyState: history.state,
            heading: document.querySelector("h1")?.textContent.trim() ?? null,
            historyLinkCount: historyLinks.length,
            historyLinkVisible: isVisible(historyLink),
            historyLinkHref: historyLink?.href ?? null,
            startTestVisible: isVisible(startTestLink),
            startTestHref: startTestLink?.href ?? null,
            visibleEmptyMessageCount: emptyMessages.filter(isVisible).length,
            visibleTakeTestHrefs: takeTestLinks.filter(isVisible).map((link) => link.href),
            visibleNoticeTexts: notices.filter(isVisible).map((notice) => notice.textContent.trim()),
            visibleParagraphTexts: Array.from(document.querySelectorAll("p"))
                .filter(isVisible)
                .map((paragraph) => paragraph.textContent.trim()),
            visibleResultListCount: Array.from(
                document.querySelectorAll("[data-history-results]")
            ).filter(isVisible).length,
            visibleResultRowCount: Array.from(
                document.querySelectorAll("[data-history-result]")
            ).filter(isVisible).length,
            resultRowCount: resultRows.length,
            visibleResultRows: resultRows.filter(isVisible).map((row) => ({
                values: Array.from(row.children).filter(isVisible).map(
                    (value) => value.textContent.trim()
                ),
                interactiveCount: row.querySelectorAll(
                    "a, button, form, input, select, textarea"
                ).length,
                tabIndex: row.tabIndex,
                role: row.getAttribute("role"),
                hasClickHandler: row.onclick !== null,
                html: row.outerHTML,
            })),
            visibleChartCount: Array.from(
                document.querySelectorAll("canvas, svg, [data-history-chart]")
            ).filter(isVisible).length,
            chart: {
                visibleContainerCount: Array.from(
                    document.querySelectorAll("[data-history-chart-container]")
                ).filter(isVisible).length,
                containerVisible: isVisible(chartContainer),
                containerTag: chartContainer?.tagName.toLowerCase() ?? null,
                appearsBeforeResults:
                    Boolean(chartContainer && resultsList) &&
                    Boolean(
                        chartContainer.compareDocumentPosition(resultsList) &
                        Node.DOCUMENT_POSITION_FOLLOWING
                    ),
                heading: chartContainer?.querySelector("h2")?.textContent.trim() ?? null,
                headingVisible: isVisible(chartContainer?.querySelector("h2")),
                explanation: chartExplanation?.textContent.trim() ?? null,
                explanationVisible: isVisible(chartExplanation),
                svgVisible: isVisible(chart),
                namespace: chart?.namespaceURI ?? null,
                role: chart?.getAttribute("role") ?? null,
                accessibleName: chart?.getAttribute("aria-label") ?? null,
                viewBox: chart?.getAttribute("viewBox") ?? null,
                width: chart?.getAttribute("width") ?? null,
                preserveAspectRatio: chart?.getAttribute("preserveAspectRatio") ?? null,
                titleCount: chart?.querySelectorAll("title").length ?? 0,
                cutoffLineCount: chart?.querySelectorAll(
                    "[data-history-cutoff-line]"
                ).length ?? 0,
                cutoff: cutoffLine ? {
                    visible: isVisible(cutoffLine),
                    x1: Number(cutoffLine.getAttribute("x1")),
                    x2: Number(cutoffLine.getAttribute("x2")),
                    y1: Number(cutoffLine.getAttribute("y1")),
                    y2: Number(cutoffLine.getAttribute("y2")),
                    dash: cutoffLine.getAttribute("stroke-dasharray"),
                    stroke: cutoffLine.getAttribute("stroke"),
                } : null,
                scoreLineCount: chart?.querySelectorAll(
                    "[data-history-score-line]"
                ).length ?? 0,
                scoreLinePoints: scoreLine?.getAttribute("points") ?? null,
                scoreLineFill: scoreLine?.getAttribute("fill") ?? null,
                scoreLineStroke: scoreLine?.getAttribute("stroke") ?? null,
                scoreLineVisible: isVisible(scoreLine),
                points: scorePoints.map((point) => ({
                    visible: isVisible(point),
                    x: Number(point.getAttribute("cx")),
                    y: Number(point.getAttribute("cy")),
                    radius: Number(point.getAttribute("r")),
                    fill: point.getAttribute("fill"),
                    namespace: point.namespaceURI,
                })),
                interactiveCount: chartContainer?.querySelectorAll(
                    "a, button, form, input, select, textarea, [tabindex]"
                ).length ?? 0,
                focusableCount: chartElements.filter(
                    (element) => element.tabIndex >= 0
                ).length,
                animationElementCount: chartContainer?.querySelectorAll(
                    "animate, animateMotion, animateTransform, set"
                ).length ?? 0,
                hasEventHandler: chartElements.some((element) =>
                    ["onclick", "onpointerdown", "onpointerup", "onmouseenter", "onfocus"]
                        .some((name) => element[name] !== null)
                ),
                hasPointerCursor: chartElements.some(
                    (element) => getComputedStyle(element).cursor === "pointer"
                ),
                hasTransition: chartElements.some(
                    (element) => getComputedStyle(element).transitionDuration !== "0s"
                ),
                hasAnimation: chartElements.some(
                    (element) => getComputedStyle(element).animationName !== "none"
                ),
                dataHooks: chartElements.flatMap((element) =>
                    Array.from(element.attributes)
                        .map((attribute) => attribute.name)
                        .filter((name) => name.startsWith("data-"))
                ),
                html: chartContainer?.outerHTML ?? "",
                widthPixels: chartRect?.width ?? 0,
                heightPixels: chartRect?.height ?? 0,
                leftPixels: chartRect?.left ?? 0,
                rightPixels: chartRect?.right ?? 0,
                shellLeftPixels: shellRect?.left ?? 0,
                shellRightPixels: shellRect?.right ?? 0,
                viewportWidth: innerWidth,
                documentWidth: document.documentElement.scrollWidth,
            },
            visibleClearHistoryCount: Array.from(
                clearControls
            ).filter(isVisible).length,
            clearHistoryCount: clearControls.length,
            clearHistoryText: clearControl?.textContent.trim() ?? null,
            clearHistoryTag: clearControl?.tagName.toLowerCase() ?? null,
            clearHistoryType: clearControl?.getAttribute("type") ?? null,
            clearHistoryHref: clearControl?.getAttribute("href") ?? null,
            clearHistoryInsideForm: Boolean(clearControl?.closest("form")),
            clearHistoryAppearsAfterResults:
                Boolean(clearControl && resultsList) &&
                Boolean(
                    resultsList.compareDocumentPosition(clearControl) &
                    Node.DOCUMENT_POSITION_FOLLOWING
                ),
            dialogCount: document.querySelectorAll("dialog, [role='dialog'], [role='alertdialog']").length,
            getResultsCalls: window.__issue16GetResultsCalls,
            saveResultCalls: window.__issue16SaveResultCalls,
            clearResultsCalls: window.__issue19ClearResultsCalls,
            markupReadyAtRead: window.__issue16MarkupReadyAtRead,
            rawHistory: localStorage.getItem(${JSON.stringify(storageKey)}),
            unrelatedStorageValue: localStorage.getItem(
                ${JSON.stringify(unrelatedStorageKey)}
            ),
        };
    })()`);

const assertSettledWithoutSideEffects = async (
    context,
    readCount,
    clearCount = 0,
) => {
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
    assert(
        (await evaluate("window.__issue19ClearResultsCalls")) === clearCount,
        `${context} retried or unexpectedly attempted a clear`,
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
    assert(state.clearResultsCalls === 0, `${context}: availability attempted a clear`);
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
    assert(state.clearResultsCalls === 0, `${mode}: Home attempted a clear`);
};

const assertUnavailableHistory = (state, mode, clearCount = 0) => {
    assert(state.pathname === "/history", `${mode}: History pathname changed`);
    assert(state.search === "" && state.hash === "", `${mode}: History URL has extra data`);
    assert(state.heading === "History", `${mode}: History heading changed`);
    assert(state.visibleEmptyMessageCount === 0, `${mode}: History shows the empty state`);
    assert(state.visibleTakeTestHrefs.length === 0, `${mode}: History shows Take Test`);
    assert(state.visibleResultListCount === 0, `${mode}: History shows a result list`);
    assert(state.visibleResultRowCount === 0, `${mode}: History shows a result row`);
    assert(state.resultRowCount === 0, `${mode}: History retains a result row`);
    assert(!state.chart.containerVisible, `${mode}: History shows the chart figure`);
    assert(!state.chart.headingVisible, `${mode}: History shows the chart heading`);
    assert(!state.chart.explanationVisible, `${mode}: History shows the chart explanation`);
    assert(state.chart.scoreLineCount === 0, `${mode}: History retains a score line`);
    assert(state.chart.points.length === 0, `${mode}: History retains score points`);
    assert(state.visibleClearHistoryCount === 0, `${mode}: History shows Clear All History`);
    assert(
        JSON.stringify(state.visibleNoticeTexts) === JSON.stringify([unavailableNotice]),
        `${mode}: History notice is missing, duplicated, or wrong`,
    );
    assert(
        JSON.stringify(state.visibleParagraphTexts) ===
            JSON.stringify([unavailableNotice]),
        `${mode}: History shows extra state copy`,
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
    assert(
        state.clearResultsCalls === clearCount,
        `${mode}: History clear call count is wrong`,
    );
};

const assertEmptyHistory = (state, clearCount = 0) => {
    assert(state.pathname === "/history", "empty History pathname changed");
    assert(state.search === "" && state.hash === "", "empty History URL has extra data");
    assert(state.heading === "History", "empty History heading changed");
    assert(state.visibleEmptyMessageCount === 1, "empty History message is missing or duplicated");
    assert(
        JSON.stringify(state.visibleTakeTestHrefs) === JSON.stringify([testUrl]),
        "empty History Take Test action is missing, duplicated, or wrong",
    );
    assert(state.visibleNoticeTexts.length === 0, "empty History shows unavailable notice");
    assert(
        JSON.stringify(state.visibleParagraphTexts) ===
            JSON.stringify(["No saved results yet."]),
        "empty History shows extra state copy",
    );
    assert(state.visibleResultListCount === 0, "empty History shows a result list");
    assert(state.visibleResultRowCount === 0, "empty History shows a result row");
    assert(state.resultRowCount === 0, "empty History retains a result row");
    assert(state.visibleChartCount === 0, "empty History shows a chart");
    assert(!state.chart.containerVisible, "empty History shows the chart figure");
    assert(!state.chart.headingVisible, "empty History shows the chart heading");
    assert(!state.chart.explanationVisible, "empty History shows the chart explanation");
    assert(state.chart.scoreLineCount === 0, "empty History retains a score line");
    assert(state.chart.points.length === 0, "empty History retains score points");
    assert(state.visibleClearHistoryCount === 0, "empty History shows Clear All History");
    assert(state.getResultsCalls === 1, "empty History was not read exactly once");
    assert(state.saveResultCalls === 0, "empty History performed a write probe");
    assert(
        state.clearResultsCalls === clearCount,
        "empty History clear call count is wrong",
    );
};

const approximatelyEqual = (actual, expected) =>
    Math.abs(actual - expected) < 0.001;

const parsePolylinePoints = (points) =>
    points.split(/\s+/).map((point) => point.split(",").map(Number));

const assertChart = (state, scores, context) => {
    const chart = state.chart;
    const expectedCutoffY = 164 - (13 / 24) * 148;
    const expectedCoordinates = scores.map((score, index) => ({
        x:
            scores.length === 1
                ? 160
                : 24 + index * (272 / (scores.length - 1)),
        y: 164 - (score / 24) * 148,
    }));
    assert(state.visibleChartCount === 1, `${context}: expected one inline SVG chart`);
    assert(chart.visibleContainerCount === 1, `${context}: expected one chart figure`);
    assert(chart.containerVisible, `${context}: chart figure is hidden`);
    assert(chart.containerTag === "figure", `${context}: chart container is not a figure`);
    assert(chart.appearsBeforeResults, `${context}: chart is not above the results list`);
    assert(chart.headingVisible && chart.heading === "Score trend", `${context}: chart heading is wrong`);
    assert(chart.explanationVisible, `${context}: chart explanation is hidden`);
    assert(chart.explanation === chartExplanation, `${context}: chart explanation is wrong`);
    assert(chart.svgVisible, `${context}: chart SVG is hidden`);
    assert(chart.namespace === "http://www.w3.org/2000/svg", `${context}: chart is not SVG`);
    assert(chart.role === "img", `${context}: chart role is wrong`);
    assert(
        chart.accessibleName === "Saved score trend from oldest to newest",
        `${context}: chart accessible name is wrong`,
    );
    assert(chart.viewBox === "0 0 320 180", `${context}: chart viewBox is wrong`);
    assert(chart.width === "100%", `${context}: chart width attribute is wrong`);
    assert(
        chart.preserveAspectRatio === "xMidYMid meet",
        `${context}: chart aspect-ratio mode is wrong`,
    );
    assert(chart.titleCount === 0, `${context}: chart contains a tooltip title`);
    assert(chart.cutoffLineCount === 1, `${context}: cutoff line count is wrong`);
    assert(chart.cutoff.visible, `${context}: cutoff line is hidden`);
    assert(chart.cutoff.x1 === 24 && chart.cutoff.x2 === 296, `${context}: cutoff x bounds are wrong`);
    assert(
        approximatelyEqual(chart.cutoff.y1, expectedCutoffY) &&
            approximatelyEqual(chart.cutoff.y2, expectedCutoffY),
        `${context}: cutoff y coordinate is wrong`,
    );
    assert(Boolean(chart.cutoff.dash), `${context}: cutoff line is not dashed`);
    assert(
        Boolean(chart.cutoff.stroke) && chart.cutoff.stroke !== "none",
        `${context}: cutoff line has no stroke`,
    );
    assert(chart.scoreLineCount === 1, `${context}: score polyline count is wrong`);
    assert(chart.scoreLineFill === "none", `${context}: score polyline is filled`);
    assert(
        Boolean(chart.scoreLineStroke) && chart.scoreLineStroke !== "none",
        `${context}: score polyline has no stroke`,
    );
    assert(chart.scoreLineVisible, `${context}: score polyline is hidden`);
    assert(chart.points.length === scores.length, `${context}: score point count is wrong`);
    for (let index = 0; index < chart.points.length; index += 1) {
        const point = chart.points[index];
        const expected = expectedCoordinates[index];
        assert(approximatelyEqual(point.x, expected.x), `${context}: point ${index} x is wrong`);
        assert(approximatelyEqual(point.y, expected.y), `${context}: point ${index} y is wrong`);
        assert(point.radius === 3, `${context}: point ${index} radius is wrong`);
        assert(point.visible, `${context}: point ${index} is hidden`);
        assert(
            Boolean(point.fill) && point.fill !== "none",
            `${context}: point ${index} has no fill`,
        );
        assert(
            point.namespace === "http://www.w3.org/2000/svg",
            `${context}: point ${index} was not created in the SVG namespace`,
        );
        assert(point.x >= 24 && point.x <= 296, `${context}: point ${index} exceeds x bounds`);
        assert(point.y >= 16 && point.y <= 164, `${context}: point ${index} exceeds y bounds`);
    }
    const lineCoordinates = parsePolylinePoints(chart.scoreLinePoints);
    assert(
        lineCoordinates.length === expectedCoordinates.length,
        `${context}: score polyline coordinate count is wrong`,
    );
    for (let index = 0; index < lineCoordinates.length; index += 1) {
        assert(
            approximatelyEqual(lineCoordinates[index][0], expectedCoordinates[index].x) &&
                approximatelyEqual(lineCoordinates[index][1], expectedCoordinates[index].y),
            `${context}: score polyline coordinate ${index} is wrong`,
        );
    }
    assert(chart.interactiveCount === 0, `${context}: chart contains interactive content`);
    assert(chart.focusableCount === 0, `${context}: chart contains a focus target`);
    assert(chart.animationElementCount === 0, `${context}: chart contains SVG animation`);
    assert(!chart.hasEventHandler, `${context}: chart has an event handler`);
    assert(!chart.hasPointerCursor, `${context}: chart uses a pointer cursor`);
    assert(!chart.hasTransition, `${context}: chart has a transition`);
    assert(!chart.hasAnimation, `${context}: chart has CSS animation`);
    const allowedHooks = new Set([
        "data-history-chart-container",
        "data-history-chart",
        "data-history-cutoff-line",
        "data-history-score-line",
        "data-history-score-point",
        "data-history-chart-explanation",
    ]);
    assert(
        chart.dataHooks.every((hook) => allowedHooks.has(hook)),
        `${context}: chart exposes an unsupported data hook`,
    );
    for (const hook of allowedHooks) {
        assert(chart.dataHooks.includes(hook), `${context}: chart is missing ${hook}`);
    }
    for (const result of seededResults) {
        assert(!chart.html.includes(String(result.timestamp)), `${context}: chart exposes a timestamp`);
    }
    assert(!/answer|response/i.test(chart.html), `${context}: chart exposes answer metadata`);
    assert(chart.widthPixels > 0 && chart.heightPixels > 0, `${context}: chart has no size`);
    assert(
        approximatelyEqual(chart.widthPixels / chart.heightPixels, 16 / 9),
        `${context}: chart does not preserve its 16:9 ratio`,
    );
    assert(
        chart.leftPixels >= 0 &&
            chart.rightPixels <= chart.viewportWidth &&
            chart.leftPixels >= chart.shellLeftPixels &&
            chart.rightPixels <= chart.shellRightPixels,
        `${context}: chart exceeds the viewport or page shell`,
    );
    assert(chart.documentWidth <= chart.viewportWidth, `${context}: chart causes horizontal overflow`);
};

const assertPopulatedHistory = async (state) => {
    assert(state.pathname === "/history", "populated History pathname changed");
    assert(state.search === "" && state.hash === "", "populated History URL has extra data");
    assert(state.heading === "History", "populated History heading changed");
    assert(state.visibleEmptyMessageCount === 0, "populated History shows the empty message");
    assert(state.visibleTakeTestHrefs.length === 0, "populated History shows Take Test");
    assert(state.visibleNoticeTexts.length === 0, "populated History shows unavailable notice");
    assert(state.visibleResultListCount === 1, "populated History does not show exactly one list");
    assert(
        state.visibleResultRowCount === seededResults.length,
        "populated History row count does not match the boundary",
    );
    assert(
        JSON.stringify(state.visibleResultRows.map((row) => row.values)) ===
            JSON.stringify(expectedNewestFirstRows),
        "populated History values, formatting, cutoff labels, or order are wrong",
    );
    for (const row of state.visibleResultRows) {
        assert(row.values.length === 4, "a History row exposes more than four values");
        assert(row.interactiveCount === 0, "a History row contains an interactive control");
        assert(row.tabIndex === -1, "a History row is keyboard-focusable");
        assert(row.role === null, "a History row declares an interactive role");
        assert(!row.hasClickHandler, "a History row has a click handler");
        for (const result of seededResults) {
            assert(
                !row.html.includes(String(result.timestamp)),
                "a History row exposes a raw timestamp",
            );
        }
    }
    assert(
        state.visibleClearHistoryCount === 1 && state.clearHistoryCount === 1,
        "populated History does not show exactly one Clear All History action",
    );
    assert(
        state.clearHistoryTag === "button" &&
            state.clearHistoryType === "button" &&
            state.clearHistoryText === "Clear All History",
        "populated History Clear All History action is not the required button",
    );
    assert(state.clearHistoryHref === null, "Clear All History is an anchor");
    assert(!state.clearHistoryInsideForm, "Clear All History is a form control");
    assert(
        state.clearHistoryAppearsAfterResults,
        "Clear All History is not after the chart and results list",
    );
    assert(state.getResultsCalls === 1, "populated History was not read exactly once");
    assert(state.saveResultCalls === 0, "populated History performed a write probe");
    assert(state.clearResultsCalls === 0, "populated History cleared before activation");
    assert(
        await evaluate(
            "JSON.stringify(window.__issue17ReturnedResults) === " +
                "window.__issue17ReturnedResultsBefore",
        ),
        "History presentation mutated the boundary-owned result order or records",
    );
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
    await client.send("Emulation.setTimezoneOverride", {
        timezoneId: "America/Los_Angeles",
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
    assert(state.clearResultsCalls === 0, "Test attempted to clear history");
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
    assert(
        JSON.stringify(await evaluate("window.__issue16OriginalBoundary.getResults()")) ===
            JSON.stringify({ ok: true, results: [] }),
        "empty-state Take Test created a persisted history record",
    );

    await evaluate(
        `window.__issue16OriginalBoundary.saveResult(${JSON.stringify(singleResult)})`,
    );
    await client.send("Page.navigate", { url: historyUrl });
    await waitForInitializedPage("/history", "History", "available");
    state = await snapshot();
    assertChart(state, [13], "single-result History");
    assert(state.visibleResultRowCount === 1, "single-result History list count changed");
    assert(
        JSON.stringify(state.visibleResultRows[0].values) ===
            JSON.stringify(expectedNewestFirstRows[4]),
        "single-result History list values changed",
    );
    await assertSettledWithoutSideEffects("single-result History", 1);

    await evaluate(
        `window.__issue16OriginalBoundary.saveResult(${JSON.stringify(equalScoreResult)})`,
    );
    await client.send("Page.reload", { ignoreCache: true });
    await waitForInitializedPage("/history", "History", "available");
    state = await snapshot();
    assertChart(state, [13, 13], "equal-score History");
    assert(state.visibleResultRowCount === 2, "equal-score History list count changed");
    assert(
        state.visibleResultRows.every(
            (row) => JSON.stringify(row.values) === JSON.stringify(expectedNewestFirstRows[4])
        ),
        "equal-score History did not preserve duplicate list rows",
    );
    await assertSettledWithoutSideEffects("equal-score History", 1);

    await evaluate(`(() => {
        const additionalResults = ${JSON.stringify(additionalResults)};
        return additionalResults.map((result) =>
            window.__issue16OriginalBoundary.saveResult(result)
        );
    })()`);
    await client.send("Page.navigate", { url: homeUrl });
    await waitForInitializedPage("/", "K6-Based Psychological Distress Check", "available");
    state = await snapshot();
    assertAvailableHome(state, "populated history");

    await pointerClickLink("View History");
    await waitForInitializedPage("/history", "History", "available");
    state = await snapshot();
    await assertPopulatedHistory(state);
    assertChart(state, expectedOldestFirstScores, "populated History");
    const chartBeforeInteraction = JSON.stringify({
        url: state.url,
        historyState: state.historyState,
        line: state.chart.scoreLinePoints,
        points: state.chart.points,
        rows: state.visibleResultRows.map((row) => row.values),
    });
    await pointerClickElement("[data-history-chart]");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
    state = await snapshot();
    assert(
        JSON.stringify({
            url: state.url,
            historyState: state.historyState,
            line: state.chart.scoreLinePoints,
            points: state.chart.points,
            rows: state.visibleResultRows.map((row) => row.values),
        }) === chartBeforeInteraction,
        "chart interaction changed chart or list content",
    );
    assert((await evaluate("location.pathname")) === "/history", "chart interaction changed URL");
    await pointerClickElement("[data-history-result]");
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" });
    assert((await evaluate("location.pathname")) === "/history", "row interaction changed URL");
    await assertSettledWithoutSideEffects("populated History", 1);

    await installBoundaryMode("clear-reentrant-success");
    await navigate(
        historyUrl,
        "/history",
        "History",
        "clear-reentrant-success",
    );
    state = await snapshot();
    await assertPopulatedHistory(state);
    assertChart(state, expectedOldestFirstScores, "clearable populated History");
    await evaluate(`localStorage.setItem(
        ${JSON.stringify(unrelatedStorageKey)},
        "preserve this value",
    )`);
    const populatedRawHistory = state.rawHistory;
    assert(populatedRawHistory !== null, "populated History has no persisted history");
    const urlBeforeClear = state.url;
    const historyStateBeforeClear = JSON.stringify(state.historyState);
    const dialogsBeforeClear = client.dialogs.length;
    const requestsBeforeClear = client.networkRequests.length;
    await evaluate(
        "window.__issue19RetainedClearButton = " +
            'document.querySelector("[data-clear-history]")',
    );
    await pointerClickElement("[data-clear-history]");
    state = await snapshot();
    assertEmptyHistory(state, 1);
    assert(state.url === urlBeforeClear, "successful clear changed the History URL");
    assert(
        JSON.stringify(state.historyState) === historyStateBeforeClear,
        "successful clear changed browser history state",
    );
    assert(state.resultRowCount === 0, "successful clear retained generated result rows");
    assert(state.chart.scoreLineCount === 0, "successful clear retained the score line");
    assert(state.chart.points.length === 0, "successful clear retained score points");
    assert(state.rawHistory === null, "successful clear left the history key present");
    assert(
        state.unrelatedStorageValue === "preserve this value",
        "successful clear changed unrelated browser storage",
    );
    assert(client.dialogs.length === dialogsBeforeClear, "successful clear opened a dialog");
    assert(
        client.networkRequests.length === requestsBeforeClear,
        "successful clear caused a post-load network request",
    );
    await evaluate(`(() => {
        const button = window.__issue19RetainedClearButton;
        button.click();
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        window.dispatchEvent(new Event("pageshow"));
        document.dispatchEvent(new Event("visibilitychange"));
    })()`);
    await assertSettledWithoutSideEffects("successful clear", 1, 1);

    await client.send("Page.reload", { ignoreCache: true });
    await waitForInitializedPage("/history", "History", "available");
    state = await snapshot();
    assertEmptyHistory(state);
    assert(state.rawHistory === null, "reload restored successfully cleared history");
    assert(
        state.unrelatedStorageValue === "preserve this value",
        "reload lost unrelated browser storage after clear",
    );

    await evaluate(
        `window.__issue16OriginalBoundary.saveResult(${JSON.stringify(singleResult)})`,
    );
    const clearFailureModes = [
        "clear-storage-unavailable",
        "clear-arbitrary-non-success",
        "clear-invalid-success",
        "clear-undefined",
        "clear-throw",
    ];
    for (let index = 0; index < clearFailureModes.length; index += 1) {
        const mode = clearFailureModes[index];
        await installBoundaryMode(mode);
        await navigate(historyUrl, "/history", "History", mode);
        state = await snapshot();
        await assertPopulatedHistory(state);
        const rawHistoryBeforeFailedClear = state.rawHistory;
        const failedClearUrl = state.url;
        const failedClearHistoryState = JSON.stringify(state.historyState);
        const exceptionsBeforeFailedClear = client.exceptions.length;
        const dialogsBeforeFailedClear = client.dialogs.length;
        const requestsBeforeFailedClear = client.networkRequests.length;
        await evaluate(
            "window.__issue19RetainedClearButton = " +
                'document.querySelector("[data-clear-history]")',
        );
        if (index === 0) {
            await evaluate(
                'document.querySelector("[data-clear-history]").focus()',
            );
            await client.send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "Enter",
            });
            await client.send("Input.dispatchKeyEvent", {
                type: "keyUp",
                key: "Enter",
            });
        } else {
            await pointerClickElement("[data-clear-history]");
        }
        state = await snapshot();
        assertUnavailableHistory(state, mode, 1);
        assert(state.url === failedClearUrl, `${mode}: failed clear changed the URL`);
        assert(
            JSON.stringify(state.historyState) === failedClearHistoryState,
            `${mode}: failed clear changed browser history state`,
        );
        assert(state.resultRowCount === 0, `${mode}: failed clear retained result rows`);
        assert(state.chart.scoreLineCount === 0, `${mode}: failed clear retained score line`);
        assert(state.chart.points.length === 0, `${mode}: failed clear retained score points`);
        assert(
            state.rawHistory === rawHistoryBeforeFailedClear,
            `${mode}: failed clear changed persisted history`,
        );
        assert(
            state.unrelatedStorageValue === "preserve this value",
            `${mode}: failed clear changed unrelated browser storage`,
        );
        assert(
            client.exceptions.length === exceptionsBeforeFailedClear,
            `${mode}: failed clear exposed an uncaught exception`,
        );
        assert(
            client.dialogs.length === dialogsBeforeFailedClear,
            `${mode}: failed clear opened a dialog`,
        );
        assert(
            client.networkRequests.length === requestsBeforeFailedClear,
            `${mode}: failed clear caused a post-load network request`,
        );
        await evaluate(`(() => {
            const button = window.__issue19RetainedClearButton;
            button.click();
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            window.dispatchEvent(new Event("pageshow"));
            document.dispatchEvent(new Event("visibilitychange"));
        })()`);
        await assertSettledWithoutSideEffects(mode, 1, 1);
    }

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

    const malformedHistory = "malformed history must remain unchanged";
    await installBoundaryMode("available");
    await evaluate(
        `localStorage.setItem(
            ${JSON.stringify(storageKey)},
            ${JSON.stringify(malformedHistory)},
        )`,
    );
    await navigate(historyUrl, "/history", "History", "malformed-real-storage");
    state = await snapshot();
    assertUnavailableHistory(state, "malformed-real-storage");
    assert(
        state.rawHistory === malformedHistory,
        "malformed History initialization changed the stored value",
    );
    await assertSettledWithoutSideEffects("malformed real-storage History", 1);

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
