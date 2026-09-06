const [websocketUrl, testUrl, homeUrl] = process.argv.slice(2);
const resultUrl = new URL("/result", testUrl).href;

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
        this.eventHandlers = new Map();
        websocket.addEventListener("message", (event) => {
            const message = JSON.parse(event.data.toString());
            const pendingMessage = this.pendingMessages.get(message.id);
            if (pendingMessage) {
                this.pendingMessages.delete(message.id);
                if (message.error) {
                    pendingMessage.reject(new Error(message.error.message));
                } else {
                    pendingMessage.resolve(message.result);
                }
                return;
            }

            for (const handler of this.eventHandlers.get(message.method) ?? []) {
                handler(message.params, message.sessionId);
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

    static async connect(url) {
        let lastError;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const websocket = new WebSocket(url);
            websocket.addEventListener("error", () => {});
            try {
                await new Promise((resolve, reject) => {
                    const handleOpen = () => {
                        websocket.removeEventListener("error", handleError);
                        resolve();
                    };
                    const handleError = (error) => {
                        websocket.removeEventListener("open", handleOpen);
                        reject(error);
                    };
                    websocket.addEventListener("open", handleOpen, { once: true });
                    websocket.addEventListener("error", handleError, { once: true });
                });
                return new DevToolsClient(websocket);
            } catch (error) {
                lastError = error;
                await delay(50);
            }
        }
        throw lastError;
    }

    send(method, params = {}, sessionId = undefined) {
        const id = this.nextMessageId;
        this.nextMessageId += 1;

        return new Promise((resolve, reject) => {
            this.pendingMessages.set(id, { resolve, reject });
            this.websocket.send(
                JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
            );
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
const networkRequests = [];
client.on("Network.requestWillBeSent", ({ request }) => {
    networkRequests.push({
        url: request.url,
        method: request.method,
        postData: request.postData ?? null,
    });
});

const evaluate = async (expression, sessionId = undefined) => {
    const response = await client.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
    );
    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text);
    }
    return response.result.value;
};

const waitFor = async (predicate, message, sessionId = undefined) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try {
            if (await evaluate(predicate, sessionId)) {
                return;
            }
        } catch {
            // A route transition can briefly destroy the prior execution context.
        }
        await delay(50);
    }
    throw new Error(message);
};

const waitForQuestionnaire = (sessionId = undefined) =>
    waitFor(
        'location.pathname === "/test" && document.readyState === "complete" && Boolean(document.querySelector("[data-questionnaire]"))',
        "questionnaire did not become ready",
        sessionId,
    );

const waitForHome = (sessionId = undefined) =>
    waitFor(
        'location.pathname === "/" && document.querySelector("h1")?.textContent.trim() === "K6-Based Psychological Distress Check"',
        "Home did not become visible",
        sessionId,
    );

const waitForResult = (expectedScore) =>
    waitFor(
        `location.pathname === "/result" && document.querySelector("[data-active-result-score]")?.textContent.trim() === "${expectedScore} / 24"`,
        `active ${expectedScore}-point result did not become visible`,
    );

const navigate = async (url, ready) => {
    await client.send("Page.navigate", { url });
    await ready();
};

