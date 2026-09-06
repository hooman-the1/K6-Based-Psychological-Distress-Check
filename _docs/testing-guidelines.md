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

The questionnaire interaction test starts Django's static live server and drives
headless Microsoft Edge at a 320 px viewport through the browser's DevTools
protocol. It uses the installed Edge executable and Node.js runtime directly, so
it adds no Python or JavaScript package dependency. The test is skipped with an
explicit reason when either runtime is unavailable.

Run that focused browser test with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests -v 2
```
