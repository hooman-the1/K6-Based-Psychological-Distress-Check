const [websocketUrl, testUrl, homeUrl, historyUrl] = process.argv.slice(2);

const appOrigin = new URL(homeUrl).origin;
const resultUrl = `${appOrigin}/result`;
const storageKey = "k6-based-distress-check.history.v1";
const unrelatedStorageKey = "unrelated.application.preference";
const unrelatedStorageValue = "preserve this value";
const unavailableNotice = "Saved history is unavailable in this browser.";
const chartExplanation =
    "Scores are shown from oldest to newest. The horizontal line marks the cutoff score of 13.";
const availableResponses = [
    "All of the time",
    "Most of the time",
    "Some of the time",
    "A little of the time",
    "None of the time",
    "All of the time",
];
const unavailableResponses = Array(6).fill("None of the time");
const resourceLinks = [
    ["NIMH: Mental Health Information", "https://www.nimh.nih.gov/health"],
    [
        "WHO: Mental health",
        "https://www.who.int/news-room/fact-sheets/detail/mental-health-strengthening-our-response",
    ],
    [
        "WHO: Doing What Matters in Times of Stress",
        "https://www.who.int/publications/i/item/9789240003927",
    ],
    [
        "NHS Every Mind Matters: Self-help CBT techniques",
        "https://www.nhs.uk/every-mind-matters/mental-wellbeing-tips/self-help-cbt-techniques/",
    ],
];
const firstSeedTimestamp = Date.UTC(2020, 0, 1, 12);
const seededResults = Array.from({ length: 20 }, (_, index) => ({
    score: index + 1,
    timestamp: firstSeedTimestamp + index * 60_000,
}));

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

class DevToolsClient {
    constructor(websocket) {
        this.websocket = websocket;
        this.nextMessageId = 1;
        this.pendingMessages = new Map();
        this.requests = [];
        this.exceptions = [];
        this.dialogs = [];
        this.navigationUrls = [];
        websocket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data.toString());
            if (message.method === "Network.requestWillBeSent") {
                this.requests.push(message.params.request);
            }
            if (message.method === "Runtime.exceptionThrown") {
                this.exceptions.push(message.params.exceptionDetails);
            }
            if (message.method === "Page.javascriptDialogOpening") {
                this.dialogs.push(message.params);
                this.send("Page.handleJavaScriptDialog", { accept: false }).catch(
                    () => {},
                );
            }
            if (message.method === "Page.frameNavigated") {
                const { frame } = message.params;
                if (!frame.parentId && frame.url.startsWith(appOrigin)) {
                    this.navigationUrls.push(frame.url);
                }
            }
            if (message.method === "Page.navigatedWithinDocument") {
                const { url } = message.params;
                if (url.startsWith(appOrigin)) this.navigationUrls.push(url);
            }
            const pending = this.pendingMessages.get(message.id);
            if (pending) {
                this.pendingMessages.delete(message.id);
                if (message.error) pending.reject(new Error(message.error.message));
                else pending.resolve(message.result);
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

const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try {
            if (await evaluate(predicate)) return;
        } catch {
            // Real navigation briefly destroys the previous execution context.
        }
        await delay(50);
    }
    throw new Error(message);
};

const settleRendering = () =>
    evaluate(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );

const assertExactRoute = async (pathname, context) => {
    const route = await evaluate(`({
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        state: history.state,
    })`);
    assert(
        route.pathname === pathname &&
            route.search === "" &&
            route.hash === "" &&
            route.state === null,
        `${context}: route or browser-history state is not exact`,
    );
};

const navigate = async (url, pathname, heading, context) => {
    await client.send("Page.navigate", { url });
    await waitFor(
        `document.readyState === "complete" &&
            location.pathname === ${JSON.stringify(pathname)} &&
            document.querySelector("h1")?.textContent.trim() === ${JSON.stringify(heading)}`,
        `${context} did not settle`,
    );
    await assertExactRoute(pathname, context);
};

