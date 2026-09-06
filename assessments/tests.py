from html.parser import HTMLParser
from pathlib import Path

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
            f'<a href="{reverse("test")}">Start Test</a>',
            count=1,
            html=True,
        )
        self.assertContains(
            response,
            f'<a href="{reverse("history")}">View History</a>',
            count=1,
            html=True,
        )
        self.assertContains(
            response,
            f"""
            <main class="page-shell">
                <h1>K6-Based Psychological Distress Check</h1>
                <p>Answer six short questions about how you have felt over the past 30 days.</p>
                <a href="{reverse("test")}">Start Test</a>
                <a href="{reverse("history")}">View History</a>
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
        _, steps = self.get_rendered_steps()

        self.assertEqual(steps[0]["controls"], ["next"])
        for step in steps[1:5]:
            with self.subTest(number=step["number"]):
                self.assertEqual(step["controls"], ["back", "next"])
        self.assertEqual(steps[5]["controls"], ["back"])

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
            "history.pushState",
            "history.replaceState",
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


class QuestionnaireBrowserInteractionTests(StaticLiveServerTestCase):
    def test_questionnaire_interactions_execute_in_a_real_browser(self):
        result = self.run_questionnaire_browser_scenario()

        self.assertEqual(result, "questionnaire browser scenario passed")


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
            "result",
            "/result",
            "assessments/result.html",
            "Result",
            "Result | K6-Based Psychological Distress Check",
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
        self.assertIsNotNone(finders.find("assessments/app.js"))

    def test_main_content_width_prevents_overflow_at_320_pixel_viewport(self):
        stylesheet_path = finders.find("assessments/app.css")
        stylesheet = Path(stylesheet_path).read_text(encoding="utf-8")

        self.assertRegex(
            stylesheet,
            r"\*\s*\{[^}]*box-sizing:\s*border-box;[^}]*\}",
        )
        self.assertRegex(
            stylesheet,
            r"body\s*\{[^}]*margin:\s*0;[^}]*\}",
        )
        self.assertRegex(
            stylesheet,
            r"\.page-shell\s*\{[^}]*width:\s*min\(calc\(100% - 2rem\), 36rem\);[^}]*\}",
        )