const pointerClick = async (selector) => {
    const bounds = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const bounds = element.getBoundingClientRect();
        return { x: bounds.right - 4, y: bounds.top + bounds.height / 2 };
    })()`);
    assert(bounds, `missing element for pointer click: ${selector}`);
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

const questionnaireSnapshot = () =>
    evaluate(`(() => {
        const visibleStep = document.querySelector("[data-question-step]:not([hidden])");
        const submit = visibleStep?.querySelector("[data-questionnaire-submit]");
        return {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            question: Number(visibleStep?.dataset.questionStep ?? 0),
            checkedCount: document.querySelectorAll('input[type="radio"]:checked').length,
            submitCount: document.querySelectorAll("[data-questionnaire-submit]").length,
            submitLabel: submit?.textContent.trim() ?? null,
            submitType: submit?.type ?? null,
            submitDisabled: submit?.disabled ?? null,
            historyLength: history.length,
            historyState: history.state,
            hasResult: Boolean(document.querySelector("[data-active-result]")),
        };
    })()`);

const resultSnapshot = () =>
    evaluate(`(async () => ({
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        heading: document.querySelector("h1")?.textContent.trim() ?? null,
        score: document.querySelector("[data-active-result-score]")?.textContent.trim() ?? null,
        cutoffState: document.querySelector("[data-active-result-cutoff]")?.dataset.activeResultCutoff ?? null,
        resultText: document.querySelector("[data-active-result-cutoff]")?.textContent.trim() ?? null,
        answerInputCount: document.querySelectorAll('input[type="radio"]').length,
        questionnaireCount: document.querySelectorAll("[data-questionnaire]").length,
        localStorageLength: localStorage.length,
        sessionStorageLength: sessionStorage.length,
        cookie: document.cookie,
        cacheNames: await caches.keys(),
        databaseNames: typeof indexedDB.databases === "function"
            ? (await indexedDB.databases()).map((database) => database.name)
            : [],
        historyState: history.state,
        suspiciousGlobals: Object.keys(window).filter((key) =>
            /answer|response|active.?result/i.test(key) &&
            !key.startsWith("__issue10Test"),
        ),
    }))()`);

const installScoringSpy = () =>
    evaluate(`(() => {
        const original = window.K6Scoring.calculateK6Score;
        window.__issue10TestScoringCallCount = 0;
        window.__issue10TestScoringResponses = null;
        window.__issue10TestHandoff = null;
        window.__issue10TestOriginalFreeze = Object.freeze;
        Object.freeze = (value) => {
            if (
                value &&
                Object.hasOwn(value, "score") &&
                Object.hasOwn(value, "isAtOrAboveCutoff")
            ) {
                window.__issue10TestHandoff = { ...value };
            }
            return window.__issue10TestOriginalFreeze(value);
        };
        window.K6Scoring = {
            calculateK6Score(responses) {
                window.__issue10TestScoringCallCount += 1;
                window.__issue10TestScoringResponses = [...responses];
                return original(responses);
            },
        };
    })()`);

const readAndClearScoringSpy = () =>
    evaluate(`(() => {
        const evidence = {
            calls: window.__issue10TestScoringCallCount,
            responses: window.__issue10TestScoringResponses,
            handoff: window.__issue10TestHandoff,
        };
        Object.freeze = window.__issue10TestOriginalFreeze;
        delete window.__issue10TestScoringCallCount;
        delete window.__issue10TestScoringResponses;
        delete window.__issue10TestHandoff;
        delete window.__issue10TestOriginalFreeze;
        return evidence;
    })()`);

const answerThroughQuestionSix = async (responses) => {
    for (let question = 1; question <= 6; question += 1) {
        let state = await questionnaireSnapshot();
        assert(state.question === question, `expected question ${question}`);

        if (question === 6) {
            assert(state.submitCount === 1, "Question 6 must have one submit action");
            assert(state.submitLabel === "See my result", "wrong final action label");
            assert(state.submitType === "submit", "final action is not a submit button");
            assert(state.submitDisabled === true, "unanswered final action is enabled");
        }

        await pointerClick(
            `[data-question-step="${question}"] .response-option:nth-of-type(${responses[question - 1] + 1})`,
        );
        state = await questionnaireSnapshot();
        assert(state.question === question, `answer ${question} advanced automatically`);
        assert(state.pathname === "/test", `answer ${question} changed the URL`);

        if (question < 6) {
            await pointerClick(
                `[data-question-step="${question}"] [data-questionnaire-next]`,
            );
        } else {
            assert(state.submitDisabled === false, "final answer did not enable submit");
        }
    }
};

const submitAndAssertResult = async (responses, score, cutoffState) => {
    await navigate(testUrl, waitForQuestionnaire);
    await installScoringSpy();
    const historyLengthBefore = (await questionnaireSnapshot()).historyLength;
    await answerThroughQuestionSix(responses);
    const requestsBefore = networkRequests.length;
    await pointerClick("[data-questionnaire-submit]");
    await waitForResult(score);

    const scoringEvidence = await readAndClearScoringSpy();
    assert(scoringEvidence.calls === 1, "submission did not call K6Scoring exactly once");
    assert(
        JSON.stringify(scoringEvidence.responses) === JSON.stringify(responses),
        "K6Scoring did not receive the six selected responses in order",
    );
    assert(
        JSON.stringify(scoringEvidence.handoff) ===
            JSON.stringify({
                score,
                isAtOrAboveCutoff: cutoffState === "at-or-above-13",
            }),
        "transient handoff did not contain exactly score and cutoff classification",
    );

    const state = await resultSnapshot();
    assert(state.pathname === "/result", "successful submission did not reach /result");
    assert(state.search === "", "successful result URL contains a query string");
    assert(state.hash === "", "successful result URL contains a fragment");
    assert(state.heading === "Result", "minimal Result heading is not visible");
    assert(state.score === `${score} / 24`, "minimal Result score is wrong");
    assert(state.cutoffState === cutoffState, "minimal Result cutoff state is wrong");
    assert(state.answerInputCount === 0, "answers remain in the rendered result DOM");
    assert(state.questionnaireCount === 0, "questionnaire remains in the rendered result DOM");
    assert(state.localStorageLength === 0, "submission wrote localStorage");
    assert(state.sessionStorageLength === 0, "submission wrote sessionStorage");
    assert(state.cookie === "", "submission wrote a cookie");
    assert(state.cacheNames.length === 0, "submission wrote Cache Storage");
    assert(state.databaseNames.length === 0, "submission wrote IndexedDB");
    assert(state.historyState === null, "result or answers were written to history.state");
    assert(state.suspiciousGlobals.length === 0, "result or answers leaked onto window");
    assert(
        (await evaluate("history.length")) === historyLengthBefore + 1,
        "successful submission did not create one route-level history entry",
    );
    assert(
        networkRequests.length === requestsBefore,
        "questionnaire submission transmitted a network request",
    );
};

const assertFreshQuestionnaire = async (context) => {
    const state = await questionnaireSnapshot();
    assert(state.pathname === "/test", `${context}: expected /test`);
    assert(state.question === 1, `${context}: did not start at Question 1`);
    assert(state.checkedCount === 0, `${context}: retained selected answers`);
    assert(state.hasResult === false, `${context}: retained an active result`);
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

    await navigate(resultUrl, waitForHome);
    assert((await evaluate("location.href")) === homeUrl, "direct /result did not end at Home");

    await navigate(testUrl, waitForQuestionnaire);
    await installScoringSpy();
    for (let question = 1; question <= 5; question += 1) {
        await pointerClick(
            `[data-question-step="${question}"] .response-option:nth-of-type(2)`,
        );
        await pointerClick(
            `[data-question-step="${question}"] [data-questionnaire-next]`,
        );
    }
    let state = await questionnaireSnapshot();
    assert(state.question === 6, "incomplete scenario did not reach Question 6");
    assert(state.submitDisabled === true, "incomplete attempt enabled final submit");
    await pointerClick("[data-questionnaire-submit]");
    state = await questionnaireSnapshot();
    assert(state.pathname === "/test", "disabled incomplete submit changed URL");
    await evaluate(`(() => {
        const submit = document.querySelector("[data-questionnaire-submit]");
        submit.disabled = false;
        document.querySelector("[data-questionnaire]").requestSubmit(submit);
    })()`);
    state = await questionnaireSnapshot();
    assert(state.pathname === "/test", "tampered incomplete submit changed URL");
    assert(state.hasResult === false, "tampered incomplete submit created a result");
    const incompleteScoringEvidence = await readAndClearScoringSpy();
    assert(incompleteScoringEvidence.calls === 0, "incomplete attempt reached scoring");
    assert(incompleteScoringEvidence.handoff === null, "incomplete attempt created a handoff");
    await navigate(resultUrl, waitForHome);

    await submitAndAssertResult([4, 3, 2, 1, 0, 4], 14, "at-or-above-13");
    await client.send("Page.reload", { ignoreCache: true });
    await waitForHome();
    assert((await evaluate("location.href")) === homeUrl, "refreshed /result did not end at Home");

    await submitAndAssertResult([2, 2, 2, 2, 2, 2], 12, "below-13");
    await evaluate("history.back()");
    await waitForQuestionnaire();
    await assertFreshQuestionnaire("browser Back from Result");
    await evaluate("history.forward()");
    await waitForHome();
    assert((await evaluate("location.href")) === homeUrl, "Forward resurrected a discarded result");

    await submitAndAssertResult([2, 2, 2, 2, 2, 2], 12, "below-13");
    await navigate(testUrl, waitForQuestionnaire);
    await assertFreshQuestionnaire("new /test navigation");
    await evaluate("history.back()");
    await waitForHome();
    assert((await evaluate("location.href")) === homeUrl, "old Result reopened after a new attempt");

    const { targetId } = await client.send("Target.createTarget", { url: resultUrl });
    const { sessionId } = await client.send("Target.attachToTarget", {
        targetId,
        flatten: true,
    });
    await client.send("Runtime.enable", {}, sessionId);
    await waitForHome(sessionId);
    assert(
        (await evaluate("location.href", sessionId)) === homeUrl,
        "new-tab /result did not visibly end at Home",
    );
    await client.send("Target.closeTarget", { targetId });

    const cookies = (await client.send("Network.getAllCookies")).cookies.filter(
        (cookie) => new URL(testUrl).hostname.endsWith(cookie.domain.replace(/^\./, "")),
    );
    assert(cookies.length === 0, "assessment flow created a cookie");
    assert(
        networkRequests.every(
            (request) =>
                request.method === "GET" &&
                request.postData === null &&
                !request.url.includes("question-") &&
                !request.url.includes("4%2C3%2C2%2C1%2C0%2C4"),
        ),
        "answers were transmitted in a request, URL, or request body",
    );

    console.log("result submission browser scenario passed");
} finally {
    client.close();
}