const visiblePoint = async (selector, text) => {
    return evaluate(`(() => {
        const visible = (element) => Boolean(
            element && !element.hidden && element.getClientRects().length > 0 &&
            getComputedStyle(element).display !== "none" &&
            getComputedStyle(element).visibility !== "hidden"
        );
        const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
            .find((candidate) => visible(candidate) &&
                candidate.textContent.trim() === ${JSON.stringify(text)});
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const bounds = element.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
};

const activateVisible = async (selector, text) => {
    const point = await visiblePoint(selector, text);
    assert(point, `visible ${selector} named ${JSON.stringify(text)} was not found`);
    await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
    });
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

const installBoundaryFailure = async (mode) => {
    if (boundaryInjectionIdentifier !== null) {
        await client.send("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: boundaryInjectionIdentifier,
        });
    }
    const installed = await client.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
            const mode = ${JSON.stringify(mode)};
            let exposedBoundary;
            window.__issue25GetResultsCalls = 0;
            window.__issue25SaveResultCalls = 0;
            window.__issue25ClearResultsCalls = 0;
            Object.defineProperty(window, "AssessmentHistory", {
                configurable: true,
                get() { return exposedBoundary; },
                set(boundary) {
                    window.__issue25OriginalBoundary = boundary;
                    exposedBoundary = Object.freeze({
                        getResults() {
                            window.__issue25GetResultsCalls += 1;
                            if (mode === "throw-read-save") {
                                throw new Error("injected application history read failure");
                            }
                            return boundary.getResults();
                        },
                        saveResult(result) {
                            window.__issue25SaveResultCalls += 1;
                            if (mode === "throw-read-save") {
                                throw new Error("injected application history save failure");
                            }
                            return boundary.saveResult(result);
                        },
                        clearResults() {
                            window.__issue25ClearResultsCalls += 1;
                            if (mode === "throw-clear") {
                                throw new Error("injected application history clear failure");
                            }
                            return boundary.clearResults();
                        },
                    });
                },
            });
        })()`,
    });
    boundaryInjectionIdentifier = installed.identifier;
};

const removeBoundaryFailure = async () => {
    if (boundaryInjectionIdentifier === null) return;
    await client.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: boundaryInjectionIdentifier,
    });
    boundaryInjectionIdentifier = null;
};

