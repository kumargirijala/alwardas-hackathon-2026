# Alwardas Student Hackathon 2026

Starter examination system with Admin and Student panels, 45-minute Round 1 (English + Reasoning), 90-minute Round 2 (HTML + Python), per-student question shuffling, saved-answer recording, live admin responses, results, feedback, and Google Sheets integration.

## Run locally
1. Install Node.js 18+ (Node 20+ recommended).
2. Open a terminal in this folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env` and change `SESSION_SECRET`.
5. Run `npm start`.
6. Open `http://localhost:3000`.

## Admin
Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in your environment before deployment. Do not keep a default admin password in the repo or in source control.

## Student data
`data/students.csv` is a development snapshot of the registration responses you uploaded. For live registration, use the Google Apps Script bridge below.

## Live Google Sheets
1. Open the Google Sheet connected to your Google Form.
2. Extensions -> Apps Script.
3. Replace the Apps Script code with `google-apps-script/Code.gs`.
4. Change `ACCESS_TOKEN` to a long random secret.
5. Deploy -> New deployment -> Web app. Execute as yourself; allow access to anyone with the link.
6. Copy the Web App URL into `.env` as `GOOGLE_SHEETS_WEB_APP_URL`. Put the same secret into `.env` as `GOOGLE_SHEETS_TOKEN`.
7. Restart the Node server.

The server refreshes registered students from the sheet every minute, so new Google Form registrations can become available for login without editing the CSV. Saved answers are also sent to an `Exam Responses` tab.

## Questions
Edit `data/questions.json`. Round 1 currently has 30 sample questions: English + Reasoning. Round 2 currently has 30 sample questions: HTML + Python. Keep each question object shaped like:
`{ "id": "R1-Q1", "section": "English", "question": "...", "options": ["A", "B", "C", "D"], "correct": "A" }`

## Important deployment note
This project is a development architecture. For a real high-stakes exam, use HTTPS, a production session store/database, rate limiting, strong admin authentication, backups, and server-side persistence for exam state/results. Browser anti-cheating controls can detect and deter many actions but cannot guarantee that a browser user can never open another window.
