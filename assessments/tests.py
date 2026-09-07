import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from unittest import skipUnless

from django.apps import apps
from django.contrib.staticfiles import finders
from django.contrib.staticfiles.testing import StaticLiveServerTestCase
from django.test import SimpleTestCase
from django.urls import reverse

from assessments.questionnaire_content import QUESTIONNAIRE_CONTENT


class QuestionnaireMarkupParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.steps = []
        self.current_step = None
        self.text_target = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "section" and "data-question-step" in attributes:
            self.current_step = {
                "number": int(attributes["data-question-step"]),
                "hidden": "hidden" in attributes,
                "count": "",
                "progress": None,
                "prompt": "",
                "groups": 0,
                "choices": [],
                "radios": [],
                "controls": [],
            }
            self.steps.append(self.current_step)
        elif self.current_step is not None and tag == "p":
            if "question-count" in attributes.get("class", "").split():
                self.text_target = "count"
        elif self.current_step is not None and tag == "progress":
            self.current_step["progress"] = attributes
        elif self.current_step is not None and tag == "h2":
            self.text_target = "prompt"
        elif self.current_step is not None and tag == "fieldset":
            self.current_step["groups"] += 1
        elif self.current_step is not None and tag == "label":
            self.current_step["choices"].append(
                {"text": "", "class": attributes.get("class", "")}
            )
            self.text_target = "choice"
        elif (
            self.current_step is not None
            and tag == "input"
            and attributes.get("type") == "radio"
        ):
            self.current_step["radios"].append(attributes)
        elif self.current_step is not None and tag == "button":
            action = next(
                (
                    key.removeprefix("data-questionnaire-")
                    for key in attributes
                    if key.startswith("data-questionnaire-")
                ),
                None,
            )
            if action is not None:
                self.current_step["controls"].append(action)

    def handle_endtag(self, tag):
        if tag in {"p", "h2", "label"}:
            self.text_target = None
        elif tag == "section":
            self.current_step = None

    def handle_data(self, data):
        if self.current_step is None or self.text_target is None:
            return

        normalized_text = " ".join(data.split())
        if not normalized_text:
            return

        if self.text_target == "choice":
            self.current_step["choices"][-1]["text"] += normalized_text
        else:
            self.current_step[self.text_target] += normalized_text


class AssessmentsAppTests(SimpleTestCase):
    def test_assessments_app_is_installed(self):
        app_config = apps.get_app_config("assessments")

        self.assertEqual(app_config.name, "assessments")


