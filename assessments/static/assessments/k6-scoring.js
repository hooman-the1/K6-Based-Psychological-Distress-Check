(function exposeK6Scoring(globalScope) {
    "use strict";

    const responseCount = 6;
    const minimumResponse = 0;
    const maximumResponse = 4;
    const seriousElevatedDistressCutoff = 13;

    /**
     * Return the raw K6-based total and its single cutoff classification.
     * Higher totals represent greater psychological distress.
     */
    const calculateK6Score = (responses) => {
        if (!Array.isArray(responses)) {
            throw new TypeError("K6 responses must be supplied as an array");
        }
        if (responses.length !== responseCount) {
            throw new RangeError("K6 scoring requires exactly six responses");
        }

        let total = 0;
        for (const response of responses) {
            if (
                !Number.isInteger(response) ||
                response < minimumResponse ||
                response > maximumResponse
            ) {
                throw new TypeError(
                    "Each K6 response must be an integer from zero through four",
                );
            }
            total += response;
        }

        return {
            total,
            isAtOrAboveSeriousElevatedDistressThreshold:
                total >= seriousElevatedDistressCutoff,
        };
    };

    const scoringApi = Object.freeze({ calculateK6Score });

    if (typeof module === "object" && module.exports) {
        module.exports = scoringApi;
    }
    if (globalScope) {
        globalScope.K6Scoring = scoringApi;
    }
})(typeof window === "undefined" ? null : window);
