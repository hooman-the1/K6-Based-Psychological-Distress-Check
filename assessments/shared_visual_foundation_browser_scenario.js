import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [websocketUrl, testUrl, homeUrl, historyUrl, screenshotDirectory] =
    process.argv.slice(2);
const appOrigin = new URL(homeUrl).origin;
const storageKey = "k6-based-distress-check.history.v1";
const viewportWidths = [320, 375, 768];
const colors = {
    page: "rgb(247, 248, 250)",
    surface: "rgb(255, 255, 255)",
    text: "rgb(31, 41, 51)",
    muted: "rgb(82, 96, 109)",
    border: "rgb(188, 204, 220)",
    primary: "rgb(11, 92, 173)",
    primaryHover: "rgb(8, 72, 135)",
    onPrimary: "rgb(255, 255, 255)",
    focus: "rgb(124, 58, 237)",
    danger: "rgb(159, 18, 57)",
    dangerHover: "rgb(127, 18, 48)",
    disabledBackground: "rgb(228, 231, 235)",
    disabledText: "rgb(82, 96, 109)",
};
const expectedTokens = {
    "--color-page": "#f7f8fa",
    "--color-surface": "#ffffff",
    "--color-text": "#1f2933",
    "--color-muted": "#52606d",
    "--color-border": "#bcccdc",
    "--color-primary": "#0b5cad",
    "--color-primary-hover": "#084887",
    "--color-on-primary": "#ffffff",
    "--color-focus": "#7c3aed",
    "--color-danger": "#9f1239",
    "--color-danger-hover": "#7f1230",
    "--color-disabled-bg": "#e4e7eb",
    "--color-disabled-text": "#52606d",
    "--space-1": "0.25rem",
    "--space-2": "0.5rem",
    "--space-3": "0.75rem",
    "--space-4": "1rem",
    "--space-5": "1.5rem",
    "--space-6": "2rem",
};
const expectedFontFamily =
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const assert = (condition, message) => {
    if (!condition) {
        throw new Error(message);
    }
};
const approximatelyEqual = (actual, expected) =>
    Math.abs(actual - expected) < 0.2;
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
        const debuggingOrigin = new URL(initialUrl.replace(/^ws:/, "http:"))
            .origin;
        let lastError;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
                const targets = await fetch(`${debuggingOrigin}/json/list`).then(
                    (response) => response.json(),
                );
                const target = targets.find((candidate) => candidate.type === "page");
                if (!target) {
                    throw new Error("Edge has not exposed a page target");
                }
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

const setViewport = async (width) => {
    await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: width === 768 ? 1024 : 900,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await delay(40);
};

const waitForPage = async (pathname, heading) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
            if (
                await evaluate(`
                    document.readyState === "complete" &&
                    location.pathname === ${JSON.stringify(pathname)} &&
                    document.querySelector("h1")?.textContent.trim() ===
                        ${JSON.stringify(heading)}
                `)
            ) {
                return;
            }
        } catch {
            // Navigation can briefly destroy the previous execution context.
        }
        await delay(50);
    }
    throw new Error(`${pathname} did not become ready`);
};

const navigate = async (url, pathname, heading) => {
    await client.send("Page.navigate", { url });
    await waitForPage(pathname, heading);
};