class ReleaseDocumentationTests(SimpleTestCase):
    def test_readme_is_a_complete_public_user_and_contributor_guide(self):
        readme_path = Path(__file__).resolve().parents[1] / "README.md"
        readme = readme_path.read_text(encoding="utf-8")
        normalized_readme = " ".join(readme.split())
        normalized_casefold_readme = normalized_readme.casefold()

        required_sections = (
            "## Overview",
            "## Important health notice",
            "## Features",
            "## How scoring works",
            "## Routes and state lifecycle",
            "## Privacy and local data",
            "## Requirements",
            "## Quick start",
            "## Using the application",
            "## Testing",
            "## Project structure",
            "## Contributing",
            "## Production-use note",
        )
        for section in required_sections:
            with self.subTest(section=section):
                self.assertIn(section, readme)
        self.assertEqual(
            sorted(readme.find(section) for section in required_sections),
            [readme.find(section) for section in required_sections],
        )

        required_commands = (
            "git clone https://github.com/hooman-the1/K6-Based-Psychological-Distress-Check.git",
            'Set-Location "K6-Based-Psychological-Distress-Check"',
            "python -m venv .venv",
            ".\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt",
            ".\\.venv\\Scripts\\python.exe manage.py migrate",
            ".\\.venv\\Scripts\\python.exe manage.py check",
            ".\\.venv\\Scripts\\python.exe manage.py test assessments",
            ".\\.venv\\Scripts\\python.exe manage.py test",
            ".\\.venv\\Scripts\\python.exe manage.py runserver",
            "python3 -m venv .venv",
            ".venv/bin/python -m pip install -r requirements.txt",
            ".venv/bin/python manage.py migrate",
            ".venv/bin/python manage.py check",
            ".venv/bin/python manage.py runserver",
        )
        for command in required_commands:
            with self.subTest(command=command):
                self.assertIn(command, readme)

        required_contracts = (
            "answer six questions about the past 30 days",
            "0–24 score",
            "review locally saved score History",
            "clear that History",
            "K6-based",
            "adapted wording",
            "not the validated K6 instrument",
            "not a diagnostic tool",
            "not a replacement for professional care",
            "one question at a time",
            "Back and Next",
            "in-session",
            "four curated external resources",
            "oldest to newest",
            "cutoff line",
            "newest first",
            "Clear All History",
            "Each answer uses the 0–4 response scale",
            "Totals range from 0 to 24",
            "Higher scores mean greater psychological distress",
            "13 or above",
            "validation of the original instrument cannot automatically be assumed",
            "`/`, `/test`, `/result`, and `/history`",
            "`/result` exists only for the active in-memory completion",
            "Direct access or refresh without that state returns to Home",
            "refreshing an unfinished questionnaire discards its answers",
            "Django serves pages and local static assets",
            "questionnaire interaction, scoring, active Result state, and History behavior run in the browser",
            "no product API, account or authentication flow, server-side result persistence, cloud synchronization, analytics, or telemetry",
            "`k6-based-distress-check.history.v1`",
            "numeric `score` and integer `timestamp`",
            "Individual answers are never saved",
            "At most 20 records",
            "result 21 evicts the oldest",
            "removes only that application key",
            "preserves unrelated browser storage",
            "malformed, unavailable, denied, full, or throwing",
            "read, save, or clear",
            "still start and complete an assessment, calculate its score, and view the active Result",
            "History becomes unavailable with a non-blocking notice",
            "failed save is not recreated in another location",
            "NIMH, WHO, and NHS",
            "user-directed external navigation",
            "do not inherit this application's local-only privacy boundary",
            "Python 3.12 or newer",
            "Django 6.1.1",
            "Node.js",
            r"`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`",
            "execute rather than skip",
            "full browser suite has not been validated on macOS or Linux",
            "http://127.0.0.1:8000/",
            "Django contrib migrations",
            "assessment answers, scores, timestamps, and History are not persisted by Django or SQLite",
            "current browser profile",
            "](_docs/testing-guidelines.md)",
            "`config/`",
            "`assessments/templates/`",
            "`assessments/static/assessments/`",
            "`assessments/tests.py`",
            "`_docs/`",
            "](_docs/plan.md)",
            "](_docs/design-system.md)",
            "test-first development",
            "Django `runserver`",
            "`DEBUG=True`",
            "checked-in development secret",
            "empty `ALLOWED_HOSTS`",
            "unsuitable for production",
            "https://docs.djangoproject.com/en/6.1/howto/deployment/",
        )
        for contract in required_contracts:
            with self.subTest(contract=contract):
                self.assertIn(contract.casefold(), normalized_casefold_readme)

        for forbidden_framing in (
            "course",
            "coursework",
            "assignment",
            "portfolio",
            "demo",
        ):
            with self.subTest(forbidden_framing=forbidden_framing):
                self.assertNotIn(forbidden_framing, normalized_casefold_readme)


