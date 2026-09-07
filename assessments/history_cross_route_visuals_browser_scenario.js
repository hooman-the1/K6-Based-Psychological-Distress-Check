import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [websocketUrl, testUrl, homeUrl, historyUrl, screenshotDirectory] =
    process.argv.slice(2);
const resultUrl = new URL("/result", testUrl).href;
const appOrigin = new URL(testUrl).origin;
const storageKey = "k6-based-distress-check.history.v1";
const viewports = [
    { width: 320, height: 900 },
    { width: 375, height: 900 },
    { width: 768, height: 1024 },
];
const colors = {
    border: "rgb(188, 204, 220)",
    danger: "rgb(159, 18, 57)",
    dangerHover: "rgb(127, 18, 48)",
    focus: "rgb(124, 58, 237)",
    muted: "rgb(82, 96, 109)",
    page: "rgb(247, 248, 250)",
    primary: "rgb(11, 92, 173)",
    surface: "rgb(255, 255, 255)",
    text: "rgb(31, 41, 51)",
};
const baseTimestamp = Date.parse("2026-09-01T12:00:00Z");
const oneResult = [{ score: 13, timestamp: baseTimestamp }];
const threeResults = [
    { score: 4, timestamp: baseTimestamp },
    { score: 13, timestamp: baseTimestamp + 1000 },
    { score: 24, timestamp: baseTimestamp + 2000 },
];
const twentyResults = Array.from({ length: 20 }, (_, index) => ({
    score: index === 11 ? 12 : index % 19,
    timestamp: baseTimestamp + Math.floor(index / 2) * 1000,
}));
twentyResults[10] = { score: 12, timestamp: baseTimestamp + 5000 };

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const approximatelyEqual = (actual, expected, tolerance = 0.7) =>
    Math.abs(actual - expected) <= tolerance;
const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

class DevToolsClient {
    constructor(websocket) {
        this.websocket = websocket;
        this.nextMessageId = 1;
        this.pendingMessages = new Map();
        this.eventHandlers = new Map();
        websocket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data.toString());
            const pending = this.pendingMessages.get(message.id);
            if (pending) {
                this.pendingMessages.delete(message.id);
                if (message.error) pending.reject(new Error(message.error.message));
                else pending.resolve(message.result);
                return;
            }
            for (const handler of this.eventHandlers.get(message.method) ?? []) {
                handler(message.params);
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
        const debuggingOrigin = new URL(initialUrl.replace(/^ws:/, "http:")).origin;
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
                    const opened = () => {
                        websocket.removeEventListener("error", failed);
                        resolve();
                    };
                    const failed = (error) => {
                        websocket.removeEventListener("open", opened);
                        reject(error);
                    };
                    websocket.addEventListener("open", opened, { once: true });
                    websocket.addEventListener("error", failed, { once: true });
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

    on(method, handler) {
        const handlers = this.eventHandlers.get(method) ?? [];
        handlers.push(handler);
        this.eventHandlers.set(method, handlers);
    }

    close() {
        this.websocket.close();
    }
}

const client = await DevToolsClient.connect(websocketUrl);
const requests = [];
const exceptions = [];
const dialogs = [];
client.on("Network.requestWillBeSent", ({ request }) => requests.push(request));
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
    exceptions.push(exceptionDetails));
client.on("Page.javascriptDialogOpening", ({ message }) => dialogs.push(message));

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

const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try {
            if (await evaluate(predicate)) return;
        } catch {
            // Navigation can briefly destroy the previous execution context.
        }
        await delay(50);
    }
    throw new Error(message);
};

