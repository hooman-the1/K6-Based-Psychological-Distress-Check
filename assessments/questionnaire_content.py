from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ResponseOption:
    label: str
    value: int


@dataclass(frozen=True, slots=True)
class Question:
    prompt: str
    helper_text: str | None = None


@dataclass(frozen=True, slots=True)
class QuestionnaireContent:
    display_name: str
    questions: tuple[Question, ...]
    response_options: tuple[ResponseOption, ...]


QUESTIONNAIRE_CONTENT = QuestionnaireContent(
    display_name="K6-Based Psychological Distress Check",
    questions=(
        Question(prompt="Over the past 30 days, how often did you feel nervous?"),
        Question(prompt="Over the past 30 days, how often did you feel hopeless?"),
        Question(
            prompt="Over the past 30 days, how often did you feel restless or fidgety?",
            helper_text=(
                "Restless or fidgety means finding it hard to relax or stay still."
            ),
        ),
        Question(
            prompt=(
                "Over the past 30 days, how often did you feel so down that nothing "
                "could cheer you up?"
            )
        ),
        Question(
            prompt=(
                "Over the past 30 days, how often did it feel like everything took a "
                "lot of effort?"
            ),
            helper_text=(
                "This means ordinary things felt harder or more tiring to do than usual."
            ),
        ),
        Question(
            prompt="Over the past 30 days, how often did you feel like you had no value?"
        ),
    ),
    response_options=(
        ResponseOption(label="None of the time", value=0),
        ResponseOption(label="A little of the time", value=1),
        ResponseOption(label="Some of the time", value=2),
        ResponseOption(label="Most of the time", value=3),
        ResponseOption(label="All of the time", value=4),
    ),
)
