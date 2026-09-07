const form = document.querySelector("[data-questionnaire]");
const historyUnavailableNotice = document.querySelector(
    "[data-history-unavailable]",
);

if (historyUnavailableNotice) {
    const historyLink = document.querySelector("[data-history-link]");
    const historyEmptyState = document.querySelector("[data-history-empty]");
    let historyResults = null;

    try {
        const readResult = window.AssessmentHistory.getResults();
        if (readResult?.ok === true && Array.isArray(readResult.results)) {
            historyResults = readResult.results;
        }
    } catch {
        historyResults = null;
    }

    const isHistoryAvailable = historyResults !== null;
    if (historyLink) {
        historyLink.hidden = !isHistoryAvailable;
    }
    historyUnavailableNotice.hidden = isHistoryAvailable;
    if (historyEmptyState) {
        historyEmptyState.hidden =
            !isHistoryAvailable || historyResults.length !== 0;
    }
}

if (form) {
    const steps = Array.from(form.querySelectorAll("[data-question-step]"));
    const pageShell = document.querySelector(".page-shell");
    const questionnairePage = form.closest("[data-questionnaire-page]");
    const resultTemplate = document.querySelector("[data-active-result-template]");
    let currentStep = 0;
    let activeResult = null;
    let isSubmissionComplete = false;

    const updateForwardButtonState = () => {
        const currentQuestion = steps[currentStep];
        const forwardButton = currentQuestion.querySelector(
            "[data-questionnaire-next], [data-questionnaire-submit]",
        );

        if (forwardButton) {
            forwardButton.disabled = !currentQuestion.querySelector(
                'input[type="radio"]:checked',
            );
        }
    };
    const collapseHelper = (step) => {
        const helperButton = step.querySelector("[data-question-helper]");
        const helperCopy = step.querySelector("[data-question-helper-copy]");

        if (helperButton && helperCopy) {
            helperButton.setAttribute("aria-expanded", "false");
            helperCopy.hidden = true;
        }
    };
    const showStep = (stepNumber) => {
        if (stepNumber !== currentStep) {
            collapseHelper(steps[currentStep]);
        }
        currentStep = stepNumber;
        steps.forEach((step, index) => {
            step.hidden = index !== currentStep;
        });
        updateForwardButtonState();
    };

    const resetQuestionnaire = () => {
        form.reset();
        steps.forEach(collapseHelper);
        currentStep = 0;
        showStep(0);
    };

    const showFreshQuestionnaire = () => {
        activeResult = null;
        isSubmissionComplete = false;
        resetQuestionnaire();
        pageShell.replaceChildren(questionnairePage);
        document.title = "Test | K6-Based Psychological Distress Check";
    };

    const showActiveResult = () => {
        const content = window.ResultContent.getResultContent(
            activeResult.isAtOrAboveCutoff,
        );
        const resultPage = resultTemplate.content.firstElementChild.cloneNode(true);
        resultPage.querySelector("[data-active-result-score]").textContent =
            `${activeResult.score} / 24`;
        const cutoff = resultPage.querySelector("[data-active-result-cutoff]");
        cutoff.dataset.activeResultCutoff = activeResult.isAtOrAboveCutoff
            ? "at-or-above-13"
            : "below-13";
        resultPage.querySelector("[data-active-result-status]").textContent =
            content.status;
        resultPage.querySelector(
            "[data-active-result-interpretation]",
        ).textContent = content.interpretation;
        resultPage.querySelector("[data-active-result-higher-score]").textContent =
            content.higherScoreExplanation;
        resultPage.querySelector("[data-active-result-guidance]").textContent =
            content.guidance;
        const resourceList = resultPage.querySelector(
            "[data-active-result-resources]",
        );
        for (const resource of content.resources) {
            const item = document.createElement("li");
            const link = document.createElement("a");
            link.href = resource.url;
            link.textContent = resource.label;
            item.append(link);
            resourceList.append(item);
        }
        pageShell.replaceChildren(resultPage);
        document.title = "Result | K6-Based Psychological Distress Check";
    };

    resetQuestionnaire();

    form.addEventListener("change", (event) => {
        if (
            event.target.matches('input[type="radio"]') &&
            steps[currentStep].contains(event.target)
        ) {
            updateForwardButtonState();
        }
    });

    form.addEventListener("click", (event) => {
        const helperButton = event.target.closest("[data-question-helper]");

        if (helperButton && steps[currentStep].contains(helperButton)) {
            const helperCopy = document.getElementById(
                helperButton.getAttribute("aria-controls"),
            );

            helperButton.setAttribute("aria-expanded", "true");
            helperCopy.hidden = false;
            return;
        }

        const nextButton = event.target.closest("[data-questionnaire-next]");
        const backButton = event.target.closest("[data-questionnaire-back]");

        if (!nextButton && !backButton) {
            return;
        }

        if (nextButton) {
            showStep(Math.min(currentStep + 1, steps.length - 1));
        } else {
            showStep(Math.max(currentStep - 1, 0));
        }
    });

    form.addEventListener("submit", (event) => {
        event.preventDefault();

        if (isSubmissionComplete) {
            return;
        }

        const responses = steps.map((step) => {
            const selectedResponse = step.querySelector(
                'input[type="radio"]:checked',
            );
            return selectedResponse ? Number(selectedResponse.value) : null;
        });

        if (responses.some((response) => response === null)) {
            return;
        }

        const score = window.K6Scoring.calculateK6Score(responses);
        isSubmissionComplete = true;
        activeResult = Object.freeze({
            score: score.total,
            isAtOrAboveCutoff:
                score.isAtOrAboveSeriousElevatedDistressThreshold,
        });
        form.reset();
        const timestamp = Date.now();
        try {
            window.AssessmentHistory.saveResult({
                score: activeResult.score,
                timestamp,
            });
        } catch {
            // The completed result remains available when history storage fails.
        }
        showActiveResult();
        history.pushState(null, "", "/result");
    });

    pageShell.addEventListener("click", (event) => {
        const retakeLink = event.target.closest("[data-take-test-again]");

        if (!retakeLink) {
            return;
        }

        event.preventDefault();
        showFreshQuestionnaire();
        history.pushState(null, "", "/test");
    });

    window.addEventListener("popstate", () => {
        if (location.pathname === "/test") {
            showFreshQuestionnaire();
            return;
        }

        if (location.pathname === "/result" && activeResult) {
            showActiveResult();
            return;
        }

        activeResult = null;
        location.replace("/");
    });

    window.addEventListener("pagehide", () => {
        activeResult = null;
        form.reset();
    });

    window.addEventListener("pageshow", () => {
        if (location.pathname === "/result" && !activeResult) {
            location.replace("/");
        }
    });
}
