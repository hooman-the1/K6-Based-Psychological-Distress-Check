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
    const collapseHelper = (step) => {
        const helperButton = step.querySelector("[data-question-helper]");
        const helperCopy = step.querySelector("[data-question-helper-copy]");

        if (helperButton && helperCopy) {
            helperButton.setAttribute("aria-expanded", "false");
            helperCopy.hidden = true;
        }
    };
    const showStep = (stepNumber) => {
        if (stepNumber !== currentStep) {
            collapseHelper(steps[currentStep]);
        }
        currentStep = stepNumber;
        steps.forEach((step, index) => {
            step.hidden = index !== currentStep;
        });
        updateNextButtonState();
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
        const helperButton = event.target.closest("[data-question-helper]");

        if (helperButton && steps[currentStep].contains(helperButton)) {
            const helperCopy = document.getElementById(
                helperButton.getAttribute("aria-controls"),
            );

            helperButton.setAttribute("aria-expanded", "true");
            helperCopy.hidden = false;
            return;
        }

        const nextButton = event.target.closest("[data-questionnaire-next]");
        const backButton = event.target.closest("[data-questionnaire-back]");

        if (!nextButton && !backButton) {
            return;
        }

        if (nextButton) {
            showStep(Math.min(currentStep + 1, steps.length - 1));
        } else {
            showStep(Math.max(currentStep - 1, 0));
        }
    });
}
