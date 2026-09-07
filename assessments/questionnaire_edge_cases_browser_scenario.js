const [websocketUrl, testUrl, homeUrl] = process.argv.slice(2);

const appOrigin = new URL(testUrl).origin;
const storageKey = "k6-based-distress-check.history.v1";
const expectedInitialRequestPaths = [
    "/test",
    "/static/assessments/app.css",
    "/static/assessments/k6-scoring.js",
    "/static/assessments/result-content.js",
    "/static/assessments/assessment-history.js",
    "/static/assessments/app.js",
    "/favicon.ico",
];
const choices = [
    "None of the time",
    "A little of the time",
    "Some of the time",
    "Most of the time",
    "All of the time",
];
const retainedAnswers = new Map([
    [1, "A little of the time"],
    [2, "Some of the time"],
    [3, "Some of the time"],
    [4, "None of the time"],
    [5, "Most of the time"],
]);

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
const requestCheckpoints = [];
const exceptions = [];
const dialogs = [];
let settledRequestCount = null;
client.on("Network.requestWillBeSent", ({ request }) => requests.push(request));
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => exceptions.push(exceptionDetails));
client.on("Page.javascriptDialogOpening", ({ message }) => dialogs.push(message));

const evaluate = async (expression) => {
    const response = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(
            response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
        );
    }
    return response.result.value;
};

const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try {
            if (await evaluate(predicate)) return;
        } catch {
            // Navigation can briefly replace the execution context.
        }
        await delay(50);
    }
    throw new Error(message);
};

const assertExpectedRequest = (request, context) => {
    const url = new URL(request.url);
    assert(request.method === "GET" && request.postData === undefined &&
        url.origin === appOrigin && url.search === "" && url.hash === "" &&
        expectedInitialRequestPaths.includes(url.pathname),
    `${context}: unexpected request ${request.method} ${request.url}`);
};