class QuestionnaireContentTests(SimpleTestCase):
    expected_questions = (
        "Over the past 30 days, how often did you feel nervous?",
        "Over the past 30 days, how often did you feel hopeless?",
        "Over the past 30 days, how often did you feel restless or fidgety?",
        "Over the past 30 days, how often did you feel so down that nothing could cheer you up?",
        "Over the past 30 days, how often did it feel like everything took a lot of effort?",
        "Over the past 30 days, how often did you feel like you had no value?",
    )

    def test_questionnaire_has_approved_name_and_ordered_question_copy(self):
        self.assertEqual(
            QUESTIONNAIRE_CONTENT.display_name,
            "K6-Based Psychological Distress Check",
        )
        self.assertEqual(len(QUESTIONNAIRE_CONTENT.questions), 6)
        self.assertEqual(
            tuple(question.prompt for question in QUESTIONNAIRE_CONTENT.questions),
            self.expected_questions,
        )
        for question in QUESTIONNAIRE_CONTENT.questions:
            with self.subTest(prompt=question.prompt):
                self.assertIn("past 30 days", question.prompt)

    def test_questionnaire_has_one_approved_ordered_response_scale(self):
        self.assertEqual(
            tuple(
                (option.label, option.value)
                for option in QUESTIONNAIRE_CONTENT.response_options
            ),
            (
                ("None of the time", 0),
                ("A little of the time", 1),
                ("Some of the time", 2),
                ("Most of the time", 3),
                ("All of the time", 4),
            ),
        )

    def test_helper_text_is_present_only_for_questions_three_and_five(self):
        self.assertEqual(
            tuple(question.helper_text for question in QUESTIONNAIRE_CONTENT.questions),
            (
                None,
                None,
                "Restless or fidgety means finding it hard to relax or stay still.",
                None,
                "This means ordinary things felt harder or more tiring to do than usual.",
                None,
            ),
        )

    def test_exposed_content_uses_k6_based_without_validation_or_diagnostic_claims(self):
        exposed_text = " ".join(
            (
                QUESTIONNAIRE_CONTENT.display_name,
                *(question.prompt for question in QUESTIONNAIRE_CONTENT.questions),
                *(
                    question.helper_text
                    for question in QUESTIONNAIRE_CONTENT.questions
                    if question.helper_text is not None
                ),
                *(
                    option.label
                    for option in QUESTIONNAIRE_CONTENT.response_options
                ),
            )
        )

        self.assertIn("K6-Based", exposed_text)
        for prohibited_claim in (
            "the k6 questionnaire",
            "validated",
            "diagnosis",
            "diagnostic",
        ):
            with self.subTest(prohibited_claim=prohibited_claim):
                self.assertNotIn(prohibited_claim, exposed_text.lower())


class HomePageTests(SimpleTestCase):
    def test_home_page_shows_only_its_approved_content_and_actions(self):
        response = self.client.get(reverse("home"))

        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "assessments/base.html")
        self.assertTemplateUsed(response, "assessments/home.html")
        self.assertContains(
            response,
            "<h1>K6-Based Psychological Distress Check</h1>",
            count=1,
            html=True,
        )
        self.assertContains(
            response,
            "Answer six short questions about how you have felt over the past 30 days.",
            count=1,
        )
        self.assertContains(
            response,
            f'<a class="button button--primary" href="{reverse("test")}">Start Test</a>',
            count=1,
            html=True,
        )
        self.assertContains(
            response,
            f'<a class="button button--secondary" href="{reverse("history")}" data-history-link hidden>View History</a>',
            count=1,
            html=True,
        )
        self.assertContains(
            response,
            "<p data-history-unavailable hidden>Saved history is unavailable in this browser.</p>",
            count=1,
            html=True,
        )
        self.assertContains(
            response,
            f"""
            <main class="page-shell">
                <h1>K6-Based Psychological Distress Check</h1>
                <p>Answer six short questions about how you have felt over the past 30 days.</p>
                <div class="action-stack">
                    <a class="button button--primary" href="{reverse("test")}">Start Test</a>
                    <a class="button button--secondary" href="{reverse("history")}" data-history-link hidden>View History</a>
                </div>
                <p data-history-unavailable hidden>Saved history is unavailable in this browser.</p>
            </main>
            """,
            count=1,
            html=True,
        )


