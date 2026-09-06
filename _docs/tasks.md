## 1. Set up an empty project with a passing test
Goal: Establish a runnable Django project and frontend app with one passing smoke test.
Description: Create the minimal project structure, dependency manifest, test runner configuration, and local development commands. Prove the application loads with a smoke test, without adding assessment behavior, backend persistence, authentication, or database models.

## 2. Add the four page routes and shared page shell
Goal: Make Home, Test, Result, and History reachable through `/`, `/test`, `/result`, and `/history`.
Description: Add the thinnest page views and templates needed to render each route, plus a shared mobile-first document shell and static asset entry points. Test each route at its public boundary and keep the shell free of a persistent navigation bar or footer.

## 3. Define the K6-based questionnaire content
Goal: Create one authoritative definition for the six adapted questions and the original five response options.
Description: Define plain-language question copy that retains the 30-day timeframe, optional helper text, and response values from 0 through 4. Add focused tests for question count, score values, required timeframes, and the rule that the product is described as K6-based rather than as the validated K6 instrument.

## 4. Build the Home screen
Goal: Let a user understand the product briefly and start the assessment or open History.
Description: Render only the app name, a short introduction, a Start Test CTA, and a View History CTA on `/`. Add a page-level test for the required content and verify that excluded material such as scores, detailed methodology, disclaimers, citations, privacy notices, age notices, and About content is absent.

## 5. Render one questionnaire question at a time
Goal: Present the current question, progress, response choices, and appropriate controls on `/test`.
Description: Start each visit with question 1 of 6 and render large selectable answer cards, an immediate non-animated progress update, Next, and Back only from question 2 onward. Add UI tests that prove only one question is visible and that refreshing or revisiting the route starts a fresh in-memory attempt.

## 6. Require an answer before advancing
Goal: Prevent incomplete questionnaire steps while keeping answer selection deliberate.
Description: Keep Next disabled until the current question has a selected response, show selection with a subtle border-state change, and do not advance automatically when an answer is chosen. Add interaction tests for the disabled state, selection state, and explicit Next action.

## 7. Support backward and forward questionnaire navigation
Goal: Preserve answers while the user moves between the six questions during one attempt.
Description: Implement in-memory Back and Next behavior without adding special browser Back/Forward handling or persisted drafts. Test that previous selections remain selected when revisited, question 1 has no Back control, and progress follows the displayed question.

## 8. Add optional inline question help
Goal: Explain selected questions without disrupting the one-question flow.
Description: Where helper copy exists, show a “What does this mean?” control that expands the text inline and remains open while the user stays on that question. Test that leaving and later returning to the question resets its helper text to collapsed.

## 9. Implement and test K6 scoring
Goal: Calculate a raw score from 0 to 24 and classify it against the single cutoff of 13.
Description: Add pure scoring behavior that sums six response values and reports whether the total is at or above the serious/elevated distress threshold. Test boundary and representative cases, including scores 0, 12, 13, and 24, without introducing custom mild, moderate, or severe bands.

## 10. Submit a completed questionnaire into in-memory result state
Goal: Turn six completed answers into an active result and navigate to `/result`.
Description: Label the final submit action “See my result,” require all six answers, calculate the score, and retain only the active result needed by the result route. Add tests for successful submission and for redirecting a direct or refreshed `/result` visit to Home when no active in-memory result exists.

## 11. Define Result content and resource links
Goal: Approve the health-sensitive interpretation, guidance, and resource content shown after an assessment.
Description: Define plain-language copy for above- and below-cutoff results, the meaning of higher scores, and identical general guidance for every user. Select hardcoded links covering both reputable mental-health organizations and practical self-help resources, while excluding urgent-help copy, extra disclaimers, adaptation caveats, and diagnostic claims.

## 12. Build the Result screen
Goal: Present the active score, approved Result content, resources, and retake action on `/result`.
Description: Render the raw score out of 24, above/below-cutoff status, approved interpretation and guidance, resource links, and a Take Test Again CTA. Test both cutoff outcomes and verify that answers, gauges, progress visuals, and score-dependent guidance are absent.

## 13. Create the local history storage boundary
Goal: Safely store and retrieve completed results in browser `localStorage`.
Description: Implement a client-side storage module that persists only numeric `score` and `timestamp`, permits multiple same-day entries, returns results predictably, and never sends data to a backend. Test serialization, malformed or unavailable storage handling, and the privacy rule that individual answers are never stored.