const checkpointNoNewRequest = (context) => {
    if (settledRequestCount === null) return;
    requestCheckpoints.push({ context, count: requests.length });
    assert(requests.length === settledRequestCount,
        `${context}: interaction caused a request after initial assets settled`);
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

const pointerActivate = async (selector, text) => {
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

const pressKey = async (key, code, keyCode) => {
    const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
    await client.send("Input.dispatchKeyEvent", {
        type: "keyDown", key, code,
        text, unmodifiedText: text,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
    await client.send("Input.dispatchKeyEvent", {
        type: "keyUp", key, code,
        windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
};

const focusByTab = async (selector, context) => {
    await client.send("Page.bringToFront");
    for (let attempt = 0; attempt < 16; attempt += 1) {
        await pressKey("Tab", "Tab", 9);
        if (await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return;
    }
    throw new Error(`${context}: keyboard focus did not reach ${selector}`);
};

const focusRadioByKeyboard = async (question, value, context) => {
    const groupSelector = `[data-question-step="${question}"] input[type="radio"]`;
    await focusByTab(groupSelector, context);
    for (let attempt = 0; attempt < choices.length; attempt += 1) {
        if (await evaluate(`document.activeElement?.value === ${JSON.stringify(String(value))}`)) return;
        await pressKey("ArrowRight", "ArrowRight", 39);
    }
    throw new Error(`${context}: keyboard navigation did not reach response ${value}`);
};

const assertFocusedRadioIsUnchecked = async (question, value, context) => {
    const focusState = await evaluate(`(() => {
        const radio = document.querySelector('[data-question-step="${question}"] input[value="${value}"]');
        return { focused: document.activeElement === radio, checked: radio.checked };
    })()`);
    assert(focusState.focused && !focusState.checked,
        `${context}: target radio must be focused and unchecked immediately before Space`);
};

const snapshot = () => evaluate(`(() => {
    const visible = (element) => Boolean(element && !element.hidden &&
        element.getClientRects().length > 0 && getComputedStyle(element).display !== "none");
    const steps = Array.from(document.querySelectorAll("[data-question-step]:not([hidden])"));
    const step = steps[0];
    const forward = step?.querySelector("[data-questionnaire-next], [data-questionnaire-submit]");
    const back = step?.querySelector("[data-questionnaire-back]");
    const helper = step?.querySelector("[data-question-helper]");
    const helperCopy = step?.querySelector("[data-question-helper-copy]");
    return {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        historyState: history.state,
        heading: document.querySelector("h1")?.textContent.trim(),
        visibleStepCount: steps.length,
        number: Number(step?.dataset.questionStep),
        count: step?.querySelector(".question-count")?.textContent.trim(),
        progressValue: step?.querySelector("progress")?.value,
        progressMaximum: step?.querySelector("progress")?.max,
        choices: Array.from(step?.querySelectorAll(".response-option") ?? [],
            (card) => card.textContent.trim()),
        selected: step?.querySelector('input[type="radio"]:checked')?.closest(".response-option")?.textContent.trim() ?? null,
        selectedCount: step?.querySelectorAll('input[type="radio"]:checked').length ?? 0,
        totalSelectedCount: document.querySelectorAll('input[type="radio"]:checked').length,
        backVisible: visible(back),
        backText: back?.textContent.trim() ?? null,
        forwardVisible: visible(forward),
        forwardText: forward?.textContent.trim() ?? null,
        forwardDisabled: forward?.disabled ?? null,
        activeIsForward: document.activeElement === forward,
        helper: helper ? {
            text: helper.textContent.trim(),
            expanded: helper.getAttribute("aria-expanded"),
            copy: helperCopy?.textContent.trim(),
            copyVisible: visible(helperCopy),
        } : null,
        activeResult: Boolean(document.querySelector("[data-active-result]")),
        rawHistory: localStorage.getItem(${JSON.stringify(storageKey)}),
        localKeys: Object.keys(localStorage),
        sessionLength: sessionStorage.length,
        cookie: document.cookie,
    };
})()`);

const assertQuestion = async (
    number,
    selected,
    context,
    { helperExpanded = false, totalSelectedCount = null } = {},
) => {
    const state = await snapshot();
    assert(state.pathname === "/test" && state.search === "" && state.hash === "" &&
        state.historyState === null && !state.activeResult, `${context}: route or Result state changed`);
    assert(state.heading === "Test" && state.visibleStepCount === 1 && state.number === number &&
        state.count === `Question ${number} of 6` && state.progressValue === number &&
        state.progressMaximum === 6, `${context}: question count or progress is wrong`);
    assert(JSON.stringify(state.choices) === JSON.stringify(choices),
        `${context}: five visible response labels changed`);
    assert(state.backVisible === (number > 1) &&
        (number === 1 || state.backText === "Back"), `${context}: Back state is wrong`);
    assert(state.forwardVisible && state.forwardText === (number === 6 ? "See my result" : "Next") &&
        state.forwardDisabled === (selected === null), `${context}: forward state is wrong`);
    assert(state.selected === selected && state.selectedCount === (selected === null ? 0 : 1),
        `${context}: current selected response is wrong`);
    if (totalSelectedCount !== null) {
        assert(state.totalSelectedCount === totalSelectedCount,
            `${context}: retained response count is wrong`);
    }
    if (number === 3) {
        assert(state.helper?.text === "What does this mean?" &&
            state.helper.expanded === (helperExpanded ? "true" : "false") &&
            state.helper.copy === "Restless or fidgety means finding it hard to relax or stay still." &&
            state.helper.copyVisible === helperExpanded,
        `${context}: helper state is wrong`);
    }
    assert(state.rawHistory === null && state.localKeys.length === 0 &&
        state.sessionLength === 0 && state.cookie === "",
    `${context}: questionnaire interaction persisted data before completion`);
    checkpointNoNewRequest(context);
    return state;
};

const selectByPointer = async (question, label, totalSelectedCount, helperExpanded = false) => {
    await pointerActivate(`[data-question-step="${question}"] .response-option`, label);
    const state = await assertQuestion(question, label, `Question ${question} after selecting ${label}`, {
        helperExpanded,
        totalSelectedCount,
    });
    assert(!state.activeIsForward, `Question ${question}: selection moved focus to the forward control`);
};

const nextByPointer = async (question) => {
    await pointerActivate(`[data-question-step="${question}"] button`, "Next");
    await waitFor(`!document.querySelector('[data-question-step="${question + 1}"]').hidden`,
        `Next did not show Question ${question + 1}`);
};

const backByPointer = async (question) => {
    await pointerActivate(`[data-question-step="${question}"] button`, "Back");
    await waitFor(`!document.querySelector('[data-question-step="${question - 1}"]').hidden`,
        `Back did not show Question ${question - 1}`);
};

const exerciseDisabledForward = async (question) => {
    const label = question === 6 ? "See my result" : "Next";
    const selector = `[data-question-step="${question}"] [data-questionnaire-${question === 6 ? "submit" : "next"}]`;
    await pointerActivate(selector, label);
    await assertQuestion(question, null, `Question ${question} after disabled pointer activation`, {
        totalSelectedCount: question === 6 ? 5 : 0,
    });
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await assertQuestion(question, null, `Question ${question} after disabled click()`, {
        totalSelectedCount: question === 6 ? 5 : 0,
    });
    await evaluate("document.querySelector('[data-questionnaire]').requestSubmit()");
    await assertQuestion(question, null, `Question ${question} after unanswered requestSubmit()`, {
        totalSelectedCount: question === 6 ? 5 : 0,
    });
};

try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
        width: 320, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await client.send("Page.navigate", { url: testUrl });
    await waitFor('location.pathname === "/test" && document.readyState === "complete" && Boolean(document.querySelector("[data-questionnaire]"))',
        "fresh questionnaire did not load");

    requests.forEach((request) => assertExpectedRequest(request, "initial page load"));
    const observedInitialPaths = requests.map((request) => new URL(request.url).pathname).sort();
    assert(JSON.stringify(observedInitialPaths) ===
        JSON.stringify([...expectedInitialRequestPaths].sort()),
    `initial page load requests changed: ${JSON.stringify(observedInitialPaths)}`);
    settledRequestCount = requests.length;

    await assertQuestion(1, null, "initial Question 1", { totalSelectedCount: 0 });
    await exerciseDisabledForward(1);
    await selectByPointer(1, "A little of the time", 1);
    await nextByPointer(1);
    await assertQuestion(2, null, "initial Question 2", { totalSelectedCount: 1 });

    await focusRadioByKeyboard(2, 2, "Question 2 Some of the time");
    await assertFocusedRadioIsUnchecked(2, 2, "Question 2 before Space");
    await assertQuestion(2, null, "Question 2 immediately before Space", {
        totalSelectedCount: 1,
    });
    await pressKey(" ", "Space", 32);
    let state = await assertQuestion(2, "Some of the time", "Question 2 after Space", {
        totalSelectedCount: 2,
    });
    assert(!state.activeIsForward, "Question 2 Space selection auto-advanced or moved focus to Next");
    await focusByTab('[data-question-step="2"] [data-questionnaire-next]', "Question 2 Next");
    await pressKey("Enter", "Enter", 13);
    await waitFor('!document.querySelector("[data-question-step=\\"3\\"]").hidden',
        "Question 2 Enter did not advance exactly once to Question 3");
    await assertQuestion(3, null, "initial Question 3", { totalSelectedCount: 2 });

    await pointerActivate('[data-question-step="3"] button', "What does this mean?");
    await assertQuestion(3, null, "Question 3 expanded helper", {
        helperExpanded: true,
        totalSelectedCount: 2,
    });
    await selectByPointer(3, "Some of the time", 3, true);
    await nextByPointer(3);
    await assertQuestion(4, null, "initial Question 4", { totalSelectedCount: 3 });
    await backByPointer(4);
    await assertQuestion(3, "Some of the time", "Question 3 restored after Back", {
        helperExpanded: false,
        totalSelectedCount: 3,
    });
    await nextByPointer(3);
    await assertQuestion(4, null, "returned Question 4", { totalSelectedCount: 3 });

    await selectByPointer(4, "None of the time", 4);
    await nextByPointer(4);
    await assertQuestion(5, null, "initial Question 5", { totalSelectedCount: 4 });
    await selectByPointer(5, "Most of the time", 5);
    await nextByPointer(5);
    await assertQuestion(6, null, "initial Question 6", { totalSelectedCount: 5 });
    await exerciseDisabledForward(6);

    for (let question = 6; question > 1; question -= 1) {
        await backByPointer(question);
        const previous = question - 1;
        await assertQuestion(previous, retainedAnswers.get(previous),
            `Question ${previous} restored while returning`, {
                helperExpanded: false,
                totalSelectedCount: 5,
            });
    }

    await selectByPointer(1, "All of the time", 5);
    for (let question = 1; question < 6; question += 1) {
        await nextByPointer(question);
        const nextQuestion = question + 1;
        const retained = retainedAnswers.get(nextQuestion) ?? null;
        await assertQuestion(nextQuestion, retained,
            `Question ${nextQuestion} retained while advancing`, {
                helperExpanded: false,
                totalSelectedCount: 5,
            });
    }

    await focusRadioByKeyboard(6, 4, "Question 6 All of the time");
    await assertFocusedRadioIsUnchecked(6, 4, "Question 6 before Space");
    await assertQuestion(6, null, "Question 6 immediately before Space", {
        totalSelectedCount: 5,
    });
    await pressKey(" ", "Space", 32);
    state = await assertQuestion(6, "All of the time", "Question 6 after Space", {
        totalSelectedCount: 6,
    });
    assert(!state.activeIsForward, "Question 6 Space selection auto-submitted or moved focus to Submit");
    await focusByTab('[data-question-step="6"] [data-questionnaire-submit]', "Question 6 See my result");
    checkpointNoNewRequest("before accepted keyboard submission");
    const beforeCompletion = await evaluate("Date.now()");
    await pressKey("Enter", "Enter", 13);
    await waitFor('location.pathname === "/result" && Boolean(document.querySelector("[data-active-result]"))',
        "enabled keyboard submission did not render Result");
    const afterCompletion = await evaluate("Date.now()");

    const result = await evaluate(`(() => {
        const raw = localStorage.getItem(${JSON.stringify(storageKey)});
        const record = JSON.parse(raw)[0];
        const page = document.querySelector("[data-active-result]");
        return {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            historyState: history.state,
            questionnaireCount: document.querySelectorAll("[data-questionnaire]").length,
            heading: page.querySelector("h1").textContent.trim(),
            score: page.querySelector("[data-active-result-score]").textContent.trim(),
            status: page.querySelector("[data-active-result-status]").textContent.trim(),
            interpretation: page.querySelector("[data-active-result-interpretation]").textContent.trim(),
            retakeVisible: !page.querySelector("[data-take-test-again]").hidden,
            retakeText: page.querySelector("[data-take-test-again]").textContent.trim(),
            visibleText: page.innerText,
            raw,
            record,
            recordKeys: Object.keys(record),
            localKeys: Object.keys(localStorage),
            sessionLength: sessionStorage.length,
            cookie: document.cookie,
        };
    })()`);
    assert(result.pathname === "/result" && result.search === "" && result.hash === "" &&
        result.historyState === null && result.questionnaireCount === 0,
    "accepted completion did not settle on exact transient Result");
    assert(result.heading === "Result" && result.score === "15 / 24" &&
        result.status === "At or above the cutoff" &&
        result.interpretation === "Your score is at or above the serious or elevated psychological distress cutoff of 13." &&
        result.retakeVisible && result.retakeText === "Take test again",
    "edited retained answers did not produce the exact 15-point Result");
    assert(JSON.stringify(result.recordKeys) === JSON.stringify(["score", "timestamp"]) &&
        result.record.score === 15 && Number.isFinite(result.record.timestamp) &&
        Number.isInteger(result.record.timestamp) && result.record.timestamp >= beforeCompletion &&
        result.record.timestamp <= afterCompletion &&
        result.raw === JSON.stringify([{ score: 15, timestamp: result.record.timestamp }]),
    "accepted keyboard submit did not save one canonical 15-point record");
    assert(JSON.stringify(result.localKeys) === JSON.stringify([storageKey]) &&
        result.sessionLength === 0 && result.cookie === "" &&
        !/answer|response|prompt|cutoff|identifier/i.test(result.raw) &&
        choices.every((choice) => !result.visibleText.includes(choice)),
    "Result or storage exposes questionnaire answers or additional state");

    assert(exceptions.length === 0, `edge journey exposed an exception: ${JSON.stringify(exceptions)}`);
    assert(dialogs.length === 0, "edge journey opened a dialog");
    requests.forEach((request) => assertExpectedRequest(request, "full edge journey"));
    assert(requests.length === settledRequestCount &&
        requestCheckpoints.every((checkpoint) => checkpoint.count === settledRequestCount),
    "edge journey made a request after the initial navigation and static assets");

    console.log("questionnaire edge cases browser scenario passed");
} finally {
    client.close();
}
