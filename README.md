# Daily Job Mailer

A small Node.js cron job that emails a digest of **new** job posts every day at **1:00 PM IST**. It runs for free on GitHub Actions.

It looks for these roles:

- Java Developer · Java Full Stack Developer · Spring Boot Developer
- Backend Developer · Node.js Developer
- Software Engineer · Associate Software Engineer
- Graduate Engineer Trainee · Trainee Software Engineer

In these locations: **Ahmedabad**, **Gandhinagar** and **Remote India**. You can change both lists without touching code (see [Configuration](#configuration)).

---

## How it works

```
GitHub Actions (daily 07:30 UTC)
        │
        ▼
 ┌─────────────── fetch (providers in parallel, rate-limited, with retries) ───────────────┐
 │ Adzuna*   Jooble*   Google Jobs via SerpApi*   → Ahmedabad / Gandhinagar / Remote India │
 │ Himalayas   Jobicy  (free, no key)             → Remote India                           │
 └────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 filter:  title matches a keyword  →  location is really Ahmedabad/Gandhinagar or remote-for-India
          →  posted within FRESH_HOURS  →  not already emailed  →  de-duplicate across sources
        │
        ▼
 email grouped by location  →  remember sent jobs in .cache/seen-jobs.json (kept via actions/cache)

 * needs a (free) API key
```

### Job sources

| Source | Covers | Key needed | Free limit | Notes |
|---|---|---|---|---|
| [Adzuna](https://developer.adzuna.com) | Cities + remote | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | 250 calls/day | **Best free source for Ahmedabad/Gandhinagar** |
| [Jooble](https://jooble.org/api/about) | Cities + remote | `JOOBLE_API_KEY` | generous | Aggregates Indian job boards |
| [SerpApi Google Jobs](https://serpapi.com) | Cities + remote | `SERPAPI_API_KEY` | ~100–250 searches/month | Includes LinkedIn / Naukri / Indeed posts |
| [Himalayas](https://himalayas.app/api) | Remote India | none | — | Always on |
| [Jobicy](https://jobicy.com) | Remote (APAC / Anywhere) | none | — | Always on |

> **Important:** without Adzuna, Jooble or SerpApi keys, only **Remote India** jobs can be found. No free no-key API lists Ahmedabad/Gandhinagar jobs. When no city source is set up, the email includes a note saying so.

### Filtering rules

- **Title match:** a title matches a keyword when it has all the keyword's main words plus any role word (developer, engineer, programmer, SDE, dev). So `Java Developer` also matches *Java Backend Engineer*, `Node.js Developer` matches *NodeJS Dev*, and `Software Engineer` does **not** match *AI Researcher*. Spelling variants are unified: `Node JS/node.js/nodejs`, `Spring Boot/spring-boot`, `Back-end/backend`, `Full Stack/full-stack`.
- **Exclusions:** titles containing any `EXCLUDE_KEYWORDS` entry are dropped. For example `Senior, Sr, Lead, Principal` keeps the digest fresher-friendly.
- **City jobs:** the job's location must actually mention the city.
- **Remote India:** the job must be remote *and* open to India: no region restriction, or one of India / Worldwide / Anywhere / APAC / Asia.
- **Freshness:** posted within `FRESH_HOURS` (default 48). Jobs with no date are skipped unless `INCLUDE_UNKNOWN_DATES=true`.
- **No repeats:** each emailed job is remembered for 30 days by link and by title + company. A job is never sent twice, even when another site reposts it under a different link.

---

## Setup (GitHub Actions)

1. **Push this repo to GitHub.** The workflow is in `.github/workflows/daily-job-mailer.yml`.
2. **Add secrets** under *Settings → Secrets and variables → Actions → New repository secret*:

   | Secret | Required | Example |
   |---|---|---|
   | `EMAIL_TO` | ✅ | `you@gmail.com` |
   | `EMAIL_FROM` | optional (defaults to `SMTP_USER`) | `you@gmail.com` |
   | `SMTP_HOST` | ✅ | `smtp.gmail.com` |
   | `SMTP_PORT` | optional (default `465`) | `465` or `587` |
   | `SMTP_SECURE` | optional (auto: `true` for 465, `false` otherwise) | |
   | `SMTP_USER` | ✅ | `you@gmail.com` |
   | `SMTP_PASS` | ✅ | Gmail **App Password** (16 chars) |
   | `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | recommended | from developer.adzuna.com |
   | `JOOBLE_API_KEY` | recommended | from jooble.org/api/about |
   | `SERPAPI_API_KEY` | optional | from serpapi.com |

   **Gmail:** turn on 2-Step Verification, then create an App Password at <https://myaccount.google.com/apppasswords>. Your normal password will not work.

3. **Test it:** open the *Actions* tab → **Daily job mailer** → **Run workflow**. You should get an email within a minute or two.

---

## Configuration

All settings are optional. Set them as **Variables** (*Settings → Secrets and variables → Actions → Variables*) or in `.env` locally. Lists are comma-separated.

| Variable | Default | What it does |
|---|---|---|
| `SEARCH_KEYWORDS` | the 9 roles above | Roles to search for and match titles against |
| `SEARCH_LOCATIONS` | `Ahmedabad, Gandhinagar, Remote India` | Cities, plus `Remote <Country>` for remote jobs |
| `EXCLUDE_KEYWORDS` | *(none)* | Drop titles containing any of these, e.g. `Senior, Sr, Lead, Principal, Staff, Manager` |
| `SERPAPI_KEYWORDS` | same as `SEARCH_KEYWORDS` | Smaller list used only for SerpApi, to save credits |
| `MAX_RESULTS` | `50` | Maximum jobs per email |
| `FRESH_HOURS` | `48` | Only include jobs posted within this many hours |
| `INCLUDE_UNKNOWN_DATES` | `false` | Include jobs without a posting date |
| `DRY_RUN` | `false` | Print the digest instead of emailing it (nothing is marked as seen) |
| `SEEN_JOBS_DAYS` | `30` | How long to remember sent jobs |

### API usage per run

Searches per run = keywords × locations (9 × 3 = 27 by default):

- **Adzuna:** 27 calls, spaced about 2.6 s apart to stay under 25/minute. Well within 250/day.
- **Jooble:** 27 calls.
- **SerpApi:** 27 searches/day is about 810/month, **more than the free plan**. Set `SERPAPI_KEYWORDS` to 2–3 broad roles (for example `Java Developer, Software Engineer`), which uses 6–9 searches/day, or use a paid plan.
- **Himalayas:** 9 calls. **Jobicy:** 1 call.

When a key is wrong or a quota runs out (HTTP 401/403), that source stops after the first failed call and the email shows a note. The other sources still run.

---

## Run locally

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env      # then fill in your values
npm run dry-run           # prints the digest, sends nothing
npm start                 # sends the email
```

`.env` is loaded automatically, and it's in `.gitignore`, so it won't be committed.

---

## Project structure

```
src/
  index.js        entry point: run providers → filter → email → remember
  config.js       reads env vars (and .env) into one config object
  providers.js    Adzuna, Jooble, SerpApi, Himalayas, Jobicy clients
  matching.js     title matching, location/remote checks, date and text helpers
  seen-store.js   remembers already-emailed jobs (.cache/seen-jobs.json)
  email.js        builds the subject + HTML/text email and sends it via SMTP
  http.js         fetch with timeout, retries and Retry-After support
.github/workflows/daily-job-mailer.yml   daily schedule + seen-jobs cache
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Workflow never runs on schedule | GitHub **turns off scheduled workflows after 60 days with no commits**. Open *Actions* → the workflow → **Enable workflow**, or push any commit. Schedules only run from the default branch. |
| `Missing required email settings` | A required secret is missing or misspelled. Names are case-sensitive. |
| `Invalid login` / `535` from Gmail | Use an App Password, not your normal password. |
| Timeout connecting to SMTP on port 587 | Leave `SMTP_SECURE` empty (or set `false`) for 587. Use `true` only with 465. |
| Only "Remote India" jobs, never Ahmedabad | No city source configured. Add Adzuna and/or Jooble keys. |
| `Adzuna: 1/27 searches failed, 26 skipped (401 …)` | Wrong Adzuna ID/key. |
| `Google Jobs: … run out of searches` | SerpApi monthly quota used up. Set `SERPAPI_KEYWORDS` to fewer roles. |
| The same jobs every day | The seen-jobs cache isn't being restored. Check the *Restore seen jobs* step log. Dry runs never save. |
| Email says "no new roles" | Nothing new matched in the window. Try `FRESH_HOURS=72` or more keywords. |

---

## License

MIT
