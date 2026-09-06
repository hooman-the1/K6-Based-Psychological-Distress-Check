const form = document.querySelector("[data-questionnaire]");

if (form) {
    const steps = Array.from(form.querySelectorAll("[data-question-step]"));
    let currentStep = 0;

    const updateNextButtonState = () => {
        const currentQuestion = steps[currentStep];
        const nextButton = currentQuestion.querySelector(
            "[data-questionnaire-next]",
        );

        if (nextButton) {
            nextButton.disabled = !currentQuestion.querySelector(
                'input[type="radio"]:checked',
            );
        }
    };

    const showStep = (stepNumber) => {
        currentStep = stepNumber;
        steps.forEach((step, index) => {
            step.hidden = index !== currentStep;
        });
        updateNextButtonState();
    };

    const clearCurrentResponse = () => {
        const selectedResponse = steps[currentStep].querySelector(
            'input[type="radio"]:checked',
        );
        if (selectedResponse) {
            selectedResponse.checked = false;
        }
    };

    form.reset();
    showStep(0);

    form.addEventListener("change", (event) => {
        if (
            event.target.matches('input[type="radio"]') &&
            steps[currentStep].contains(event.target)
        ) {
            updateNextButtonState();
        }
    });

    form.addEventListener("click", (event) => {
        const nextButton = event.target.closest("[data-questionnaire-next]");
        const backButton = event.target.closest("[data-questionnaire-back]");

        if (!nextButton && !backButton) {
            return;
        }

        clearCurrentResponse();
        if (nextButton) {
            showStep(Math.min(currentStep + 1, steps.length - 1));
        } else {
            showStep(Math.max(currentStep - 1, 0));
        }
    });
}
