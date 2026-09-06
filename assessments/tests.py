from pathlib import Path

from django.apps import apps
from django.contrib.staticfiles import finders
from django.test import SimpleTestCase
from django.urls import reverse

from assessments.questionnaire_content import QUESTIONNAIRE_CONTENT


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


class PageRouteTests(SimpleTestCase):
    pages = (
        ("home", "/", "assessments/home.html", "Home"),
        ("test", "/test", "assessments/test.html", "Test"),
        ("result", "/result", "assessments/result.html", "Result"),
        ("history", "/history", "assessments/history.html", "History"),
    )

    def test_each_page_route_renders_its_template(self):
        for route_name, path, template_name, heading in self.pages:
            with self.subTest(route_name=route_name):
                response = self.client.get(path)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(reverse(route_name), path)
                self.assertTemplateUsed(response, "assessments/base.html")
                self.assertTemplateUsed(response, template_name)
                self.assertContains(response, f"<h1>{heading}</h1>", html=True)
                self.assertContains(
                    response,
                    f"<title>{heading} | K6-Based Psychological Distress Check</title>",
                    html=True,
                )

    def test_each_page_uses_the_shared_mobile_document_shell(self):
        for route_name, path, _, _ in self.pages:
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
