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
const expectedHelperText = {
    3: "Restless or fidgety means finding it hard to relax or stay still.",
    5: "This means ordinary things felt harder or more tiring to do than usual.",
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
        const nextButton = step?.querySelector("[data-questionnaire-next]");
        const helperButton = step?.querySelector("[data-question-helper]");
        const helperCopy = step?.querySelector("[data-question-helper-copy]");
        const helperStyle = helperCopy ? getComputedStyle(helperCopy) : null;
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
            checkedCount: step?.querySelectorAll('input[type="radio"]:checked').length ?? 0,
            totalCheckedCount: document.querySelectorAll('input[type="radio"]:checked').length,
            nextDisabled: nextButton?.disabled ?? null,
            nextMatchesDisabled: nextButton?.matches(":disabled") ?? null,
            nextOpacity: nextButton ? getComputedStyle(nextButton).opacity : null,
            helperButtonCount: step?.querySelectorAll("[data-question-helper]").length ?? 0,
            helperCopyCount: step?.querySelectorAll("[data-question-helper-copy]").length ?? 0,
            helperButtonType: helperButton?.type ?? null,
            helperButtonLabel: helperButton?.textContent.trim() ?? null,
            helperExpanded: helperButton?.getAttribute("aria-expanded") ?? null,
            helperControls: helperButton?.getAttribute("aria-controls") ?? null,
            helperCopyId: helperCopy?.id ?? null,
            helperCopyText: helperCopy?.textContent.trim() ?? null,
            helperCopyHidden: helperCopy?.hidden ?? null,
            helperCopyDisplay: helperStyle?.display ?? null,
            helperCopyAnimationName: helperStyle?.animationName ?? null,
            helperCopyTransitionDuration: helperStyle?.transitionDuration ?? null,
            helperIsInline:
                Boolean(helperButton) &&
                helperButton.nextElementSibling === helperCopy &&
                helperCopy.nextElementSibling === step.querySelector(".response-options"),
            allHelperButtonCounts: [...document.querySelectorAll("[data-question-step]")].map(
                (question) => question.querySelectorAll("[data-question-helper]").length,
            ),
            allHelperCopyCounts: [...document.querySelectorAll("[data-question-step]")].map(
                (question) => question.querySelectorAll("[data-question-helper-copy]").length,
            ),
            allCheckedValues: [...document.querySelectorAll("[data-question-step]")].map(
                (question) => question.querySelector('input[type="radio"]:checked')?.value ?? null,
            ),
            openDialogCount: document.querySelectorAll("dialog[open], [role=dialog]").length,
            cardStyles: cards.map((card) => {
                const bounds = card.getBoundingClientRect();
                const style = getComputedStyle(card);
                return {
                    left: bounds.left,
                    top: bounds.top,
                    right: bounds.right,
                    width: bounds.width,
                    height: bounds.height,
                    borderTopColor: style.borderTopColor,
                    borderRightColor: style.borderRightColor,
                    borderBottomColor: style.borderBottomColor,
                    borderLeftColor: style.borderLeftColor,
                    borderTopWidth: style.borderTopWidth,
                    borderRightWidth: style.borderRightWidth,
                    borderBottomWidth: style.borderBottomWidth,
                    borderLeftWidth: style.borderLeftWidth,
                    borderRadius: style.borderRadius,
                    backgroundColor: style.backgroundColor,
                    color: style.color,
                    fontFamily: style.fontFamily,
                    fontSize: style.fontSize,
                    fontStyle: style.fontStyle,
                    fontWeight: style.fontWeight,
                    letterSpacing: style.letterSpacing,
                    textDecorationLine: style.textDecorationLine,
                    boxShadow: style.boxShadow,
                    transform: style.transform,
                    scale: style.scale,
                    translate: style.translate,
                    rotate: style.rotate,
                    transitionProperty: style.transitionProperty,
                    transitionDuration: style.transitionDuration,
                    animationName: style.animationName,
                    animationDuration: style.animationDuration,
                };
            }),
            documentWidth: document.documentElement.scrollWidth,
            historyLength: history.length,
            locationHref: location.href,
            submitCount: window.questionnaireSubmitCount ?? 0,
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

    const navigationControls =
        number === 1 ? ["Next"] : number === 6 ? ["Back"] : ["Back", "Next"];
    const expectedControls = expectedHelperText[number]
        ? ["What does this mean?", ...navigationControls]
        : navigationControls;
    assert(
        JSON.stringify(state.controls) === JSON.stringify(expectedControls),
        `step ${number}: wrong controls`,
    );
    assert(
        state.cardStyles.every(
            (style) =>
                style.transitionDuration === "0s" &&
                style.animationName === "none",
        ),
        `step ${number}: answer cards must not animate or transition`,
    );

    if (expectedHelperText[number]) {
        assert(state.helperButtonCount === 1, `step ${number}: expected one helper control`);
        assert(state.helperCopyCount === 1, `step ${number}: expected one helper copy element`);
        assert(state.helperButtonType === "button", `step ${number}: helper is not type=button`);
        assert(
            state.helperButtonLabel === "What does this mean?",
            `step ${number}: wrong helper control label`,
        );
        assert(
            state.helperControls === `question-${number}-helper`,
            `step ${number}: helper control targets the wrong element`,
        );
        assert(
            state.helperCopyId === state.helperControls,
            `step ${number}: helper copy ID does not match aria-controls`,
        );
        assert(
            state.helperCopyText === expectedHelperText[number],
            `step ${number}: wrong helper copy`,
        );
        assert(state.helperIsInline, `step ${number}: helper copy is not inline before choices`);
        assert(state.openDialogCount === 0, `step ${number}: helper opened a dialog`);
    } else {
        assert(state.helperButtonCount === 0, `step ${number}: unexpected helper control`);
        assert(state.helperCopyCount === 0, `step ${number}: unexpected helper copy`);
    }
};