const foundationSnapshot = () =>
    evaluate(`(() => {
        const isVisible = (element) => Boolean(
            element &&
            !element.hidden &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).display !== "none" &&
            getComputedStyle(element).visibility !== "hidden"
        );
        const styleSummary = (element) => {
            if (!element) return null;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
                backgroundColor: style.backgroundColor,
                borderColor: style.borderTopColor,
                borderRadius: style.borderRadius,
                borderWidth: style.borderTopWidth,
                color: style.color,
                cursor: style.cursor,
                display: style.display,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                justifyContent: style.justifyContent,
                alignItems: style.alignItems,
                lineHeight: style.lineHeight,
                marginTop: style.marginTop,
                marginBottom: style.marginBottom,
                maxWidth: style.maxWidth,
                minHeight: style.minHeight,
                minWidth: style.minWidth,
                opacity: style.opacity,
                outlineColor: style.outlineColor,
                outlineOffset: style.outlineOffset,
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
                paddingLeft: style.paddingLeft,
                paddingRight: style.paddingRight,
                paddingTop: style.paddingTop,
                paddingBottom: style.paddingBottom,
                textAlign: style.textAlign,
                textDecorationLine: style.textDecorationLine,
                textUnderlineOffset: style.textUnderlineOffset,
                transitionDuration: style.transitionDuration,
                animationName: style.animationName,
                rect: {
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height,
                },
            };
        };
        const rootStyle = getComputedStyle(document.documentElement);
        const shell = document.querySelector("main.page-shell");
        const shellChildren = Array.from(shell.children).filter(isVisible);
        const sharedControls = Array.from(
            document.querySelectorAll(".button, .link")
        ).filter(isVisible);
        const actionGroups = Array.from(
            document.querySelectorAll(".action-stack, .questionnaire-controls")
        ).filter(isVisible);
        const motionElements = Array.from(document.querySelectorAll(
            ".page-shell, .button, .link, progress, " +
            "[data-history-unavailable], [data-history-empty], " +
            "[data-history-results], [data-history-chart-container]"
        ));
        return {
            pathname: location.pathname,
            viewportWidth: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            scrollBehavior: rootStyle.scrollBehavior,
            colorScheme: rootStyle.colorScheme,
            tokens: Object.fromEntries(
                ${JSON.stringify(Object.keys(expectedTokens))}.map((name) => [
                    name,
                    rootStyle.getPropertyValue(name).trim(),
                ])
            ),
            body: styleSummary(document.body),
            shell: styleSummary(shell),
            h1: styleSummary(document.querySelector("h1")),
            h2: styleSummary(
                Array.from(document.querySelectorAll("h2")).find(isVisible)
            ),
            supporting: styleSummary(
                Array.from(document.querySelectorAll(
                    ".question-count, small, figcaption"
                )).find(isVisible)
            ),
            mainCount: document.querySelectorAll("main").length,
            shellCount: document.querySelectorAll("main.page-shell").length,
            shellIsDirectBodyChild: shell?.parentElement === document.body,
            forbiddenLandmarkCount: document.querySelectorAll(
                "body > header, body > nav, body > footer, body > aside"
            ).length,
            directChildGaps: shellChildren.slice(1).map((child, index) => ({
                previousTag: shellChildren[index].tagName.toLowerCase(),
                currentTag: child.tagName.toLowerCase(),
                gap:
                    child.getBoundingClientRect().top -
                    shellChildren[index].getBoundingClientRect().bottom,
            })),
            controls: sharedControls.map((control) => ({
                selectorKey:
                    control.getAttribute("data-questionnaire-next") !== null
                        ? "next"
                        : control.getAttribute("data-questionnaire-back") !== null
                          ? "back"
                          : control.getAttribute("data-question-helper") !== null
                            ? "helper"
                            : control.getAttribute("data-take-test-again") !== null
                              ? "retake"
                              : control.getAttribute("data-clear-history") !== null
                                ? "clear"
                                : control.textContent.trim(),
                tag: control.tagName.toLowerCase(),
                type: control.getAttribute("type"),
                classNames: Array.from(control.classList),
                disabled: control.disabled === true,
                ariaDisabled: control.getAttribute("aria-disabled"),
                style: styleSummary(control),
            })),
            actionGroups: actionGroups.map((group) => ({
                classNames: Array.from(group.classList),
                style: styleSummary(group),
                childRects: Array.from(group.children)
                    .filter(isVisible)
                    .map((child) => styleSummary(child).rect),
            })),
            mediaMaxWidths: Array.from(
                document.querySelectorAll("img, svg, canvas, video, iframe")
            ).map((element) => getComputedStyle(element).maxWidth),
            motion: motionElements.map((element) => ({
                transitionDuration: getComputedStyle(element).transitionDuration,
                animationName: getComputedStyle(element).animationName,
            })),
            visibleText: document.body.innerText,
        };
    })()`);

