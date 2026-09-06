"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const { calculateK6Score } = require("./static/assessments/k6-scoring.js");

const responsesForTotal = (total) => {
    const responses = Array(6).fill(0);
    let remaining = total;

    for (let index = 0; index < responses.length; index += 1) {
        responses[index] = Math.min(remaining, 4);
        remaining -= responses[index];
    }

    return responses;
};

describe("calculateK6Score", () => {
    test("reports the required raw totals and single cutoff classification", () => {
        const examples = [
            {
                responses: [0, 0, 0, 0, 0, 0],
                expected: {
                    total: 0,
                    isAtOrAboveSeriousElevatedDistressThreshold: false,
                },
            },
            {
                responses: [2, 2, 2, 2, 2, 2],
                expected: {
                    total: 12,
                    isAtOrAboveSeriousElevatedDistressThreshold: false,
                },
            },
            {
                responses: [3, 2, 2, 2, 2, 2],
                expected: {
                    total: 13,
                    isAtOrAboveSeriousElevatedDistressThreshold: true,
                },
            },
            {
                responses: [4, 4, 4, 4, 4, 4],
                expected: {
                    total: 24,
                    isAtOrAboveSeriousElevatedDistressThreshold: true,
                },
            },
        ];

        for (const { responses, expected } of examples) {
            assert.deepEqual(calculateK6Score(responses), expected);
        }
    });

    test("uses 13 as the only inclusive cutoff for every possible total", () => {
        for (let total = 0; total <= 24; total += 1) {
            assert.deepEqual(calculateK6Score(responsesForTotal(total)), {
                total,
                isAtOrAboveSeriousElevatedDistressThreshold: total >= 13,
            });
        }
    });

    test("rejects incomplete, excessive, and non-collection inputs", () => {
        const invalidCollections = [
            [],
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0],
            null,
            undefined,
            0,
            "000000",
            { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, length: 6 },
        ];

        for (const invalidCollection of invalidCollections) {
            assert.throws(() => calculateK6Score(invalidCollection));
        }
    });

    test("rejects values that are not exact integers from zero through four", () => {
        const invalidValues = [
            -1,
            5,
            1.5,
            "0",
            true,
            false,
            null,
            undefined,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            {},
            [],
        ];

        for (const invalidValue of invalidValues) {
            assert.throws(() =>
                calculateK6Score([0, 1, invalidValue, 2, 3, 4]),
            );
        }
        assert.throws(() => calculateK6Score(new Array(6)));
    });

    test("is deterministic and preserves the caller's collection", () => {
        const responses = Object.freeze([4, 0, 3, 1, 2, 4]);
        const originalResponses = [...responses];

        const firstResult = calculateK6Score(responses);
        const secondResult = calculateK6Score(responses);

        assert.deepEqual(firstResult, secondResult);
        assert.deepEqual(responses, originalResponses);
    });

    test("scores without accessing browser state or network boundaries", () => {
        const forbiddenGlobals = [
            "document",
            "localStorage",
            "sessionStorage",
            "history",
            "fetch",
        ];
        const originalDescriptors = new Map();

        for (const name of forbiddenGlobals) {
            originalDescriptors.set(
                name,
                Object.getOwnPropertyDescriptor(globalThis, name),
            );
            Object.defineProperty(globalThis, name, {
                configurable: true,
                get() {
                    throw new Error(`scoring accessed ${name}`);
                },
            });
        }

        try {
            assert.deepEqual(calculateK6Score([0, 1, 2, 3, 4, 0]), {
                total: 10,
                isAtOrAboveSeriousElevatedDistressThreshold: false,
            });
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
