"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
    createAssessmentHistory,
} = require("./static/assessments/assessment-history.js");

const storageKey = "k6-based-distress-check.history.v1";

class FakeHistoryStoragePort {
    constructor(value = null) {
        this.value = value;
        this.reads = [];
        this.writes = [];
        this.readResult = null;
        this.writeResult = null;
        this.readError = null;
        this.writeError = null;
    }

    read(key) {
        this.reads.push(key);
        if (this.readError) {
            throw this.readError;
        }
        return this.readResult ?? { ok: true, value: this.value };
    }

    write(key, value) {
        this.writes.push({ key, value });
        if (this.writeError) {
            throw this.writeError;
        }
        if (this.writeResult) {
            return this.writeResult;
        }
        this.value = value;
        return { ok: true };
    }
}

const createHistory = (storedValue = null) => {
    const port = new FakeHistoryStoragePort(storedValue);
    return { history: createAssessmentHistory(port), port };
};

describe("AssessmentHistory", () => {
    test("exposes only the two non-throwing result-object operations", () => {
        const { history } = createHistory();

        assert.deepEqual(Object.keys(history), ["getResults", "saveResult"]);
        assert.deepEqual(history.getResults(), { ok: true, results: [] });
        assert.deepEqual(history.saveResult({ score: 0, timestamp: 0 }), {
            ok: true,
        });
    });

    test("uses the one exact key and writes canonical compact JSON", () => {
        const { history, port } = createHistory();

        assert.deepEqual(
            history.saveResult({ score: 12, timestamp: 1788710400000 }),
            { ok: true },
        );
        assert.deepEqual(port.reads, [storageKey]);
        assert.deepEqual(port.writes, [
            {
                key: storageKey,
                value: '[{"score":12,"timestamp":1788710400000}]',
            },
        ]);
    });

    test("accepts only exact score and epoch-millisecond result objects", () => {
        for (const result of [
            { score: 0, timestamp: 0 },
            { score: 24, timestamp: 8640000000000000 },
        ]) {
            const { history } = createHistory();
            assert.deepEqual(history.saveResult(result), { ok: true });
        }

        const symbolField = Symbol("answers");
        const withEnumerableSymbol = { score: 12, timestamp: 1000 };
        withEnumerableSymbol[symbolField] = [1, 2, 3, 4, 1, 1];
        const withHiddenExtraField = { score: 12, timestamp: 1000 };
        Object.defineProperty(withHiddenExtraField, "answers", { value: [] });
        const invalidResults = [
            null,
            undefined,
            [],
            12,
            "result",
            { score: 12 },
            { timestamp: 1000 },
            { score: 12, timestamp: 1000, answers: [] },
            withEnumerableSymbol,
            withHiddenExtraField,
            { score: -1, timestamp: 1000 },
            { score: 25, timestamp: 1000 },
            { score: 1.5, timestamp: 1000 },
            { score: "12", timestamp: 1000 },
            { score: true, timestamp: 1000 },
            { score: Number.NaN, timestamp: 1000 },
            { score: Number.POSITIVE_INFINITY, timestamp: 1000 },
            { score: 12, timestamp: -1 },
            { score: 12, timestamp: 8640000000000001 },
            { score: 12, timestamp: 1.5 },
            { score: 12, timestamp: "1000" },
            { score: 12, timestamp: false },
            { score: 12, timestamp: Number.NaN },
            { score: 12, timestamp: Number.NEGATIVE_INFINITY },
        ];

        for (const result of invalidResults) {
            const { history, port } = createHistory();
            assert.deepEqual(history.saveResult(result), {
                ok: false,
                reason: "invalid-result",
            });
            assert.deepEqual(port.reads, []);
            assert.deepEqual(port.writes, []);
        }

        const throwingResult = {};
        Object.defineProperties(throwingResult, {
            score: {
                enumerable: true,
                get() {
                    throw new Error("score unavailable");
                },
            },
            timestamp: { enumerable: true, value: 1000 },
        });
        const { history, port } = createHistory();
        assert.doesNotThrow(() => history.saveResult(throwingResult));
        assert.deepEqual(history.saveResult(throwingResult), {
            ok: false,
            reason: "invalid-result",
        });
        assert.deepEqual(port.reads, []);
        assert.deepEqual(port.writes, []);
    });

    test("creates an empty history and appends every valid result without deduplication", () => {
        const { history, port } = createHistory();

        assert.deepEqual(history.getResults(), { ok: true, results: [] });
        assert.deepEqual(history.saveResult({ score: 3, timestamp: 1000 }), {
            ok: true,
        });
        assert.deepEqual(history.saveResult({ score: 4, timestamp: 1000 }), {
            ok: true,
        });
        assert.deepEqual(history.saveResult({ score: 3, timestamp: 1000 }), {
            ok: true,
        });
        assert.equal(
            port.value,
            '[{"score":3,"timestamp":1000},{"score":4,"timestamp":1000},{"score":3,"timestamp":1000}]',
        );
    });

    test("returns fresh plain records oldest-first and keeps insertion order on ties", () => {
        const storedValue =
            '[{"score":20,"timestamp":3000},{"score":8,"timestamp":1000},{"score":9,"timestamp":1000},{"score":10,"timestamp":2000}]';
        const { history, port } = createHistory(storedValue);

        const firstRead = history.getResults();
        const secondRead = history.getResults();
        const expectedResults = [
            { score: 8, timestamp: 1000 },
            { score: 9, timestamp: 1000 },
            { score: 10, timestamp: 2000 },
            { score: 20, timestamp: 3000 },
        ];
        assert.deepEqual(firstRead, { ok: true, results: expectedResults });
        assert.deepEqual(secondRead, { ok: true, results: expectedResults });
        assert.notStrictEqual(firstRead.results, secondRead.results);
        for (let index = 0; index < firstRead.results.length; index += 1) {
            assert.equal(Object.getPrototypeOf(firstRead.results[index]), Object.prototype);
            assert.deepEqual(Object.keys(firstRead.results[index]), ["score", "timestamp"]);
            assert.notStrictEqual(firstRead.results[index], secondRead.results[index]);
        }
        assert.deepEqual(port.writes, []);
        assert.equal(port.value, storedValue);

        assert.deepEqual(history.saveResult({ score: 5, timestamp: 1000 }), {
            ok: true,
        });
        assert.equal(
            port.value,
            '[{"score":8,"timestamp":1000},{"score":9,"timestamp":1000},{"score":5,"timestamp":1000},{"score":10,"timestamp":2000},{"score":20,"timestamp":3000}]',
        );
    });

    test("rejects all malformed stored data without salvage or overwrite", () => {
        const invalidStoredValues = [
            "not-json",
            "null",
            "{}",
            '"history"',
            "12",
            "[null]",
            "[[]]",
            '[{"score":12}]',
            '[{"timestamp":1000}]',
            '[{"timestamp":1000,"score":12}]',
            '[{"score":12,"timestamp":1000,"answers":[]}]',
            '[{"score":-1,"timestamp":1000}]',
            '[{"score":25,"timestamp":1000}]',
            '[{"score":1.5,"timestamp":1000}]',
            '[{"score":"12","timestamp":1000}]',
            '[{"score":12,"timestamp":-1}]',
            '[{"score":12,"timestamp":8640000000000001}]',
            '[{"score":12,"timestamp":1.5}]',
            '[{"score":12,"timestamp":"1000"}]',
            '[{"score":12,"timestamp":1000},{"score":30,"timestamp":2000}]',
        ];

        for (const storedValue of invalidStoredValues) {
            for (const operation of ["getResults", "saveResult"]) {
                const { history, port } = createHistory(storedValue);
                const result =
                    operation === "getResults"
                        ? history.getResults()
                        : history.saveResult({ score: 4, timestamp: 2000 });
                assert.deepEqual(result, {
                    ok: false,
                    reason: "invalid-stored-data",
                });
                assert.equal(port.value, storedValue);
                assert.deepEqual(port.writes, []);
            }
        }
    });

    test("maps unavailable, denied, full, and throwing storage to one explicit failure", () => {
        const unavailable = { ok: false, reason: "storage-unavailable" };

        for (const operation of ["getResults", "saveResult"]) {
            const port = new FakeHistoryStoragePort();
            port.readResult = unavailable;
            const history = createAssessmentHistory(port);
            assert.deepEqual(
                operation === "getResults"
                    ? history.getResults()
                    : history.saveResult({ score: 12, timestamp: 1000 }),
                unavailable,
            );
            assert.deepEqual(port.writes, []);
        }

        const fullPort = new FakeHistoryStoragePort();
        fullPort.writeResult = unavailable;
        assert.deepEqual(
            createAssessmentHistory(fullPort).saveResult({ score: 12, timestamp: 1000 }),
            unavailable,
        );

        for (const failurePoint of ["readError", "writeError"]) {
            const port = new FakeHistoryStoragePort();
            port[failurePoint] = new Error("platform storage denied");
            const history = createAssessmentHistory(port);
            const operation = failurePoint === "readError" ? "getResults" : "saveResult";
            assert.doesNotThrow(() =>
                operation === "getResults"
                    ? history.getResults()
                    : history.saveResult({ score: 12, timestamp: 1000 }),
            );
            assert.deepEqual(
                operation === "getResults"
                    ? history.getResults()
                    : history.saveResult({ score: 12, timestamp: 1000 }),
                unavailable,
            );
        }
    });

    test("persists no answers, metadata, or data through any other browser boundary", () => {
        const forbiddenGlobals = [
            "document",
            "localStorage",
            "sessionStorage",
            "indexedDB",
            "caches",
            "history",
            "fetch",
            "XMLHttpRequest",
            "navigator",
        ];
        const originalDescriptors = new Map();

        for (const name of forbiddenGlobals) {
            originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            Object.defineProperty(globalThis, name, {
                configurable: true,
                get() {
                    throw new Error(`history contract accessed ${name}`);
                },
            });
        }

        try {
            const { history, port } = createHistory();
            const source = {
                score: 12,
                timestamp: 1788710400000,
            };
            assert.deepEqual(history.saveResult(source), { ok: true });
            assert.equal(
                port.value,
                '[{"score":12,"timestamp":1788710400000}]',
            );
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