class QuestionnairePageTests(SimpleTestCase):
    def get_rendered_steps(self):
        response = self.client.get(reverse("test"))
        parser = QuestionnaireMarkupParser()
        parser.feed(response.content.decode())
        return response, parser.steps

    def test_test_page_starts_with_only_the_first_question_visible(self):
        response, steps = self.get_rendered_steps()

        self.assertEqual(response.status_code, 200)
        self.assertFalse(steps[0]["hidden"])
        self.assertEqual(steps[0]["count"], "Question 1 of 6")
        self.assertEqual(
            steps[0]["prompt"],
            "Over the past 30 days, how often did you feel nervous?",
        )
        self.assertTrue(all(step["hidden"] for step in steps[1:]))

    def test_each_step_renders_the_authoritative_prompt_scale_and_progress(self):
        response, steps = self.get_rendered_steps()

        expected_labels = [
            option.label for option in QUESTIONNAIRE_CONTENT.response_options
        ]
        self.assertEqual(len(steps), 6)
        for number, (step, question) in enumerate(
            zip(steps, QUESTIONNAIRE_CONTENT.questions, strict=True),
            start=1,
        ):
            with self.subTest(number=number):
                self.assertEqual(step["number"], number)
                self.assertEqual(step["count"], f"Question {number} of 6")
                self.assertEqual(step["progress"]["value"], str(number))
                self.assertEqual(step["progress"]["max"], "6")
                self.assertEqual(
                    step["progress"]["aria-label"], "Questionnaire progress"
                )
                self.assertEqual(step["prompt"], question.prompt)
                self.assertEqual(step["groups"], 1)
                self.assertEqual(
                    [choice["text"] for choice in step["choices"]],
                    expected_labels,
                )
                self.assertTrue(
                    all(
                        "response-option" in choice["class"].split()
                        for choice in step["choices"]
                    )
                )
                self.assertEqual(
                    [radio["value"] for radio in step["radios"]],
                    [str(value) for value in range(5)],
                )
                self.assertTrue(
                    all(
                        radio["name"] == f"question-{number}"
                        for radio in step["radios"]
                    )
                )
        self.assertContains(response, 'type="radio"', count=30)

    def test_each_new_test_page_render_has_a_fresh_initial_state(self):
        first_response, first_steps = self.get_rendered_steps()
        self.client.get(reverse("home"))
        second_response, second_steps = self.get_rendered_steps()

        for response in (first_response, second_response):
            self.assertNotContains(response, " checked")
        for steps in (first_steps, second_steps):
            self.assertFalse(steps[0]["hidden"])
            self.assertTrue(all(step["hidden"] for step in steps[1:]))

    def test_each_step_has_only_its_temporary_navigation_controls(self):
        response, steps = self.get_rendered_steps()

        self.assertEqual(steps[0]["controls"], ["next"])
        for step in steps[1:5]:
            with self.subTest(number=step["number"]):
                self.assertEqual(step["controls"], ["back", "next"])
        self.assertEqual(steps[5]["controls"], ["back", "submit"])
        self.assertContains(
            response,
            '<button class="button button--primary" type="submit" data-questionnaire-submit disabled>See my result</button>',
            count=1,
            html=True,
        )

    def test_static_assets_define_in_memory_boundary_safe_immediate_stepping(self):
        script = Path(finders.find("assessments/app.js")).read_text(encoding="utf-8")
        stylesheet = Path(finders.find("assessments/app.css")).read_text(
            encoding="utf-8"
        )

        for behavior in (
            'querySelector("[data-questionnaire]")',
            'querySelectorAll("[data-question-step]")',
            'form.reset()',
            "currentStep = 0",
            "Math.min(currentStep + 1, steps.length - 1)",
            "Math.max(currentStep - 1, 0)",
        ):
            with self.subTest(behavior=behavior):
                self.assertIn(behavior, script)
        for prohibited_persistence in (
            "localStorage",
            "sessionStorage",
            "document.cookie",
        ):
            with self.subTest(prohibited_persistence=prohibited_persistence):
                self.assertNotIn(prohibited_persistence, script)
        self.assertRegex(
            stylesheet,
            r"\.response-option\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*\}",
        )
        self.assertRegex(
            stylesheet,
            r"progress\s*\{[^}]*transition:\s*none;[^}]*\}",
        )


