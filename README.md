# K6-Based Psychological Distress Check

## Product scope

This is a frontend-only, mobile-first portfolio demo of a K6-based
psychological-distress self-assessment with adapted wording. It is not the
validated K6 instrument, not a diagnostic tool, and not a replacement for
professional care.

## Routes and result lifecycle

The four user routes are `/`, `/test`, `/result`, and `/history`:

- `/` opens Home.
- `/test` runs the six-question assessment.
- `/result` shows the completed assessment result.
- `/history` shows saved results and the trend chart when History is available.

`/result` is transient. It is available only immediately after a completed
assessment; a direct visit or refresh without an active in-memory result returns
to Home.

## Prerequisites

Runtime use requires Python 3.12 or newer, compatible with the pinned Django
version in `requirements.txt`.

Running the full test suite on the documented Windows environment additionally
requires Node.js and Microsoft Edge installed at
`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. Both are required
to execute, rather than skip, the dependency-free browser scenarios.

## Install, verify, and run

From a clean checkout in Windows PowerShell, run these commands in order:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe manage.py test
.\.venv\Scripts\python.exe manage.py runserver
```

Then open `http://127.0.0.1:8000/`. The Django `runserver` command starts a local
development server, not a production deployment server. See the
[testing guidelines](_docs/testing-guidelines.md) for focused Node/Edge scenario
commands and review screenshot locations.

## Browser data and storage failures

Django serves the local pages and static assets, while questionnaire state,
scoring, the transient Result state, and History behavior execute in the
browser. There is no product API, server-side result persistence, account,
authentication, database model, or cloud synchronization.

Saved History is scoped to the current browser profile and uses only the
`k6-based-distress-check.history.v1` `localStorage` key. Each retained record
contains only numeric `score` and integer `timestamp`. History retains at most 20
records; when result 21 is saved, the oldest record is evicted. Individual
questionnaire answers are never saved.

The unfinished questionnaire and the active Result are memory-only, so leaving
or refreshing discards them. Clearing History removes only the application
History key, leaving unrelated browser storage untouched.

If stored History is malformed, or browser storage is unavailable, denied, full,
or throws while reading, saving, or clearing, the user can still start,
complete, score, and view a Result. History access and presentation become
unavailable with a non-blocking notice, and a failed save is not recreated
elsewhere.

## Privacy and external resources

The application does not automatically send questionnaire answers, scores,
timestamps, or History to a server, analytics service, or telemetry service.
Activating one of the Result resource links is a user-directed visit to an
external first-party website.