const assertFoundation = (state, width, context) => {
    const expectedShellWidth = width === 768 ? 576 : width - 32;
    const expectedGutter = width === 768 ? 96 : 16;
    const expectedPadding = width === 768 ? 32 : 20;
    assert(state.viewportWidth === width, `${context}: viewport width is wrong`);
    assert(
        JSON.stringify(state.tokens) === JSON.stringify(expectedTokens),
        `${context}: shared tokens are missing or wrong`,
    );
    assert(
        state.colorScheme.split(" ").sort().join(" ") === "light only",
        `${context}: color scheme is not only light`,
    );
    assert(state.body.backgroundColor === colors.page, `${context}: page color is wrong`);
    assert(state.body.color === colors.text, `${context}: default text color is wrong`);
    assert(state.body.fontFamily === expectedFontFamily, `${context}: font stack is wrong`);
    assert(
        state.body.fontSize === "16px" &&
            state.body.lineHeight === "24px" &&
            state.body.fontWeight === "400",
        `${context}: body typography is wrong`,
    );
    assert(state.body.marginTop === "0px", `${context}: body margin is not zero`);
    assert(state.mainCount === 1 && state.shellCount === 1, `${context}: main landmark count is wrong`);
    assert(state.shellIsDirectBodyChild, `${context}: page shell is not a direct body child`);
    assert(state.forbiddenLandmarkCount === 0, `${context}: persistent chrome was introduced`);
    assert(
        approximatelyEqual(state.shell.rect.width, expectedShellWidth) &&
            approximatelyEqual(state.shell.rect.left, expectedGutter) &&
            approximatelyEqual(width - state.shell.rect.right, expectedGutter),
        `${context}: shell width or gutters are wrong (${JSON.stringify(state.shell.rect)})`,
    );
    assert(
        approximatelyEqual(Number.parseFloat(state.shell.paddingLeft), expectedPadding) &&
            approximatelyEqual(Number.parseFloat(state.shell.paddingRight), expectedPadding) &&
            approximatelyEqual(Number.parseFloat(state.shell.paddingTop), expectedPadding) &&
            approximatelyEqual(Number.parseFloat(state.shell.paddingBottom), expectedPadding),
        `${context}: shell padding is wrong`,
    );
    assert(
        state.shell.marginTop === "16px" &&
            state.shell.marginBottom === "16px" &&
            state.shell.borderWidth === "1px" &&
            state.shell.borderColor === colors.border &&
            state.shell.borderRadius === "12px" &&
            state.shell.backgroundColor === colors.surface,
        `${context}: shell surface is wrong`,
    );
    assert(
        state.h1.fontSize === "32px" &&
            approximatelyEqual(Number.parseFloat(state.h1.lineHeight), 38.4) &&
            state.h1.fontWeight === "700" &&
            state.h1.color === colors.text,
        `${context}: h1 typography is wrong`,
    );
    if (state.h2) {
        assert(
            state.h2.fontSize === "24px" &&
                state.h2.lineHeight === "30px" &&
                state.h2.fontWeight === "700" &&
                state.h2.color === colors.text,
            `${context}: h2 typography is wrong`,
        );
    }
    if (state.supporting) {
        assert(
            state.supporting.fontSize === "14px" &&
                state.supporting.lineHeight === "21px",
            `${context}: supporting typography is wrong`,
        );
    }
    assert(state.scrollWidth <= width, `${context}: document overflows horizontally`);
    assert(
        state.mediaMaxWidths.every((maxWidth) => maxWidth === "100%"),
        `${context}: shared media can exceed its content box`,
    );
    for (const control of state.controls) {
        assert(
            control.style.rect.width >= 44 && control.style.rect.height >= 44,
            `${context}: ${control.selectorKey} target is smaller than 44px`,
        );
        assert(
            control.style.rect.left >= 0 && control.style.rect.right <= width,
            `${context}: ${control.selectorKey} leaves the viewport`,
        );
        if (control.classNames.includes("link")) {
            assert(
                ["flex", "inline-flex"].includes(control.style.display) &&
                    control.style.alignItems === "center" &&
                    control.style.justifyContent === "center" &&
                    control.style.minHeight === "44px" &&
                    control.style.color === colors.primary &&
                    control.style.textDecorationLine.includes("underline") &&
                    control.style.textUnderlineOffset === "2px",
                `${context}: ${control.selectorKey} shared link presentation is wrong`,
            );
            continue;
        }
        assert(
            ["flex", "inline-flex"].includes(control.style.display) &&
                control.style.alignItems === "center" &&
                control.style.justifyContent === "center" &&
                control.style.fontSize === "16px" &&
                control.style.fontWeight === "600" &&
                control.style.lineHeight === "20px" &&
                control.style.minWidth === "44px" &&
                control.style.minHeight === "44px" &&
                control.style.borderWidth === "1px" &&
                control.style.borderRadius === "8px",
            `${context}: ${control.selectorKey} shared box model is wrong (${JSON.stringify(control.style)})`,
        );
    }
    for (const group of state.actionGroups) {
        for (let index = 1; index < group.childRects.length; index += 1) {
            const previous = group.childRects[index - 1];
            const current = group.childRects[index];
            const verticalGap = current.top - previous.bottom;
            const horizontalGap = current.left - previous.right;
            assert(
                verticalGap >= 8 || horizontalGap >= 8,
                `${context}: adjacent controls overlap or lack 8px separation`,
            );
        }
    }
    assert(
        state.motion.every(
            (motion) =>
                motion.transitionDuration
                    .split(", ")
                    .every((duration) => duration === "0s") &&
                motion.animationName
                    .split(", ")
                    .every((name) => name === "none"),
        ),
        `${context}: a shared element animates or transitions`,
    );
    assert(state.scrollBehavior === "auto", `${context}: smooth scrolling is enabled`);
};