let boundaryScriptIdentifier = null;
const installBoundaryMode = async (mode) => {
    if (boundaryScriptIdentifier !== null) {
        await client.send("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: boundaryScriptIdentifier,
        });
    }
    const source = `(() => {
        const mode = ${JSON.stringify(mode)};
        let exposedBoundary;
        window.__issue22GetResultsCalls = 0;
        window.__issue22SaveResultCalls = 0;
        window.__issue22ClearResultsCalls = 0;
        window.__issue22ReturnedResultsBefore = null;
        Object.defineProperty(window, "AssessmentHistory", {
            configurable: true,
            get() { return exposedBoundary; },
            set(boundary) {
                window.__issue22OriginalBoundary = boundary;
                exposedBoundary = Object.freeze({
                    getResults() {
                        window.__issue22GetResultsCalls += 1;
                        if (mode === "unavailable-read") {
                            return { ok: false, reason: "storage-unavailable" };
                        }
                        const result = boundary.getResults();
                        if (result?.ok === true && Array.isArray(result.results)) {
                            window.__issue22ReturnedResults = result.results;
                            window.__issue22ReturnedResultsBefore = JSON.stringify(result.results);
                        }
                        return result;
                    },
                    saveResult(result) {
                        window.__issue22SaveResultCalls += 1;
                        return boundary.saveResult(result);
                    },
                    clearResults() {
                        window.__issue22ClearResultsCalls += 1;
                        if (mode === "clear-failure") {
                            return { ok: false, reason: "storage-unavailable" };
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
    boundaryScriptIdentifier = installed.identifier;
};

const setViewport = ({ width, height }) =>
    client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
    });

const navigate = async (url, predicate, message) => {
    await client.send("Page.navigate", { url });
    await waitFor(predicate, message);
};

const seedHistory = async (results) => {
    if (results.length === 0) {
        await evaluate(`localStorage.removeItem(${JSON.stringify(storageKey)})`);
        return;
    }
    await evaluate(
        `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(results))})`,
    );
};

const loadHistory = async (results, mode = "available") => {
    await installBoundaryMode(mode);
    await seedHistory(results);
    const expectedCount = mode === "unavailable-read" ? 0 : results.length;
    await navigate(
        historyUrl,
        `location.pathname === "/history" && document.readyState === "complete" &&
            window.__issue22GetResultsCalls === 1 &&
            document.querySelectorAll("[data-history-result]").length === ${expectedCount}`,
        `${mode} History with ${results.length} seeded records did not settle`,
    );
};

const pointerMove = async (selector) => {
    const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element || element.hidden) return null;
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    assert(point, `missing visible element: ${selector}`);
    await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
    });
};

const pointerClick = async (selector) => {
    await pointerMove(selector);
    const point = await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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

const pressTab = async (shift = false) => {
    await client.send("Page.bringToFront");
    await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        modifiers: shift ? 8 : 0,
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
    });
    await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Tab",
        code: "Tab",
        modifiers: shift ? 8 : 0,
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
    });
};

const captureScreenshot = async (name, resetScroll = true) => {
    if (resetScroll) await evaluate("document.scrollingElement.scrollTop = 0");
    const screenshot = await client.send("Page.captureScreenshot", {
        captureBeyondViewport: false,
        format: "png",
        fromSurface: true,
    });
    await writeFile(
        path.join(screenshotDirectory, `${name}.png`),
        screenshot.data,
        "base64",
    );
};

const pageSnapshot = () =>
    evaluate(`(() => {
        const rect = (element) => {
            if (!element) return null;
            const bounds = element.getBoundingClientRect();
            return {
                bottom: bounds.bottom,
                height: bounds.height,
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
                width: bounds.width,
            };
        };
        const style = (element) => {
            if (!element) return null;
            const computed = getComputedStyle(element);
            return {
                alignSelf: computed.alignSelf,
                animationName: computed.animationName,
                backgroundColor: computed.backgroundColor,
                borderColor: computed.borderTopColor,
                borderRadius: computed.borderRadius,
                borderWidth: computed.borderTopWidth,
                boxShadow: computed.boxShadow,
                color: computed.color,
                columnGap: computed.columnGap,
                cursor: computed.cursor,
                display: computed.display,
                fill: computed.fill,
                fontSize: computed.fontSize,
                fontVariantNumeric: computed.fontVariantNumeric,
                fontWeight: computed.fontWeight,
                gap: computed.gap,
                gridColumn: computed.gridColumn,
                gridColumnEnd: computed.gridColumnEnd,
                gridColumnStart: computed.gridColumnStart,
                gridRow: computed.gridRow,
                gridRowEnd: computed.gridRowEnd,
                gridRowStart: computed.gridRowStart,
                gridTemplateColumns: computed.gridTemplateColumns,
                justifySelf: computed.justifySelf,
                lineHeight: computed.lineHeight,
                listStyleType: computed.listStyleType,
                marginBottom: computed.marginBottom,
                marginLeft: computed.marginLeft,
                marginRight: computed.marginRight,
                marginTop: computed.marginTop,
                maxHeight: computed.maxHeight,
                opacity: computed.opacity,
                outlineColor: computed.outlineColor,
                outlineOffset: computed.outlineOffset,
                outlineStyle: computed.outlineStyle,
                outlineWidth: computed.outlineWidth,
                overflow: computed.overflow,
                overflowX: computed.overflowX,
                overflowY: computed.overflowY,
                paddingBottom: computed.paddingBottom,
                paddingLeft: computed.paddingLeft,
                paddingRight: computed.paddingRight,
                paddingTop: computed.paddingTop,
                position: computed.position,
                rowGap: computed.rowGap,
                stroke: computed.stroke,
                strokeDasharray: computed.strokeDasharray,
                strokeLinecap: computed.strokeLinecap,
                strokeLinejoin: computed.strokeLinejoin,
                strokeWidth: computed.strokeWidth,
                transform: computed.transform,
                transitionDuration: computed.transitionDuration,
                vectorEffect: computed.vectorEffect,
                whiteSpace: computed.whiteSpace,
            };
        };
        const visible = (element) => Boolean(
            element && !element.hidden && element.getClientRects().length > 0 &&
            getComputedStyle(element).display !== "none"
        );
        const shell = document.querySelector("main.page-shell");
        const heading = shell?.querySelector("h1");
        const unavailable = document.querySelector("[data-history-unavailable]");
        const empty = document.querySelector("[data-history-empty]");
        const figure = document.querySelector("[data-history-chart-container]");
        const chartHeading = figure?.querySelector("h2");
        const svg = document.querySelector("[data-history-chart]");
        const cutoff = document.querySelector("[data-history-cutoff-line]");
        const scoreLine = document.querySelector("[data-history-score-line]");
        const points = Array.from(document.querySelectorAll("[data-history-score-point]"));
        const explanation = document.querySelector("[data-history-chart-explanation]");
        const list = document.querySelector("[data-history-results]");
        const rows = Array.from(document.querySelectorAll("[data-history-result]"));
        const clear = document.querySelector("[data-clear-history]");
        const visibleFirstBlock = [unavailable, empty, figure].find(visible);
        const root = getComputedStyle(document.documentElement);
        return {
            pathname: location.pathname,
            viewportWidth: innerWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            horizontalOverflowers: Array.from(document.querySelectorAll("body *"))
                .map((element) => ({
                    name: element.tagName + (element.getAttribute("data-history-result") !== null ? "[result]" : ""),
                    right: rect(element).right,
                    scrollWidth: element.scrollWidth,
                    width: rect(element).width,
                }))
                .filter((item) => item.right > innerWidth + 0.5 || item.scrollWidth > item.width + 0.5),
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight,
            scrollY,
            mainCount: document.querySelectorAll("main.page-shell").length,
            headingCount: document.querySelectorAll("main.page-shell h1").length,
            forbiddenChromeCount: document.querySelectorAll("body > header, body > nav, body > footer, aside").length,
            tokens: [
                "--color-page", "--color-surface", "--color-text", "--color-muted",
                "--color-border", "--color-primary", "--color-focus", "--color-danger",
                "--space-2", "--space-3", "--space-4", "--space-5",
            ].map((name) => [name, root.getPropertyValue(name).trim()]),
            shell: { rect: rect(shell), style: style(shell) },
            heading: { rect: rect(heading), style: style(heading), text: heading?.textContent.trim() },
            firstBlockGap: visibleFirstBlock ? rect(visibleFirstBlock).top - rect(heading).bottom : null,
            visibleStateCount: [unavailable, empty, figure].filter(visible).length,
            unavailable: {
                rect: rect(unavailable), style: style(unavailable), text: unavailable?.textContent.trim(),
                visible: visible(unavailable), interactiveCount: unavailable?.querySelectorAll("a, button, input").length,
            },
            empty: {
                rect: rect(empty), style: style(empty), visible: visible(empty),
                message: empty?.querySelector("p")?.textContent.trim(),
                messageRect: rect(empty?.querySelector("p")),
                link: empty?.querySelector("a") ? {
                    href: empty.querySelector("a").href,
                    rect: rect(empty.querySelector("a")),
                    style: style(empty.querySelector("a")),
                    text: empty.querySelector("a").textContent.trim(),
                } : null,
            },
            figure: {
                rect: rect(figure), style: style(figure), visible: visible(figure),
                heading: { rect: rect(chartHeading), style: style(chartHeading), text: chartHeading?.textContent.trim() },
                svg: {
                    rect: rect(svg), style: style(svg),
                    role: svg?.getAttribute("role"), ariaLabel: svg?.getAttribute("aria-label"),
                    viewBox: svg?.getAttribute("viewBox"), width: svg?.getAttribute("width"),
                    preserveAspectRatio: svg?.getAttribute("preserveAspectRatio"),
                    interactiveCount: svg?.querySelectorAll("a, button, input, [tabindex]").length,
                },
                cutoff: cutoff ? {
                    attributes: ["x1", "x2", "y1", "y2", "stroke-dasharray"].map(
                        (name) => [name, cutoff.getAttribute(name)]),
                    style: style(cutoff),
                } : null,
                scoreLine: scoreLine ? {
                    points: scoreLine.getAttribute("points"), style: style(scoreLine),
                } : null,
                points: points.map((point) => ({
                    cx: Number(point.getAttribute("cx")),
                    cy: Number(point.getAttribute("cy")),
                    r: point.getAttribute("r"),
                    style: style(point),
                })),
                explanation: {
                    rect: rect(explanation), style: style(explanation),
                    text: explanation?.textContent.trim(),
                },
            },
            list: {
                rect: rect(list), style: style(list), visible: visible(list),
                rows: rows.map((row) => ({
                    rect: rect(row), style: style(row), tabIndex: row.tabIndex,
                    role: row.getAttribute("role"), onclick: row.onclick !== null,
                    interactiveCount: row.querySelectorAll("a, button, input, form, select, textarea, [tabindex]").length,
                    html: row.outerHTML,
                    values: Array.from(row.children, (value) => ({
                        rect: rect(value), style: style(value), text: value.textContent.trim(),
                    })),
                })),
            },
            clear: {
                rect: rect(clear), style: style(clear), visible: visible(clear),
                text: clear?.textContent.trim(), type: clear?.type,
            },
            counters: {
                get: window.__issue22GetResultsCalls,
                save: window.__issue22SaveResultCalls,
                clear: window.__issue22ClearResultsCalls,
            },
            boundaryUnchanged: window.__issue22ReturnedResults
                ? JSON.stringify(window.__issue22ReturnedResults) === window.__issue22ReturnedResultsBefore
                : true,
            rawHistory: localStorage.getItem(${JSON.stringify(storageKey)}),
        };
    })()`);

const expectedContentWidth = (width) => (width === 320 ? 246 : width === 375 ? 301 : 510);
const expectedSvgWidth = (width) => (width === 320 ? 212 : width === 375 ? 267 : 476);

const assertSharedPage = (state, viewport, context) => {
    const expectedShellWidth = viewport.width === 768 ? 576 : viewport.width - 32;
    const expectedGutter = viewport.width === 768 ? 96 : 16;
    const expectedPadding = viewport.width === 768 ? 32 : 20;
    assert(state.mainCount === 1 && state.headingCount === 1, `${context}: landmark count changed`);
    assert(state.forbiddenChromeCount === 0, `${context}: persistent chrome was introduced`);
    assert(
        approximatelyEqual(state.shell.rect.width, expectedShellWidth) &&
            approximatelyEqual(state.shell.rect.left, expectedGutter) &&
            approximatelyEqual(viewport.width - state.shell.rect.right, expectedGutter) &&
            state.shell.style.paddingLeft === `${expectedPadding}px` &&
            state.shell.style.backgroundColor === colors.surface &&
            state.shell.style.borderColor === colors.border,
        `${context}: shared shell geometry or surface changed (${JSON.stringify(state.shell)})`,
    );
    assert(
        state.heading.style.fontSize === "32px" && state.heading.style.lineHeight === "38.4px" &&
            state.heading.style.fontWeight === "700" && state.heading.style.color === colors.text,
        `${context}: h1 typography changed`,
    );
    assert(state.documentScrollWidth <= viewport.width,
        `${context}: horizontal overflow (${JSON.stringify(state.horizontalOverflowers)})`);
};

const assertEmptyHistory = (state, viewport, context = "empty History", expectedClearCalls = 0) => {
    assertSharedPage(state, viewport, `${context} at ${viewport.width}px`);
    assert(state.pathname === "/history" && state.heading.text === "History", `${context}: route or heading changed`);
    assert(state.visibleStateCount === 1 && state.empty.visible && !state.unavailable.visible && !state.figure.visible,
        `${context}: states are not mutually exclusive`);
    assert(approximatelyEqual(state.firstBlockGap, 16), `${context}: first block gap is not 16px`);
    assert(
        approximatelyEqual(state.empty.rect.width, expectedContentWidth(viewport.width)) &&
            state.empty.style.paddingTop === "24px" && state.empty.style.paddingRight === "24px" &&
            state.empty.style.paddingBottom === "24px" && state.empty.style.paddingLeft === "24px" &&
            state.empty.style.borderWidth === "1px" && state.empty.style.borderColor === colors.border &&
            state.empty.style.borderRadius === "8px" && state.empty.style.backgroundColor === colors.page &&
            state.empty.message === "No saved results yet." &&
            approximatelyEqual(state.empty.link.rect.top - state.empty.messageRect.bottom, 16) &&
            approximatelyEqual(state.empty.link.rect.left, state.empty.rect.left + 25) &&
            state.empty.link.href === testUrl && state.empty.link.rect.width >= 44 &&
            state.empty.link.rect.height >= 44,
        `${context}: empty panel presentation is wrong`,
    );
    assert(!state.list.visible && !state.clear.visible && state.list.rows.length === 0,
        `${context}: populated content remains visible`);
    assert(state.counters.get === 1 && state.counters.save === 0 && state.counters.clear === expectedClearCalls,
        `${context}: storage boundary call counts changed`);
};

const assertUnavailableHistory = (state, viewport, context = "unavailable History", expectedClearCalls = 0) => {
    assertSharedPage(state, viewport, `${context} at ${viewport.width}px`);
    assert(state.pathname === "/history" && state.heading.text === "History", `${context}: route or heading changed`);
    assert(state.visibleStateCount === 1 && state.unavailable.visible && !state.empty.visible && !state.figure.visible,
        `${context}: states are not mutually exclusive`);
    assert(approximatelyEqual(state.firstBlockGap, 16), `${context}: first block gap is not 16px`);
    assert(
        approximatelyEqual(state.unavailable.rect.width, expectedContentWidth(viewport.width)) &&
            state.unavailable.style.paddingTop === "16px" && state.unavailable.style.paddingRight === "16px" &&
            state.unavailable.style.paddingBottom === "16px" && state.unavailable.style.paddingLeft === "16px" &&
            state.unavailable.style.borderWidth === "1px" &&
            state.unavailable.style.borderColor === colors.border &&
            state.unavailable.style.borderRadius === "8px" &&
            state.unavailable.style.backgroundColor === colors.page &&
            state.unavailable.text === "Saved history is unavailable in this browser." &&
            state.unavailable.interactiveCount === 0,
        `${context}: unavailable panel presentation is wrong`,
    );
    assert(!state.list.visible && !state.clear.visible && state.list.rows.length === 0,
        `${context}: stale populated content remains`);
    assert(state.counters.get === 1 && state.counters.save === 0 && state.counters.clear === expectedClearCalls,
        `${context}: storage boundary call counts changed`);
};

const assertNoMotion = (items, context) => {
    assert(
        items.every((item) =>
            item.style.animationName === "none" && item.style.transitionDuration === "0s"),
        `${context}: motion is enabled`,
    );
};

const orderedOldestFirst = (results) =>
    results
        .map((result, index) => ({ ...result, index }))
        .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index);

const expectedPoint = (result, index, count) => ({
    x: count === 1 ? 160 : 24 + (index * 272) / (count - 1),
    y: 164 - (result.score / 24) * 148,
});

const assertPopulatedHistory = (state, viewport, results, context = "populated History") => {
    const contentWidth = expectedContentWidth(viewport.width);
    const svgWidth = expectedSvgWidth(viewport.width);
    assertSharedPage(state, viewport, `${context} at ${viewport.width}px`);
    assert(state.pathname === "/history" && state.heading.text === "History", `${context}: route or heading changed`);
    assert(state.visibleStateCount === 1 && state.figure.visible && !state.empty.visible && !state.unavailable.visible,
        `${context}: states are not mutually exclusive`);
    assert(approximatelyEqual(state.firstBlockGap, 16), `${context}: first block gap is not 16px`);
    assert(
        approximatelyEqual(state.figure.rect.width, contentWidth) &&
            state.figure.style.paddingTop === "16px" && state.figure.style.paddingRight === "16px" &&
            state.figure.style.paddingBottom === "16px" && state.figure.style.paddingLeft === "16px" &&
            state.figure.style.borderWidth === "1px" && state.figure.style.borderColor === colors.border &&
            state.figure.style.borderRadius === "8px" && state.figure.style.backgroundColor === colors.page &&
            state.figure.style.overflow === "visible",
        `${context}: figure panel is wrong (${JSON.stringify(state.figure)})`,
    );
    assert(
        state.figure.heading.text === "Score trend" && state.figure.heading.style.fontSize === "24px" &&
            state.figure.heading.style.lineHeight === "30px" && state.figure.heading.style.fontWeight === "700" &&
            approximatelyEqual(state.figure.svg.rect.top - state.figure.heading.rect.bottom, 12) &&
            approximatelyEqual(state.figure.svg.rect.width, svgWidth) &&
            approximatelyEqual(state.figure.svg.rect.height, (svgWidth * 9) / 16) &&
            state.figure.svg.role === "img" && state.figure.svg.ariaLabel === "Saved score trend from oldest to newest" &&
            state.figure.svg.viewBox === "0 0 320 180" && state.figure.svg.width === "100%" &&
            state.figure.svg.preserveAspectRatio === "xMidYMid meet" && state.figure.svg.interactiveCount === 0,
        `${context}: chart heading or SVG contract is wrong (${JSON.stringify({ heading: state.figure.heading, svg: state.figure.svg })})`,
    );
    const cutoffAttributes = Object.fromEntries(state.figure.cutoff.attributes);
    assert(
        cutoffAttributes.x1 === "24" && cutoffAttributes.x2 === "296" &&
            approximatelyEqual(Number(cutoffAttributes.y1), 83.83333333333333, 0.001) &&
            cutoffAttributes.y1 === cutoffAttributes.y2 && cutoffAttributes["stroke-dasharray"] === "4 4" &&
            state.figure.cutoff.style.fill === "none" && state.figure.cutoff.style.stroke === colors.muted &&
            state.figure.cutoff.style.strokeWidth === "1px" &&
            state.figure.cutoff.style.vectorEffect === "non-scaling-stroke",
        `${context}: cutoff line contract is wrong`,
    );
    const ordered = orderedOldestFirst(results);
    const expectedPoints = ordered.map((result, index) =>
        expectedPoint(result, index, ordered.length));
    assert(state.figure.points.length === ordered.length, `${context}: point count changed`);
    for (let index = 0; index < expectedPoints.length; index += 1) {
        const actual = state.figure.points[index];
        const expected = expectedPoints[index];
        assert(
            approximatelyEqual(actual.cx, expected.x, 0.001) && approximatelyEqual(actual.cy, expected.y, 0.001) &&
                actual.r === "3" && actual.style.fill === colors.primary && actual.style.stroke === "none",
            `${context}: point ${index + 1} geometry or style is wrong`,
        );
    }
    const lineCoordinates = state.figure.scoreLine.points.trim().split(/\s+/).map((pair) =>
        pair.split(",").map(Number));
    assert(lineCoordinates.length === expectedPoints.length, `${context}: line point count changed`);
    for (let index = 0; index < expectedPoints.length; index += 1) {
        assert(
            approximatelyEqual(lineCoordinates[index][0], expectedPoints[index].x, 0.001) &&
                approximatelyEqual(lineCoordinates[index][1], expectedPoints[index].y, 0.001),
            `${context}: line order or geometry changed at point ${index + 1}`,
        );
    }
    assert(
        state.figure.scoreLine.style.fill === "none" && state.figure.scoreLine.style.stroke === colors.primary &&
            state.figure.scoreLine.style.strokeWidth === "2px" &&
            state.figure.scoreLine.style.strokeLinecap === "round" &&
            state.figure.scoreLine.style.strokeLinejoin === "round" &&
            state.figure.scoreLine.style.strokeDasharray === "none" &&
            state.figure.scoreLine.style.vectorEffect === "non-scaling-stroke",
        `${context}: score line style is wrong`,
    );
    assert(
        state.figure.explanation.text === "Scores are shown from oldest to newest. The horizontal line marks the cutoff score of 13." &&
            approximatelyEqual(state.figure.explanation.rect.top - state.figure.svg.rect.bottom, 12) &&
            state.figure.explanation.style.fontSize === "14px" &&
            state.figure.explanation.style.lineHeight === "21px" &&
            state.figure.explanation.style.color === colors.muted,
        `${context}: chart explanation is wrong`,
    );
    assert(
        state.list.visible && approximatelyEqual(state.list.rect.width, contentWidth) &&
            approximatelyEqual(state.list.rect.top - state.figure.rect.bottom, 24) &&
            state.list.style.display === "grid" && state.list.style.gap === "12px" &&
            state.list.style.paddingLeft === "0px" && state.list.style.listStyleType === "none" &&
            state.list.style.overflowY === "visible" && state.list.style.maxHeight === "none" &&
            state.list.rows.length === results.length,
        `${context}: results list layout is wrong`,
    );
    const newestFirst = ordered.slice().reverse();
    state.list.rows.forEach((row, index) => {
        const record = newestFirst[index];
        assert(
            approximatelyEqual(row.rect.width, contentWidth) && row.style.display === "grid" &&
                row.style.gridTemplateColumns.endsWith("px") && row.style.columnGap === "16px" &&
                row.style.rowGap === "4px" && row.style.paddingTop === "16px" &&
                row.style.paddingRight === "16px" && row.style.paddingBottom === "16px" &&
                row.style.paddingLeft === "16px" && row.style.borderWidth === "1px" &&
                row.style.borderColor === colors.border && row.style.borderRadius === "8px" &&
                row.style.backgroundColor === colors.surface && row.style.boxShadow === "none" &&
                row.style.transform === "none" && row.tabIndex === -1 && row.role === null && !row.onclick &&
                row.interactiveCount === 0 && row.values.length === 4 && !row.html.includes("timestamp") &&
                !row.html.includes("answers"),
            `${context}: row ${index + 1} card or privacy contract is wrong`,
        );
        const [date, time, score, status] = row.values;
        assert(
            date.style.gridColumnStart === "1" && date.style.gridRowStart === "1" &&
                date.style.fontSize === "16px" && date.style.lineHeight === "24px" && date.style.fontWeight === "600" &&
                time.style.gridColumnStart === "1" && time.style.gridRowStart === "2" &&
                time.style.fontSize === "14px" && time.style.lineHeight === "21px" && time.style.color === colors.muted &&
                score.style.gridColumnStart === "2" && score.style.gridRowStart === "1" && score.style.gridRowEnd === "3" &&
                score.style.alignSelf === "center" && score.style.justifySelf === "end" &&
                score.style.fontSize === "24px" && score.style.lineHeight === "30px" && score.style.fontWeight === "700" &&
                score.style.color === colors.primary && score.style.whiteSpace === "nowrap" &&
                score.text === `${record.score} / 24` &&
                status.style.gridColumnStart === "1" && status.style.gridColumnEnd === "-1" &&
                status.style.gridRowStart === "3" && status.style.fontSize === "14px" &&
                status.style.lineHeight === "21px" && status.style.fontWeight === "600" &&
                status.style.color === colors.text,
            `${context}: row ${index + 1} content grid or type is wrong (${JSON.stringify(row.values)})`,
        );
        if (index > 0) {
            assert(approximatelyEqual(row.rect.top - state.list.rows[index - 1].rect.bottom, 12),
                `${context}: row gap is not 12px`);
        }
    });
    assert(
        state.clear.visible && state.clear.text === "Clear All History" && state.clear.type === "button" &&
            state.clear.rect.width >= 44 && state.clear.rect.height >= 44 &&
            approximatelyEqual(state.clear.rect.left, state.list.rect.left) &&
            approximatelyEqual(state.clear.rect.top - state.list.rect.bottom, 24) &&
            state.clear.style.backgroundColor === colors.danger && state.clear.style.borderColor === colors.danger &&
            state.clear.style.color === colors.surface && state.clear.style.cursor === "pointer",
        `${context}: Clear action presentation is wrong`,
    );
    assert(state.counters.get === 1 && state.counters.save === 0 && state.counters.clear === 0 &&
        state.boundaryUnchanged, `${context}: boundary reads or mutation changed`);
    assertNoMotion([
        state.figure, state.figure.svg, state.figure.cutoff, state.figure.scoreLine,
        ...state.figure.points, state.figure.explanation, state.list, ...state.list.rows, state.clear,
    ], context);
};

const auditSharedAtAllWidths = async (context) => {
    for (const viewport of viewports) {
        await setViewport(viewport);
        assertSharedPage(await pageSnapshot(), viewport, context);
    }
};

const auditHistoryAtAllWidths = async (results, assertion, context) => {
    for (const viewport of viewports) {
        await setViewport(viewport);
        assertion(await pageSnapshot(), viewport, results, context);
    }
};

const waitForQuestion = (number) => waitFor(
    `location.pathname === "/test" && !document.querySelector('[data-question-step="${number}"]').hidden`,
    `Question ${number} did not become active`,
);
const selectResponse = async (question, value) => {
    await pointerClick(`[data-question-step="${question}"] .response-option:has(input[value="${value}"])`);
};
const goForward = async (question) => {
    await pointerClick(question === 6
        ? '[data-question-step="6"] [data-questionnaire-submit]'
        : `[data-question-step="${question}"] [data-questionnaire-next]`);
};
const completeQuestionnaire = async (responses, expectedScore) => {
    for (let index = 0; index < responses.length; index += 1) {
        await selectResponse(index + 1, responses[index]);
        await goForward(index + 1);
        if (index < 5) await waitForQuestion(index + 2);
    }
    await waitFor(
        `location.pathname === "/result" && document.querySelector("[data-active-result-score]")?.textContent.trim() === ${JSON.stringify(`${expectedScore} / 24`)}`,
        `${expectedScore}-point Result did not render`,
    );
};

try {
    await mkdir(screenshotDirectory, { recursive: true });
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Emulation.setTimezoneOverride", { timezoneId: "America/Los_Angeles" });

    await installBoundaryMode("available");
    await setViewport(viewports[0]);
    await navigate(homeUrl, 'location.pathname === "/" && document.readyState === "complete"', "Home did not load");
    await seedHistory(threeResults);
    await client.send("Page.reload", { ignoreCache: true });
    await waitFor('location.pathname === "/" && window.__issue22GetResultsCalls === 1', "available Home did not settle");
    for (const viewport of viewports) {
        await setViewport(viewport);
        const state = await pageSnapshot();
        assertSharedPage(state, viewport, "available Home");
        assert(await evaluate('Boolean(document.querySelector("a[href=\\"/history\\"]"))'), "available Home hid View History");
        await captureScreenshot(`home-available-${viewport.width}`);
    }

    await installBoundaryMode("available");
    await navigate(testUrl, 'location.pathname === "/test" && !document.querySelector("[data-question-step=\\"1\\"]").hidden', "Questionnaire did not load");
    await selectResponse(1, 2);
    await auditSharedAtAllWidths("selected Question 1");
    await setViewport(viewports[0]);
    await captureScreenshot("questionnaire-selected-320");
    await goForward(1);
    await waitForQuestion(2);
    await selectResponse(2, 2);
    await goForward(2);
    await waitForQuestion(3);
    await pointerClick('[data-question-step="3"] [data-question-helper]');
    await setViewport(viewports[2]);
    await captureScreenshot("questionnaire-helper-768");
    await selectResponse(3, 2);
    await goForward(3);
    await waitForQuestion(4);
    await selectResponse(4, 2);
    await goForward(4);
    await waitForQuestion(5);
    await selectResponse(5, 2);
    await goForward(5);
    await waitForQuestion(6);
    await selectResponse(6, 2);
    await auditSharedAtAllWidths("answered Question 6");
    await setViewport(viewports[1]);
    await captureScreenshot("questionnaire-question-6-controls-375");
    await goForward(6);
    await waitFor('location.pathname === "/result"', "12-point Result did not load");
    await auditSharedAtAllWidths("12-point Result");
    await setViewport(viewports[0]);
    await captureScreenshot("result-12-320");
    await setViewport(viewports[2]);
    await captureScreenshot("result-one-record-768");

    await pointerClick("[data-take-test-again]");
    await waitForQuestion(1);
    await completeQuestionnaire([3, 2, 2, 2, 2, 2], 13);
    await auditSharedAtAllWidths("13-point Result");
    await setViewport(viewports[1]);
    await captureScreenshot("result-13-375");

    await loadHistory([]);
    await auditHistoryAtAllWidths([], (state, viewport, _results, context) =>
        assertEmptyHistory(state, viewport, context), "empty History");
    for (const viewport of viewports.slice(0, 2)) {
        await setViewport(viewport);
        await captureScreenshot(`history-empty-${viewport.width}`);
    }

    await loadHistory(oneResult);
    await auditHistoryAtAllWidths(oneResult, assertPopulatedHistory, "one-result History");
    for (const viewport of [viewports[0], viewports[2]]) {
        await setViewport(viewport);
        await captureScreenshot(`history-one-${viewport.width}`);
    }

    await loadHistory(threeResults);
    await auditHistoryAtAllWidths(threeResults, assertPopulatedHistory, "three-result History");
    for (const viewport of viewports) {
        await setViewport(viewport);
        await captureScreenshot(`history-three-${viewport.width}`);
    }
    await setViewport(viewports[0]);
    const passiveBefore = await pageSnapshot();
    await pointerClick("[data-history-chart]");
    await pointerClick("[data-history-result]");
    let state = await pageSnapshot();
    assert(state.pathname === "/history" && JSON.stringify(state.counters) === JSON.stringify(passiveBefore.counters),
        "chart or result row became interactive");
    await pointerMove("[data-clear-history]");
    state = await pageSnapshot();
    assert(state.clear.style.backgroundColor === colors.dangerHover && state.clear.style.borderColor === colors.dangerHover,
        "Clear hover state is wrong");
    await evaluate("document.activeElement.blur()");
    await pressTab(true);
    await evaluate('document.querySelector("[data-clear-history]").focus()');
    state = await pageSnapshot();
    const clearFocus = await evaluate(`(() => ({
        active: document.activeElement === document.querySelector("[data-clear-history]"),
        activeHtml: document.activeElement?.outerHTML,
        focusVisible: document.querySelector("[data-clear-history]").matches(":focus-visible"),
    }))()`);
    assert(clearFocus.active && clearFocus.focusVisible &&
        state.clear.style.outlineWidth === "3px" && state.clear.style.outlineStyle === "solid" &&
        state.clear.style.outlineColor === colors.focus && state.clear.style.outlineOffset === "2px" &&
        state.clear.rect.left - 5 >= state.shell.rect.left + 1,
    `Clear focus-visible state is wrong or clipped (${JSON.stringify({ clear: state.clear, clearFocus })})`);

    await loadHistory(threeResults, "unavailable-read");
    await auditHistoryAtAllWidths(threeResults, (snapshot, viewport, _results, context) =>
        assertUnavailableHistory(snapshot, viewport, context), "unavailable History");
    for (const viewport of viewports.slice(0, 2)) {
        await setViewport(viewport);
        await captureScreenshot(`history-unavailable-${viewport.width}`);
    }

    await loadHistory(threeResults);
    await setViewport(viewports[0]);
    await evaluate('window.__issue22RetainedClear = document.querySelector("[data-clear-history]")');
    await pointerClick("[data-clear-history]");
    await waitFor('!document.querySelector("[data-history-empty]").hidden', "successful clear did not show empty state");
    state = await pageSnapshot();
    assertEmptyHistory(state, viewports[0], "post-clear success History", 1);
    assert(state.counters.clear === 1 && state.rawHistory === null, "successful clear did not call once and remove history");
    await evaluate("window.__issue22RetainedClear.click(); window.__issue22RetainedClear.click()");
    assert((await pageSnapshot()).counters.clear === 1, "successful clear accepted a duplicate activation");
    await captureScreenshot("history-post-clear-success-320");

    await loadHistory(threeResults, "clear-failure");
    await setViewport(viewports[0]);
    const rawBeforeFailedClear = (await pageSnapshot()).rawHistory;
    await evaluate('window.__issue22RetainedClear = document.querySelector("[data-clear-history]")');
    await pointerClick("[data-clear-history]");
    await waitFor('!document.querySelector("[data-history-unavailable]").hidden', "failed clear did not show unavailable state");
    state = await pageSnapshot();
    assertUnavailableHistory(state, viewports[0], "post-clear failure History", 1);
    assert(state.counters.clear === 1 && state.rawHistory === rawBeforeFailedClear,
        "failed clear changed storage or retried");
    await evaluate("window.__issue22RetainedClear.click(); window.__issue22RetainedClear.click()");
    assert((await pageSnapshot()).counters.clear === 1, "failed clear accepted a duplicate activation");
    await captureScreenshot("history-post-clear-failure-320");

    await loadHistory(twentyResults);
    await auditHistoryAtAllWidths(twentyResults, assertPopulatedHistory, "20-result History");
    for (const viewport of [viewports[0], viewports[2]]) {
        await setViewport(viewport);
        await evaluate("document.scrollingElement.scrollTop = 0");
        await captureScreenshot(`history-20-top-${viewport.width}`, false);
        state = await pageSnapshot();
        assert(state.scrollHeight > state.clientHeight && state.list.style.overflowY === "visible" &&
            state.list.style.maxHeight === "none", `20-result History at ${viewport.width}px did not use document scrolling`);
        await evaluate("document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight");
        await delay(50);
        state = await pageSnapshot();
        assert(state.scrollY > 0 && state.clear.rect.bottom <= state.clientHeight + 0.5 &&
            approximatelyEqual(state.scrollHeight - (state.shell.rect.bottom + state.scrollY), 16),
        `20-result History bottom is not reachable at ${viewport.width}px`);
        await captureScreenshot(`history-20-bottom-${viewport.width}`, false);
    }

    assert(exceptions.length === 0, `visual scenario exposed exceptions: ${JSON.stringify(exceptions)}`);
    assert(dialogs.length === 0, "visual scenario opened a dialog");
    assert(requests.every((request) => request.method === "GET" && request.postData === undefined &&
        new URL(request.url).origin === appOrigin), "visual scenario made an unexpected, remote, or data-bearing request");
    assert((await evaluate("sessionStorage.length")) === 0 && (await evaluate("document.cookie")) === "",
        "visual scenario introduced session or cookie persistence");
    console.log("History and cross-route visual scenario passed");
} finally {
    client.close();
}
