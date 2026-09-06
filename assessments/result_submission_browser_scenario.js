const [websocketUrl, testUrl, homeUrl] = process.argv.slice(2);
const resultUrl = new URL("/result", testUrl).href;
const storageKey = "k6-based-distress-check.history.v1";
const expectedHigherScoreExplanation =
    "Higher scores indicate greater psychological distress.";
const expectedGuidance =
    "Take a moment to reflect on how you have been feeling. If you are concerned about your mental health or it is affecting your daily life, consider talking with a qualified healthcare professional. You can also explore the resources below for information and practical coping ideas.";
const expectedResources = [
    {
        label: "NIMH: Mental Health Information",
        url: "https://www.nimh.nih.gov/health",
    },
    {
        label: "WHO: Mental health",
        url: "https://www.who.int/news-room/fact-sheets/detail/mental-health-strengthening-our-response",
    },
    {
        label: "WHO: Doing What Matters in Times of Stress",
        url: "https://www.who.int/publications/i/item/9789240003927",
    },
    {
        label: "NHS Every Mind Matters: Self-help CBT techniques",
        url: "https://www.nhs.uk/every-mind-matters/mental-wellbeing-tips/self-help-cbt-techniques/",
    },
];
const expectedOutcomes = {
    "below-13": {
        status: "Below the cutoff",
        interpretation:
            "Your score is below the serious or elevated psychological distress cutoff of 13.",
    },
    "at-or-above-13": {
        status: "At or above the cutoff",
        interpretation:
            "Your score is at or above the serious or elevated psychological distress cutoff of 13.",
    },
};

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
                const pageTarget = targets.find(
                    (target) => target.type === "page",
                );
                if (!pageTarget) {
                    throw new Error("Edge has not exposed a page target");
                }
                const websocket = new WebSocket(pageTarget.webSocketDebuggerUrl);
                websocket.addEventListener("error", () => {});
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
        status: document.querySelector("[data-active-result-status]")?.textContent.trim() ?? null,
        interpretation: document.querySelector("[data-active-result-interpretation]")?.textContent.trim() ?? null,
        higherScoreExplanation: document.querySelector("[data-active-result-higher-score]")?.textContent.trim() ?? null,
        guidance: document.querySelector("[data-active-result-guidance]")?.textContent.trim() ?? null,
        resources: Array.from(document.querySelectorAll("[data-active-result-resources] a"), (link) => ({
            label: link.textContent.trim(),
            url: link.href,
        })),
        retakeCount: document.querySelectorAll("[data-take-test-again]").length,
        retakeLabel: document.querySelector("[data-take-test-again]")?.textContent.trim() ?? null,
        retakeHref: document.querySelector("[data-take-test-again]")?.href ?? null,
        retakeTarget: document.querySelector("[data-take-test-again]")?.target ?? null,
        visibleText: document.querySelector("[data-active-result]")?.innerText ?? "",
        answerInputCount: document.querySelectorAll('input[type="radio"]').length,
        questionnaireCount: document.querySelectorAll("[data-questionnaire]").length,
        questionnaireControlCount: document.querySelectorAll("[data-questionnaire-next], [data-questionnaire-back], [data-questionnaire-submit], [data-question-helper]").length,
        prohibitedVisualizationCount: document.querySelectorAll("progress, meter, canvas, svg, [role='progressbar'], [data-score-gauge], [data-chart]").length,
        localStorageLength: localStorage.length,
        localStorageKeys: Object.keys(localStorage),
        rawHistory: localStorage.getItem(${JSON.stringify(storageKey)}),
        sessionStorageLength: sessionStorage.length,
        cookie: document.cookie,
        cacheNames: await caches.keys(),
        databaseNames: typeof indexedDB.databases === "function"
            ? (await indexedDB.databases()).map((database) => database.name)
            : [],
        historyState: history.state,
        suspiciousGlobals: Object.keys(window).filter((key) => {
            if (key === "ResultContent" || key === "AssessmentHistory" || key.startsWith("__issue10Test") || key.startsWith("__issue12Test") || key.startsWith("__issue15Test")) {
                return false;
            }
            return /answer|response|active.?result/i.test(key);
        }),
    }))()`);

const installSubmissionSpies = (saveMode = "delegate") =>
    evaluate(`(() => {
        const original = window.K6Scoring.calculateK6Score;
        const originalGetResultContent = window.ResultContent?.getResultContent;
        const originalAssessmentHistory = window.AssessmentHistory;
        const originalDateNow = Date.now;
        window.__issue10TestScoringCallCount = 0;
        window.__issue10TestScoringResponses = null;
        window.__issue10TestHandoff = null;
        window.__issue10TestOriginalFreeze = Object.freeze;
        window.__issue12TestResultContentCalls = [];
        window.__issue15TestEvents = [];
        window.__issue15TestDateNowCalls = 0;
        window.__issue15TestSaveCalls = [];
        window.__issue15TestSaveResults = [];
        window.__issue15TestSaveThrows = 0;
        window.__issue15TestOriginalAssessmentHistory = originalAssessmentHistory;
        window.__issue15TestOriginalDateNow = originalDateNow;
        Object.freeze = (value) => {
            if (
                value &&
                Object.hasOwn(value, "score") &&
                Object.hasOwn(value, "isAtOrAboveCutoff")
            ) {
                window.__issue10TestHandoff = { ...value };
                window.__issue15TestEvents.push("active-result-established");
            }
            return window.__issue10TestOriginalFreeze(value);
        };
        window.K6Scoring = {
            calculateK6Score(responses) {
                window.__issue10TestScoringCallCount += 1;
                window.__issue10TestScoringResponses = [...responses];
                window.__issue15TestEvents.push("scoring-started");
                const result = original(responses);
                window.__issue15TestEvents.push("scoring-succeeded");
                return result;
            },
        };
        Date.now = () => {
            window.__issue15TestDateNowCalls += 1;
            window.__issue15TestEvents.push("timestamp-captured");
            return originalDateNow();
        };
        window.AssessmentHistory = Object.freeze({
            getResults: originalAssessmentHistory.getResults,
            saveResult(result) {
                window.__issue15TestEvents.push("save-attempted");
                window.__issue15TestSaveCalls.push({
                    argument: { ...result },
                    argumentKeys: Object.keys(result),
                    handoff: window.__issue10TestHandoff
                        ? { ...window.__issue10TestHandoff }
                        : null,
                    checkedCount: document.querySelectorAll('input[type="radio"]:checked').length,
                    resultVisible: Boolean(document.querySelector("[data-active-result]")),
                    pathname: location.pathname,
                });
                const mode = ${JSON.stringify(saveMode)};
                if (mode === "storage-unavailable") {
                    const outcome = { ok: false, reason: "storage-unavailable" };
                    window.__issue15TestSaveResults.push(outcome);
                    return outcome;
                }
                if (mode === "explicit-failure") {
                    const outcome = { ok: false, reason: "unexpected-failure" };
                    window.__issue15TestSaveResults.push(outcome);
                    return outcome;
                }
                if (mode === "throw") {
                    window.__issue15TestSaveThrows += 1;
                    throw new Error("injected application history boundary failure");
                }
                const outcome = originalAssessmentHistory.saveResult(result);
                window.__issue15TestSaveResults.push(outcome);
                return outcome;
            },
        });
        if (originalGetResultContent) {
            window.ResultContent = Object.freeze({
                getResultContent(isAtOrAboveCutoff) {
                    window.__issue12TestResultContentCalls.push(isAtOrAboveCutoff);
                    return originalGetResultContent(isAtOrAboveCutoff);
                },
            });
        }
    })()`);

const readAndClearSubmissionSpies = () =>
    evaluate(`(() => {
        const evidence = {
            calls: window.__issue10TestScoringCallCount,
            responses: window.__issue10TestScoringResponses,
            handoff: window.__issue10TestHandoff,
            resultContentCalls: window.__issue12TestResultContentCalls,
            events: window.__issue15TestEvents,
            dateNowCalls: window.__issue15TestDateNowCalls,
            saveCalls: window.__issue15TestSaveCalls,
            saveResults: window.__issue15TestSaveResults,
            saveThrows: window.__issue15TestSaveThrows,
        };
        Object.freeze = window.__issue10TestOriginalFreeze;
        Date.now = window.__issue15TestOriginalDateNow;
        window.AssessmentHistory = window.__issue15TestOriginalAssessmentHistory;
        delete window.__issue10TestScoringCallCount;
        delete window.__issue10TestScoringResponses;
        delete window.__issue10TestHandoff;
        delete window.__issue10TestOriginalFreeze;
        delete window.__issue12TestResultContentCalls;
        delete window.__issue15TestEvents;
        delete window.__issue15TestDateNowCalls;
        delete window.__issue15TestSaveCalls;
        delete window.__issue15TestSaveResults;
        delete window.__issue15TestSaveThrows;
        delete window.__issue15TestOriginalAssessmentHistory;
        delete window.__issue15TestOriginalDateNow;
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

const assertResultPresentation = (state, score, cutoffState) => {
    const expectedOutcome = expectedOutcomes[cutoffState];
    assert(state.pathname === "/result", "successful submission did not reach /result");
    assert(state.search === "", "successful result URL contains a query string");
    assert(state.hash === "", "successful result URL contains a fragment");
    assert(state.heading === "Result", "Result heading is not visible");
    assert(state.score === `${score} / 24`, "Result score is wrong");
    assert(state.cutoffState === cutoffState, "Result cutoff state is wrong");
    assert(state.status === expectedOutcome.status, "Result status is wrong");
    assert(
        state.interpretation === expectedOutcome.interpretation,
        "Result interpretation is wrong",
    );
    assert(
        state.higherScoreExplanation === expectedHigherScoreExplanation,
        "Result higher-score explanation is wrong",
    );
    assert(state.guidance === expectedGuidance, "Result guidance is wrong");
    assert(
        JSON.stringify(state.resources) === JSON.stringify(expectedResources),
        "Result resources or their order are wrong",
    );
    assert(state.retakeCount === 1, "Result does not have exactly one retake CTA");
    assert(state.retakeLabel === "Take test again", "retake CTA label is wrong");
    assert(state.retakeHref === testUrl, "retake CTA destination is wrong");
    assert(state.retakeTarget === "", "retake CTA does not target the current tab");
    assert(state.answerInputCount === 0, "answers remain in the rendered result DOM");
    assert(state.questionnaireCount === 0, "questionnaire remains in the rendered result DOM");
    assert(
        state.questionnaireControlCount === 0,
        "questionnaire controls remain in the rendered result DOM",
    );
    assert(
        state.prohibitedVisualizationCount === 0,
        "Result contains a prohibited visualization",
    );
    for (const prohibitedCopy of [
        "Over the past 30 days",
        "None of the time",
        "A little of the time",
        "Some of the time",
        "Most of the time",
        "All of the time",
        "mild",
        "moderate",
        "severe",
        "urgent help",
        "crisis",
        "diagnosis",
        "diagnostic",
        "screening",
        "adaptation",
        "adapted wording",
        "modified wording",
        "services near you",
        "history saved",
        "saved history is unavailable",
    ]) {
        assert(
            !state.visibleText.toLowerCase().includes(prohibitedCopy.toLowerCase()),
            `Result contains prohibited copy: ${prohibitedCopy}`,
        );
    }
};

const completeCurrentQuestionnaireAndAssertResult = async (
    responses,
    score,
    cutoffState,
    {
        saveMode = "delegate",
        duplicateSubmit = false,
        expectedSaveOutcome = { ok: true },
        expectHistoryUnchanged = false,
        spiesAlreadyInstalled = false,
    } = {},
) => {
    const historyBeforeRaw = await evaluate(
        `localStorage.getItem(${JSON.stringify(storageKey)})`,
    );
    if (!spiesAlreadyInstalled) {
        await installSubmissionSpies(saveMode);
    }
    const historyLengthBefore = (await questionnaireSnapshot()).historyLength;
    await answerThroughQuestionSix(responses);
    const requestsBefore = networkRequests.length;
    const timestampLowerBound = await evaluate(
        "Math.floor(performance.timeOrigin + performance.now())",
    );
    if (duplicateSubmit) {
        await evaluate(`(() => {
            const form = document.querySelector("[data-questionnaire]");
            const submit = document.querySelector("[data-questionnaire-submit]");
            form.dispatchEvent(new SubmitEvent("submit", {
                bubbles: true,
                cancelable: true,
                submitter: submit,
            }));
            form.dispatchEvent(new SubmitEvent("submit", {
                bubbles: true,
                cancelable: true,
                submitter: submit,
            }));
        })()`);
    } else {
        await pointerClick("[data-questionnaire-submit]");
    }
    await waitForResult(score);
    const timestampUpperBound = await evaluate(
        "Math.ceil(performance.timeOrigin + performance.now())",
    );

    const scoringEvidence = await readAndClearSubmissionSpies();
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
    assert(
        JSON.stringify(scoringEvidence.resultContentCalls) ===
            JSON.stringify([cutoffState === "at-or-above-13"]),
        "Result did not consume the active classification through ResultContent exactly once",
    );
    assert(scoringEvidence.dateNowCalls === 1, "completion timestamp was not captured exactly once");
    assert(scoringEvidence.saveCalls.length === 1, "submission did not attempt exactly one save");
    assert(
        scoringEvidence.saveThrows === (saveMode === "throw" ? 1 : 0),
        "history boundary throw count is wrong",
    );
    if (saveMode !== "throw") {
        assert(
            JSON.stringify(scoringEvidence.saveResults) ===
                JSON.stringify([expectedSaveOutcome]),
            "submission observed the wrong history-boundary outcome",
        );
    }
    const saveCall = scoringEvidence.saveCalls[0];
    assert(
        JSON.stringify(saveCall.argumentKeys) === JSON.stringify(["score", "timestamp"]),
        "history argument does not have only canonical score/timestamp keys",
    );
    assert(saveCall.argument.score === score, "history argument contains the wrong score");
    assert(
        Number.isInteger(saveCall.argument.timestamp) &&
            Number.isFinite(saveCall.argument.timestamp),
        "completion timestamp is not a finite integer",
    );
    assert(
        saveCall.argument.timestamp >= timestampLowerBound &&
            saveCall.argument.timestamp <= timestampUpperBound,
        "completion timestamp is not bounded by the accepted submit event",
    );
    assert(
        JSON.stringify(saveCall.handoff) === JSON.stringify(scoringEvidence.handoff),
        "active Result was not established before saving",
    );
    assert(saveCall.checkedCount === 0, "answers were not discarded before saving");
    assert(saveCall.resultVisible === false, "Result rendered before the save attempt");
    assert(saveCall.pathname === "/test", "URL changed before the save attempt");
    assert(
        JSON.stringify(scoringEvidence.events) ===
            JSON.stringify([
                "scoring-started",
                "scoring-succeeded",
                "active-result-established",
                "timestamp-captured",
                "save-attempted",
            ]),
        "accepted-completion operations ran out of order",
    );

    const state = await resultSnapshot();
    assertResultPresentation(state, score, cutoffState);
    assert(
        state.localStorageKeys.every((key) => key === storageKey),
        "submission wrote an unexpected localStorage key",
    );
    if (expectHistoryUnchanged) {
        assert(state.rawHistory === historyBeforeRaw, "failed save changed stored history");
    } else {
        const priorRecords = historyBeforeRaw === null ? [] : JSON.parse(historyBeforeRaw);
        const expectedRecords = [...priorRecords, saveCall.argument]
            .map((record, insertionIndex) => ({ record, insertionIndex }))
            .sort(
                (left, right) =>
                    left.record.timestamp - right.record.timestamp ||
                    left.insertionIndex - right.insertionIndex,
            )
            .slice(-20)
            .map(({ record }) => record);
        assert(
            state.rawHistory === JSON.stringify(expectedRecords),
            "submission did not persist the exact canonical history record",
        );
        assert(
            JSON.stringify(Object.keys(JSON.parse(state.rawHistory).at(-1))) ===
                JSON.stringify(["score", "timestamp"]),
            "stored history contains fields beyond score and timestamp",
        );
    }
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
    return { state, scoringEvidence, saveCall };
};

const submitAndAssertResult = async (responses, score, cutoffState, options = {}) => {
    await navigate(testUrl, waitForQuestionnaire);
    return completeCurrentQuestionnaireAndAssertResult(
        responses,
        score,
        cutoffState,
        options,
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
    await evaluate("localStorage.clear()");
    await installSubmissionSpies();
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
    const incompleteScoringEvidence = await readAndClearSubmissionSpies();
    assert(incompleteScoringEvidence.calls === 0, "incomplete attempt reached scoring");
    assert(incompleteScoringEvidence.handoff === null, "incomplete attempt created a handoff");
    assert(incompleteScoringEvidence.dateNowCalls === 0, "incomplete attempt captured a timestamp");
    assert(incompleteScoringEvidence.saveCalls.length === 0, "incomplete attempt reached history");
    assert((await evaluate("localStorage.length")) === 0, "incomplete attempt wrote history");
    await navigate(resultUrl, waitForHome);

    const primaryCompletion = await submitAndAssertResult(
        [4, 3, 2, 1, 0, 4],
        14,
        "at-or-above-13",
    );
    const primaryRawHistory = await evaluate(
        `localStorage.getItem(${JSON.stringify(storageKey)})`,
    );
    assert(
        primaryRawHistory === JSON.stringify([primaryCompletion.saveCall.argument]),
        "first completion did not leave exactly one raw canonical record",
    );
    await client.send("Page.reload", { ignoreCache: true });
    await waitForHome();
    assert((await evaluate("location.href")) === homeUrl, "refreshed /result did not end at Home");
    assert(
        (await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`)) ===
            primaryRawHistory,
        "refresh duplicated or changed the completed result",
    );

    const belowCompletion = await submitAndAssertResult(
        [2, 2, 2, 2, 2, 2],
        12,
        "below-13",
    );
    const atOrAboveResult = primaryCompletion.state;
    const belowResult = belowCompletion.state;
    for (const sharedField of [
        "higherScoreExplanation",
        "guidance",
        "resources",
        "retakeCount",
        "retakeLabel",
        "retakeHref",
        "retakeTarget",
    ]) {
        assert(
            JSON.stringify(belowResult[sharedField]) ===
                JSON.stringify(atOrAboveResult[sharedField]),
            `Result content varies unexpectedly at ${sharedField}`,
        );
    }
    const normalizeOutcomeText = (state, outcome) =>
        state.visibleText
            .replace(state.score, "[score]")
            .replace(outcome.status, "[status]")
            .replace(outcome.interpretation, "[interpretation]");
    assert(
        normalizeOutcomeText(belowResult, expectedOutcomes["below-13"]) ===
            normalizeOutcomeText(
                atOrAboveResult,
                expectedOutcomes["at-or-above-13"],
            ),
        "visible Result content varies beyond score, status, and interpretation",
    );
    const historyBeforeRetake = belowResult.rawHistory;
    await installSubmissionSpies();
    await pointerClick("[data-take-test-again]");
    await waitForQuestionnaire();
    await assertFreshQuestionnaire("Take test again");
    assert(
        (await evaluate("window.__issue15TestSaveCalls.length")) === 0,
        "Take test again called saveResult",
    );
    assert(
        (await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`)) ===
            historyBeforeRetake,
        "Take test again changed history",
    );
    const retakeCompletion = await completeCurrentQuestionnaireAndAssertResult(
        [2, 2, 2, 2, 2, 2],
        12,
        "below-13",
        { spiesAlreadyInstalled: true },
    );
    assert(
        JSON.parse(retakeCompletion.state.rawHistory).length ===
            JSON.parse(historyBeforeRetake).length + 1,
        "completed retake did not add exactly one new record",
    );
    await evaluate("history.back()");
    await waitForQuestionnaire();
    await assertFreshQuestionnaire("Back from completed retake Result");
    const historyAfterRetake = retakeCompletion.state.rawHistory;
    assert(
        (await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`)) ===
            historyAfterRetake,
        "Back duplicated the completed retake",
    );
    await evaluate("history.forward()");
    await waitForHome();
    assert((await evaluate("location.href")) === homeUrl, "Forward resurrected a retake Result");
    assert(
        (await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`)) ===
            historyAfterRetake,
        "Forward duplicated the completed retake",
    );

    const duplicateCompletion = await submitAndAssertResult(
        [4, 3, 2, 1, 0, 4],
        14,
        "at-or-above-13",
        { duplicateSubmit: true },
    );
    const historyAfterDuplicateAttempt = duplicateCompletion.state.rawHistory;
    await evaluate("history.back()");
    await waitForQuestionnaire();
    await assertFreshQuestionnaire("browser Back from Result");
    assert(
        (await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`)) ===
            historyAfterDuplicateAttempt,
        "Back duplicated a completed result",
    );
    await evaluate("history.forward()");
    await waitForHome();
    assert((await evaluate("location.href")) === homeUrl, "Forward resurrected a discarded result");
    assert(
        (await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`)) ===
            historyAfterDuplicateAttempt,
        "Forward duplicated a completed result",
    );

    await navigate(testUrl, waitForQuestionnaire);
    await evaluate("localStorage.clear()");
    await installSubmissionSpies();
    await answerThroughQuestionSix([4, 3, 2, 1, 0, 4]);
    await evaluate(`(() => {
        document.querySelector('input[type="radio"]:checked').value = "invalid";
        document.querySelector("[data-questionnaire]").requestSubmit();
    })()`);
    await delay(100);
    state = await questionnaireSnapshot();
    assert(state.pathname === "/test", "invalid scoring input changed URL");
    assert(state.hasResult === false, "invalid scoring input created a Result");
    const invalidScoringEvidence = await readAndClearSubmissionSpies();
    assert(invalidScoringEvidence.calls === 1, "invalid response did not reach scoring boundary");
    assert(invalidScoringEvidence.handoff === null, "invalid scoring input created a handoff");
    assert(invalidScoringEvidence.dateNowCalls === 0, "invalid scoring input captured a timestamp");
    assert(invalidScoringEvidence.saveCalls.length === 0, "invalid scoring input reached history");
    assert((await evaluate("localStorage.length")) === 0, "invalid scoring input wrote history");

    const failedSaveCases = [
        {
            label: "storage-unavailable",
            mode: "storage-unavailable",
            outcome: { ok: false, reason: "storage-unavailable" },
            seed: null,
        },
        {
            label: "malformed history",
            mode: "delegate",
            outcome: { ok: false, reason: "invalid-stored-data" },
            seed: "{malformed",
        },
        {
            label: "explicit non-success",
            mode: "explicit-failure",
            outcome: { ok: false, reason: "unexpected-failure" },
            seed: null,
        },
        {
            label: "unexpected throw",
            mode: "throw",
            outcome: null,
            seed: null,
        },
    ];
    for (const failureCase of failedSaveCases) {
        await navigate(testUrl, waitForQuestionnaire);
        await evaluate("localStorage.clear()");
        if (failureCase.seed !== null) {
            await evaluate(
                `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(failureCase.seed)})`,
            );
        }
        const failedCompletion = await completeCurrentQuestionnaireAndAssertResult(
            [4, 3, 2, 1, 0, 4],
            14,
            "at-or-above-13",
            {
                saveMode: failureCase.mode,
                expectedSaveOutcome: failureCase.outcome,
                expectHistoryUnchanged: true,
            },
        );
        assertResultPresentation(
            failedCompletion.state,
            14,
            "at-or-above-13",
        );
        const failedRawHistory = failedCompletion.state.rawHistory;
        await pointerClick("[data-take-test-again]");
        await waitForQuestionnaire();
        await assertFreshQuestionnaire(`${failureCase.label} retake`);
        assert(
            (await evaluate(`localStorage.getItem(${JSON.stringify(storageKey)})`)) ===
                failedRawHistory,
            `${failureCase.label} retake changed history`,
        );
    }

    const twentyRecords = Array.from({ length: 20 }, (_, index) => ({
        score: index,
        timestamp: index + 1,
    }));
    await navigate(testUrl, waitForQuestionnaire);
    await evaluate(
        `localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(twentyRecords))})`,
    );
    const retainedCompletion = await completeCurrentQuestionnaireAndAssertResult(
        [4, 3, 2, 1, 0, 4],
        14,
        "at-or-above-13",
    );
    const retainedRecords = JSON.parse(retainedCompletion.state.rawHistory);
    assert(retainedRecords.length === 20, "submission bypassed the 20-result boundary limit");
    assert(
        JSON.stringify(retainedRecords.slice(0, -1)) ===
            JSON.stringify(twentyRecords.slice(1)),
        "submission did not delegate oldest-record retention to the history boundary",
    );

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
                !request.url.includes("4%2C4%2C4%2C1%2C0%2C0") &&
                !request.url.includes("4%2C3%2C2%2C1%2C0%2C4") &&
                !request.url.includes("2%2C2%2C2%2C2%2C2%2C2"),
        ),
        "answers were transmitted in a request, URL, or request body",
    );

    console.log("result submission browser scenario passed");
} finally {
    client.close();
}
