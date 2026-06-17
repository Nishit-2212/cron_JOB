# Daily Job Mailer

This Node.js script sends a daily email with fresh job posts for:

- Java Developer
- Backend Developer
- Spring Boot Developer
- Software Engineer
- Associate Software Engineer
- Graduate Engineer Trainee
- Trainee Software Engineer
- Java Full Stack Developer
- Node.js Developer

Locations:

- Ahmedabad
- Gandhinagar
- Remote India

The included GitHub Actions workflow runs every day at **1:00 PM Asia/Kolkata**.

## How it searches

The script searches public job APIs first:

- Remotive for remote jobs
- Arbeitnow for public job-board results
- Adzuna, if you add `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`
- Jooble, if you add `JOOBLE_API_KEY`
- Google Jobs through SerpApi, if you add `SERPAPI_API_KEY`

For LinkedIn, the reliable route is `SERPAPI_API_KEY`, because Google Jobs often includes LinkedIn results without logging in or scraping LinkedIn directly.

## Required GitHub secrets

Add these in your GitHub repo:

`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`

Required:

- `EMAIL_TO`
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`

Optional:

- `SERPAPI_API_KEY`
- `ADZUNA_APP_ID`
- `ADZUNA_APP_KEY`
- `JOOBLE_API_KEY`

For Gmail, use an app password for `SMTP_PASS`; your normal Gmail password will not work.

## Optional GitHub variables

Add these under `Secrets and variables` -> `Actions` -> `Variables`:

- `MAX_RESULTS`, default `50`
- `FRESH_HOURS`, default `36`
- `INCLUDE_UNKNOWN_DATES`, default `false`
- `DRY_RUN`, default `false`

## Run locally

```bash
npm install
npm start
```

You can copy `.env.example` to `.env` for local testing, but do not commit `.env`.

To test without sending email:

```bash
DRY_RUN=true npm start
```

## Deploy choice

GitHub Actions is the simplest deployment for this project because the repository itself can run the daily cron. Render or Railway would also work, but they add another account, billing/runtime setup, and environment-variable screen for a job that only needs to run once per day.