const pageSnapshot = () =>
    evaluate(`(() => {
        const visible = (element) => Boolean(
            element && !element.hidden && element.getClientRects().length > 0 &&
            getComputedStyle(element).display !== "none" &&
            getComputedStyle(element).visibility !== "hidden"
        );
        const historyLink = document.querySelector("[data-history-link]");
        const startTest = Array.from(document.querySelectorAll("a"))
            .find((link) => link.textContent.trim() === "Start Test");
        const unavailable = document.querySelector("[data-history-unavailable]");
        const empty = document.querySelector("[data-history-empty]");
        const chartContainer = document.querySelector("[data-history-chart-container]");
        const resultsList = document.querySelector("[data-history-results]");
        const rows = Array.from(document.querySelectorAll("[data-history-result]"));
        const clear = document.querySelector("[data-clear-history]");
        const takeTest = Array.from(document.querySelectorAll("a"))
            .find((link) => link.textContent.trim() === "Take Test");
        const result = document.querySelector("[data-active-result]");
        return {
            heading: document.querySelector("h1")?.textContent.trim() ?? null,
            visibleText: document.body.innerText,
            startVisible: visible(startTest),
            startDisabled: startTest?.getAttribute("aria-disabled") ?? null,
            historyLinkVisible: visible(historyLink),
            historyLinkRectCount: historyLink?.getClientRects().length ?? 0,
            historyLinkFocused: document.activeElement === historyLink,
            unavailableVisible: visible(unavailable),
            visibleUnavailableCount: Array.from(
                document.querySelectorAll("[data-history-unavailable]")
            ).filter(visible).length,
            unavailableText: unavailable?.textContent.trim() ?? null,
            visibleParagraphs: Array.from(document.querySelectorAll("p"))
                .filter(visible)
                .map((paragraph) => paragraph.textContent.trim()),
            emptyVisible: visible(empty),
            takeTestVisible: visible(takeTest),
            chartVisible: visible(chartContainer),
            chartHeading: chartContainer?.querySelector("h2")?.textContent.trim() ?? null,
            chartExplanation: document.querySelector("[data-history-chart-explanation]")
                ?.textContent.trim() ?? null,
            chartBeforeList: Boolean(
                chartContainer && resultsList &&
                chartContainer.compareDocumentPosition(resultsList) &
                    Node.DOCUMENT_POSITION_FOLLOWING
            ),
            scoreLineCount: document.querySelectorAll("[data-history-score-line]").length,
            pointYs: Array.from(
                document.querySelectorAll("[data-history-score-point]"),
                (point) => Number(point.getAttribute("cy")),
            ),
            listVisible: visible(resultsList),
            rowCount: rows.length,
            visibleRowCount: rows.filter(visible).length,
            rows: rows.map((row) => ({
                values: Array.from(row.children, (value) => value.textContent.trim()),
                html: row.outerHTML,
                interactiveCount: row.querySelectorAll(
                    "a, button, input, select, textarea, [tabindex]"
                ).length,
                tabIndex: row.tabIndex,
                role: row.getAttribute("role"),
            })),
            clearVisible: visible(clear),
            clearCount: document.querySelectorAll("[data-clear-history]").length,
            resultHeading: result?.querySelector("h1")?.textContent.trim() ?? null,
            resultScore: result?.querySelector("[data-active-result-score]")
                ?.textContent.trim() ?? null,
            resultStatus: result?.querySelector("[data-active-result-status]")
                ?.textContent.trim() ?? null,
            resultInterpretation: result
                ?.querySelector("[data-active-result-interpretation]")
                ?.textContent.trim() ?? null,
            resultHigher: result?.querySelector("[data-active-result-higher-score]")
                ?.textContent.trim() ?? null,
            resultGuidance: result?.querySelector("[data-active-result-guidance]")
                ?.textContent.trim() ?? null,
            resultResources: Array.from(
                result?.querySelectorAll("[data-active-result-resources] a") ?? [],
                (link) => [link.textContent.trim(), link.href],
            ),
            retakeVisible: visible(result?.querySelector("[data-take-test-again]")),
            questionnaireCount: document.querySelectorAll("[data-questionnaire]").length,
            sessionLength: sessionStorage.length,
            cookie: document.cookie,
        };
    })()`);

const storageSnapshot = () =>
    evaluate(`({
        raw: localStorage.getItem(${JSON.stringify(storageKey)}),
        keys: Object.keys(localStorage).sort(),
        unrelated: localStorage.getItem(${JSON.stringify(unrelatedStorageKey)}),
        sessionLength: sessionStorage.length,
        cookie: document.cookie,
    })`);

const assertStorageIsolation = (storage, expectedRaw, context) => {
    const expectedKeys = expectedRaw === null
        ? [unrelatedStorageKey]
        : [storageKey, unrelatedStorageKey].sort();
    assert(storage.raw === expectedRaw, `${context}: canonical history value changed`);
    assert(
        JSON.stringify(storage.keys) === JSON.stringify(expectedKeys),
        `${context}: an unexpected localStorage key exists`,
    );
    assert(
        storage.unrelated === unrelatedStorageValue,
        `${context}: unrelated localStorage changed`,
    );
    assert(
        storage.sessionLength === 0 && storage.cookie === "",
        `${context}: sessionStorage or cookies are not empty`,
    );
};

const assertUnavailableHome = async (context) => {
    await assertExactRoute("/", context);
    const state = await pageSnapshot();
    assert(
        state.heading === "K6-Based Psychological Distress Check",
        `${context}: Home heading changed`,
    );
    assert(
        state.unavailableVisible && state.visibleUnavailableCount === 1 &&
            state.unavailableText === unavailableNotice,
        `${context}: unavailable notice is missing or wrong`,
    );
    assert(
        state.startVisible && state.startDisabled === null,
        `${context}: Start Test is unavailable`,
    );
    assert(
        !state.historyLinkVisible && state.historyLinkRectCount === 0,
        `${context}: View History remains reachable`,
    );
};

