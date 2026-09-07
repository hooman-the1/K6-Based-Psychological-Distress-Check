import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [websocketUrl, testUrl, homeUrl, screenshotDirectory] = process.argv.slice(2);
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
    disabledBackground: "rgb(228, 231, 235)",
    focus: "rgb(124, 58, 237)",
    muted: "rgb(82, 96, 109)",
    page: "rgb(247, 248, 250)",
    primary: "rgb(11, 92, 173)",
    surface: "rgb(255, 255, 255)",
    text: "rgb(31, 41, 51)",
};
const assert = (condition, message) => {
    if (!condition) {
        throw new Error(message);
    }
};
const approximatelyEqual = (actual, expected, tolerance = 0.6) =>
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
                handler(message.params);
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
                const pageTarget = targets.find((target) => target.type === "page");
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
const networkRequests = [];
const exceptions = [];
const dialogs = [];
client.on("Network.requestWillBeSent", ({ request }) => {
    networkRequests.push({
        method: request.method,
        postData: request.postData,
        url: request.url,
    });
});
client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    exceptions.push(exceptionDetails.text);
});
client.on("Page.javascriptDialogOpening", ({ message }) => {
    dialogs.push(message);
});

const evaluate = async (expression) => {
    const response = await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text);
    }
    return response.result.value;
};

const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        try {
            if (await evaluate(predicate)) {
                return;
            }
        } catch {
            // Navigation can briefly destroy the previous execution context.
        }
        await delay(50);
    }
    throw new Error(message);
};
const waitForQuestionnaire = () =>
    waitFor(
        'location.pathname === "/test" && document.readyState === "complete" && Boolean(document.querySelector("[data-questionnaire]"))',
        "questionnaire did not become ready",
    );
const waitForResult = (score) =>
    waitFor(
        `location.pathname === "/result" && document.querySelector("[data-active-result-score]")?.textContent.trim() === "${score} / 24"`,
        `${score}-point Result did not become ready`,
    );
const waitForHome = () =>
    waitFor(
        'location.pathname === "/" && document.querySelector("h1")?.textContent.trim() === "K6-Based Psychological Distress Check"',
        "Home did not become ready",
    );
const setViewport = ({ width, height }) =>
    client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
    });
const navigate = async (url, ready) => {
    await client.send("Page.navigate", { url });
    await ready();
};

const pointerClick = async (selector, edge = false) => {
    const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        return {
            x: ${edge} ? rect.right - 8 : rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    })()`);
    assert(point, `missing element for pointer click: ${selector}`);
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

const questionnaireSnapshot = () =>
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
                accentColor: computed.accentColor,
                alignItems: computed.alignItems,
                animationName: computed.animationName,
                backgroundColor: computed.backgroundColor,
                borderColor: computed.borderTopColor,
                borderRadius: computed.borderRadius,
                borderWidth: computed.borderTopWidth,
                boxShadow: computed.boxShadow,
                color: computed.color,
                cursor: computed.cursor,
                display: computed.display,
                flexShrink: computed.flexShrink,
                fontSize: computed.fontSize,
                fontWeight: computed.fontWeight,
                gap: computed.gap,
                justifyContent: computed.justifyContent,
                lineHeight: computed.lineHeight,
                marginBottom: computed.marginBottom,
                marginLeft: computed.marginLeft,
                marginRight: computed.marginRight,
                marginTop: computed.marginTop,
                minHeight: computed.minHeight,
                opacity: computed.opacity,
                outlineColor: computed.outlineColor,
                outlineOffset: computed.outlineOffset,
                outlineStyle: computed.outlineStyle,
                outlineWidth: computed.outlineWidth,
                paddingBottom: computed.paddingBottom,
                paddingLeft: computed.paddingLeft,
                paddingRight: computed.paddingRight,
                paddingTop: computed.paddingTop,
                position: computed.position,
                transform: computed.transform,
                transitionDuration: computed.transitionDuration,
                width: computed.width,
            };
        };
        const visibleStep = document.querySelector("[data-question-step]:not([hidden])");
        const heading = document.querySelector("[data-questionnaire-page] > h1");
        const form = document.querySelector("[data-questionnaire]");
        const count = visibleStep.querySelector(".question-count");
        const progress = visibleStep.querySelector("progress");
        const prompt = visibleStep.querySelector("h2");
        const helper = visibleStep.querySelector("[data-question-helper]");
        const helperCopy = visibleStep.querySelector("[data-question-helper-copy]");
        const fieldset = visibleStep.querySelector(".response-options");
        const legend = fieldset.querySelector("legend");
        const controls = visibleStep.querySelector(".questionnaire-controls");
        return {
            checkedCount: visibleStep.querySelectorAll('input[type="radio"]:checked').length,
            documentScrollWidth: document.documentElement.scrollWidth,
            formGap: rect(form).top - rect(heading).bottom,
            headingCount: document.querySelectorAll("main.page-shell h1").length,
            mainCount: document.querySelectorAll("main.page-shell").length,
            question: Number(visibleStep.dataset.questionStep),
            visibleStepCount: document.querySelectorAll("[data-question-step]:not([hidden])").length,
            step: { rect: rect(visibleStep), style: style(visibleStep) },
            count: { text: count.textContent.trim(), rect: rect(count), style: style(count) },
            progress: {
                ariaLabel: progress.getAttribute("aria-label"),
                max: progress.max,
                rect: rect(progress),
                style: style(progress),
                trackBackground: getComputedStyle(progress, "::-webkit-progress-bar").backgroundColor,
                value: progress.value,
                valueBackground: getComputedStyle(progress, "::-webkit-progress-value").backgroundColor,
            },
            prompt: { text: prompt.textContent.trim(), rect: rect(prompt), style: style(prompt) },
            helper: helper ? {
                expanded: helper.getAttribute("aria-expanded"),
                rect: rect(helper),
                style: style(helper),
            } : null,
            helperCopy: helperCopy ? {
                hidden: helperCopy.hidden,
                rect: rect(helperCopy),
                style: style(helperCopy),
                text: helperCopy.textContent.trim(),
            } : null,
            fieldset: { rect: rect(fieldset), style: style(fieldset) },
            legend: { rect: rect(legend), style: style(legend), text: legend.textContent.trim() },
            options: Array.from(fieldset.querySelectorAll(".response-option"), (option) => {
                const radio = option.querySelector('input[type="radio"]');
                return {
                    checked: radio.checked,
                    label: option.textContent.trim(),
                    rect: rect(option),
                    style: style(option),
                    radio: {
                        focusVisible: radio.matches(":focus-visible"),
                        rect: rect(radio),
                        style: style(radio),
                        value: radio.value,
                    },
                };
            }),
            controls: {
                rect: rect(controls),
                style: style(controls),
                children: Array.from(controls.children, (control) => ({
                    disabled: control.disabled,
                    label: control.textContent.trim(),
                    rect: rect(control),
                    style: style(control),
                })),
            },
        };
    })()`);

