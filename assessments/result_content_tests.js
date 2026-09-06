"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { calculateK6Score } = require("./static/assessments/k6-scoring.js");
const { getResultContent } = require("./static/assessments/result-content.js");

const higherScoreExplanation =
    "Higher scores indicate greater psychological distress.";
const guidance =
    "Take a moment to reflect on how you have been feeling. If you are concerned about your mental health or it is affecting your daily life, consider talking with a qualified healthcare professional. You can also explore the resources below for information and practical coping ideas.";
const resources = [
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

const responsesForTotal = (total) => {
    const responses = Array(6).fill(0);
    let remaining = total;

    for (let index = 0; index < responses.length; index += 1) {
        responses[index] = Math.min(remaining, 4);
        remaining -= responses[index];
    }

    return responses;
};

const contentForScore = (score) => {
    const classification = calculateK6Score(responsesForTotal(score));
    return getResultContent(
        classification.isAtOrAboveSeriousElevatedDistressThreshold,
    );
};

describe("getResultContent", () => {
    test("returns the exact cutoff status and interpretation at 12 and 13", () => {
        assert.equal(contentForScore(12).status, "Below the cutoff");
        assert.equal(
            contentForScore(12).interpretation,
            "Your score is below the serious or elevated psychological distress cutoff of 13.",
        );
        assert.equal(contentForScore(13).status, "At or above the cutoff");
        assert.equal(
            contentForScore(13).interpretation,
            "Your score is at or above the serious or elevated psychological distress cutoff of 13.",
        );
    });

    test("returns the exact shared explanation and guidance for both classifications", () => {
        for (const score of [12, 13]) {
            const content = contentForScore(score);

            assert.equal(content.higherScoreExplanation, higherScoreExplanation);
            assert.equal(content.guidance, guidance);
        }
    });

    test("returns exactly the four approved resources in order", () => {
        for (const score of [12, 13]) {
            assert.deepEqual(contentForScore(score).resources, resources);
        }
    });

    test("has non-empty labels and unique safe absolute HTTPS resource URLs", () => {
        const seenUrls = new Set();

        for (const resource of contentForScore(12).resources) {
            assert.notEqual(resource.label.trim(), "");

            const parsedUrl = new URL(resource.url);
            assert.equal(parsedUrl.protocol, "https:");
            assert.equal(parsedUrl.username, "");
            assert.equal(parsedUrl.password, "");
            assert.equal(parsedUrl.search, "");
            assert.equal(parsedUrl.hash, "");
            assert.equal(seenUrls.has(parsedUrl.href), false);
            seenUrls.add(parsedUrl.href);
        }
    });

    test("varies only status and interpretation across all valid scores", () => {
        const sharedFieldNames = [
            "higherScoreExplanation",
            "guidance",
            "resources",
        ];
        const belowCutoff = contentForScore(0);
        const atOrAboveCutoff = contentForScore(13);

        assert.deepEqual(Object.keys(belowCutoff), [
            "status",
            "interpretation",
            ...sharedFieldNames,
        ]);
        assert.deepEqual(Object.keys(atOrAboveCutoff), Object.keys(belowCutoff));
        for (let score = 0; score <= 24; score += 1) {
            const content = contentForScore(score);
            const expectedVariant = score < 13 ? belowCutoff : atOrAboveCutoff;

            assert.equal(content.status, expectedVariant.status);
            assert.equal(content.interpretation, expectedVariant.interpretation);
            for (const fieldName of sharedFieldNames) {
                assert.strictEqual(content[fieldName], belowCutoff[fieldName]);
            }
        }
    });

    test("exposes deeply immutable content without browser or network access", () => {
        const forbiddenGlobals = ["document", "fetch", "XMLHttpRequest"];
        const originalDescriptors = new Map();

        for (const name of forbiddenGlobals) {
            originalDescriptors.set(
                name,
                Object.getOwnPropertyDescriptor(globalThis, name),
            );
            Object.defineProperty(globalThis, name, {
                configurable: true,
                get() {
                    throw new Error(`result content accessed ${name}`);
                },
            });
        }

        try {
            const belowCutoff = contentForScore(12);
            const atOrAboveCutoff = contentForScore(13);

            for (const content of [belowCutoff, atOrAboveCutoff]) {
                assert.equal(Object.isFrozen(content), true);
                assert.equal(Object.isFrozen(content.resources), true);
                assert.equal(
                    content.resources.every((resource) =>
                        Object.isFrozen(resource),
                    ),
                    true,
                );
            }
            assert.throws(() => {
                belowCutoff.status = "Changed";
            }, TypeError);
            assert.throws(() => {
                belowCutoff.resources.push({ label: "Extra", url: "https://example.com" });
            }, TypeError);
        } finally {
            for (const [name, descriptor] of originalDescriptors) {
                if (descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    delete globalThis[name];
                }
            }
        }
    });
});