const assertUnavailableHistory = async (context) => {
    await assertExactRoute("/history", context);
    const state = await pageSnapshot();
    assert(state.heading === "History", `${context}: History heading changed`);
    assert(
        state.unavailableVisible && state.visibleUnavailableCount === 1 &&
            state.unavailableText === unavailableNotice,
        `${context}: unavailable notice is missing or wrong`,
    );
    assert(
        !state.emptyVisible && !state.takeTestVisible && !state.chartVisible &&
            !state.listVisible && state.rowCount === 0 && state.scoreLineCount === 0 &&
            state.pointYs.length === 0 && !state.clearVisible,
        `${context}: stale empty or populated History content remains`,
    );
    assert(
        JSON.stringify(state.visibleParagraphs) ===
            JSON.stringify([unavailableNotice]),
        `${context}: unavailable History exposes alternate copy or error detail`,
    );
};

const assertQuestionnaireOnly = async (context) => {
    await assertExactRoute("/test", context);
    const state = await pageSnapshot();
    assert(
        state.heading === "Test" && state.questionnaireCount === 1,
        `${context}: fresh questionnaire is unavailable`,
    );
    assert(
        !state.unavailableVisible && !state.historyLinkVisible,
        `${context}: questionnaire offers saved-history UI`,
    );
};

const completeAssessment = async (responseLabels, context) => {
    for (let index = 0; index < responseLabels.length; index += 1) {
        const question = index + 1;
        const label = responseLabels[index];
        await waitFor(
            `document.querySelector('[data-question-step="${question}"]')?.hidden === false`,
            `${context}: Question ${question} did not appear`,
        );
        await activateVisible(
            `[data-question-step="${question}"] .response-option`,
            label,
        );
        const selectedState = await evaluate(`(() => {
            const step = document.querySelector('[data-question-step="${question}"]');
            const forward = step.querySelector(
                "[data-questionnaire-next], [data-questionnaire-submit]"
            );
            return {
                stillVisible: step.hidden === false,
                visibleSteps: document.querySelectorAll(
                    "[data-question-step]:not([hidden])"
                ).length,
                selected: step.querySelector('input[type="radio"]:checked')
                    ?.closest(".response-option")?.textContent.trim(),
                forwardEnabled: forward.disabled === false,
                forwardText: forward.textContent.trim(),
            };
        })()`);
        assert(
            selectedState.stillVisible && selectedState.visibleSteps === 1 &&
                selectedState.selected === label && selectedState.forwardEnabled,
            `${context}: Question ${question} selection advanced or did not enable forward`,
        );
        assert(
            selectedState.forwardText ===
                (question === 6 ? "See my result" : "Next"),
            `${context}: Question ${question} forward copy changed`,
        );
        if (question < 6) {
            await activateVisible(`[data-question-step="${question}"] button`, "Next");
        }
    }
};

const assertResult = async (score, status, interpretation, context) => {
    await assertExactRoute("/result", context);
    const state = await pageSnapshot();
    assert(
        state.resultHeading === "Result" && state.resultScore === `${score} / 24` &&
            state.resultStatus === status &&
            state.resultInterpretation === interpretation,
        `${context}: Result score or cutoff presentation is wrong`,
    );
    assert(
        state.resultHigher === "Higher scores indicate greater psychological distress." &&
            state.resultGuidance.includes(
                "consider talking with a qualified healthcare professional",
            ) &&
            JSON.stringify(state.resultResources) === JSON.stringify(resourceLinks) &&
            state.retakeVisible,
        `${context}: Result resources, guidance, or retake action changed`,
    );
    assert(
        !state.unavailableVisible && !state.historyLinkVisible &&
            state.questionnaireCount === 0,
        `${context}: Result exposes questionnaire or saved-history UI`,
    );
};