const assertQuestionnaire = (state, viewport, { answered, helperExpanded = false }) => {
    const { width } = viewport;
    const question = state.question;
    assert(
        state.mainCount === 1 && state.headingCount === 1 && state.visibleStepCount === 1,
        `Question ${question} at ${width}px: semantic structure changed`,
    );
    assert(
        approximatelyEqual(state.formGap, 16),
        `Question ${question} at ${width}px: heading/form gap is not 16px`,
    );
    assert(
        state.count.text === `Question ${question} of 6` &&
            state.count.style.fontSize === "14px" &&
            state.count.style.lineHeight === "21px" &&
            state.count.style.color === colors.muted &&
            approximatelyEqual(state.progress.rect.top - state.count.rect.bottom, 8),
        `Question ${question} at ${width}px: question count presentation is wrong`,
    );
    assert(
        state.progress.value === question && state.progress.max === 6 &&
            state.progress.ariaLabel === "Questionnaire progress" &&
            approximatelyEqual(state.progress.rect.width, state.step.rect.width) &&
            approximatelyEqual(state.progress.rect.height, 8) &&
            state.progress.style.borderWidth === "0px" &&
            state.progress.style.borderRadius === "999px" &&
            state.progress.style.backgroundColor === colors.disabledBackground &&
            state.progress.style.color === colors.primary &&
            state.progress.style.accentColor === colors.primary &&
            state.progress.style.boxShadow === "none" &&
            state.progress.trackBackground === colors.disabledBackground,
        `Question ${question} at ${width}px: progress presentation is wrong (${JSON.stringify(state.progress)})`,
    );
    assert(
        approximatelyEqual(state.prompt.rect.top - state.progress.rect.bottom, 16) &&
            state.prompt.text.length > 0 &&
            state.prompt.style.fontSize === "24px" &&
            state.prompt.style.lineHeight === "30px" &&
            state.prompt.style.fontWeight === "700" &&
            state.prompt.rect.right <= state.step.rect.right + 0.5,
        `Question ${question} at ${width}px: prompt presentation is wrong`,
    );
    let precedingContent = state.prompt;
    if (state.helper) {
        assert(
            approximatelyEqual(state.helper.rect.top - state.prompt.rect.bottom, 12) &&
                approximatelyEqual(state.helper.rect.left, state.step.rect.left) &&
                state.helper.rect.height >= 44 &&
                state.helper.expanded === String(helperExpanded),
            `Question ${question} at ${width}px: helper control presentation is wrong`,
        );
        if (helperExpanded) {
            assert(
                !state.helperCopy.hidden &&
                    approximatelyEqual(state.helperCopy.rect.top - state.helper.rect.bottom, 8) &&
                    state.helperCopy.style.fontSize === "14px" &&
                    state.helperCopy.style.lineHeight === "21px" &&
                    state.helperCopy.style.color === colors.muted &&
                    state.helperCopy.rect.right <= state.step.rect.right + 0.5,
                `Question ${question} at ${width}px: helper copy presentation is wrong`,
            );
            precedingContent = state.helperCopy;
        } else {
            assert(state.helperCopy.hidden, `Question ${question}: helper copy started open`);
            precedingContent = state.helper;
        }
    }
    assert(
        approximatelyEqual(state.fieldset.rect.top - precedingContent.rect.bottom, 24) &&
            approximatelyEqual(state.controls.rect.top - state.fieldset.rect.bottom, 24) &&
            state.fieldset.style.borderWidth === "0px" &&
            state.fieldset.style.paddingTop === "0px" &&
            state.fieldset.style.paddingRight === "0px" &&
            state.fieldset.style.paddingBottom === "0px" &&
            state.fieldset.style.paddingLeft === "0px",
        `Question ${question} at ${width}px: response group spacing is wrong (${JSON.stringify({
            before: state.fieldset.rect.top - precedingContent.rect.bottom,
            after: state.controls.rect.top - state.fieldset.rect.bottom,
            style: state.fieldset.style,
        })})`,
    );
    assert(
        state.legend.text === "Choose one response" &&
            state.legend.style.fontSize === "16px" &&
            state.legend.style.lineHeight === "24px" &&
            state.legend.style.fontWeight === "600" &&
            approximatelyEqual(state.options[0].rect.top - state.legend.rect.bottom, 12),
        `Question ${question} at ${width}px: response legend is wrong`,
    );
    assert(state.options.length === 5, `Question ${question}: response count changed`);
    for (let index = 0; index < state.options.length; index += 1) {
        const option = state.options[index];
        assert(
            approximatelyEqual(option.rect.width, state.fieldset.rect.width) &&
                option.rect.height >= 56 && option.style.minHeight === "56px" &&
                option.style.paddingTop === "12px" && option.style.paddingRight === "12px" &&
                option.style.paddingBottom === "12px" && option.style.paddingLeft === "12px" &&
                option.style.gap === "12px" && option.style.borderWidth === "1px" &&
                option.style.borderRadius === "8px" &&
                option.style.backgroundColor === colors.surface && option.style.color === colors.text &&
                option.style.boxShadow === "none" && option.style.transform === "none" &&
                option.style.animationName === "none" && option.style.transitionDuration === "0s",
            `Question ${question} at ${width}px: response ${index + 1} card is wrong`,
        );
        assert(
            approximatelyEqual(option.radio.rect.width, 20) &&
                approximatelyEqual(option.radio.rect.height, 20) &&
                option.radio.style.width === "20px" &&
                option.radio.style.marginTop === "0px" && option.radio.style.marginRight === "0px" &&
                option.radio.style.marginBottom === "0px" && option.radio.style.marginLeft === "0px" &&
                option.radio.style.flexShrink === "0" && option.radio.style.accentColor === colors.primary,
            `Question ${question} at ${width}px: response ${index + 1} radio is wrong`,
        );
        if (index > 0) {
            assert(
                approximatelyEqual(option.rect.top - state.options[index - 1].rect.bottom, 12),
                `Question ${question} at ${width}px: response gap is not 12px`,
            );
        }
    }
    assert(
        state.checkedCount === (answered ? 1 : 0),
        `Question ${question} at ${width}px: selected response state is wrong`,
    );
    assert(
        state.controls.style.display === "flex" && state.controls.style.position === "static" &&
            state.controls.style.gap === "16px" && state.controls.style.justifyContent === "space-between",
        `Question ${question} at ${width}px: navigation row is wrong`,
    );
    const forward = state.controls.children.at(-1);
    assert(
        forward.disabled === !answered && forward.rect.width >= 44 && forward.rect.height >= 44 &&
            forward.rect.right <= state.step.rect.right + 0.5,
        `Question ${question} at ${width}px: forward action state is wrong`,
    );
    if (answered) {
        assert(
            forward.style.backgroundColor === colors.primary &&
                forward.style.borderColor === colors.primary &&
                forward.style.color === colors.surface &&
                forward.style.cursor === "pointer" && forward.style.opacity === "1",
            `Question ${question} at ${width}px: enabled forward presentation is wrong`,
        );
    } else {
        assert(
            forward.style.backgroundColor === colors.disabledBackground &&
                forward.style.borderColor === colors.border &&
                forward.style.color === colors.muted &&
                forward.style.cursor === "not-allowed" && forward.style.opacity === "1",
            `Question ${question} at ${width}px: disabled forward presentation is wrong`,
        );
    }
    if (question === 1) {
        assert(
            state.controls.children.length === 1 &&
                approximatelyEqual(forward.rect.right, state.controls.rect.right),
            `Question 1 at ${width}px: sole forward action is not inline-end`,
        );
    } else {
        const back = state.controls.children[0];
        assert(
            state.controls.children.length === 2 &&
                approximatelyEqual(back.rect.left, state.controls.rect.left) &&
                approximatelyEqual(forward.rect.right, state.controls.rect.right) &&
                forward.rect.left - back.rect.right >= 16 &&
                back.rect.width >= 44 && back.rect.height >= 44,
            `Question ${question} at ${width}px: navigation actions overlap or misalign`,
        );
    }
    assert(
        state.documentScrollWidth <= width,
        `Question ${question} at ${width}px: document overflows horizontally`,
    );
};

