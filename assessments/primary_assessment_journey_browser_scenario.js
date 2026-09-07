const [websocketUrl, testUrl, homeUrl, historyUrl] = process.argv.slice(2);

const appOrigin = new URL(homeUrl).origin;
const storageKey = "k6-based-distress-check.history.v1";
const intro = "Answer six short questions about how you have felt over the past 30 days.";
const responses = [
    { label: "All of the time", score: 4 },
    { label: "Most of the time", score: 3 },
    { label: "Some of the time", score: 2 },
    { label: "A little of the time", score: 1 },
    { label: "None of the time", score: 0 },
    { label: "All of the time", score: 4 },
];
const resourceLinks = [
    ["NIMH: Mental Health Information", "https://www.nimh.nih.gov/health"],
    ["WHO: Mental health", "https://www.who.int/news-room/fact-sheets/detail/mental-health-strengthening-our-response"],
    ["WHO: Doing What Matters in Times of Stress", "https://www.who.int/publications/i/item/9789240003927"],
    ["NHS Every Mind Matters: Self-help CBT techniques", "https://www.nhs.uk/every-mind-matters/mental-wellbeing-tips/self-help-cbt-techniques/"],
];

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
const navigationUrls = [];
client.on("Network.requestWillBeSent", ({ request }) => requests.push(request));
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
    exceptions.push(exceptionDetails));
client.on("Page.javascriptDialogOpening", ({ message }) => dialogs.push(message));
client.on("Page.frameNavigated", ({ frame }) => {
    if (!frame.parentId && frame.url.startsWith(appOrigin)) navigationUrls.push(frame.url);
});
client.on("Page.navigatedWithinDocument", ({ frameId, url }) => {
    if (frameId && url.startsWith(appOrigin)) navigationUrls.push(url);
});

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
            // A real navigation can briefly destroy the previous execution context.
        }
        await delay(50);
    }
    throw new Error(message);
};

const assertExactRoute = async (pathname, context) => {
    const route = await evaluate(`({
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        state: history.state,
    })`);
    assert(route.pathname === pathname && route.search === "" && route.hash === "" &&
        route.state === null, `${context}: route or browser-history state is not exact`);
};