## 14. Enforce the 20-result history limit
Goal: Keep only the 20 most recent locally saved results.
Description: Extend the local history boundary so adding result 21 removes the oldest entry while retaining chronological information for the remaining records. Add focused tests for the limit boundary, eviction order, and multiple results sharing the same calendar date.

## 15. Automatically save completed results without blocking the assessment
Goal: Save every successful result when storage works and continue normally when it does not.
Description: Connect questionnaire submission to the local history boundary after a valid score is produced. Test exactly one save per completed attempt and prove that unavailable, denied, full, or throwing storage does not prevent navigation to or use of the Result screen.

## 16. Expose storage availability on Home and History
Goal: Disable history functionality gracefully when browser storage cannot be used.
Description: Detect storage availability without blocking page use, hide or disable the Home history entry point, and show a short non-blocking saved-history-unavailable notice. Apply the same unavailable state to `/history` and test both working and failing storage environments while leaving Start Test functional.

## 17. Build the History empty state and results list
Goal: Show locally saved results newest first or offer a clear path to take the first test.
Description: On `/history`, render an empty-state message and Take Test CTA when there are no entries; otherwise list each result with local date, time, score, and above/below-cutoff status. Add tests for ordering, multiple same-day results, cutoff labels, non-clickable entries, and the absence of dedicated historical-result navigation.

## 18. Add the static history trend chart
Goal: Visualize saved scores from oldest to newest with a reference line at 13.
Description: Render a non-interactive line chart above the History results list and include a short explanation of the cutoff line. Test point order, score values, the cutoff reference, and the absence of tooltips, tap behavior, animations, and other interactive chart features.

## 19. Add Clear All History
Goal: Let a user immediately remove every locally saved result.
Description: Add a Clear All History action to the populated History screen that clears the stored collection without a confirmation dialog and then renders the empty state. Test successful clearing and safe behavior when storage becomes unavailable or throws during the operation.

## 20. Establish the shared mobile-first visual foundation
Goal: Give every route a consistent light-theme foundation designed for small screens.
Description: Define shared typography, colors, spacing, page width, buttons, links, and semantic layout conventions without adding persistent navigation or a footer. Verify the shared styles at narrow viewports and exclude dark mode, animation, advanced branding, illustrations, loading skeletons, and desktop-specific layouts.

## 21. Style the Questionnaire and Result screens
Goal: Make assessment interaction and score presentation clear and usable on small screens.
Description: Apply the shared visual foundation to progress, questions, large answer targets, subtle selected borders, navigation controls, score output, guidance, resources, and the retake action. Perform focused narrow-viewport checks while preserving the interaction and Result behavior covered by existing tests.

## 22. Style History and complete cross-route visual QA
Goal: Finish the History presentation and verify visual consistency across the complete flow.
Description: Style the trend chart, results list, empty state, storage notice, and Clear All History action for small screens. Check all four routes together for readable spacing, consistent controls, semantic HTML, and compliance with the MVP visual exclusions.

## 23. Add end-to-end coverage for the primary assessment journey
Goal: Prove the main Home → Test → Result → History flow from the browser boundary.
Description: Test starting the assessment, answering all six questions, submitting, seeing the correct score and cutoff status, automatically saving the result, viewing it in History, and starting another test. Keep the scenario expressed in user language and avoid duplicating lower-level implementation details.

## 24. Add end-to-end coverage for questionnaire edge cases
Goal: Protect required-answer and navigation behavior through the real browser UI.
Description: Test that unanswered questions cannot advance, selection does not auto-advance, Back/Next retains answers, helper text resets after leaving a question, and the last action submits successfully. Include the expected progress and control states without testing private implementation structure.

## 25. Add end-to-end coverage for history and failure scenarios
Goal: Prove that history boundaries and browser-storage failures behave safely.
Description: Test the 20-result limit, Clear All History, direct or refreshed `/result` redirect, unavailable storage notices, disabled history access, and successful assessment completion when storage throws. Seed only `score` and `timestamp` data and verify that no answers are persisted.

## 26. Complete release verification and documentation
Goal: Confirm the MVP is ready to run locally and its operational boundaries are documented.
Description: Run the full automated test suite and review the product against the definition of MVP and explicit exclusions. Update the README with final install, test, and local-start commands plus the no-backend, local-only history, and storage-failure guarantees.