const selectedPresentation = (card) => ({
    animationName: card.style.animationName,
    backgroundColor: card.style.backgroundColor,
    borderColor: card.style.borderColor,
    borderRadius: card.style.borderRadius,
    borderWidth: card.style.borderWidth,
    boxShadow: card.style.boxShadow,
    color: card.style.color,
    height: card.rect.height,
    opacity: card.style.opacity,
    transform: card.style.transform,
    transitionDuration: card.style.transitionDuration,
    width: card.rect.width,
    x: card.rect.left,
    y: card.rect.top,
});

const assertSelectedBorderOnly = (before, after, width) => {
    const normalizedAfter = {
        ...selectedPresentation(after),
        borderColor: selectedPresentation(before).borderColor,
    };
    assert(
        after.style.borderColor === colors.primary && after.style.borderWidth === "1px" &&
            JSON.stringify(normalizedAfter) === JSON.stringify(selectedPresentation(before)),
        `selected response card did not change only its 1px border to primary at ${width}px`,
    );
};

const assertRadioFocus = async (selector, context) => {
    const state = await evaluate(`(() => {
        const radio = document.querySelector(${JSON.stringify(selector)});
        const card = radio.closest(".response-option");
        const style = getComputedStyle(card);
        const cardRect = card.getBoundingClientRect();
        const shellRect = document.querySelector(".page-shell").getBoundingClientRect();
        return {
            active: document.activeElement === radio,
            focusVisible: radio.matches(":focus-visible"),
            outlineColor: style.outlineColor,
            outlineOffset: style.outlineOffset,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            unclipped: cardRect.left - 5 >= shellRect.left + 1 &&
                cardRect.right + 5 <= shellRect.right - 1,
        };
    })()`);
    assert(
        state.active && state.focusVisible && state.outlineWidth === "3px" &&
            state.outlineStyle === "solid" && state.outlineColor === colors.focus &&
            state.outlineOffset === "2px" && state.unclipped,
        `${context}: radio focus-visible outline is wrong or clipped (${JSON.stringify(state)})`,
    );
};

