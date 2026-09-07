# K6-Based Psychological Distress Check

## Overview

K6-Based Psychological Distress Check is a browser-based self-assessment. It
lets a person answer six questions about the past 30 days, see a 0–24 score and
its cutoff interpretation, review locally saved score History, and clear that
History.

The application runs locally with Django serving its pages and static files.
Assessment interaction and data stay in the person's browser except when they
choose to follow an external resource link.

## Important health notice

**Important:** This is a K6-based self-assessment with adapted wording. It is not
the validated K6 instrument, not a diagnostic tool, and not a replacement for
professional care.

The score is informational. This application does not diagnose a condition,
recommend treatment, or establish that its adapted questions have the
psychometric properties of the original instrument.

## Features

- A mobile-first light interface with no account setup.
- A six-question flow that presents one question at a time and covers the past
  30 days.
- Back and Next navigation, required responses, and in-session answer retention
  while moving between questions. Selecting a response does not advance the
  questionnaire automatically.
- A raw score and one cutoff interpretation, followed by the same general
  guidance for every score.
- Four curated external resources from NIMH, WHO, and NHS.
- Automatic browser-local History after each successfully completed assessment.
- A static trend chart ordered from oldest to newest, with a cutoff line, plus a
  newest-first result list.
- A 20-record History limit and a Clear All History action.
- Graceful storage-failure behavior that keeps assessment and active Result use
  available.

## How scoring works

Each answer uses the 0–4 response scale:

| Response | Value |
| --- | ---: |
| None of the time | 0 |
| A little of the time | 1 |
| Some of the time | 2 |
| Most of the time | 3 |
| All of the time | 4 |

The six values are added without weighting. Totals range from 0 to 24. Higher
scores mean greater psychological distress. A score of 13 or above is labelled
at or above the serious or elevated psychological-distress cutoff; a lower score
is labelled below that cutoff. No additional severity levels are assigned.

This scoring contract follows the original K6 model, but this application's
adapted wording means validation of the original instrument cannot automatically
be assumed.

## Routes and state lifecycle

The four user routes are `/`, `/test`, `/result`, and `/history`:

- `/` — Home, with actions to start an assessment or open available History.
- `/test` — the six-question assessment.
- `/result` — the score, cutoff interpretation, general guidance, and resources.
- `/history` — locally retained scores, their trend chart, and the clear action.

`/result` exists only for the active in-memory completion. Direct access or
refresh without that state returns to Home. Starting a new assessment replaces
the active Result state. Leaving or refreshing an unfinished questionnaire
discards its answers; unfinished answers are not persisted.

## Privacy and local data

Django serves pages and local static assets. Questionnaire interaction, scoring,
active Result state, and History behavior run in the browser. The application
has no product API, account or authentication flow, server-side result
persistence, cloud synchronization, analytics, or telemetry.

History is scoped to the current browser profile and stored in `localStorage`
under exactly one key: `k6-based-distress-check.history.v1`. Each retained record
contains only numeric `score` and integer `timestamp` values. Individual answers
are never saved. At most 20 records are retained; result 21 evicts the oldest.
Clear All History removes only that application key and preserves unrelated
browser storage.

Malformed, unavailable, denied, full, or throwing browser storage during read,
save, or clear does not block the core flow. A user can still start and complete
an assessment, calculate its score, and view the active Result. History becomes
unavailable with a non-blocking notice, and a failed save is not recreated in
another location.

The four hardcoded Result resources are links to NIMH, WHO, and NHS first-party
sites:

- [NIMH: Mental Health Information](https://www.nimh.nih.gov/health)
- [WHO: Mental health](https://www.who.int/news-room/fact-sheets/detail/mental-health-strengthening-our-response)
- [WHO: Doing What Matters in Times of Stress](https://www.who.int/publications/i/item/9789240003927)
- [NHS Every Mind Matters: Self-help CBT techniques](https://www.nhs.uk/every-mind-matters/mental-wellbeing-tips/self-help-cbt-techniques/)

Opening one is a user-directed external navigation. Those third-party sites do
not inherit this application's local-only privacy boundary.

## Requirements

Ordinary local use requires:

- Python 3.12 or newer.
- Django 6.1.1, installed from the pinned entry in `requirements.txt`.

Full automated verification on the documented Windows test environment also
requires:

- Node.js.
- Microsoft Edge at
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.

Node.js and Edge are additional test runtimes; no JavaScript package installation
is required. They are needed to execute rather than skip the complete
dependency-free browser suite. The Windows-only Edge path is an assumption of
the current genuine-browser test harness. The full browser suite has not been
validated on macOS or Linux.

## Quick start

### Windows PowerShell

From a directory in which you want to place the repository:

```powershell
git clone https://github.com/hooman-the1/K6-Based-Psychological-Distress-Check.git
Set-Location "K6-Based-Psychological-Distress-Check"
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe manage.py runserver
```

Open `http://127.0.0.1:8000/`. Keep that terminal open while using the
application and press `Ctrl+C` to stop the server.

### macOS or Linux

```bash
git clone https://github.com/hooman-the1/K6-Based-Psychological-Distress-Check.git
cd K6-Based-Psychological-Distress-Check
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python manage.py migrate
.venv/bin/python manage.py check
.venv/bin/python manage.py runserver
```

Open `http://127.0.0.1:8000/`. These are general Django startup instructions;
the genuine-Edge test harness still assumes the Windows location documented in
[Requirements](#requirements).

The `migrate` step applies the default Django contrib migrations, removes the
expected unapplied-migrations warning, and creates framework tables in the local
SQLite database. Assessment answers, scores, timestamps, and History are not
persisted by Django or SQLite.

## Using the application

1. On Home, choose **Start Test**.
2. Answer each of the six required questions. Use **Next** to continue and
   **Back** to review or change an in-session answer.
3. On the last question, choose **See my result** to view the active Result and
   its four external resources. If browser storage is available, the score and
   completion timestamp are saved automatically.
4. Choose **Take test again** to begin a fresh assessment. Return to Home when
   you want to use **View History**.
5. In History, read the chart from oldest to newest and the list from newest
   first. History belongs only to the current browser profile.
6. Choose **Clear All History** to remove the saved records immediately. There
   is no confirmation step.

## Testing

Run the application-focused suite on Windows:

```powershell
.\.venv\Scripts\python.exe manage.py test assessments
```

Run the full Django suite:

```powershell
.\.venv\Scripts\python.exe manage.py test
```

Node-dependent contract tests are skipped when Node.js is unavailable. Genuine
browser scenarios are skipped unless both Node.js and Edge at the documented
Windows path are available. A green run containing those skips does not verify
the complete browser behavior.

See the [testing guidelines](_docs/testing-guidelines.md) for focused test
commands, individual Node/Edge scenarios, and generated review screenshot
locations.

## Project structure

- `config/` contains Django configuration, URL assembly, and WSGI/ASGI entry
  points.
- `assessments/templates/` contains page markup for Home, Test, Result, and
  History.
- `assessments/static/assessments/` contains browser behavior, scoring, Result
  content, History storage logic, and styling.
- `assessments/tests.py`, the JavaScript `*_tests.js` files, and the
  `*_browser_scenario.js` files provide automated contract and genuine-browser
  coverage.
- `_docs/` contains product, design, process, and testing references.

## Contributing

Before proposing a change:

1. Read the [product plan](_docs/plan.md), then the relevant
   [design system](_docs/design-system.md) and
   [testing guidelines](_docs/testing-guidelines.md).
2. Start from a GitHub issue with checkable acceptance criteria and follow the
   repository [process](_docs/process.md).
3. Use test-first development: add or update a failing test, make the smallest
   production or documentation change that passes it, and refactor only while
   protected by green tests.
4. Preserve the health notice and the privacy, transient-state, and local-storage
   boundaries. Do not change dependencies or public contracts without approval.
5. Run the focused tests first and the broader suite before proposing the
   change.

Repository-specific working rules are in [AGENTS.md](AGENTS.md).

## Production-use note

The checked-in settings are development defaults and are unsuitable for
production: Django `runserver` is a development server, `DEBUG=True`, the
`SECRET_KEY` is a checked-in development secret, and the project uses empty
`ALLOWED_HOSTS`. No production server or deployment configuration is included.

Before considering a deployment, review Django's
[deployment guidance](https://docs.djangoproject.com/en/6.1/howto/deployment/)
and provide environment-appropriate security, hosting, and operational
configuration.
