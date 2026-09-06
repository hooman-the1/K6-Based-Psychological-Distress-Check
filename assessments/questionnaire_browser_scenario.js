const [websocketUrl, testUrl, homeUrl] = process.argv.slice(2);

const expectedPrompts = [
    "Over the past 30 days, how often did you feel nervous?",
    "Over the past 30 days, how often did you feel hopeless?",
    "Over the past 30 days, how often did you feel restless or fidgety?",
    "Over the past 30 days, how often did you feel so down that nothing could cheer you up?",
    "Over the past 30 days, how often did it feel like everything took a lot of effort?",
    "Over the past 30 days, how often did you feel like you had no value?",
];
const expectedChoices = [
    "None of the time",
    "A little of the time",
    "Some of the time",
    "Most of the time",
    "All of the time",
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
    }

    static async connect(url) {
        const websocket = new WebSocket(url);
        await new Promise((resolve, reject) => {
            websocket.addEventListener("open", resolve, { once: true });
            websocket.addEventListener("error", reject, { once: true });
        });
        return new DevToolsClient(websocket);
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
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text);
    }
    return response.result.value;
};

const waitForQuestionnaire = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            if (
                await evaluate(
                    'document.readyState === "complete" && Boolean(document.querySelector("[data-questionnaire]"))',
                )
            ) {
                return;
            }
        } catch {
            // Navigation briefly destroys the previous JavaScript execution context.
        }
        await delay(50);
    }
    throw new Error("Questionnaire did not become ready");
};

const snapshot = () =>
    evaluate(`(() => {
        const visibleSteps = [...document.querySelectorAll("[data-question-step]")]
            .filter((step) => !step.hidden);
        const step = visibleSteps[0];
        const cards = step
            ? [...step.querySelectorAll(".response-option")]
            : [];
        return {
            visibleStepCount: visibleSteps.length,
            number: step ? Number(step.dataset.questionStep) : null,
            count: step?.querySelector(".question-count")?.textContent.trim(),
            progressValue: step?.querySelector("progress")?.value,
            progressMaximum: step?.querySelector("progress")?.max,
            prompt: step?.querySelector("h2")?.textContent.trim(),
            choices: cards.map((card) => card.textContent.trim()),
            controls: step
                ? [...step.querySelectorAll("button")].map((button) => button.textContent.trim())
                : [],
            checkedValue: step?.querySelector('input[type="radio"]:checked')?.value ?? null,
            checkedCount: document.querySelectorAll('input[type="radio"]:checked').length,
            cardBounds: cards.map((card) => {
                const bounds = card.getBoundingClientRect();
                return { left: bounds.left, right: bounds.right, width: bounds.width };
            }),
            documentWidth: document.documentElement.scrollWidth,
            historyLength: history.length,
            localStorageLength: localStorage.length,
            sessionStorageLength: sessionStorage.length,
            cookie: document.cookie,
        };
    })()`);

const verifyStep = (state, number) => {
    assert(state.visibleStepCount === 1, `step ${number}: expected one visible step`);
    assert(state.number === number, `expected step ${number}, got ${state.number}`);
    assert(state.count === `Question ${number} of 6`, `step ${number}: wrong count`);
    assert(state.progressValue === number, `step ${number}: wrong progress value`);
    assert(state.progressMaximum === 6, `step ${number}: wrong progress maximum`);
    assert(state.prompt === expectedPrompts[number - 1], `step ${number}: wrong prompt`);
    assert(
        JSON.stringify(state.choices) === JSON.stringify(expectedChoices),
        `step ${number}: wrong ordered choices`,
    );

    const expectedControls =
        number === 1 ? ["Next"] : number === 6 ? ["Back"] : ["Back", "Next"];
    assert(
        JSON.stringify(state.controls) === JSON.stringify(expectedControls),
        `step ${number}: wrong controls`,
    );
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

    let state = await snapshot();
    verifyStep(state, 1);
    assert(state.checkedCount === 0, "new page must have no selected response");
    assert(state.documentWidth === 320, "questionnaire must not overflow 320px");
    assert(
        state.cardBounds.every(
            (bounds) =>
                bounds.left === 16 && bounds.right === 304 && bounds.width === 288,
        ),
        "response cards must fill the 320px viewport content width",
    );
    const questionnaireHistoryLength = state.historyLength;

    await pointerClick(
        '[data-question-step="1"] .response-option:nth-of-type(3)',
    );
    state = await snapshot();
    assert(state.checkedValue === "2", "clicking the answer card must select it");

    for (let number = 2; number <= 6; number += 1) {
        await pointerClick(
            '[data-question-step]:not([hidden]) [data-questionnaire-next]',
        );
        state = await snapshot();
        verifyStep(state, number);
        assert(
            state.historyLength === questionnaireHistoryLength,
            `step ${number}: browser history changed`,
        );
    }
    assert(state.checkedCount === 0, "temporary answer must not follow the user");
    assert(
        (await evaluate(
            'document.querySelector("[data-question-step]:not([hidden]) [data-questionnaire-next]")',
        )) === null,
        "question 6 must have no Next or submission action",
    );

    for (let number = 5; number >= 1; number -= 1) {
        await pointerClick(
            '[data-question-step]:not([hidden]) [data-questionnaire-back]',
        );
        state = await snapshot();
        verifyStep(state, number);
    }
    assert(
        (await evaluate(
            'document.querySelector("[data-question-step]:not([hidden]) [data-questionnaire-back]")',
        )) === null,
        "question 1 must have no Back action",
    );

    await pointerClick(
        '[data-question-step="1"] .response-option:nth-of-type(2)',
    );
    await pointerClick(
        '[data-question-step]:not([hidden]) [data-questionnaire-next]',
    );
    await client.send("Page.reload", { ignoreCache: true });
    await waitForQuestionnaire();
    state = await snapshot();
    verifyStep(state, 1);
    assert(state.checkedCount === 0, "reload must reset all answers");

    await pointerClick(
        '[data-question-step="1"] .response-option:nth-of-type(4)',
    );
    await pointerClick(
        '[data-question-step]:not([hidden]) [data-questionnaire-next]',
    );
    await client.send("Page.navigate", { url: homeUrl });
    await delay(100);
    await client.send("Page.navigate", { url: testUrl });
    await waitForQuestionnaire();
    state = await snapshot();
    verifyStep(state, 1);
    assert(state.checkedCount === 0, "route revisit must reset all answers");
    assert(state.localStorageLength === 0, "questionnaire wrote localStorage");
    assert(state.sessionStorageLength === 0, "questionnaire wrote sessionStorage");
    assert(state.cookie === "", "questionnaire wrote a cookie");

    console.log("questionnaire browser scenario passed");
} finally {
    client.close();
}