const assertControlFocus = async (selector, context) => {
    const state = await evaluate(`(() => {
        const control = document.querySelector(${JSON.stringify(selector)});
        const style = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        const shellRect = document.querySelector(".page-shell").getBoundingClientRect();
        return {
            active: document.activeElement === control,
            focusVisible: control.matches(":focus-visible"),
            outlineColor: style.outlineColor,
            outlineOffset: style.outlineOffset,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            unclipped: rect.left - 5 >= shellRect.left + 1 &&
                rect.right + 5 <= shellRect.right - 1,
        };
    })()`);
    assert(
        state.active && state.focusVisible && state.outlineWidth === "3px" &&
            state.outlineStyle === "solid" && state.outlineColor === colors.focus &&
            state.outlineOffset === "2px" && state.unclipped,
        `${context}: control focus-visible outline is wrong or clipped`,
    );
};

const resultSnapshot = () =>
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
                animationName: computed.animationName,
                backgroundColor: computed.backgroundColor,
                borderColor: computed.borderTopColor,
                borderRadius: computed.borderRadius,
                borderWidth: computed.borderTopWidth,
                color: computed.color,
                display: computed.display,
                fontSize: computed.fontSize,
                fontVariantNumeric: computed.fontVariantNumeric,
                fontWeight: computed.fontWeight,
                gap: computed.gap,
                lineHeight: computed.lineHeight,
                overflowWrap: computed.overflowWrap,
                paddingBottom: computed.paddingBottom,
                paddingLeft: computed.paddingLeft,
                paddingRight: computed.paddingRight,
                paddingTop: computed.paddingTop,
                transitionDuration: computed.transitionDuration,
                whiteSpace: computed.whiteSpace,
            };
        };
        const result = document.querySelector("[data-active-result]");
        const heading = result.querySelector("h1");
        const score = result.querySelector("[data-active-result-score]");
        const cutoff = result.querySelector("[data-active-result-cutoff]");
        const status = result.querySelector("[data-active-result-status]");
        const interpretation = result.querySelector("[data-active-result-interpretation]");
        const higher = result.querySelector("[data-active-result-higher-score]");
        const guidance = result.querySelector("[data-active-result-guidance]");
        const resourcesSection = result.querySelector('section[aria-labelledby="result-resources-heading"]');
        const resourcesHeading = resourcesSection.querySelector("h2");
        const resources = result.querySelector("[data-active-result-resources]");
        const retake = result.querySelector("[data-take-test-again]");
        return {
            cutoffState: cutoff.dataset.activeResultCutoff,
            documentScrollWidth: document.documentElement.scrollWidth,
            forbiddenGraphicCount: result.querySelectorAll("progress, svg, canvas, img").length,
            formCount: document.querySelectorAll("form").length,
            headingCount: document.querySelectorAll("main.page-shell h1").length,
            inputCount: document.querySelectorAll("input").length,
            mainCount: document.querySelectorAll("main.page-shell").length,
            pathname: location.pathname,
            order: Array.from(result.children, (child) =>
                child.tagName === "H1" ? "heading"
                    : child.hasAttribute("data-active-result-score") ? "score"
                      : child.hasAttribute("data-active-result-cutoff") ? "cutoff"
                        : child.hasAttribute("data-active-result-higher-score") ? "higher"
                          : child.hasAttribute("data-active-result-guidance") ? "guidance"
                            : child.matches('section[aria-labelledby="result-resources-heading"]') ? "resources"
                              : child.hasAttribute("data-take-test-again") ? "retake"
                                : "unexpected",
            ),
            result: { rect: rect(result), style: style(result) },
            heading: { rect: rect(heading), style: style(heading), text: heading.textContent.trim() },
            score: { rect: rect(score), style: style(score), text: score.textContent.trim() },
            cutoff: { rect: rect(cutoff), style: style(cutoff) },
            status: { rect: rect(status), style: style(status), text: status.textContent.trim() },
            interpretation: {
                rect: rect(interpretation),
                style: style(interpretation),
                text: interpretation.textContent.trim(),
            },
            higher: { rect: rect(higher), style: style(higher), text: higher.textContent.trim() },
            guidance: { rect: rect(guidance), style: style(guidance), text: guidance.textContent.trim() },
            resourcesSection: { rect: rect(resourcesSection), style: style(resourcesSection) },
            resourcesHeading: {
                rect: rect(resourcesHeading),
                style: style(resourcesHeading),
                text: resourcesHeading.textContent.trim(),
            },
            resources: {
                rect: rect(resources),
                style: style(resources),
                items: Array.from(resources.children, (item) => {
                    const link = item.querySelector("a");
                    return {
                        href: link.href,
                        itemRect: rect(item),
                        label: link.textContent.trim(),
                        linkRect: rect(link),
                        linkStyle: style(link),
                        target: link.target,
                    };
                }),
            },
            retake: {
                href: retake.href,
                rect: rect(retake),
                style: style(retake),
                text: retake.textContent.trim(),
            },
        };
    })()`);

const cutoffPresentation = (state) => ({
    cutoff: state.cutoff.style,
    interpretation: state.interpretation.style,
    status: state.status.style,
});

const sharedResultContent = (state) => ({
    guidance: state.guidance.text,
    higher: state.higher.text,
    resources: state.resources.items.map(({ href, label, target }) => ({
        href,
        label,
        target,
    })),
    retake: { href: state.retake.href, text: state.retake.text },
});

const assertResult = (state, viewport, score) => {
    const { width } = viewport;
    const expectedCutoff = score === 12 ? "below-13" : "at-or-above-13";
    assert(
        state.pathname === "/result" && state.mainCount === 1 &&
            state.headingCount === 1 && state.formCount === 0 && state.inputCount === 0 &&
            state.forbiddenGraphicCount === 0 && state.heading.text === "Result",
        `${score}-point Result at ${width}px: semantic structure changed`,
    );
    assert(
        JSON.stringify(state.order) === JSON.stringify([
            "heading", "score", "cutoff", "higher", "guidance", "resources", "retake",
        ]),
        `${score}-point Result at ${width}px: content order changed`,
    );
    assert(
        state.score.text === `${score} / 24` && state.score.style.fontSize === "48px" &&
            state.score.style.lineHeight === "48px" && state.score.style.fontWeight === "700" &&
            state.score.style.fontVariantNumeric.includes("tabular-nums") &&
            state.score.style.color === colors.primary && state.score.style.whiteSpace === "nowrap" &&
            approximatelyEqual(state.score.rect.top - state.heading.rect.bottom, 16),
        `${score}-point Result at ${width}px: score presentation is wrong`,
    );
    assert(
        state.cutoffState === expectedCutoff &&
            approximatelyEqual(state.cutoff.rect.top - state.score.rect.bottom, 16) &&
            state.cutoff.style.paddingTop === "16px" && state.cutoff.style.paddingRight === "16px" &&
            state.cutoff.style.paddingBottom === "16px" && state.cutoff.style.paddingLeft === "16px" &&
            state.cutoff.style.borderWidth === "1px" && state.cutoff.style.borderColor === colors.border &&
            state.cutoff.style.borderRadius === "8px" && state.cutoff.style.backgroundColor === colors.page,
        `${score}-point Result at ${width}px: cutoff panel is wrong`,
    );
    assert(
        state.status.text.length > 0 && state.status.style.fontSize === "20px" &&
            state.status.style.lineHeight === "26px" && state.status.style.fontWeight === "700" &&
            state.status.style.color === colors.text &&
            state.interpretation.text.length > 0 &&
            state.interpretation.style.fontSize === "16px" &&
            state.interpretation.style.lineHeight === "24px" &&
            state.interpretation.style.fontWeight === "400" &&
            state.interpretation.style.color === colors.text &&
            approximatelyEqual(state.interpretation.rect.top - state.status.rect.bottom, 8),
        `${score}-point Result at ${width}px: cutoff copy presentation is wrong`,
    );
    assert(
        state.higher.text.length > 0 &&
            state.higher.style.fontSize === "14px" && state.higher.style.lineHeight === "21px" &&
            state.higher.style.color === colors.muted &&
            approximatelyEqual(state.higher.rect.top - state.cutoff.rect.bottom, 24),
        `${score}-point Result at ${width}px: higher-score note is wrong`,
    );
    assert(
        state.guidance.style.fontSize === "16px" && state.guidance.style.lineHeight === "24px" &&
            state.guidance.style.fontWeight === "400" && state.guidance.style.color === colors.text &&
            approximatelyEqual(state.guidance.rect.top - state.higher.rect.bottom, 16),
        `${score}-point Result at ${width}px: guidance presentation is wrong`,
    );
    assert(
        approximatelyEqual(state.resourcesSection.rect.top - state.guidance.rect.bottom, 24) &&
            state.resourcesHeading.text === "Resources" &&
            state.resourcesHeading.style.fontSize === "24px" &&
            state.resourcesHeading.style.lineHeight === "30px" &&
            state.resourcesHeading.style.fontWeight === "700" &&
            approximatelyEqual(state.resources.rect.top - state.resourcesHeading.rect.bottom, 12) &&
            state.resources.style.display === "grid" && state.resources.style.gap === "8px",
        `${score}-point Result at ${width}px: Resources composition is wrong`,
    );
    assert(state.resources.items.length === 4, `${score}-point Result: resource count changed`);
    state.resources.items.forEach((resource, index) => {
        assert(
            resource.label.length > 0 && !resource.label.startsWith("http") &&
                new URL(resource.href).protocol === "https:" && resource.target === "" &&
                resource.linkStyle.overflowWrap === "anywhere" &&
                resource.itemRect.right <= state.result.rect.right + 0.5 &&
                resource.linkRect.right <= state.result.rect.right + 0.5 &&
                resource.linkRect.width >= 44 && resource.linkRect.height >= 44,
            `${score}-point Result at ${width}px: resource ${index + 1} changed or overflows`,
        );
        if (index > 0) {
            assert(
                approximatelyEqual(
                    resource.itemRect.top - state.resources.items[index - 1].itemRect.bottom,
                    8,
                ),
                `${score}-point Result at ${width}px: resource gap is not 8px`,
            );
        }
    });
    assert(
        state.retake.text === "Take test again" && state.retake.href === testUrl &&
            state.retake.rect.width >= 44 && state.retake.rect.height >= 44 &&
            state.retake.rect.right <= state.result.rect.right + 0.5 &&
            approximatelyEqual(state.retake.rect.top - state.resourcesSection.rect.bottom, 24),
        `${score}-point Result at ${width}px: retake placement is wrong`,
    );
    assert(
        [
            state.result, state.score, state.cutoff, state.status, state.interpretation,
            state.higher, state.guidance, state.resourcesSection, state.resources, state.retake,
            ...state.resources.items.map((resource) => ({ style: resource.linkStyle })),
        ].every((item) =>
            item.style.animationName === "none" && item.style.transitionDuration === "0s"),
        `${score}-point Result at ${width}px: component motion is enabled`,
    );
    assert(
        state.documentScrollWidth <= width,
        `${score}-point Result at ${width}px: document overflows horizontally`,
    );
};

const captureScreenshot = async (name) => {
    await evaluate("document.scrollingElement.scrollTop = 0");
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

const snapshotQuestionnaireAtAllWidths = async (expectations) => {
    const snapshots = new Map();
    for (const viewport of viewports) {
        await setViewport(viewport);
        const state = await questionnaireSnapshot();
        assertQuestionnaire(state, viewport, expectations);
        snapshots.set(viewport.width, state);
    }
    return snapshots;
};

const snapshotResultAtAllWidths = async (score) => {
    const snapshots = new Map();
    for (const viewport of viewports) {
        await setViewport(viewport);
        const state = await resultSnapshot();
        assertResult(state, viewport, score);
        snapshots.set(viewport.width, state);
    }
    return snapshots;
};

const selectResponse = (question, value, edge = false) =>
    pointerClick(
        `[data-question-step="${question}"] .response-option:has(input[value="${value}"])`,
        edge,
    );
const goForward = (question) =>
    pointerClick(
        question === 6
            ? '[data-question-step="6"] [data-questionnaire-submit]'
            : `[data-question-step="${question}"] [data-questionnaire-next]`,
    );
const completeQuestionnaire = async (responses, expectedScore) => {
    for (let index = 0; index < responses.length; index += 1) {
        const question = index + 1;
        await selectResponse(question, responses[index]);
        await goForward(question);
    }
    await waitForResult(expectedScore);
};

try {
    await mkdir(screenshotDirectory, { recursive: true });
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");

    await setViewport(viewports[0]);
    await navigate(resultUrl, waitForHome);
    assert(
        (await evaluate("location.href")) === homeUrl,
        "direct /result did not end at Home",
    );

    await navigate(testUrl, waitForQuestionnaire);
    await evaluate("localStorage.clear()");
    const initial = await snapshotQuestionnaireAtAllWidths({ answered: false });

    await setViewport(viewports[0]);
    await selectResponse(1, 1, true);
    let state = await questionnaireSnapshot();
    assert(
        state.question === 1 && state.options[1].checked,
        "clicking padded response-card space selected incorrectly or advanced",
    );
    const selected = await snapshotQuestionnaireAtAllWidths({ answered: true });
    for (const viewport of viewports) {
        assertSelectedBorderOnly(
            initial.get(viewport.width).options[1],
            selected.get(viewport.width).options[1],
            viewport.width,
        );
    }
    await setViewport(viewports[0]);
    await captureScreenshot("question-1-selected-320");

    await pressTab();
    await pressTab(true);
    await assertRadioFocus(
        '[data-question-step="1"] input[value="1"]',
        "Question 1 after pointer selection and later keyboard navigation",
    );

    await goForward(1);
    await selectResponse(2, 3);
    await goForward(2);
    await snapshotQuestionnaireAtAllWidths({ answered: false });
    await setViewport(viewports[0]);
    await pointerClick('[data-question-step="3"] [data-question-helper]');
    await snapshotQuestionnaireAtAllWidths({ answered: false, helperExpanded: true });
    await setViewport(viewports[0]);
    await captureScreenshot("question-3-helper-expanded-320");
    await setViewport(viewports[2]);
    await captureScreenshot("questionnaire-helper-expanded-768");

    await pointerClick('[data-question-step="3"] [data-questionnaire-back]');
    state = await questionnaireSnapshot();
    assert(
        state.question === 2 && state.checkedCount === 1 &&
            !state.controls.children.at(-1).disabled,
        "Back did not retain the prior response and enabled state",
    );
    await goForward(2);
    state = await questionnaireSnapshot();
    assert(
        state.question === 3 && state.helper.expanded === "false" &&
            state.helperCopy.hidden,
        "leaving and returning to Question 3 did not collapse its helper",
    );

    await selectResponse(3, 2);
    await goForward(3);
    await selectResponse(4, 2);
    await goForward(4);
    await selectResponse(5, 2);
    await goForward(5);
    await snapshotQuestionnaireAtAllWidths({ answered: false });
    await setViewport(viewports[0]);
    state = await questionnaireSnapshot();
    assert(
        state.controls.children[0].label === "Back" &&
            state.controls.children[1].label === "See my result" &&
            state.controls.children[1].disabled,
        "unanswered Question 6 controls are wrong",
    );
    await pointerClick("[data-questionnaire-submit]");
    assert(
        (await questionnaireSnapshot()).question === 6,
        "disabled Submit changed the questionnaire state",
    );
    await selectResponse(6, 2);
    await snapshotQuestionnaireAtAllWidths({ answered: true });
    await setViewport(viewports[1]);
    await captureScreenshot("question-6-answered-375");
    await setViewport(viewports[0]);
    await pressTab();
    await assertControlFocus(
        '[data-question-step="6"] [data-questionnaire-back]',
        "Question 6 Back",
    );
    await pressTab();
    await assertControlFocus(
        '[data-question-step="6"] [data-questionnaire-submit]',
        "Question 6 Submit",
    );
    await goForward(6);
    await waitForResult(12);

    const belowResults = await snapshotResultAtAllWidths(12);
    await setViewport(viewports[0]);
    await captureScreenshot("result-12-320");
    await setViewport(viewports[2]);
    await captureScreenshot("result-12-768");
    const storedAfterTwelve = await evaluate(`(() => {
        const keys = Object.keys(localStorage);
        const records = JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}));
        return { keys, records };
    })()`);
    assert(
        JSON.stringify(storedAfterTwelve.keys) === JSON.stringify([storageKey]) &&
            storedAfterTwelve.records.length === 1 &&
            JSON.stringify(Object.keys(storedAfterTwelve.records[0])) ===
                JSON.stringify(["score", "timestamp"]) &&
            storedAfterTwelve.records[0].score === 12,
        "12-point completion stored anything beyond one canonical score/timestamp record",
    );

    await client.send("Page.reload", { ignoreCache: true });
    await waitForHome();
    assert(
        (await evaluate("location.href")) === homeUrl,
        "refreshing /result did not end at Home",
    );

    await navigate(testUrl, waitForQuestionnaire);
    await completeQuestionnaire([3, 2, 2, 2, 2, 2], 13);
    const aboveResults = await snapshotResultAtAllWidths(13);
    for (const viewport of viewports) {
        assert(
            JSON.stringify(cutoffPresentation(belowResults.get(viewport.width))) ===
                JSON.stringify(cutoffPresentation(aboveResults.get(viewport.width))),
            `cutoff presentation differs between 12 and 13 at ${viewport.width}px`,
        );
        assert(
            JSON.stringify(sharedResultContent(belowResults.get(viewport.width))) ===
                JSON.stringify(sharedResultContent(aboveResults.get(viewport.width))),
            `shared Result content differs between 12 and 13 at ${viewport.width}px`,
        );
    }
    await setViewport(viewports[1]);
    await captureScreenshot("result-13-375");
    await setViewport(viewports[2]);
    await captureScreenshot("result-13-768");

    await setViewport(viewports[0]);
    await pressTab();
    let focusState = await evaluate(`(() => {
        const link = document.querySelector("[data-active-result-resources] a");
        const style = getComputedStyle(link);
        return {
            active: document.activeElement === link,
            focusVisible: link.matches(":focus-visible"),
            outlineColor: style.outlineColor,
            outlineOffset: style.outlineOffset,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
        };
    })()`);
    assert(
        focusState.active && focusState.focusVisible &&
            focusState.outlineWidth === "3px" && focusState.outlineStyle === "solid" &&
            focusState.outlineColor === colors.focus && focusState.outlineOffset === "2px",
        "Result resource keyboard focus is not visibly outlined",
    );
    for (let tab = 0; tab < 4; tab += 1) {
        await pressTab();
    }
    focusState = await evaluate(`(() => {
        const link = document.querySelector("[data-take-test-again]");
        const style = getComputedStyle(link);
        return {
            active: document.activeElement === link,
            focusVisible: link.matches(":focus-visible"),
            outlineColor: style.outlineColor,
            outlineOffset: style.outlineOffset,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
        };
    })()`);
    assert(
        focusState.active && focusState.focusVisible &&
            focusState.outlineWidth === "3px" && focusState.outlineStyle === "solid" &&
            focusState.outlineColor === colors.focus && focusState.outlineOffset === "2px",
        "Result retake keyboard focus is not visibly outlined",
    );

    await pointerClick("[data-take-test-again]");
    await waitForQuestionnaire();
    state = await questionnaireSnapshot();
    assert(
        (await evaluate("location.href")) === testUrl &&
            state.question === 1 && state.checkedCount === 0,
        "Take test again did not produce a fresh exact /test state",
    );
    await evaluate("history.back()");
    await waitForHome();
    await evaluate("history.forward()");
    await waitForQuestionnaire();
    assert(
        !(await evaluate('Boolean(document.querySelector("[data-active-result]"))')),
        "Back/Forward resurrected a discarded Result",
    );

    assert(exceptions.length === 0, "visual scenario exposed an exception");
    assert(dialogs.length === 0, "visual scenario opened a dialog");
    assert(
        networkRequests.every((request) =>
            request.method === "GET" && request.postData === undefined &&
                new URL(request.url).origin === appOrigin),
        "visual scenario made an unexpected, remote, or data-bearing request",
    );
    assert(
        (await evaluate("sessionStorage.length")) === 0 &&
            (await evaluate("document.cookie")) === "",
        "visual scenario introduced session or cookie persistence",
    );

    console.log("questionnaire and Result visual scenario passed");
} finally {
    client.close();
}
