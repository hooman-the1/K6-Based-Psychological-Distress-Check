(function exposeAssessmentHistory(globalScope) {
    "use strict";

    const storageKey = "k6-based-distress-check.history.v1";
    const maximumScore = 24;
    const maximumTimestamp = 8640000000000000;
    const maximumHistorySize = 20;
    const storageUnavailable = Object.freeze({
        ok: false,
        reason: "storage-unavailable",
    });
    const invalidStoredData = Object.freeze({
        ok: false,
        reason: "invalid-stored-data",
    });
    const invalidResult = Object.freeze({
        ok: false,
        reason: "invalid-result",
    });

    const hasValidValues = (result) =>
        Number.isInteger(result.score) &&
        result.score >= 0 &&
        result.score <= maximumScore &&
        Number.isInteger(result.timestamp) &&
        result.timestamp >= 0 &&
        result.timestamp <= maximumTimestamp;

    const copyValidResult = (result, requireCanonicalKeyOrder) => {
        try {
            if (
                result === null ||
                typeof result !== "object" ||
                Array.isArray(result)
            ) {
                return null;
            }

            const keys = Reflect.ownKeys(result);
            const hasExactKeys =
                keys.length === 2 &&
                keys.every((key) => key === "score" || key === "timestamp") &&
                keys.includes("score") &&
                keys.includes("timestamp") &&
                keys.every((key) =>
                    Object.prototype.propertyIsEnumerable.call(result, key),
                );
            const hasCanonicalKeyOrder =
                keys[0] === "score" && keys[1] === "timestamp";

            if (
                !hasExactKeys ||
                (requireCanonicalKeyOrder && !hasCanonicalKeyOrder) ||
                !hasValidValues(result)
            ) {
                return null;
            }

            return {
                score: result.score,
                timestamp: result.timestamp,
            };
        } catch {
            return null;
        }
    };

    const orderOldestFirst = (results) =>
        results
            .map((result, insertionIndex) => ({ result, insertionIndex }))
            .sort(
                (left, right) =>
                    left.result.timestamp - right.result.timestamp ||
                    left.insertionIndex - right.insertionIndex,
            )
            .map(({ result }) => ({
                score: result.score,
                timestamp: result.timestamp,
            }));

    const retainNewestResults = (results) =>
        orderOldestFirst(results).slice(-maximumHistorySize);

    const parseStoredResults = (storedValue) => {
        if (storedValue === null) {
            return { ok: true, results: [] };
        }

        let parsedValue;
        try {
            parsedValue = JSON.parse(storedValue);
        } catch {
            return invalidStoredData;
        }

        if (!Array.isArray(parsedValue)) {
            return invalidStoredData;
        }

        const results = [];
        for (const storedResult of parsedValue) {
            const result = copyValidResult(storedResult, true);
            if (result === null) {
                return invalidStoredData;
            }
            results.push(result);
        }

        return { ok: true, results: orderOldestFirst(results) };
    };

    const createAssessmentHistory = (storagePort) => {
        const readResults = () => {
            let readResult;
            try {
                readResult = storagePort.read(storageKey);
            } catch {
                return storageUnavailable;
            }

            if (!readResult || readResult.ok !== true) {
                return storageUnavailable;
            }
            return parseStoredResults(readResult.value);
        };

        const getResults = () => {
            const readResult = readResults();
            if (!readResult.ok) {
                return { ok: false, reason: readResult.reason };
            }
            const retainedResults = retainNewestResults(readResult.results);
            return {
                ok: true,
                results: retainedResults.map((result) => ({
                    score: result.score,
                    timestamp: result.timestamp,
                })),
            };
        };

        const saveResult = (result) => {
            const validResult = copyValidResult(result, false);
            if (validResult === null) {
                return { ...invalidResult };
            }

            const readResult = readResults();
            if (!readResult.ok) {
                return { ok: false, reason: readResult.reason };
            }

            const retainedResults = retainNewestResults([
                ...readResult.results,
                validResult,
            ]);
            let writeResult;
            try {
                writeResult = storagePort.write(
                    storageKey,
                    JSON.stringify(retainedResults),
                );
            } catch {
                return { ...storageUnavailable };
            }

            return writeResult && writeResult.ok === true
                ? { ok: true }
                : { ...storageUnavailable };
        };

        const clearResults = () => {
            let removeResult;
            try {
                removeResult = storagePort.remove(storageKey);
            } catch {
                return { ...storageUnavailable };
            }
            if (!removeResult || removeResult.ok !== true) {
                return { ...storageUnavailable };
            }

            let verificationResult;
            try {
                verificationResult = storagePort.read(storageKey);
            } catch {
                return { ...storageUnavailable };
            }
            return verificationResult &&
                verificationResult.ok === true &&
                verificationResult.value === null
                ? { ok: true }
                : { ...storageUnavailable };
        };

        return Object.freeze({ getResults, saveResult, clearResults });
    };

    const createBrowserStoragePort = (browserScope) => ({
        read(key) {
            try {
                const storage = browserScope.localStorage;
                if (!storage) {
                    return storageUnavailable;
                }
                return { ok: true, value: storage.getItem(key) };
            } catch {
                return storageUnavailable;
            }
        },
        write(key, value) {
            try {
                const storage = browserScope.localStorage;
                if (!storage) {
                    return storageUnavailable;
                }
                storage.setItem(key, value);
                return { ok: true };
            } catch {
                return storageUnavailable;
            }
        },
        remove(key) {
            try {
                const storage = browserScope.localStorage;
                if (!storage) {
                    return storageUnavailable;
                }
                storage.removeItem(key);
                return { ok: true };
            } catch {
                return storageUnavailable;
            }
        },
    });

    if (typeof module === "object" && module.exports) {
        module.exports = Object.freeze({ createAssessmentHistory });
    }
    if (globalScope) {
        globalScope.AssessmentHistory = createAssessmentHistory(
            createBrowserStoragePort(globalScope),
        );
    }
})(typeof window === "undefined" ? null : window);