class K6ScoringTests(SimpleTestCase):
    node_path = shutil.which("node")

    @skipUnless(node_path, "requires Node.js")
    def test_public_browser_side_scoring_contract(self):
        completed = subprocess.run(
            [
                self.node_path,
                "--test",
                str(Path(__file__).with_name("k6_scoring_tests.js")),
            ],
            capture_output=True,
            check=False,
            encoding="utf-8",
            timeout=10,
        )

        self.assertEqual(
            completed.returncode,
            0,
            msg=f"Scoring unit tests failed:\n{completed.stdout}\n{completed.stderr}",
        )


class ResultContentTests(SimpleTestCase):
    node_path = shutil.which("node")

    @skipUnless(node_path, "requires Node.js")
    def test_public_browser_side_result_content_contract(self):
        completed = subprocess.run(
            [
                self.node_path,
                "--test",
                str(Path(__file__).with_name("result_content_tests.js")),
            ],
            capture_output=True,
            check=False,
            encoding="utf-8",
            timeout=10,
        )

        self.assertEqual(
            completed.returncode,
            0,
            msg=(
                "Result content unit tests failed:\n"
                f"{completed.stdout}\n{completed.stderr}"
            ),
        )


class AssessmentHistoryTests(SimpleTestCase):
    node_path = shutil.which("node")

    @skipUnless(node_path, "requires Node.js")
    def test_public_browser_side_history_contract(self):
        completed = subprocess.run(
            [
                self.node_path,
                "--test",
                str(Path(__file__).with_name("assessment_history_tests.js")),
            ],
            capture_output=True,
            check=False,
            encoding="utf-8",
            timeout=10,
        )

        self.assertEqual(
            completed.returncode,
            0,
            msg=(
                "Assessment history unit tests failed:\n"
                f"{completed.stdout}\n{completed.stderr}"
            ),
        )


