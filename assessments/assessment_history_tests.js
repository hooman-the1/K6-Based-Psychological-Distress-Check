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
        this.removeResult = null;
        this.useReadResult = false;
        this.useRemoveResult = false;
        this.readError = null;
        this.writeError = null;
        this.removeError = null;
        this.removals = [];
        this.removeLeavesValue = false;
    }

    read(key) {
        this.reads.push(key);
        if (this.readError) {
            throw this.readError;
        }
        if (this.useReadResult) {
            return this.readResult;
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

    remove(key) {
        this.removals.push(key);
        if (this.removeError) {
            throw this.removeError;
        }
        if (this.useRemoveResult || this.removeResult) {
            return this.removeResult;
        }
        if (!this.removeLeavesValue && key === storageKey) {
            this.value = null;
        }
        return { ok: true };
    }
}

const createHistory = (storedValue = null) => {
    const port = new FakeHistoryStoragePort(storedValue);
    return { history: createAssessmentHistory(port), port };
};

const createResults = (count, firstTimestamp = 1000) =>
    Array.from({ length: count }, (_, index) => ({
        score: index % 25,
        timestamp: firstTimestamp + index,
    }));

describe("AssessmentHistory", () => {
    test("exposes exactly the three ordered non-throwing result-object operations", () => {
        const { history } = createHistory();

        assert.deepEqual(Object.keys(history), [
            "getResults",
            "saveResult",
            "clearResults",
        ]);
        assert.deepEqual(history.getResults(), { ok: true, results: [] });
        assert.deepEqual(history.saveResult({ score: 0, timestamp: 0 }), {
            ok: true,
        });
        assert.equal(history.clearResults.length, 0);
        let clearResult;
        assert.doesNotThrow(() => {
            clearResult = history.clearResults();
        });
        assert.deepEqual(clearResult, { ok: true });
    });

    test("clears populated, absent, and malformed history by removing only the exact key", () => {
        for (const storedValue of [
            '[{"score":12,"timestamp":1000}]',
            null,
            "malformed history",
        ]) {
            const { history, port } = createHistory(storedValue);
            assert.deepEqual(history.clearResults(), { ok: true });
            assert.deepEqual(port.removals, [storageKey]);
            assert.deepEqual(port.reads, [storageKey]);
            assert.deepEqual(port.writes, []);
            assert.equal(port.value, null);
            assert.deepEqual(history.getResults(), { ok: true, results: [] });
        }
    });

    test("maps failed or throwing removal to unavailable without verification or retry", () => {
        const unavailable = { ok: false, reason: "storage-unavailable" };

        for (const failure of [
            { useRemoveResult: true, removeResult: unavailable },
            {
                useRemoveResult: true,
                removeResult: { ok: false, reason: "another-failure" },
            },
            { useRemoveResult: true, removeResult: undefined },
            { removeMissing: true },
            { removeError: new Error("remove denied") },
        ]) {
            const port = new FakeHistoryStoragePort("stored history");
            Object.assign(port, failure);
            if (failure.removeMissing) {
                port.remove = undefined;
            }
            const history = createAssessmentHistory(port);

            let clearResult;
            assert.doesNotThrow(() => {
                clearResult = history.clearResults();
            });
            assert.deepEqual(clearResult, unavailable);
            assert.deepEqual(
                port.removals,
                failure.removeMissing ? [] : [storageKey],
            );
            assert.deepEqual(port.reads, []);
            assert.deepEqual(port.writes, []);
            assert.equal(port.value, "stored history");
        }
    });

    test("requires one successful absent-key verification after removal", () => {
        const unavailable = { ok: false, reason: "storage-unavailable" };
        const verificationFailures = [
            { useReadResult: true, readResult: unavailable },
            {
                useReadResult: true,
                readResult: { ok: false, reason: "another-failure" },
            },
            { useReadResult: true, readResult: undefined },
            {
                useReadResult: true,
                readResult: { ok: true, value: "history remains" },
            },
            { readError: new Error("verification denied") },
            { removeLeavesValue: true },
        ];

        for (const failure of verificationFailures) {
            const port = new FakeHistoryStoragePort("history remains");
            Object.assign(port, failure);
            const history = createAssessmentHistory(port);

            let clearResult;
            assert.doesNotThrow(() => {
                clearResult = history.clearResults();
            });
            assert.deepEqual(clearResult, unavailable);
            assert.deepEqual(port.removals, [storageKey]);
            assert.deepEqual(port.reads, [storageKey]);
            assert.deepEqual(port.writes, []);
        }
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

    test("grows histories through the exact 19-to-20 boundary without eviction", () => {
        for (let storedCount = 0; storedCount <= 19; storedCount += 1) {
            const storedResults = createResults(storedCount);
            const storedValue = storedCount === 0 ? null : JSON.stringify(storedResults);
            const { history, port } = createHistory(storedValue);
            const newResult = {
                score: 24,
                timestamp: 2000 + storedCount,
            };

            assert.deepEqual(history.saveResult(newResult), { ok: true });
            assert.deepEqual(JSON.parse(port.value), [...storedResults, newResult]);
            assert.equal(JSON.parse(port.value).length, storedCount + 1);
        }
    });

    test("evicts the chronologically oldest candidate when a full history is saved", () => {
        const storedResults = createResults(20);
        const { history, port } = createHistory(JSON.stringify(storedResults));
        const newestResult = { score: 20, timestamp: 3000 };

        assert.deepEqual(history.saveResult(newestResult), { ok: true });
        assert.equal(
            port.value,
            JSON.stringify([...storedResults.slice(1), newestResult]),
        );
        assert.deepEqual(history.getResults(), {
            ok: true,
            results: [...storedResults.slice(1), newestResult],
        });
    });

    test("orders out-of-order saves and immediately evicts an older new candidate", () => {
        const initialResults = [
            { score: 6, timestamp: 6000 },
            { score: 2, timestamp: 2000 },
            { score: 4, timestamp: 4000 },
        ];
        const { history, port } = createHistory(JSON.stringify(initialResults));

        assert.deepEqual(history.saveResult({ score: 3, timestamp: 3000 }), {
            ok: true,
        });
        assert.equal(
            port.value,
            '[{"score":2,"timestamp":2000},{"score":3,"timestamp":3000},{"score":4,"timestamp":4000},{"score":6,"timestamp":6000}]',
        );

        const fullResults = createResults(20, 10000);
        const fullHistory = createHistory(JSON.stringify(fullResults));
        assert.deepEqual(
            fullHistory.history.saveResult({ score: 24, timestamp: 1 }),
            { ok: true },
        );
        assert.equal(fullHistory.port.value, JSON.stringify(fullResults));
        assert.equal(fullHistory.port.writes.length, 1);
    });

    test("uses insertion order to retain later equal-timestamp cutoff candidates", () => {
        const cutoffTies = [
            { score: 1, timestamp: 1000 },
            { score: 2, timestamp: 1000 },
            { score: 3, timestamp: 1000 },
        ];
        const newerResults = createResults(17, 2000);
        const { history, port } = createHistory(
            JSON.stringify([...cutoffTies, ...newerResults]),
        );
        const newTie = { score: 4, timestamp: 1000 };

        assert.deepEqual(history.saveResult(newTie), { ok: true });
        assert.deepEqual(JSON.parse(port.value), [
            cutoffTies[1],
            cutoffTies[2],
            newTie,
            ...newerResults,
        ]);
    });

    test("retains identical and same-calendar-date results as distinct records", () => {
        const sameDayMorning = { score: 12, timestamp: 1788652800000 };
        const identicalLater = { score: 12, timestamp: 1788696000000 };
        const { history, port } = createHistory(JSON.stringify([sameDayMorning]));

        assert.deepEqual(history.saveResult(identicalLater), { ok: true });
        assert.deepEqual(history.saveResult(identicalLater), { ok: true });
        assert.deepEqual(JSON.parse(port.value), [
            sameDayMorning,
            identicalLater,
            identicalLater,
        ]);
    });

    test("reads oversized valid histories without mutation and compacts on save", () => {
        const persistedResults = createResults(21).reverse();
        const storedValue = JSON.stringify(persistedResults);
        const { history, port } = createHistory(storedValue);
        const expectedRead = createResults(21).slice(1);

        assert.deepEqual(history.getResults(), {
            ok: true,
            results: expectedRead,
        });
        assert.equal(port.value, storedValue);
        assert.deepEqual(port.writes, []);

        const newestResult = { score: 21, timestamp: 3000 };
        assert.deepEqual(history.saveResult(newestResult), { ok: true });
        assert.equal(
            port.value,
            JSON.stringify([...createResults(21).slice(2), newestResult]),
        );
        assert.equal(JSON.parse(port.value).length, 20);
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
            assert.deepEqual(history.clearResults(), { ok: true });
            assert.equal(port.value, null);
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