const formatHistoryRow = (result) => {
    const date = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(result.timestamp);
    const time = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    }).format(result.timestamp);
    return [
        date,
        time,
        `${result.score} / 24`,
        result.score >= 13 ? "At or above the cutoff" : "Below the cutoff",
    ];
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
        timezoneId: "America/New_York",
    });

    // Build/Operate/Check: a fresh direct Result request fails closed to Home.
    await navigate(
        resultUrl,
        "/",
        "K6-Based Psychological Distress Check",
        "fresh direct Result",
    );
    let state = await pageSnapshot();
    assert(
        state.resultHeading === null && state.resultScore === null &&
            !/At or above the cutoff|Below the cutoff|\/ 24/.test(state.visibleText),
        "fresh direct Result exposed Result content, a score, or an answer",
    );
    let storage = await storageSnapshot();
    assert(
        storage.raw === null && storage.keys.length === 0 &&
            storage.sessionLength === 0 && storage.cookie === "",
        "fresh direct Result did not start with empty browser storage",
    );

    // Build: use only the real public boundary to seed exactly 20 canonical records.
    assert(
        seededResults.every(
            (result, index) =>
                result.timestamp < Date.now() &&
                (index === 0 || result.timestamp > seededResults[index - 1].timestamp),
        ),
        "seed timestamps are not distinct, increasing, and safely in the past",
    );
    const seedResults = await evaluate(`(() => {
        localStorage.removeItem(${JSON.stringify(storageKey)});
        localStorage.setItem(
            ${JSON.stringify(unrelatedStorageKey)},
            ${JSON.stringify(unrelatedStorageValue)}
        );
        return ${JSON.stringify(seededResults)}.map((result) =>
            window.AssessmentHistory.saveResult(result)
        );
    })()`);
    assert(
        seedResults.every(
            (result) =>
                JSON.stringify(result) === JSON.stringify({ ok: true }),
        ),
        "real AssessmentHistory boundary rejected a seed record",
    );
    const seededRaw = JSON.stringify(seededResults);
    storage = await storageSnapshot();
    assertStorageIsolation(storage, seededRaw, "available seed setup");
    assert(
        JSON.stringify(JSON.parse(storage.raw).map(Object.keys)) ===
            JSON.stringify(Array(20).fill(["score", "timestamp"])),
        "seed history is not canonical score/timestamp data",
    );

    // Operate: complete the visible six-question journey and create result #21.
    await navigate(
        homeUrl,
        "/",
        "K6-Based Psychological Distress Check",
        "available Home",
    );
    state = await pageSnapshot();
    assert(
        state.startVisible && state.historyLinkVisible && !state.unavailableVisible,
        "available Home actions are wrong",
    );
    await activateVisible("a", "Start Test");
    await waitFor(
        'location.pathname === "/test" && Boolean(document.querySelector("[data-questionnaire]"))',
        "available Start Test did not open the questionnaire",
    );
    await assertQuestionnaireOnly("available questionnaire");
    await completeAssessment(availableResponses, "available completion");
    const beforeCompletion = await evaluate("Date.now()");
    const requestsBeforeAvailableCompletion = client.requests.length;
    await activateVisible('[data-question-step="6"] button', "See my result");
    await waitFor(
        'location.pathname === "/result" && Boolean(document.querySelector("[data-active-result]"))',
        "available completion did not render Result",
    );
    const afterCompletion = await evaluate("Date.now()");
    await assertResult(
        14,
        "At or above the cutoff",
        "Your score is at or above the serious or elevated psychological distress cutoff of 13.",
        "available completion",
    );
    assert(
        client.requests.length === requestsBeforeAvailableCompletion,
        "available completion caused a post-load request",
    );
    state = await pageSnapshot();
    assert(
        availableResponses.every((label) => !state.visibleText.includes(label)),
        "available Result exposes a response label",
    );

    // Check: retention, privacy, canonical ordering, and Result-refresh behavior.
    storage = await storageSnapshot();
    const retained = JSON.parse(storage.raw);
    const liveResult = retained.at(-1);
    const expectedRetained = [...seededResults.slice(1), liveResult];
    assert(
        retained.length === 20 && liveResult.score === 14 &&
            Number.isInteger(liveResult.timestamp) &&
            liveResult.timestamp >= beforeCompletion &&
            liveResult.timestamp <= afterCompletion &&
            JSON.stringify(retained) === JSON.stringify(expectedRetained),
        "completion did not remove only the oldest seed and append the bounded result",
    );
    const retainedRaw = JSON.stringify(expectedRetained);
    assertStorageIsolation(storage, retainedRaw, "available completion");
    assert(
        storage.raw === retainedRaw && retained.every(
            (result) =>
                JSON.stringify(Object.keys(result)) ===
                    JSON.stringify(["score", "timestamp"]),
        ),
        "retained history is not compact canonical JSON",
    );
    assert(
        !/answer|response|prompt|cutoff|result|identifier/i.test(storage.raw),
        "retained history exposes questionnaire or Result data",
    );

    await client.send("Page.reload", { ignoreCache: true });
    await waitFor(
        'location.pathname === "/" && document.readyState === "complete"',
        "Result reload did not settle at Home",
    );
    await assertExactRoute("/", "Result reload");
    state = await pageSnapshot();
    assert(
        state.heading === "K6-Based Psychological Distress Check" &&
            state.resultHeading === null && state.resultScore === null &&
            state.historyLinkVisible && !state.unavailableVisible,
        "Result reload did not show normal available Home",
    );

    // Operate/Check: render the retained History newest-first, then clear it.
    await activateVisible("a", "View History");
    await waitFor(
        'location.pathname === "/history" && document.querySelectorAll("[data-history-result]").length === 20',
        "View History did not render 20 retained results",
    );
    await assertExactRoute("/history", "retained History");
    const rawBeforeHistoryInspection = (await storageSnapshot()).raw;
    state = await pageSnapshot();
    const expectedRows = [...expectedRetained].reverse().map(formatHistoryRow);
    assert(
        state.heading === "History" && !state.emptyVisible &&
            !state.unavailableVisible && state.chartVisible &&
            state.chartHeading === "Score trend" &&
            state.chartExplanation === chartExplanation && state.chartBeforeList &&
            state.scoreLineCount === 1 && state.pointYs.length === 20 &&
            state.listVisible && state.visibleRowCount === 20 &&
            state.clearVisible && state.clearCount === 1,
        "retained History composition is incomplete",
    );
    assert(
        JSON.stringify(state.rows.map((row) => row.values)) ===
            JSON.stringify(expectedRows),
        "History list is not exact newest-first local date/time data",
    );
    assert(
        state.rows.every(
            (row) => row.interactiveCount === 0 && row.tabIndex === -1 &&
                row.role === null,
        ),
        "History rows became interactive",
    );
    assert(
        state.pointYs.slice(0, 19).every(
            (pointY, index, points) => index === 0 || pointY < points[index - 1],
        ) && state.pointYs[19] === state.pointYs[12],
        "History chart is not oldest-to-newest",
    );
    assert(
        expectedRetained.every(
            (result) => !state.rows.some((row) => row.html.includes(String(result.timestamp))),
        ) &&
            availableResponses.every(
                (label) => !state.rows.some((row) => row.html.includes(label)),
            ) &&
            !state.rows.some((row) => row.html.includes(retainedRaw)),
        "History rows expose raw or questionnaire data",
    );
    assert(
        (await storageSnapshot()).raw === rawBeforeHistoryInspection,
        "rendering the chart or list mutated retained history",
    );
    await evaluate(
        'window.__issue25RetainedClearButton = document.querySelector("[data-clear-history]")',
    );
    const requestsBeforeSuccessfulClear = client.requests.length;
    await activateVisible("button", "Clear All History");
    await waitFor(
        'document.querySelector("[data-history-empty]")?.hidden === false',
        "successful clear did not show the empty state",
    );
    await assertExactRoute("/history", "successful clear");
    state = await pageSnapshot();
    assert(
        state.emptyVisible && state.takeTestVisible && !state.unavailableVisible &&
            !state.chartVisible && !state.listVisible && state.rowCount === 0 &&
            state.scoreLineCount === 0 && state.pointYs.length === 0 &&
            !state.clearVisible,
        "successful clear left stale populated or unavailable content",
    );
    storage = await storageSnapshot();
    assertStorageIsolation(storage, null, "successful clear");
    assert(
        client.requests.length === requestsBeforeSuccessfulClear,
        "successful clear caused a post-load request",
    );
    await client.send("Page.reload", { ignoreCache: true });
    await waitFor(
        'location.pathname === "/history" && document.readyState === "complete"',
        "cleared History reload did not settle",
    );
    await assertExactRoute("/history", "cleared History reload");
    state = await pageSnapshot();
    assert(
        state.emptyVisible && state.takeTestVisible && state.rowCount === 0 &&
            state.pointYs.length === 0 && !state.chartVisible,
        "cleared History reload restored generated content",
    );
    assertStorageIsolation(await storageSnapshot(), null, "cleared History reload");

    // Build/Operate/Check: one delegated seed followed by one throwing clear.
    const failedClearRecord = { score: 9, timestamp: firstSeedTimestamp };
    const failedClearSeed = await evaluate(
        `window.AssessmentHistory.saveResult(${JSON.stringify(failedClearRecord)})`,
    );
    assert(
        JSON.stringify(failedClearSeed) === JSON.stringify({ ok: true }),
        "failed-clear setup did not seed through the original boundary",
    );
    const failedClearRaw = JSON.stringify([failedClearRecord]);
    assertStorageIsolation(
        await storageSnapshot(),
        failedClearRaw,
        "failed-clear seed",
    );
    await installBoundaryFailure("throw-clear");
    await navigate(historyUrl, "/history", "History", "failed-clear History");
    state = await pageSnapshot();
    assert(
        state.chartVisible && state.pointYs.length === 1 &&
            state.visibleRowCount === 1 && state.clearVisible &&
            (await evaluate("window.__issue25GetResultsCalls")) === 1,
        "failed-clear phase did not first render normal populated History",
    );
    const requestsBeforeFailedClear = client.requests.length;
    await evaluate(
        'window.__issue25RetainedClearButton = document.querySelector("[data-clear-history]")',
    );
    await activateVisible("button", "Clear All History");
    await waitFor(
        'document.querySelector("[data-history-unavailable]")?.hidden === false',
        "throwing clear did not show unavailable History",
    );
    await assertUnavailableHistory("failed clear");
    assert(
        (await evaluate("window.__issue25ClearResultsCalls")) === 1,
        "failed clear was not attempted exactly once",
    );
    assertStorageIsolation(
        await storageSnapshot(),
        failedClearRaw,
        "failed clear",
    );
    await evaluate(`(() => {
        const button = window.__issue25RetainedClearButton;
        button.remove();
        button.click();
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        window.dispatchEvent(new Event("pagehide"));
        window.dispatchEvent(new Event("pageshow"));
        document.dispatchEvent(new Event("visibilitychange"));
    })()`);
    await settleRendering();
    assert(
        (await evaluate("window.__issue25ClearResultsCalls")) === 1,
        "retained detached Clear button or lifecycle event retried the clear",
    );
    assert(
        (await evaluate("window.__issue25GetResultsCalls")) === 1 &&
            (await evaluate("window.__issue25SaveResultCalls")) === 0,
        "failed clear retried its read or performed a fallback write",
    );
    assert(
        client.requests.length === requestsBeforeFailedClear,
        "failed clear caused a retry, reload, navigation, or fallback request",
    );
    assertStorageIsolation(
        await storageSnapshot(),
        failedClearRaw,
        "failed clear after repeated activation",
    );

    // Build/Check: malformed real storage remains untouched and disables History.
    await removeBoundaryFailure();
    const malformedHistory = "malformed history must remain byte-for-byte unchanged";
    await evaluate(
        `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(malformedHistory)})`,
    );
    await navigate(
        homeUrl,
        "/",
        "K6-Based Psychological Distress Check",
        "malformed-storage Home",
    );
    await assertUnavailableHome("malformed-storage Home");
    const focusResult = await evaluate(`(() => {
        const link = document.querySelector("[data-history-link]");
        link.focus();
        return document.activeElement === link;
    })()`);
    assert(!focusResult, "hidden View History can be reached by keyboard focus");
    assert(
        (await visiblePoint("a", "View History")) === null,
        "hidden View History can be reached by pointer",
    );
    assertStorageIsolation(
        await storageSnapshot(),
        malformedHistory,
        "malformed-storage Home",
    );
    await navigate(historyUrl, "/history", "History", "malformed-storage History");
    await assertUnavailableHistory("malformed-storage History");
    assertStorageIsolation(
        await storageSnapshot(),
        malformedHistory,
        "malformed-storage History",
    );

    // Build/Operate/Check: throwing reads and save do not block a 0-point result.
    await evaluate(`localStorage.removeItem(${JSON.stringify(storageKey)})`);
    await installBoundaryFailure("throw-read-save");
    await navigate(
        homeUrl,
        "/",
        "K6-Based Psychological Distress Check",
        "throwing-storage Home",
    );
    await assertUnavailableHome("throwing-storage Home");
    assert(
        (await evaluate("window.__issue25GetResultsCalls")) === 1,
        "throwing-storage Home did not make exactly one read attempt",
    );
    await navigate(historyUrl, "/history", "History", "throwing-storage History");
    await assertUnavailableHistory("throwing-storage History");
    assert(
        (await evaluate("window.__issue25GetResultsCalls")) === 1,
        "throwing-storage History did not make exactly one read attempt",
    );
    await navigate(
        homeUrl,
        "/",
        "K6-Based Psychological Distress Check",
        "throwing-storage Home before test",
    );
    await assertUnavailableHome("throwing-storage Home before test");
    await activateVisible("a", "Start Test");
    await waitFor(
        'location.pathname === "/test" && Boolean(document.querySelector("[data-questionnaire]"))',
        "throwing-storage Start Test did not open the questionnaire",
    );
    await assertQuestionnaireOnly("throwing-storage questionnaire");
    assert(
        (await evaluate("window.__issue25GetResultsCalls")) === 0,
        "throwing-storage questionnaire attempted a history read",
    );
    await completeAssessment(unavailableResponses, "throwing-storage completion");
    const requestsBeforeThrowingCompletion = client.requests.length;
    await activateVisible('[data-question-step="6"] button', "See my result");
    await waitFor(
        'location.pathname === "/result" && Boolean(document.querySelector("[data-active-result]"))',
        "throwing save prevented Result",
    );
    await assertResult(
        0,
        "Below the cutoff",
        "Your score is below the serious or elevated psychological distress cutoff of 13.",
        "throwing-storage completion",
    );
    state = await pageSnapshot();
    assert(
        (await evaluate("window.__issue25SaveResultCalls")) === 1,
        "throwing completion did not make exactly one save attempt",
    );
    assert(
        !state.visibleText.includes(unavailableNotice) &&
            !/storage|exception|failed to save|try again/i.test(state.visibleText),
        "throwing completion exposed storage failure detail or alternate error copy",
    );
    assert(
        client.requests.length === requestsBeforeThrowingCompletion,
        "throwing completion caused a retry or fallback request",
    );
    assertStorageIsolation(
        await storageSnapshot(),
        null,
        "throwing-storage completion",
    );
    await client.send("Page.reload", { ignoreCache: true });
    await waitFor(
        'location.pathname === "/" && document.readyState === "complete"',
        "throwing Result reload did not settle at Home",
    );
    await assertUnavailableHome("throwing Result reload");
    state = await pageSnapshot();
    assert(
        state.resultHeading === null && state.resultScore === null &&
            (await evaluate("window.__issue25SaveResultCalls")) === 0,
        "throwing Result reload recreated the Result or made a second save attempt",
    );
    assertStorageIsolation(await storageSnapshot(), null, "throwing Result reload");

    // Whole-journey privacy, transport, and error checks.
    assert(
        client.requests.every((request) => {
            const url = new URL(request.url);
            return request.method === "GET" && request.postData === undefined &&
                url.origin === appOrigin &&
                (["/", "/test", "/result", "/history"].includes(url.pathname) ||
                    url.pathname.startsWith("/static/") ||
                    url.pathname === "/favicon.ico");
        }),
        `journey made an unexpected request: ${JSON.stringify(client.requests)}`,
    );
    assert(
        client.navigationUrls.every((url) => {
            const parsed = new URL(url);
            return parsed.origin === appOrigin && parsed.search === "" &&
                parsed.hash === "" &&
                ["/", "/test", "/result", "/history"].includes(parsed.pathname);
        }),
        `journey exposed assessment data in navigation: ${JSON.stringify(client.navigationUrls)}`,
    );
    assert(
        client.exceptions.length === 0,
        `journey exposed an uncaught exception: ${JSON.stringify(client.exceptions)}`,
    );
    assert(client.dialogs.length === 0, "journey opened a dialog");

    console.log("history and failure journey browser scenario passed");
} finally {
    await removeBoundaryFailure().catch(() => {});
    client.close();
}
