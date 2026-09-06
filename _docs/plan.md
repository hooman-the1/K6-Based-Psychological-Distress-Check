# K6-Based Psychological Distress Check — MVP Scope

## 1. Goal

Build a **frontend-only, mobile-first portfolio demo** that provides a simple psychological-distress self-assessment based on the K6 questionnaire.

The app should be credible enough for realistic use while primarily demonstrating solid frontend engineering.

Because the question wording will be simplified, the product must be described as **K6-based**, not as the validated K6 instrument itself.

---

## 2. Target User

General adult users.

No:
- authentication
- account system
- age verification
- user profiles

---

## 3. Core Flow

Home → Test → Result → History

Routes:

- `/`
- `/test`
- `/result`
- `/history`

No persistent navigation bar or footer.

---

## 4. Home

Contains:

- App/test name
- Very short introduction
- Start Test CTA
- View History CTA

Does not contain:

- previous score
- detailed K6 explanation
- disclaimer
- citations
- privacy notice
- age notice
- About section

If browser storage is unavailable:

- History entry point is disabled/hidden
- A short non-blocking notice is shown

---

## 5. Questionnaire

Six questions.

### Presentation

One question per screen.

Each screen shows:

- `Question X of 6`
- Progress bar
- Question
- Optional “What does this mean?” link
- Large selectable answer cards
- Next button
- Back button from Question 2 onward

### Wording

Questions use a **plain-language adaptation** of K6.

The original **30-day timeframe** is preserved in each question.

Because wording is modified, the app must not claim that this is the validated K6 questionnaire.

### Response options

Use the original K6 response scale unchanged.

### Helper text

When clarification is useful:

`What does this mean?`

opens helper text inline.

Once opened, it stays expanded until the user leaves that question.

Returning to the question resets the helper text to collapsed.

### Interaction

- All six questions are mandatory.
- Next is disabled until an answer is selected.
- Selecting an answer does not automatically advance.
- Previous answers remain selected when navigating backward.
- Selected cards receive only a subtle border-state change.
- Progress changes instantly with no animation.

Last-question CTA:

**See my result**

implemented as the questionnaire submit action.

### Abandoning the test

No:

- restart button
- exit button
- unsaved-progress warning
- persisted draft

Refreshing, closing, or leaving the questionnaire loses current answers.

Browser Back/Forward receives no special questionnaire-step behavior.

---

## 6. Scoring

Use the original K6 scoring model.

Score range:

**0–24**

Use one cutoff:

**13+ → serious/elevated psychological distress threshold**

No custom severity levels such as:

- mild
- moderate
- severe

Higher scores represent greater psychological distress.

Important implementation constraint:

Although original K6 scoring is retained, the modified question wording means the original instrument's psychometric validation cannot automatically be assumed to apply to this implementation.

---

## 7. Result Screen

Show:

- prominent raw score, e.g. `14 / 24`
- above/below cutoff status
- short plain-language interpretation
- short statement explaining that higher scores indicate greater psychological distress
- same brief general guidance for every user
- curated mental-health resources
- “Take test again” CTA

Resources include both:

- reputable mental-health organizations
- practical self-help/coping resources

Resource links are hardcoded.

Do not show:

- individual question answers
- visual score gauge
- progress visualization
- urgent-help notice
- extra diagnostic/screening disclaimer
- adaptation caveat
- different guidance based on score

Every successfully completed test is automatically added to history.

`/result` depends on in-memory result state.

Refreshing `/result` without an active result redirects to Home.

---

## 8. Local History

No backend or remote persistence.

Use browser `localStorage`.

Store only:

```text
score
timestamp
```

Do not store individual answers.

Maximum history:

**20 results**

When result #21 is stored, remove the oldest result.

Multiple tests on the same day are allowed.

### History Screen

Show:

1. Line chart
2. Results list
3. Clear All History action

### Chart

- line chart
- oldest → newest
- includes horizontal K6 cutoff reference line
- static
- no tooltip
- no tap interaction
- short explanation of the cutoff line

### Results list

Newest first.

Each entry shows:

- date
- time
- score
- above/below cutoff status

Entries are not clickable.

No dedicated historical-result screen.

### Empty state

Show:

- short empty-state message
- Take Test CTA

### Clear history

“Clear all history” removes everything immediately.

No confirmation dialog.

---

## 9. Storage Failure

If `localStorage` is unavailable or throws an error:

The questionnaire and result flow must continue working normally.

History functionality is disabled.

Show a small, non-blocking notice informing the user that saved history is unavailable.

---

## 10. UI Scope

Mobile-first only.

Single light theme.

Functional, clean, basic visual design.

No:

- desktop-specific optimization requirement
- dark mode
- animations
- advanced branding
- illustrations
- skeleton/loading states
- PWA/offline support

Basic reasonable semantic HTML is expected, but explicit accessibility/WCAG compliance is outside MVP scope.

---

## 11. Testing

Automated testing is part of the MVP.

At minimum test:

- K6 scoring logic
- cutoff calculation
- questionnaire navigation
- answer persistence while moving Back/Next
- required-answer behavior
- successful submission
- automatic history saving
- 20-result history limit
- Clear All History
- localStorage failure fallback
- result-route redirect without active state

---

## 12. Explicitly Out of Scope

- backend
- database
- authentication
- accounts
- cloud synchronization
- analytics
- telemetry
- public deployment
- sharing
- exports
- downloadable result cards
- notifications
- crisis-resource logic
- location-specific resources
- multiple languages
- accessibility certification
- desktop-specific design
- offline/PWA mode
- configurable resources
- diagnostic claims
- custom psychological severity system

---

## 13. Definition of MVP

The MVP is complete when a user can:

1. Open the app.
2. Start the assessment.
3. Answer all six questions.
4. Navigate backward and forward.
5. Submit the assessment.
6. Receive the calculated score and cutoff interpretation.
7. Access useful resource links.
8. Automatically save the score locally.
9. Retake the assessment at any time.
10. View up to 20 previous scores in a list and trend chart.
11. Clear the entire history.
12. Still complete the test successfully if local storage is unavailable.
