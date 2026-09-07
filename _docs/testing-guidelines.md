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
with an application-owned fake storage port. It does not mock browser Storage
types and performs no network requests. Run it directly with:

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
checks that history operations cause no post-load network request. Run only that
scenario with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_assessment_history_uses_real_same_origin_local_storage -v 2
```

The History availability and presentation scenario uses real same-origin
`localStorage` for empty and populated states, injects read failures only at the
application-owned history boundary, and fixes the browser timezone through CDP
before checking local date/time output. Run it with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests.test_history_availability_executes_in_a_real_browser -v 2
```
