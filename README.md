# K6-Based Psychological Distress Check

Django scaffold for the K6-based psychological distress check. The Django
project configuration is in `config`, and the domain app is in `assessments`.

The current page shell is available at `/`, `/test`, `/result`, and `/history`.

## Local setup

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## Development commands

```powershell
# Run tests
.\.venv\Scripts\python.exe manage.py test

# Validate configuration
.\.venv\Scripts\python.exe manage.py check

# Start locally
.\.venv\Scripts\python.exe manage.py runserver
```