class QuestionnaireBrowserInteractionTests(StaticLiveServerTestCase):
    edge_path = Path(
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    )
    node_path = shutil.which("node")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_questionnaire_interactions_execute_in_a_real_browser(self):
        result = self.run_questionnaire_browser_scenario()

        self.assertEqual(result, "questionnaire browser scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_submission_and_transient_result_execute_in_a_real_browser(self):
        result = self.run_questionnaire_browser_scenario(
            script_name="result_submission_browser_scenario.js",
            success_message="result submission browser scenario passed",
        )

        self.assertEqual(result, "result submission browser scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_assessment_history_uses_real_same_origin_local_storage(self):
        result = self.run_questionnaire_browser_scenario(
            script_name="assessment_history_browser_scenario.js",
            success_message="assessment history browser scenario passed",
        )

        self.assertEqual(result, "assessment history browser scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_history_availability_executes_in_a_real_browser(self):
        result = self.run_questionnaire_browser_scenario(
            script_name="history_availability_browser_scenario.js",
            success_message="history availability browser scenario passed",
            additional_urls=(f"{self.live_server_url}{reverse('history')}",),
        )

        self.assertEqual(result, "history availability browser scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_shared_visual_foundation_executes_in_a_real_browser(self):
        screenshot_directory = (
            Path(tempfile.gettempdir()) / "k6-issue20-visual-foundation"
        )
        result = self.run_questionnaire_browser_scenario(
            script_name="shared_visual_foundation_browser_scenario.js",
            success_message="shared visual foundation browser scenario passed",
            additional_urls=(f"{self.live_server_url}{reverse('history')}",),
            additional_arguments=(str(screenshot_directory),),
        )

        self.assertEqual(result, "shared visual foundation browser scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_questionnaire_and_result_visuals_execute_in_a_real_browser(self):
        screenshot_directory = (
            Path(tempfile.gettempdir())
            / "k6-issue21-questionnaire-result-visuals"
        )
        result = self.run_questionnaire_browser_scenario(
            script_name="questionnaire_result_visuals_browser_scenario.js",
            success_message="questionnaire and Result visual scenario passed",
            additional_arguments=(str(screenshot_directory),),
        )

        self.assertEqual(result, "questionnaire and Result visual scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_history_and_cross_route_visuals_execute_in_a_real_browser(self):
        screenshot_directory = (
            Path(tempfile.gettempdir()) / "k6-issue22-history-cross-route-visuals"
        )
        result = self.run_questionnaire_browser_scenario(
            script_name="history_cross_route_visuals_browser_scenario.js",
            success_message="History and cross-route visual scenario passed",
            additional_urls=(f"{self.live_server_url}{reverse('history')}",),
            additional_arguments=(str(screenshot_directory),),
        )

        self.assertEqual(result, "History and cross-route visual scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_primary_assessment_journey_executes_in_a_real_browser(self):
        result = self.run_questionnaire_browser_scenario(
            script_name="primary_assessment_journey_browser_scenario.js",
            success_message="primary assessment journey browser scenario passed",
            additional_urls=(f"{self.live_server_url}{reverse('history')}",),
        )

        self.assertEqual(result, "primary assessment journey browser scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_questionnaire_edge_cases_execute_in_a_real_browser(self):
        result = self.run_questionnaire_browser_scenario(
            script_name="questionnaire_edge_cases_browser_scenario.js",
            success_message="questionnaire edge cases browser scenario passed",
        )

        self.assertEqual(result, "questionnaire edge cases browser scenario passed")

    @skipUnless(edge_path.is_file() and node_path, "requires Edge and Node.js")
    def test_history_and_failure_journey_executes_in_a_real_browser(self):
        result = self.run_questionnaire_browser_scenario(
            script_name="history_failure_journey_browser_scenario.js",
            success_message="history and failure journey browser scenario passed",
            additional_urls=(f"{self.live_server_url}{reverse('history')}",),
        )

        self.assertEqual(
            result,
            "history and failure journey browser scenario passed",
        )

    def run_questionnaire_browser_scenario(
        self,
        script_name="questionnaire_browser_scenario.js",
        success_message="questionnaire browser scenario passed",
        additional_urls=(),
        additional_arguments=(),
    ):
        debugging_port = self.get_available_port()
        test_url = f"{self.live_server_url}{reverse('test')}"
        home_url = f"{self.live_server_url}{reverse('home')}"

        with tempfile.TemporaryDirectory(
            prefix="questionnaire-browser-",
            ignore_cleanup_errors=True,
        ) as profile:
            browser = subprocess.Popen(
                [
                    self.edge_path,
                    "--headless=new",
                    "--disable-gpu",
                    "--no-sandbox",
                    "--no-first-run",
                    f"--remote-debugging-port={debugging_port}",
                    "--remote-allow-origins=*",
                    f"--user-data-dir={profile}",
                    "about:blank",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                websocket_url = self.wait_for_page_websocket(debugging_port)
                completed = subprocess.run(
                    [
                        self.node_path,
                        str(
                            Path(__file__).with_name(
                                script_name
                            )
                        ),
                        websocket_url,
                        test_url,
                        home_url,
                        *additional_urls,
                        *additional_arguments,
                    ],
                    capture_output=True,
                    check=False,
                    encoding="utf-8",
                    timeout=30,
                )
            finally:
                browser.terminate()
                try:
                    browser.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    browser.kill()
                    browser.wait(timeout=5)

        self.assertEqual(
            completed.returncode,
            0,
            msg=(
                f"Browser scenario failed; expected {success_message!r}:\n"
                f"{completed.stderr}"
            ),
        )
        return completed.stdout.strip()

    @staticmethod
    def get_available_port():
        with socket.socket() as available_socket:
            available_socket.bind(("127.0.0.1", 0))
            return available_socket.getsockname()[1]

    def wait_for_page_websocket(self, debugging_port):
        endpoint = f"http://127.0.0.1:{debugging_port}/json/list"
        deadline = time.monotonic() + 10

        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(endpoint, timeout=1) as response:
                    targets = json.load(response)
                page_target = next(
                    target
                    for target in targets
                    if target.get("type") == "page"
                )
                return page_target["webSocketDebuggerUrl"]
            except (
                OSError,
                StopIteration,
                json.JSONDecodeError,
            ):
                time.sleep(0.05)

        self.fail("Edge did not expose the questionnaire page to the test")


class PageRouteTests(SimpleTestCase):
    pages = (
        (
            "home",
            "/",
            "assessments/home.html",
            "K6-Based Psychological Distress Check",
            "Home | K6-Based Psychological Distress Check",
        ),
        (
            "test",
            "/test",
            "assessments/test.html",
            "Test",
            "Test | K6-Based Psychological Distress Check",
        ),
        (
            "history",
            "/history",
            "assessments/history.html",
            "History",
            "History | K6-Based Psychological Distress Check",
        ),
    )

    def test_each_page_route_renders_its_template(self):
        for route_name, path, template_name, heading, document_title in self.pages:
            with self.subTest(route_name=route_name):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(reverse(route_name), path)
                self.assertTemplateUsed(response, "assessments/base.html")
                self.assertTemplateUsed(response, template_name)
                self.assertContains(response, f"<h1>{heading}</h1>", html=True)
                self.assertContains(
                    response,
                    f"<title>{document_title}</title>",
                    html=True,
                )

    def test_direct_result_route_redirects_home_without_active_browser_state(self):
        response = self.client.get(reverse("result"))

        self.assertRedirects(response, reverse("home"))

    def test_each_page_uses_the_shared_mobile_document_shell(self):
        for route_name, path, _, _, _ in self.pages:
            with self.subTest(route_name=route_name):
                response = self.client.get(path)

                self.assertEqual(response.charset, "utf-8")
                self.assertContains(response, '<html lang="en">')
                self.assertContains(response, '<meta charset="utf-8">', html=True)
                self.assertContains(
                    response,
                    '<meta name="viewport" content="width=device-width, initial-scale=1">',
                    html=True,
                )
                self.assertContains(response, 'href="/static/assessments/app.css"')
                self.assertContains(
                    response,
                    '<script defer src="/static/assessments/assessment-history.js"></script>',
                    html=True,
                )
                self.assertContains(
                    response,
                    '<script defer src="/static/assessments/app.js"></script>',
                    html=True,
                )
                self.assertContains(
                    response,
                    '<main class="page-shell">',
                    count=1,
                )
                self.assertNotContains(response, "<nav")
                self.assertNotContains(response, "<footer")

    def test_static_asset_entry_points_exist(self):
        self.assertIsNotNone(finders.find("assessments/app.css"))
        self.assertIsNotNone(finders.find("assessments/assessment-history.js"))
        self.assertIsNotNone(finders.find("assessments/app.js"))

    def test_main_content_width_prevents_overflow_at_320_pixel_viewport(self):
        stylesheet_path = finders.find("assessments/app.css")
        stylesheet = Path(stylesheet_path).read_text(encoding="utf-8")

        self.assertRegex(
            stylesheet,
            r"\*,\s*\*::before,\s*\*::after\s*\{[^}]*box-sizing:\s*border-box;[^}]*\}",
        )
        self.assertRegex(
            stylesheet,
            r"body\s*\{[^}]*margin:\s*0;[^}]*\}",
        )
        self.assertRegex(
            stylesheet,
            r"\.page-shell\s*\{[^}]*width:\s*min\(calc\(100% - 2rem\), 36rem\);[^}]*\}",
        )
