from pathlib import Path

from django.apps import apps
from django.contrib.staticfiles import finders
from django.test import SimpleTestCase
from django.urls import reverse


class AssessmentsAppTests(SimpleTestCase):
    def test_assessments_app_is_installed(self):
        app_config = apps.get_app_config("assessments")

        self.assertEqual(app_config.name, "assessments")


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
