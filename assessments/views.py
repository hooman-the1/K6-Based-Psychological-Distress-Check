from django.shortcuts import render

from .questionnaire_content import QUESTIONNAIRE_CONTENT


def home_page(request):
    return render(request, "assessments/home.html")


def test_page(request):
    return render(
        request,
        "assessments/test.html",
        {"questionnaire": QUESTIONNAIRE_CONTENT},
    )


def result_page(request):
    return render(request, "assessments/result.html")


def history_page(request):
    return render(request, "assessments/history.html")
