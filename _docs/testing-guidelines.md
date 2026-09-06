# Testing guidelines

Run the Django suite with:

```powershell
.\.venv\Scripts\python.exe manage.py test
```

The questionnaire interaction test starts Django's static live server and drives
headless Microsoft Edge at a 320 px viewport through the browser's DevTools
protocol. It uses the installed Edge executable and Node.js runtime directly, so
it adds no Python or JavaScript package dependency. The test is skipped with an
explicit reason when either runtime is unavailable.

Run that focused browser test with:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments.tests.QuestionnaireBrowserInteractionTests -v 2
```