const setPointerOver = async (selector) => {
    const bounds = await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)})
            .getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: bounds.x,
        y: bounds.y,
    });
    await delay(30);
};

const controlStyle = (selector) =>
    evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const style = getComputedStyle(element);
        return {
            backgroundColor: style.backgroundColor,
            borderColor: style.borderTopColor,
            color: style.color,
            cursor: style.cursor,
            opacity: style.opacity,
            outlineColor: style.outlineColor,
            outlineOffset: style.outlineOffset,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            textDecorationLine: style.textDecorationLine,
            textUnderlineOffset: style.textUnderlineOffset,
            focusVisible: element.matches(":focus-visible"),
        };
    })()`);

const pressTab = async () => {
    await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
    });
    await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
    });
};

const assertFocusVisible = async (selector, context) => {
    await evaluate("document.activeElement?.blur()");
    await pressTab();
    const activeMatches = await evaluate(
        `document.activeElement === document.querySelector(${JSON.stringify(selector)})`,
    );
    const style = await controlStyle(selector);
    assert(activeMatches, `${context}: keyboard focus reached the wrong control`);
    assert(style.focusVisible, `${context}: keyboard focus is not focus-visible`);
    assert(
        style.outlineWidth === "3px" &&
            style.outlineStyle === "solid" &&
            style.outlineColor === colors.focus &&
            style.outlineOffset === "2px",
        `${context}: focus-visible outline is wrong`,
    );
};

const captureScreenshot = async (name) => {
    await evaluate("document.scrollingElement.scrollTop = 0");
    await delay(20);
    const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true,
    });
    await writeFile(
        path.join(screenshotDirectory, `${name}.png`),
        screenshot.data,
        "base64",
    );
};

const assertAtAllWidths = async (context) => {
    for (const width of viewportWidths) {
        await setViewport(width);
        const state = await foundationSnapshot();
        assertFoundation(state, width, `${context} at ${width}px`);
    }
};

try {
    await mkdir(screenshotDirectory, { recursive: true });
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");

    await setViewport(320);
    await navigate(homeUrl, "/", "K6-Based Psychological Distress Check");
    await evaluate("localStorage.clear()");
    let state = await foundationSnapshot();
    assertFoundation(state, 320, "Home at 320px");
    assert(
        JSON.stringify(state.controls.map((control) => control.classNames)) ===
            JSON.stringify([
                ["button", "button--primary"],
                ["button", "button--secondary"],
            ]),
        "Home controls do not use the required shared classes",
    );
    assert(
        state.actionGroups.length === 1 &&
            state.actionGroups[0].classNames.includes("action-stack") &&
            state.actionGroups[0].style.display === "grid",
        "Home actions are not in the shared action stack",
    );
    assert(
        approximatelyEqual(state.directChildGaps[0].gap, 16) &&
            approximatelyEqual(state.directChildGaps[1].gap, 24),
        `Home does not follow the 16px/24px page rhythm (${JSON.stringify(state.directChildGaps)})`,
    );
    await captureScreenshot("home-320");
    await setPointerOver('a[href="/test"]');
    let style = await controlStyle('a[href="/test"]');
    assert(
        style.backgroundColor === colors.primaryHover &&
            style.borderColor === colors.primaryHover &&
            style.color === colors.onPrimary,
        "primary hover colors are wrong",
    );
    await setPointerOver("[data-history-link]");
    style = await controlStyle("[data-history-link]");
    assert(
        style.backgroundColor === "rgb(234, 242, 251)" &&
            style.borderColor === colors.primary &&
            style.color === colors.primaryHover,
        "secondary hover colors are wrong",
    );
    await navigate(homeUrl, "/", "K6-Based Psychological Distress Check");
    await assertFocusVisible('a[href="/test"]', "Home primary action");
    for (const width of [375, 768]) {
        await setViewport(width);
        state = await foundationSnapshot();
        assertFoundation(state, width, `Home at ${width}px`);
        await captureScreenshot(`home-${width}`);
    }

    await navigate(testUrl, "/test", "Test");
    await assertAtAllWidths("questionnaire initial state");
    await setViewport(320);
    state = await foundationSnapshot();
    const disabledNext = state.controls.find(
        (control) => control.selectorKey === "next",
    );
    assert(disabledNext?.disabled, "initial Next control is not disabled");
    assert(
        disabledNext.classNames.includes("button--primary") &&
            disabledNext.style.backgroundColor === colors.disabledBackground &&
            disabledNext.style.color === colors.disabledText &&
            disabledNext.style.borderColor === colors.border &&
            disabledNext.style.cursor === "not-allowed" &&
            disabledNext.style.opacity === "1",
        "disabled Next presentation is wrong",
    );
    await setPointerOver("[data-questionnaire-next]");
    style = await controlStyle("[data-questionnaire-next]");
    assert(
        style.backgroundColor === colors.disabledBackground &&
            style.color === colors.disabledText,
        "disabled Next acquired hover colors",
    );
    await evaluate(`(() => {
        const advance = () => {
            document.querySelector('.questionnaire-step:not([hidden]) input').click();
            document.querySelector(
                '.questionnaire-step:not([hidden]) [data-questionnaire-next]'
            ).click();
        };
        advance();
        advance();
    })()`);
    await assertAtAllWidths("questionnaire shared controls");
    await setViewport(320);
    state = await foundationSnapshot();
    assert(
        state.controls.some(
            (control) =>
                control.selectorKey === "helper" &&
                control.classNames.includes("button--text"),
        ),
        "question helper does not use the text-button class",
    );
    assert(
        state.controls.some(
            (control) =>
                control.selectorKey === "back" &&
                control.classNames.includes("button--secondary"),
        ) &&
            state.controls.some(
                (control) =>
                    control.selectorKey === "next" &&
                    control.classNames.includes("button--primary"),
            ),
        "questionnaire navigation classes are wrong",
    );
    await setPointerOver("[data-question-helper]");
    style = await controlStyle("[data-question-helper]");
    assert(
        style.backgroundColor === "rgb(234, 242, 251)" &&
            style.color === colors.primaryHover &&
            style.textDecorationLine.includes("underline"),
        "text-button hover presentation is wrong",
    );
    await captureScreenshot("questionnaire-320");

    await evaluate(`(() => {
        while (document.querySelector("[data-questionnaire]")) {
            const step = document.querySelector('.questionnaire-step:not([hidden])');
            step.querySelector('input[type="radio"]').click();
            const forward = step.querySelector(
                "[data-questionnaire-next], [data-questionnaire-submit]"
            );
            forward.click();
        }
    })()`);
    await waitForPage("/result", "Result");
    await assertAtAllWidths("Result");
    await setViewport(320);
    state = await foundationSnapshot();
    assert(
        state.controls.filter((control) => control.classNames.includes("link")).length === 4,
        "Result resource links do not all use the shared link class",
    );
    assert(
        state.controls.some(
            (control) =>
                control.selectorKey === "retake" &&
                control.classNames.includes("button--primary"),
        ),
        "Result retake action is not primary",
    );
    const firstResourceSelector = "[data-active-result-resources] a";
    await setPointerOver(firstResourceSelector);
    style = await controlStyle(firstResourceSelector);
    assert(
        style.color === colors.primaryHover &&
            style.textDecorationLine.includes("underline") &&
            style.textUnderlineOffset === "2px",
        "shared link hover presentation is wrong",
    );
    await captureScreenshot("result-320");

    await evaluate("window.AssessmentHistory.clearResults()");
    await navigate(historyUrl, "/history", "History");
    await assertAtAllWidths("empty History");
    state = await foundationSnapshot();
    assert(
        state.controls.length === 1 &&
            state.controls[0].classNames.includes("button--primary") &&
            state.controls[0].selectorKey === "Take Test",
        "empty History Take Test action is not primary",
    );

    await evaluate(`(() => {
        window.AssessmentHistory.saveResult({ score: 4, timestamp: 1000 });
        window.AssessmentHistory.saveResult({ score: 13, timestamp: 2000 });
        window.AssessmentHistory.saveResult({ score: 24, timestamp: 3000 });
    })()`);
    await client.send("Page.reload", { ignoreCache: true });
    await waitForPage("/history", "History");
    await assertAtAllWidths("populated History");
    await setViewport(320);
    state = await foundationSnapshot();
    assert(
        state.controls.length === 1 &&
            state.controls[0].selectorKey === "clear" &&
            state.controls[0].classNames.includes("button--danger"),
        "History Clear action is not danger",
    );
    await setPointerOver("[data-clear-history]");
    style = await controlStyle("[data-clear-history]");
    assert(
        style.backgroundColor === colors.dangerHover &&
            style.borderColor === colors.dangerHover &&
            style.color === colors.onPrimary,
        "danger hover colors are wrong",
    );
    await captureScreenshot("history-populated-320");

    await evaluate(
        `localStorage.setItem(${JSON.stringify(storageKey)}, "malformed")`,
    );
    await client.send("Page.reload", { ignoreCache: true });
    await waitForPage("/history", "History");
    await assertAtAllWidths("unavailable History");

    await delay(100);
    assert(client.exceptions.length === 0, "visual scenario exposed an exception");
    assert(client.dialogs.length === 0, "visual scenario opened a dialog");
    assert(
        client.networkRequests.every(
            (request) =>
                request.method === "GET" &&
                request.postData === undefined &&
                new URL(request.url).origin === appOrigin,
        ),
        "visual scenario caused a non-local, state-changing, or data-bearing request",
    );

    console.log("shared visual foundation browser scenario passed");
} finally {
    client.close();
}
