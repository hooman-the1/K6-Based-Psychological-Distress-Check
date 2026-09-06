(function exposeResultContent(globalScope) {
    "use strict";

    const resources = Object.freeze(
        [
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
        ].map(Object.freeze),
    );
    const sharedContent = {
        higherScoreExplanation:
            "Higher scores indicate greater psychological distress.",
        guidance:
            "Take a moment to reflect on how you have been feeling. If you are concerned about your mental health or it is affecting your daily life, consider talking with a qualified healthcare professional. You can also explore the resources below for information and practical coping ideas.",
        resources,
    };
    const belowCutoffContent = Object.freeze({
        status: "Below the cutoff",
        interpretation:
            "Your score is below the serious or elevated psychological distress cutoff of 13.",
        ...sharedContent,
    });
    const atOrAboveCutoffContent = Object.freeze({
        status: "At or above the cutoff",
        interpretation:
            "Your score is at or above the serious or elevated psychological distress cutoff of 13.",
        ...sharedContent,
    });

    const getResultContent = (isAtOrAboveCutoff) => {
        if (typeof isAtOrAboveCutoff !== "boolean") {
            throw new TypeError("Result cutoff classification must be a boolean");
        }

        return isAtOrAboveCutoff
            ? atOrAboveCutoffContent
            : belowCutoffContent;
    };

    const resultContentApi = Object.freeze({ getResultContent });

    if (typeof module === "object" && module.exports) {
        module.exports = resultContentApi;
    }
    if (globalScope) {
        globalScope.ResultContent = resultContentApi;
    }
})(typeof window === "undefined" ? null : window);