const assertHelperCollapsed = (state, number) => {
    verifyStep(state, number);
    assert(state.helperExpanded === "false", `step ${number}: helper is not collapsed`);
    assert(state.helperCopyHidden === true, `step ${number}: collapsed helper copy is not hidden`);
    assert(state.helperCopyDisplay === "none", `step ${number}: collapsed helper copy is visible`);
};

const assertHelperExpanded = (state, number) => {
    verifyStep(state, number);
    assert(state.helperExpanded === "true", `step ${number}: helper is not expanded`);
    assert(state.helperCopyHidden === false, `step ${number}: expanded helper copy is hidden`);
    assert(state.helperCopyDisplay !== "none", `step ${number}: expanded helper copy is invisible`);
    assert(
        state.helperCopyTransitionDuration === "0s" &&
            state.helperCopyAnimationName === "none",
        `step ${number}: helper expansion must not animate or transition`,
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

const focus = (selector) =>
    evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.focus();
        return document.activeElement === element;
    })()`);

const pressKey = async (key, code, virtualKeyCode) => {
    const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
    await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        text,
        unmodifiedText: text,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
    });
    await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
    });
};

const pressEnter = () => pressKey("Enter", "Enter", 13);
const pressSpace = () => pressKey(" ", "Space", 32);
const pressArrowRight = () => pressKey("ArrowRight", "ArrowRight", 39);

const assertQuestionUnchanged = (before, after, context) => {
    assert(after.number === before.number, `${context}: question changed`);
    assert(after.count === before.count, `${context}: question count changed`);
    assert(
        after.progressValue === before.progressValue,
        `${context}: progress changed`,
    );
    assert(after.prompt === before.prompt, `${context}: prompt changed`);
    assert(
        after.historyLength === before.historyLength,
        `${context}: browser history changed`,
    );
    assert(after.locationHref === before.locationHref, `${context}: URL changed`);
    assert(after.submitCount === before.submitCount, `${context}: form submitted`);
};

const assertHelperPreservedQuestionnaire = (before, after, context) => {
    assertQuestionUnchanged(before, after, context);
    assert(after.checkedValue === before.checkedValue, `${context}: visible answer changed`);
    assert(after.checkedCount === before.checkedCount, `${context}: visible answer count changed`);
    assert(
        after.totalCheckedCount === before.totalCheckedCount,
        `${context}: saved answer count changed`,
    );
    assert(
        JSON.stringify(after.allCheckedValues) === JSON.stringify(before.allCheckedValues),
        `${context}: saved answers changed`,
    );
    assert(after.nextDisabled === before.nextDisabled, `${context}: Next gating changed`);
    assert(
        after.nextMatchesDisabled === before.nextMatchesDisabled,
        `${context}: Next disabled semantics changed`,
    );
};

const nonBorderStyleProperties = [
    "left",
    "top",
    "right",
    "width",
    "height",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderRadius",
    "backgroundColor",
    "color",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "letterSpacing",
    "textDecorationLine",
    "boxShadow",
    "transform",
    "scale",
    "translate",
    "rotate",
    "transitionProperty",
    "transitionDuration",
    "animationName",
    "animationDuration",
];

const assertOnlyCardBorderColorChanged = (before, after, cardIndex, context) => {
    const beforeStyle = before.cardStyles[cardIndex];
    const afterStyle = after.cardStyles[cardIndex];
    const borderColorProperties = [
        "borderTopColor",
        "borderRightColor",
        "borderBottomColor",
        "borderLeftColor",
    ];

    for (const property of borderColorProperties) {
        assert(
            afterStyle[property] !== beforeStyle[property],
            `${context}: ${property} did not change`,
        );
    }
    for (const property of nonBorderStyleProperties) {
        assert(
            afterStyle[property] === beforeStyle[property],
            `${context}: ${property} changed`,
        );
    }
};

const assertSelectedBorderIsUnique = (state, selectedIndex, context) => {
    const selectedBorder = state.cardStyles[selectedIndex].borderTopColor;
    state.cardStyles.forEach((style, index) => {
        if (index !== selectedIndex) {
            assert(
                selectedBorder !== style.borderTopColor,
                `${context}: selected border matches card ${index + 1}`,
            );
        }
    });
};

const assertNewQuestionIsGated = (state, number) => {
    verifyStep(state, number);
    assert(state.checkedValue === null, `step ${number}: response is preselected`);
    assert(state.checkedCount === 0, `step ${number}: a response remained checked`);
    assert(state.nextDisabled === true, `step ${number}: Next is not disabled`);
    assert(
        state.nextMatchesDisabled === true,
        `step ${number}: Next does not match :disabled`,
    );
    assert(
        Number(state.nextOpacity) < 1,
        `step ${number}: disabled Next is not visually distinct`,
    );
};

const assertRestoredAnswer = (state, number, expectedValue, totalAnswers) => {
    verifyStep(state, number);
    assert(
        state.checkedValue === expectedValue,
        `step ${number}: expected restored response ${expectedValue}, got ${state.checkedValue}`,
    );
    assert(state.checkedCount === 1, `step ${number}: expected one visible response`);
    assert(
        state.totalCheckedCount === totalAnswers,
        `step ${number}: expected ${totalAnswers} saved responses, got ${state.totalCheckedCount}`,
    );
    if (number < 6) {
        assert(state.nextDisabled === false, `step ${number}: restored answer did not enable Next`);
        assert(
            state.nextMatchesDisabled === false,
            `step ${number}: restored Next still matches :disabled`,
        );
        assert(state.nextOpacity === "1", `step ${number}: restored Next looks disabled`);
    }
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
    await evaluate(`(() => {
        window.questionnaireSubmitCount = 0;
        document.querySelector("[data-questionnaire]").addEventListener("submit", (event) => {
            window.questionnaireSubmitCount += 1;
            event.preventDefault();
        });
    })()`);

    let state = await snapshot();
    assertNewQuestionIsGated(state, 1);
    assert(
        JSON.stringify(state.allHelperButtonCounts) === JSON.stringify([0, 0, 1, 0, 1, 0]),
        "helper controls must exist only on questions 3 and 5",
    );
    assert(
        JSON.stringify(state.allHelperCopyCounts) === JSON.stringify([0, 0, 1, 0, 1, 0]),
        "helper copy must exist only on questions 3 and 5",
    );
    assert(state.documentWidth === 320, "questionnaire must not overflow 320px");
    assert(
        state.cardStyles.every(
            (bounds) =>
                bounds.left === 16 && bounds.right === 304 && bounds.width === 288,
        ),
        "response cards must fill the 320px viewport content width",
    );
    const questionnaireHistoryLength = state.historyLength;
    const initialQuestionState = state;

    await pointerClick(
        '[data-question-step="1"] [data-questionnaire-next]',
    );
    state = await snapshot();
    assertQuestionUnchanged(
        initialQuestionState,
        state,
        "pointer activation of disabled Next",
    );

    assert(
        (await focus(
            '[data-question-step="1"] [data-questionnaire-next]',
        )) === false,
        "disabled Next must not accept focus",
    );
    await pressEnter();
    await pressSpace();
    state = await snapshot();
    assertQuestionUnchanged(
        initialQuestionState,
        state,
        "keyboard activation of disabled Next",
    );
    assert(state.nextDisabled, "disabled Next became enabled without an answer");

    await pointerClick(
        '[data-question-step="1"] .response-option:nth-of-type(3)',
    );
    state = await snapshot();
    assert(state.checkedValue === "2", "clicking the answer card must select it");
    assert(state.checkedCount === 1, "pointer selection must check one response");
    assertQuestionUnchanged(
        initialQuestionState,
        state,
        "pointer answer selection",
    );
    assert(state.nextDisabled === false, "pointer selection did not enable Next");
    assert(
        state.nextMatchesDisabled === false,
        "enabled Next still matches :disabled",
    );
    assert(state.nextOpacity === "1", "enabled Next retained disabled styling");
    assertOnlyCardBorderColorChanged(
        initialQuestionState,
        state,
        2,
        "pointer-selected card",
    );
    assertSelectedBorderIsUnique(state, 2, "pointer-selected card");

    await pointerClick(
        '[data-question-step="1"] .response-option:nth-of-type(5)',
    );
    state = await snapshot();
    assert(state.checkedValue === "4", "changing the answer must select the new response");
    assert(state.checkedCount === 1, "changing the answer must keep one response checked");
    assertQuestionUnchanged(
        initialQuestionState,
        state,
        "changing a pointer-selected answer",
    );
    assert(
        JSON.stringify(state.cardStyles[2]) ===
            JSON.stringify(initialQuestionState.cardStyles[2]),
        "previously selected card did not return to its initial style",
    );
    assertOnlyCardBorderColorChanged(
        initialQuestionState,
        state,
        4,
        "replacement pointer-selected card",
    );
    assertSelectedBorderIsUnique(state, 4, "replacement pointer-selected card");
    assert(state.nextDisabled === false, "changing the answer disabled Next");

    await pointerClick(
        '[data-question-step="1"] [data-questionnaire-next]',
    );
    state = await snapshot();
    assertNewQuestionIsGated(state, 2);
    assert(
        state.historyLength === questionnaireHistoryLength,
        "pointer-activated Next changed browser history",
    );

    assert(
        await focus(
            '[data-question-step="2"] [data-questionnaire-back]',
        ),
        "question 2 Back must accept focus without an answer",
    );
    await pressEnter();
    state = await snapshot();
    assertRestoredAnswer(state, 1, "4", 1);
    assert(
        state.historyLength === questionnaireHistoryLength,
        "keyboard-activated Back changed browser history",
    );
    await pointerClick(
        '[data-question-step="1"] [data-questionnaire-next]',
    );
    state = await snapshot();
    assertNewQuestionIsGated(state, 2);

    let gatedQuestionState = state;
    assert(
        await focus(
            '[data-question-step="2"] .response-option:nth-of-type(2) input',
        ),
        "keyboard response must accept focus",
    );
    await pressSpace();
    state = await snapshot();
    assert(state.checkedValue === "1", "Space did not select the focused radio");
    assert(state.checkedCount === 1, "Space must check exactly one response");
    assertQuestionUnchanged(gatedQuestionState, state, "Space radio selection");
    assertOnlyCardBorderColorChanged(
        gatedQuestionState,
        state,
        1,
        "Space-selected card",
    );
    assertSelectedBorderIsUnique(state, 1, "Space-selected card");
    assert(state.nextDisabled === false, "Space selection did not enable Next");

    assert(
        await focus(
            '[data-question-step="2"] [data-questionnaire-next]',
        ),
        "enabled Next must accept focus",
    );
    await pressEnter();
    state = await snapshot();
    assertNewQuestionIsGated(state, 3);
    assertHelperCollapsed(state, 3);

    gatedQuestionState = state;
    await pointerClick(
        '[data-question-step="3"] [data-question-helper]',
    );
    state = await snapshot();
    assertHelperExpanded(state, 3);
    assertHelperPreservedQuestionnaire(
        gatedQuestionState,
        state,
        "question 3 pointer helper activation",
    );

    assert(
        await focus(
            '[data-question-step="3"] .response-option:nth-of-type(2) input',
        ),
        "question 3 radio must accept focus",
    );
    state = await snapshot();
    assertHelperExpanded(state, 3);
    assertHelperPreservedQuestionnaire(
        gatedQuestionState,
        state,
        "question 3 focus change",
    );
    await pressSpace();
    let selectedState = await snapshot();
    assert(selectedState.checkedValue === "1", "Space did not select question 3 response");
    assertHelperExpanded(selectedState, 3);
    assertQuestionUnchanged(
        gatedQuestionState,
        selectedState,
        "question 3 Space selection",
    );
    await pressArrowRight();
    state = await snapshot();
    assert(state.checkedValue === "2", "radio-group ArrowRight did not change selection");
    assert(state.checkedCount === 1, "radio-group ArrowRight must keep one response checked");
    assertQuestionUnchanged(
        gatedQuestionState,
        state,
        "radio-group ArrowRight selection",
    );
    assert(
        JSON.stringify(state.cardStyles[1]) ===
            JSON.stringify(gatedQuestionState.cardStyles[1]),
        "keyboard selection did not clear the previous card border",
    );
    assertOnlyCardBorderColorChanged(
        gatedQuestionState,
        state,
        2,
        "arrow-selected card",
    );
    assertSelectedBorderIsUnique(state, 2, "arrow-selected card");
    assert(state.nextDisabled === false, "ArrowRight selection did not enable Next");
    assertHelperExpanded(state, 3);

    assert(
        await focus('[data-question-step="3"] [data-question-helper]'),
        "question 3 helper must accept focus",
    );
    const expandedQuestionThreeState = await snapshot();
    await pressSpace();
    state = await snapshot();
    assertHelperExpanded(state, 3);
    assertHelperPreservedQuestionnaire(
        expandedQuestionThreeState,
        state,
        "question 3 Space helper reactivation",
    );

    assert(
        await focus(
            '[data-question-step="3"] [data-questionnaire-next]',
        ),
        "question 3 enabled Next must accept focus",
    );
    await pressSpace();
    state = await snapshot();
    assertNewQuestionIsGated(state, 4);

    gatedQuestionState = state;
    await pointerClick(
        '[data-question-step="4"] .response-option:nth-of-type(1)',
    );
    state = await snapshot();
    assert(state.checkedValue === "0", "question 4 pointer selection failed");
    assertQuestionUnchanged(gatedQuestionState, state, "question 4 pointer selection");
    assert(state.nextDisabled === false, "question 4 Next remained disabled");
    await pointerClick(
        '[data-question-step="4"] [data-questionnaire-next]',
    );
    state = await snapshot();
    assertNewQuestionIsGated(state, 5);
    assertHelperCollapsed(state, 5);

    gatedQuestionState = state;
    await pointerClick(
        '[data-question-step="5"] .response-option:nth-of-type(4)',
    );
    state = await snapshot();
    assert(state.checkedValue === "3", "question 5 pointer selection failed");
    assertQuestionUnchanged(gatedQuestionState, state, "question 5 pointer selection");
    assert(state.nextDisabled === false, "question 5 Next remained disabled");
    assertHelperCollapsed(state, 5);

    assert(
        await focus('[data-question-step="5"] [data-question-helper]'),
        "question 5 helper must accept focus",
    );
    const answeredQuestionFiveState = await snapshot();
    await pressEnter();
    state = await snapshot();
    assertHelperExpanded(state, 5);
    assertHelperPreservedQuestionnaire(
        answeredQuestionFiveState,
        state,
        "question 5 Enter helper activation",
    );
    await pointerClick(
        '[data-question-step="5"] [data-questionnaire-next]',
    );
    state = await snapshot();
    verifyStep(state, 6);
    assert(state.checkedCount === 0, "question 6 must begin with no response selected");
    assert(state.nextDisabled === null, "question 6 must not render Next");
    assert(
        (await evaluate(
            'document.querySelector("[data-question-step]:not([hidden]) [data-questionnaire-next], [data-question-step]:not([hidden]) button[type=submit]")',
        )) === null,
        "question 6 must have no Next or submission action",
    );

    await pointerClick(
        '[data-question-step="6"] [data-questionnaire-back]',
    );
    state = await snapshot();
    assertRestoredAnswer(state, 5, "3", 5);
    assertHelperCollapsed(state, 5);

    assert(
        await focus('[data-question-step="5"] [data-question-helper]'),
        "returned question 5 helper must accept focus",
    );
    const returnedQuestionFiveState = await snapshot();
    await pressSpace();
    state = await snapshot();
    assertHelperExpanded(state, 5);
    assertHelperPreservedQuestionnaire(
        returnedQuestionFiveState,
        state,
        "question 5 Space helper activation",
    );

    await pointerClick(
        '[data-question-step="5"] [data-questionnaire-back]',
    );
    state = await snapshot();
    assertRestoredAnswer(state, 4, "0", 5);
    await pointerClick(
        '[data-question-step="4"] [data-questionnaire-next]',
    );
    state = await snapshot();
    assertRestoredAnswer(state, 5, "3", 5);
    assertHelperCollapsed(state, 5);
    await pointerClick(
        '[data-question-step="5"] [data-questionnaire-next]',
    );
    state = await snapshot();
    verifyStep(state, 6);
    assert(state.checkedCount === 0, "question 6 answer changed during helper navigation");

    const questionSixInitialState = state;
    await pointerClick(
        '[data-question-step="6"] .response-option:nth-of-type(4)',
    );
    state = await snapshot();
    assert(state.checkedValue === "3", "question 6 pointer selection failed");
    assert(state.checkedCount === 1, "question 6 pointer selection must check one response");
    assertQuestionUnchanged(
        questionSixInitialState,
        state,
        "question 6 pointer selection",
    );
    assertOnlyCardBorderColorChanged(
        questionSixInitialState,
        state,
        3,
        "question 6 pointer-selected card",
    );
    assertSelectedBorderIsUnique(state, 3, "question 6 pointer-selected card");
    assert(
        await focus(
            '[data-question-step="6"] .response-option:nth-of-type(4) input',
        ),
        "question 6 selected radio must accept focus",
    );
    await pressArrowRight();
    state = await snapshot();
    assert(state.checkedValue === "4", "question 6 ArrowRight did not change selection");
    assert(state.checkedCount === 1, "question 6 must keep exactly one response checked");
    assertQuestionUnchanged(
        questionSixInitialState,
        state,
        "question 6 keyboard answer change",
    );
    assert(
        JSON.stringify(state.cardStyles[3]) ===
            JSON.stringify(questionSixInitialState.cardStyles[3]),
        "question 6 previous card retained selected styling",
    );
    assertOnlyCardBorderColorChanged(
        questionSixInitialState,
        state,
        4,
        "question 6 arrow-selected card",
    );
    assertSelectedBorderIsUnique(state, 4, "question 6 arrow-selected card");

    const expectedAnswers = ["4", "1", "2", "0", "3", "4"];
    assert(state.totalCheckedCount === 6, "all six answers must be saved");

    for (let number = 5; number >= 1; number -= 1) {
        await pointerClick(
            '[data-question-step]:not([hidden]) [data-questionnaire-back]',
        );
        state = await snapshot();
        assertRestoredAnswer(state, number, expectedAnswers[number - 1], 6);
        if (number === 5 || number === 3) {
            assertHelperCollapsed(state, number);
        }
        if (number === 3) {
            assert(
                await focus('[data-question-step="3"] [data-question-helper]'),
                "returned question 3 helper must accept focus",
            );
            const returnedQuestionThreeState = await snapshot();
            await pressEnter();
            state = await snapshot();
            assertHelperExpanded(state, 3);
            assertHelperPreservedQuestionnaire(
                returnedQuestionThreeState,
                state,
                "question 3 Enter helper activation",
            );
        }
    }
    assert(
        (await evaluate(
            'document.querySelector("[data-question-step]:not([hidden]) [data-questionnaire-back]")',
        )) === null,
        "question 1 must have no Back action",
    );

    for (let number = 2; number <= 6; number += 1) {
        const previousNumber = number - 1;
        if (previousNumber === 1) {
            assert(
                await focus(
                    '[data-question-step="1"] [data-questionnaire-next]',
                ),
                "restored question 1 Next must accept focus",
            );
            await pressEnter();
        } else {
            await pointerClick(
                '[data-question-step]:not([hidden]) [data-questionnaire-next]',
            );
        }
        state = await snapshot();
        assertRestoredAnswer(state, number, expectedAnswers[number - 1], 6);
        if (number === 3 || number === 5) {
            assertHelperCollapsed(state, number);
        }

        if (number === 3) {
            await pointerClick(
                '[data-question-step="3"] .response-option:nth-of-type(5)',
            );
            state = await snapshot();
            expectedAnswers[2] = "4";
            assertRestoredAnswer(state, 3, expectedAnswers[2], 6);
        }
    }

    for (let number = 5; number >= 1; number -= 1) {
        await pointerClick(
            '[data-question-step]:not([hidden]) [data-questionnaire-back]',
        );
        state = await snapshot();
        assertRestoredAnswer(state, number, expectedAnswers[number - 1], 6);
    }

    for (let number = 2; number <= 6; number += 1) {
        await pointerClick(
            '[data-question-step]:not([hidden]) [data-questionnaire-next]',
        );
        state = await snapshot();
        assertRestoredAnswer(state, number, expectedAnswers[number - 1], 6);
    }

    await client.send("Page.reload", { ignoreCache: true });
    await waitForQuestionnaire();
    state = await snapshot();
    verifyStep(state, 1);
    assert(state.checkedCount === 0, "reload must reset the visible answer");
    assert(state.totalCheckedCount === 0, "reload must reset all answers");

    await pointerClick(
        '[data-question-step="1"] .response-option:nth-of-type(2)',
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
    assert(state.checkedCount === 0, "route revisit must reset the visible answer");
    assert(state.totalCheckedCount === 0, "route revisit must reset all answers");
    assert(state.localStorageLength === 0, "questionnaire wrote localStorage");
    assert(state.sessionStorageLength === 0, "questionnaire wrote sessionStorage");
    assert(state.cookie === "", "questionnaire wrote a cookie");

    console.log("questionnaire browser scenario passed");
} finally {
    client.close();
}
