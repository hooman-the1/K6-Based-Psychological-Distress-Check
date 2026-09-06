from django.urls import path

from . import views


urlpatterns = [
    path("", views.home_page, name="home"),
    path("test", views.test_page, name="test"),
    path("result", views.result_page, name="result"),
    path("history", views.history_page, name="history"),
]
