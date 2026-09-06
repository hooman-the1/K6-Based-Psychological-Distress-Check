from django.shortcuts import render


def home_page(request):
    return render(request, "assessments/home.html")


def test_page(request):
    return render(request, "assessments/test.html")


def result_page(request):
    return render(request, "assessments/result.html")


def history_page(request):
    return render(request, "assessments/history.html")
