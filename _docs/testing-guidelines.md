# Testing guidelines

Run the Django suite with:

```powershell
.\.venv\Scripts\python.exe manage.py test
```

The browser-side scoring contract uses Node.js's built-in test runner and does
not require Edge or an installed JavaScript package. Run it directly with:

```powershell
node --test .\assessments\k6_scoring_tests.js
```

The scoring tests also run through the Django `assessments` test suite.

The browser-side Result-content contract also uses Node.js's built-in test
runner and performs no network requests. Run it directly with:

```powershell
node --test .\assessments\result_content_tests.js
```

These tests also run through the Django `assessments` test suite.

The browser-side assessment-history contract uses Node.js's built-in test runner
with an application-owned fake storage port. The frozen boundary exposes
`getResults`, `saveResult`, and `clearResults` in that order. `clearResults()`
removes only `k6-based-distress-check.history.v1`, verifies the key is absent,
and returns exactly `{ ok: true }`; removal or verification failure returns
exactly `{ ok: false, reason: "storage-unavailable" }`. The tests do not mock
browser Storage types and perform no network requests. Run them directly with:

```powershell
node --test .\assessments\assessment_history_tests.js
```

These tests also run through the Django `assessments` test suite.

The questionnaire interaction test starts Django's static live server and drives
headless Microsoft Edge at a 320 px viewport through the browser's DevTools
protocol. It uses the installed Edge executable and Node.js runtime directly, so
it adds no Python or JavaScript package dependency. The test is skipped with an
explicit reason when either runtime is unavailable.

Run that focused browser test with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests -v 2
```

The same browser-test class includes a focused assessment-history scenario that
uses real same-origin `localStorage`, reloads the page to prove persistence, and
checks that verified clearing removes only the exact history key while preserving
an unrelated key and causing no post-load network request. Run only that scenario
with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_assessment_history_uses_real_same_origin_local_storage -v 2
```

The History availability and presentation scenario uses real same-origin
`localStorage` for empty, populated, and cleared states; injects read and clear
failures only at the application-owned history boundary; and fixes the browser
timezone through CDP before checking local date/time output. It also verifies the
immediate successful empty-state transition and the failed-clear unavailable-state
transition. Run it with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_history_availability_executes_in_a_real_browser -v 2
```

The shared visual-foundation scenario drives genuine Microsoft Edge through CDP
and measures Home, questionnaire, rendered Result, and empty/populated/unavailable
History states at 320x900, 375x900, and 768x1024. It verifies computed tokens,
shell geometry, typography, shared control states and target sizes, wrapping,
motion, local-only requests, and horizontal containment. It writes review
screenshots to the system temporary directory under
`k6-issue20-visual-foundation`. Run it with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_shared_visual_foundation_executes_in_a_real_browser -v 2
```

The focused Questionnaire and Result visual scenario uses the same genuine
Edge/CDP live-server boundary at 320x900, 375x900, and 768x1024. Computed-style
and bounding-box assertions protect progress, response cards and radios,
keyboard focus, navigation states, Result score/cutoff parity, content rhythm,
resource containment, motion, routing regressions, and local-only behavior.
Non-golden screenshots for human review are written under the system temporary
directory `k6-issue21-questionnaire-result-visuals`; they are evidence rather
than pixel-diff fixtures. Run the scenario with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_questionnaire_and_result_visuals_execute_in_a_real_browser -v 2
```

The History and cross-route visual scenario drives the genuine Edge/CDP
live-server boundary at 320x900, 375x900, and 768x1024. It checks the exact
History panel, SVG line/point, two-column row, Clear action, mutual-exclusion,
motion, privacy, and document-scroll contracts for unavailable, empty, one,
three, twenty, and both post-clear states. The same run audits the shared shell
on Home, selected/helper/control Questionnaire states, and 12- and 13-point
Results. It fixes the browser timezone through CDP and injects failures only at
the application-owned history boundary. Non-golden cross-route screenshots are
written under the system temporary directory
`k6-issue22-history-cross-route-visuals`; they are review evidence, not
pixel-diff fixtures. Run it with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_history_and_cross_route_visuals_execute_in_a_real_browser -v 2
```

The exact 24-shot review matrix is:

- Home: `home-available-320.png`, `home-available-375.png`, and
  `home-available-768.png`.
- Questionnaire: `questionnaire-selected-320.png`,
  `questionnaire-question-6-controls-375.png`, and
  `questionnaire-helper-768.png`.
- Result: `result-12-320.png`, `result-13-375.png`, and
  `result-one-record-768.png`.
- Empty History: `history-empty-320.png` and `history-empty-375.png`.
- One-result History: `history-one-320.png` and `history-one-768.png`.
- Three-result History: `history-three-320.png`,
  `history-three-375.png`, and `history-three-768.png`.
- Unavailable History: `history-unavailable-320.png` and
  `history-unavailable-375.png`.
- Post-clear History: `history-post-clear-success-320.png` and
  `history-post-clear-failure-320.png`.
- Twenty-result History top: `history-20-top-320.png` and
  `history-20-top-768.png`.
- Twenty-result History bottom: `history-20-bottom-320.png` and
  `history-20-bottom-768.png`.

Review top captures for full-width chart containment and the start of the
newest-first list. Review bottom captures for an intact final row, visible Clear
All History action, shell bottom spacing, document-only scrolling, and no
horizontal or component overflow. The automated scenario additionally checks
the same bottom reachability and focus-outline containment at 375px without
adding a twenty-fifth screenshot.

The primary assessment journey scenario uses one fresh temporary genuine Edge
profile and real same-origin storage. It fixes the browser timezone to
`America/New_York`, starts from Home, activates visible controls to answer all
six questions, checks the 14-point Result and resources, and observes the one
canonical saved record. It then follows the realistic browser-history path
Result → Back → fresh Test → Back → Home, activates View History, checks the
one-record chart/list with independently formatted local date and time, returns
Back to Home, and begins a second fresh assessment without saving another
record. It neither replaces application/browser boundaries nor visits external
resource destinations. Run it with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_primary_assessment_journey_executes_in_a_real_browser -v 2
```

The questionnaire edge-case journey complements the unchanged detailed
questionnaire interaction scenario and the primary straight-through journey.
In a fresh genuine Edge profile at 320x900, it protects disabled pointer,
`click()`, and `requestSubmit()` guards; progress and navigation; non-advancing
response selection; focused-but-unchecked radio state before Space; Question 3
helper reset; and answer retention across Back and Next. The journey changes
Question 1 from 1 to 4, retains responses
2, 2, 0, and 3 for Questions 2–5, then answers Question 6 with 4 using the
keyboard. It submits with Enter and verifies the exact 15 / 24 result, one
canonical score/timestamp record, the exact initial navigation/browser/static
request allowlist with zero later requests, and no answer or additional-storage
leakage. Run it with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_questionnaire_edge_cases_execute_in_a_real_browser -v 2
```
