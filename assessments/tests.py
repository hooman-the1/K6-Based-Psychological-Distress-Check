from django.apps import apps
from django.test import SimpleTestCase


class AssessmentsAppTests(SimpleTestCase):
    def test_assessments_app_is_installed(self):
        app_config = apps.get_app_config("assessments")

        self.assertEqual(app_config.name, "assessments")