const pointForVisibleText = async (selector, text) => {
    const point = await evaluate(`(() => {
        const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
            .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)} &&
                !candidate.hidden && candidate.getClientRects().length > 0 &&
                getComputedStyle(candidate).visibility !== "hidden");
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const bounds = element.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    assert(point, `visible ${selector} named ${JSON.stringify(text)} was not found`);
    return point;
};

const activateVisible = async (selector, text) => {
    const point = await pointForVisibleText(selector, text);
    await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: point.x, y: point.y,
    });
    await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed", x: point.x, y: point.y,
        button: "left", clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: point.x, y: point.y,
        button: "left", clickCount: 1,
    });
};

const browserBack = async () => {
    const history = await client.send("Page.getNavigationHistory");
    assert(history.currentIndex > 0, "browser has no Back history entry");
    await client.send("Page.navigateToHistoryEntry", {
        entryId: history.entries[history.currentIndex - 1].id,
    });
};

const homeSnapshot = () => evaluate(`(() => {
    const visible = (element) => Boolean(element && !element.hidden &&
        element.getClientRects().length > 0 && getComputedStyle(element).display !== "none");
    const start = Array.from(document.querySelectorAll("a"))
        .find((link) => link.textContent.trim() === "Start Test");
    const historyLink = document.querySelector("[data-history-link]");
    const unavailable = document.querySelector("[data-history-unavailable]");
    return {
        heading: document.querySelector("h1")?.textContent.trim(),
        introduction: document.querySelector("h1 + p")?.textContent.trim(),
        start: { visible: visible(start), href: start?.href, ariaDisabled: start?.getAttribute("aria-disabled") },
        history: { visible: visible(historyLink), href: historyLink?.href },
        unavailableVisible: visible(unavailable),
        storage: {
            localLength: localStorage.length,
            sessionLength: sessionStorage.length,
            cookie: document.cookie,
        },
    };
})()`);

const assertAvailableHome = async (context, expectedLocalStorageLength) => {
    await assertExactRoute("/", context);
    const state = await homeSnapshot();
    assert(state.heading === "K6-Based Psychological Distress Check" &&
        state.introduction === intro, `${context}: Home copy changed`);
    assert(state.start.visible && state.start.href === testUrl && state.start.ariaDisabled === null,
        `${context}: Start Test is unavailable`);
    assert(state.history.visible && state.history.href === historyUrl &&
        !state.unavailableVisible, `${context}: View History availability is wrong`);
    assert(state.storage.localLength === expectedLocalStorageLength &&
        state.storage.sessionLength === 0 && state.storage.cookie === "",
    `${context}: origin storage is not in the expected state`);
};

const questionSnapshot = () => evaluate(`(() => {
    const steps = Array.from(document.querySelectorAll("[data-question-step]:not([hidden])"));
    const step = steps[0];
    const forward = step?.querySelector("[data-questionnaire-next], [data-questionnaire-submit]");
    return {
        heading: document.querySelector("h1")?.textContent.trim(),
        visibleStepCount: steps.length,
        number: Number(step?.dataset.questionStep),
        count: step?.querySelector(".question-count")?.textContent.trim(),
        progressValue: step?.querySelector("progress")?.value,
        progressMaximum: step?.querySelector("progress")?.max,
        choices: Array.from(step?.querySelectorAll(".response-option") ?? [],
            (card) => card.textContent.trim()),
        selected: step?.querySelector('input[type="radio"]:checked')?.closest(".response-option")?.textContent.trim() ?? null,
        totalSelected: document.querySelectorAll('input[type="radio"]:checked').length,
        forwardText: forward?.textContent.trim(),
        forwardDisabled: forward?.disabled,
    };
})()`);

const assertQuestion = async (number, selected = null, context = `Question ${number}`) => {
    await assertExactRoute("/test", context);
    const state = await questionSnapshot();
    assert(state.heading === "Test" && state.visibleStepCount === 1 &&
        state.number === number && state.count === `Question ${number} of 6` &&
        state.progressValue === number && state.progressMaximum === 6,
    `${context}: visible question or progress is wrong`);
    assert(JSON.stringify(state.choices) === JSON.stringify([
        "None of the time", "A little of the time", "Some of the time",
        "Most of the time", "All of the time",
    ]), `${context}: response choices changed`);
    const expectedTotalSelected = selected === null ? number - 1 : number;
    assert(state.selected === selected && state.totalSelected === expectedTotalSelected,
        `${context}: selected response state is wrong`);
    assert(state.forwardText === (number === 6 ? "See my result" : "Next") &&
        state.forwardDisabled === (selected === null), `${context}: forward control state is wrong`);
};

const resultSnapshot = () => evaluate(`(() => {
    const result = document.querySelector("[data-active-result]");
    return {
        heading: result?.querySelector("h1")?.textContent.trim(),
        score: result?.querySelector("[data-active-result-score]")?.textContent.trim(),
        status: result?.querySelector("[data-active-result-status]")?.textContent.trim(),
        interpretation: result?.querySelector("[data-active-result-interpretation]")?.textContent.trim(),
        higher: result?.querySelector("[data-active-result-higher-score]")?.textContent.trim(),
        guidance: result?.querySelector("[data-active-result-guidance]")?.textContent.trim(),
        resources: Array.from(result?.querySelectorAll("[data-active-result-resources] a") ?? [],
            (link) => [link.textContent.trim(), link.href]),
        retakeCount: result?.querySelectorAll("[data-take-test-again]").length ?? 0,
        retakeText: result?.querySelector("[data-take-test-again]")?.textContent.trim(),
        visibleText: result?.innerText,
        questionnaireCount: document.querySelectorAll("[data-questionnaire]").length,
    };
})()`);

const historySnapshot = () => evaluate(`(() => {
    const visible = (element) => Boolean(element && !element.hidden &&
        element.getClientRects().length > 0 && getComputedStyle(element).display !== "none");
    const figure = document.querySelector("[data-history-chart-container]");
    const list = document.querySelector("[data-history-results]");
    const row = document.querySelector("[data-history-result]");
    return {
        heading: document.querySelector("h1")?.textContent.trim(),
        emptyVisible: visible(document.querySelector("[data-history-empty]")),
        unavailableVisible: visible(document.querySelector("[data-history-unavailable]")),
        figureVisible: visible(figure),
        figureAboveList: figure?.getBoundingClientRect().bottom < list?.getBoundingClientRect().top,
        chartName: document.querySelector("[data-history-chart]")?.getAttribute("aria-label"),
        pointCount: document.querySelectorAll("[data-history-score-point]").length,
        cutoffCount: document.querySelectorAll("[data-history-cutoff-line]").length,
        explanation: document.querySelector("[data-history-chart-explanation]")?.textContent.trim(),
        rows: Array.from(document.querySelectorAll("[data-history-result]"), (item) =>
            Array.from(item.children, (value) => value.textContent.trim())),
        clearVisible: visible(document.querySelector("[data-clear-history]")),
        clearText: document.querySelector("[data-clear-history]")?.textContent.trim(),
        rowInteractiveCount: row?.querySelectorAll("a, button, input, [tabindex]").length ?? 0,
        raw: localStorage.getItem(${JSON.stringify(storageKey)}),
        localKeys: Object.keys(localStorage),
        sessionLength: sessionStorage.length,
        cookie: document.cookie,
    };
})()`);

try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });

    await client.send("Page.navigate", { url: homeUrl });
    await waitFor('location.pathname === "/" && document.readyState === "complete"',
        "fresh Home did not load");
    await assertAvailableHome("fresh Home", 0);

    await activateVisible("a", "Start Test");
    await waitFor('location.pathname === "/test" && Boolean(document.querySelector("[data-questionnaire]"))',
        "Start Test did not open the questionnaire");
    await assertQuestion(1);

    for (let index = 0; index < responses.length; index += 1) {
        const question = index + 1;
        const response = responses[index];
        await activateVisible(`[data-question-step="${question}"] .response-option`, response.label);
        await waitFor(
            `document.querySelector('[data-question-step="${question}"] [data-questionnaire-next], [data-question-step="${question}"] [data-questionnaire-submit]').disabled === false`,
            `Question ${question} forward control did not enable`,
        );
        await assertQuestion(question, response.label);
        if (question < 6) {
            await activateVisible(`[data-question-step="${question}"] button`, "Next");
            await waitFor(
                `!document.querySelector('[data-question-step="${question + 1}"]').hidden`,
                `Question ${question + 1} did not appear`,
            );
            await assertQuestion(question + 1);
        }
    }

    const beforeCompletion = await evaluate("Date.now()");
    await activateVisible('[data-question-step="6"] button', "See my result");
    await waitFor('location.pathname === "/result" && Boolean(document.querySelector("[data-active-result]"))',
        "See my result did not render Result");
    const afterCompletion = await evaluate("Date.now()");
    await assertExactRoute("/result", "completed Result");
    const result = await resultSnapshot();
    assert(result.heading === "Result" && result.score === "14 / 24" &&
        result.status === "At or above the cutoff" &&
        result.interpretation === "Your score is at or above the serious or elevated psychological distress cutoff of 13.",
    "completed Result score or cutoff copy is wrong");
    assert(result.higher === "Higher scores indicate greater psychological distress." &&
        result.guidance.includes("consider talking with a qualified healthcare professional") &&
        JSON.stringify(result.resources) === JSON.stringify(resourceLinks) &&
        result.retakeCount === 1 && result.retakeText === "Take test again",
    "completed Result guidance or resource links are wrong");
    assert(result.questionnaireCount === 0 &&
        responses.every(({ label }) => !result.visibleText.includes(label)),
    "Result exposes questionnaire answers or retains the live questionnaire");

    const stored = await evaluate(`(() => {
        const raw = localStorage.getItem(${JSON.stringify(storageKey)});
        return {
            raw,
            parsed: JSON.parse(raw),
            keys: Object.keys(localStorage),
            sessionLength: sessionStorage.length,
            cookie: document.cookie,
        };
    })()`);
    assert(stored.parsed.length === 1 &&
        JSON.stringify(Object.keys(stored.parsed[0])) === JSON.stringify(["score", "timestamp"]) &&
        stored.parsed[0].score === 14 && Number.isFinite(stored.parsed[0].timestamp) &&
        Number.isInteger(stored.parsed[0].timestamp) && stored.parsed[0].timestamp >= beforeCompletion &&
        stored.parsed[0].timestamp <= afterCompletion,
    "completion did not create one exact score/timestamp record in the observed time window");
    assert(stored.raw === JSON.stringify([{ score: 14, timestamp: stored.parsed[0].timestamp }]) &&
        JSON.stringify(stored.keys) === JSON.stringify([storageKey]) &&
        stored.sessionLength === 0 && stored.cookie === "" &&
        !/answer|response|prompt|cutoff|result|identifier/i.test(stored.raw),
    "stored completion is non-canonical or exposes private assessment data");

    const expectedDate = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
    }).format(stored.parsed[0].timestamp);
    const expectedTime = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true,
    }).format(stored.parsed[0].timestamp);

    await browserBack();
    await waitFor('location.pathname === "/test" && Boolean(document.querySelector("[data-questionnaire]"))',
        "browser Back from Result did not return to Test");
    await assertQuestion(1, null, "fresh Test after Result Back");
    await browserBack();
    await waitFor('location.pathname === "/" && document.readyState === "complete"',
        "second browser Back did not return Home");
    await assertAvailableHome("returned Home", 1);

    await activateVisible("a", "View History");
    await waitFor('location.pathname === "/history" && document.querySelectorAll("[data-history-result]").length === 1',
        "View History did not show the saved result");
    await assertExactRoute("/history", "populated History");
    const history = await historySnapshot();
    assert(history.heading === "History" && !history.emptyVisible && !history.unavailableVisible &&
        history.figureVisible && history.figureAboveList &&
        history.chartName === "Saved score trend from oldest to newest" &&
        history.pointCount === 1 && history.cutoffCount === 1 &&
        history.explanation === "Scores are shown from oldest to newest. The horizontal line marks the cutoff score of 13.",
    "one-record History chart state is wrong");
    assert(JSON.stringify(history.rows) === JSON.stringify([[
        expectedDate, expectedTime, "14 / 24", "At or above the cutoff",
    ]]) && history.clearVisible && history.clearText === "Clear All History" &&
        history.rowInteractiveCount === 0,
    "one-record History does not show the exact saved local values");
    assert(history.raw === stored.raw && JSON.stringify(history.localKeys) === JSON.stringify([storageKey]) &&
        history.sessionLength === 0 && history.cookie === "",
    "viewing History changed or duplicated persisted data");

    await browserBack();
    await waitFor('location.pathname === "/" && document.readyState === "complete"',
        "browser Back from History did not return Home");
    await assertAvailableHome("Home after History Back", 1);
    await activateVisible("a", "Start Test");
    await waitFor('location.pathname === "/test" && Boolean(document.querySelector("[data-questionnaire]"))',
        "second Start Test did not open a fresh questionnaire");
    await assertQuestion(1, null, "second fresh assessment");
    const finalStorage = await evaluate(`({
        raw: localStorage.getItem(${JSON.stringify(storageKey)}),
        keys: Object.keys(localStorage),
        sessionLength: sessionStorage.length,
        cookie: document.cookie,
    })`);
    assert(finalStorage.raw === stored.raw &&
        JSON.stringify(finalStorage.keys) === JSON.stringify([storageKey]) &&
        finalStorage.sessionLength === 0 && finalStorage.cookie === "",
    "beginning a second assessment changed the one saved record");

    assert(exceptions.length === 0, `journey exposed an exception: ${JSON.stringify(exceptions)}`);
    assert(dialogs.length === 0, "journey opened a dialog");
    assert(requests.every((request) => request.method === "GET" &&
        request.postData === undefined && new URL(request.url).origin === appOrigin),
    "journey made a POST, data-bearing, or remote request");
    assert(navigationUrls.length >= 8 && navigationUrls.every((url) => {
        const parsed = new URL(url);
        return parsed.origin === appOrigin && parsed.search === "" && parsed.hash === "" &&
            ["/", "/test", "/result", "/history"].includes(parsed.pathname);
    }), `journey exposed an unexpected application URL: ${JSON.stringify(navigationUrls)}`);

    console.log("primary assessment journey browser scenario passed");
} finally {
    client.close();
}
