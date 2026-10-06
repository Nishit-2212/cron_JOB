# Daily Job Mailer

A small Node.js cron job that emails you **new** fresher / junior job posts **once a day around 12 PM IST**. It runs for free on GitHub Actions.

It looks for these roles:

- Java Developer · Java Full Stack Developer · Spring Boot Developer
- Backend Developer · Node.js Developer
- Software Engineer · Associate Software Engineer
- Graduate Engineer Trainee · Trainee Software Engineer

In **Ahmedabad**, **Gandhinagar** and **Remote India**, plus every new IT/Software fresher drive posted on **[OffCampusJobs4u](https://offcampusjobs4u.com)**. You can change all of this without touching code (see [Configuration](#configuration)).

Each email only contains jobs you haven't been sent before. On a day with nothing new you still get a short email, so you know it ran (`SEND_EMPTY_DIGEST=false` turns those off).

---

## How it works

```
GitHub Actions (daily, 12:07 PM IST)
        │
        ▼
 ┌──────────────── fetch (sources in parallel, rate-limited, with retries) ─────────────────┐
 │ Adzuna*   Jooble*   Google Jobs via SerpApi*   → Ahmedabad / Gandhinagar / Remote India   │
 │ Himalayas   Jobicy  (free, no key)             → Remote India                             │
 │ OffCampusJobs4u RSS feed (free, no key)        → Off-campus fresher drives (all India)    │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 filter:  title matches a keyword  →  location is really Ahmedabad/Gandhinagar or remote-for-India
          →  fresher/junior level (≤ MAX_EXPERIENCE_YEARS)  →  posted within FRESH_HOURS
          →  not already emailed  →  de-duplicate across sources
        │
        ▼
 email grouped by section  →  remember sent jobs in .cache/seen-jobs.json (kept via actions/cache)

 * needs a (free) API key
```

### Job sources

| Source | Covers | Key needed | Free limit | Notes |
|---|---|---|---|---|
| [Adzuna](https://developer.adzuna.com/signup) | Cities + remote | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | 250 calls/day | **Needed for Ahmedabad/Gandhinagar** |
| [Jooble](https://jooble.org/api/about) | Cities + remote | `JOOBLE_API_KEY` | generous | Aggregates Indian job boards |
| [SerpApi Google Jobs](https://serpapi.com) | Cities + remote | `SERPAPI_API_KEY` | 250 searches/month | Includes LinkedIn / Naukri / Indeed posts. Only ~8 searches a day fit the free plan, so it rotates. See [API usage](#api-usage-per-run) |
| [Himalayas](https://himalayas.app/api) | Remote India | none | — | Always on |
| [Jobicy](https://jobicy.com) | Remote (APAC / Anywhere) | none | — | Always on |
| [OffCampusJobs4u](https://offcampusjobs4u.com) | Fresher drives, all India | none | — | Read from the site's public RSS feed. It holds 10 posts (about a day), so older pages are read back through `FRESH_HOURS` (max 5 pages). Only posts tagged IT/Software are kept |

> **Important: Ahmedabad and Gandhinagar need an Adzuna or Jooble key.** No free job API that works without a key covers Indian cities (Careerjet now requires a key, LinkedIn and Naukri block automated requests, and the other free sources are remote-only). Without them those two sections show *"Not searched"* (or only get the few rotating Google Jobs searches SerpApi's free plan allows), and a red **Action needed** box appears at the top of every email. Both Adzuna and Jooble keys are free. See [Setup](#setup-github-actions), step 2.

### Filtering rules

- **Title match:** a title matches a keyword when it has all the keyword's main words plus a role word (developer, engineer, programmer, SDE, dev, intern). So `Java Developer` also matches *Java Backend Engineer*, `Node.js Developer` matches *NodeJS Dev*, and `Software Engineer` does **not** match *AI Researcher*. Spelling variants are unified: `Node/Node JS/node.js/nodejs`, `Spring Boot/spring-boot`, `Back-end/backend`, `Full Stack/full-stack`, and `SDE`/`SWE` count as software engineer (so *SDE 1* matches `Software Engineer`). Internships match too; add `Intern` to `EXCLUDE_KEYWORDS` to drop them.
- **Fresher / junior only** (`MAX_EXPERIENCE_YEARS`, default `2`). A job is hidden if:
  - its title contains Senior, Sr, Staff, Principal, Lead, Manager, Architect, Director, Head, VP, Chief, Founding, or a level like II / III / IV;
  - the job board labels it Senior, Manager, Director or similar (Himalayas, Jobicy);
  - or its description asks for more than 2 years, e.g. "5+ years of experience" or "Experience: 3–5 years".

  The email footer says how many roles were hidden. Set `MAX_EXPERIENCE_YEARS=any` to turn this off.
- **Extra exclusions:** titles containing any `EXCLUDE_KEYWORDS` entry are dropped.
- **City jobs:** the job's location must mention the city. Other spellings count, e.g. *Ahmadabad* or *Amdavad* for Ahmedabad and *GIFT City* for Gandhinagar.
- **Remote India:** the job must be remote *and* open to India: no region restriction, or one of India / Worldwide / Anywhere / APAC / Asia.
- **OffCampusJobs4u:** IT/Software posts with a tech word in the title (software, developer, engineer, IT, Java, QA, NQT, …) are included, since the site only lists fresher drives. Loosely tagged posts such as *Transportation Specialist* or *Executive Assistant* are dropped. The years check still applies, because the site's tags are loose. A drive located in Ahmedabad or Gandhinagar goes into that city's section.
- **Freshness:** posted within `FRESH_HOURS` (default 48). Google Jobs results may be a few days older, because each of its searches only comes round every few days (see [API usage](#api-usage-per-run)). Jobs with no date are skipped unless `INCLUDE_UNKNOWN_DATES=true`.
- **No repeats:** each emailed job is remembered for 30 days by link and by title + company. A job is never sent twice, even when another site reposts it under a different link.

---

## Setup (GitHub Actions)

1. **Push this repo to GitHub.** The workflow is in `.github/workflows/daily-job-mailer.yml`.

2. **Get free API keys for city jobs.** Without them you'll only get Remote India and OffCampusJobs4u jobs.
   - **Adzuna:** sign up at <https://developer.adzuna.com/signup>. Your *Application ID* and *Application Key* are shown on the dashboard straight away.
   - **Jooble:** fill in the form at <https://jooble.org/api/about>. The key is emailed to you.

3. **Add secrets** under *Settings → Secrets and variables → Actions → New repository secret*:

   | Secret | Required | Example |
   |---|---|---|
   | `EMAIL_TO` | ✅ | `you@gmail.com` |
   | `EMAIL_FROM` | optional (defaults to `SMTP_USER`) | `you@gmail.com` |
   | `SMTP_HOST` | ✅ | `smtp.gmail.com` |
   | `SMTP_PORT` | optional (default `465`) | `465` or `587` |
   | `SMTP_SECURE` | optional (auto: `true` for 465, `false` otherwise) | |
   | `SMTP_USER` | ✅ | `you@gmail.com` |
   | `SMTP_PASS` | ✅ | Gmail **App Password** (16 chars) |
   | `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | for city jobs | from step 2 |
   | `JOOBLE_API_KEY` | for city jobs | from step 2 |
   | `SERPAPI_API_KEY` | optional | from serpapi.com |

   **Gmail:** turn on 2-Step Verification, then create an App Password at <https://myaccount.google.com/apppasswords>. Your normal password will not work.

4. **Test it:** open the *Actions* tab → **Daily job mailer** → **Run workflow**. You should get an email within a minute or two.

---

## Configuration

All settings are optional. Set them as **Variables** (*Settings → Secrets and variables → Actions → Variables*) or in `.env` locally. Lists are comma-separated.

| Variable | Default | What it does |
|---|---|---|
| `SEARCH_KEYWORDS` | the 9 roles above | Roles to search for and match titles against |
| `SEARCH_LOCATIONS` | `Ahmedabad, Gandhinagar, Remote India` | Cities, plus `Remote <Country>` for remote jobs |
| `MAX_EXPERIENCE_YEARS` | `2` | Hide roles asking for more years than this, and senior titles. `any` turns it off |
| `EXCLUDE_KEYWORDS` | *(none)* | Extra title words to drop, e.g. `Intern, Sales` |
| `OFFCAMPUS_JOBS` | `true` | Include fresher drives from offcampusjobs4u.com |
| `SEND_EMPTY_DIGEST` | `true` | Send the email even when nothing new was found. `false` skips quiet days |
| `SERPAPI_KEYWORDS` | same as `SEARCH_KEYWORDS` | Smaller list used only for SerpApi |
| `SERPAPI_DAILY_SEARCHES` | monthly quota / 31 (8 on the free plan) | SerpApi searches per run. Raise it on a paid plan |
| `MAX_RESULTS` | `50` | Maximum jobs per email |
| `FRESH_HOURS` | `48` | Only include jobs posted within this many hours |
| `INCLUDE_UNKNOWN_DATES` | `false` | Include jobs without a posting date |
| `DRY_RUN` | `false` | Print the digest instead of emailing it (nothing is marked as seen) |
| `SEEN_JOBS_DAYS` | `30` | How long to remember sent jobs |

**Changing the schedule:** edit the `cron:` line in `.github/workflows/daily-job-mailer.yml`. Times are in **UTC**, and IST is UTC + 5:30, so subtract 5:30 from the IST time you want:

| You want (IST) | `cron:` value |
|---|---|
| 12:07 PM daily (current) | `"37 6 * * *"` |
| 9:07 AM daily | `"37 3 * * *"` |
| 9:07 AM and 6:07 PM daily | `"37 3,12 * * *"` |

### API usage per run

Adzuna and Jooble make keywords × locations searches every run (9 × 3 = 27 by default). SerpApi can't: 27 a day would use the free 250 in 9 days. So before searching, it checks how many searches are left (free, via the [Account API](https://serpapi.com/account-api)) and runs only a daily share of them, carrying on through the 27 searches the next day:

| Source | Calls per run (= per day) | Free limit |
|---|---|---|
| Adzuna | 27, spaced ~2.6 s apart to stay under 25/min | 250/day ✅ |
| Jooble | 27 | ✅ |
| SerpApi | 8 of the 27, rotating (each is repeated every 4 days), ~248/month | 250/month ✅. When none are left, Google Jobs is skipped with a grey note until the plan renews |
| Himalayas | 9 | no key |
| Jobicy | 1 | no key |
| OffCampusJobs4u | 2–3 feed pages (max 5) | no key |

When a key is wrong, a quota runs out or a source keeps rate-limiting (HTTP 401/403/429), that source stops after the first failed call and the email shows an **Action needed** note with the API's own error message. The other sources still run. The email footer lists how many postings each source returned, so a source that quietly returns nothing is easy to spot.

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
  index.js        entry point: run sources → filter → email → remember
  config.js       reads env vars (and .env) into one config object
  providers.js    Adzuna, Jooble, SerpApi, Himalayas, Jobicy, OffCampusJobs4u clients
  matching.js     title matching, seniority/experience checks, location checks, date and text helpers
  seen-store.js   remembers already-emailed jobs (.cache/seen-jobs.json)
  email.js        builds the subject + HTML/text email and sends it via SMTP
  http.js         fetch with timeout, retries and Retry-After support
.github/workflows/daily-job-mailer.yml   daily schedule (12:07 PM IST) + seen-jobs cache
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No Ahmedabad / Gandhinagar jobs ("Not searched") | No city source is configured. Add Adzuna and/or Jooble keys ([Setup](#setup-github-actions) step 2). |
| Workflow never runs on schedule | In public repos GitHub **turns off scheduled workflows after 60 days with no commits** (a yellow banner appears on the workflow page). Open *Actions* → **Daily job mailer** → **Enable workflow**; pushing a commit alone does not turn it back on. Schedules only run from the default branch. |
| Email arrives hours after 12 PM | GitHub queues scheduled runs and often starts them late (5+ hours has been seen) when its runners are busy, especially at the start of an hour. For exact timing, trigger the workflow from an external cron service (e.g. cron-job.org) via the `workflow_dispatch` API. |
| Too few jobs | Set `MAX_EXPERIENCE_YEARS=3` (or `any`), raise `FRESH_HOURS`, or add keywords. |
| `Missing required email settings` | A required secret is missing or misspelled. Names are case-sensitive. |
| `Invalid login` / `535` from Gmail | Use an App Password, not your normal password. |
| Timeout connecting to SMTP on port 587 | Leave `SMTP_SECURE` empty (or set `false`) for 587. Use `true` only with 465. |
| `Adzuna: 1/27 searches failed, 26 skipped (401 …)` | Wrong Adzuna ID/key. |
| `Google Jobs: … run out of searches` / `429` | SerpApi monthly quota used up, e.g. by extra manual runs or another app using the same key. It resumes when the plan renews; meanwhile Adzuna/Jooble keep the city sections going. |
| Ahmedabad / Gandhinagar always empty | Check the footer: if Adzuna and Jooble aren't listed, add their keys. If they are listed with 0, the API returned nothing for your keywords — add more keywords or cities (e.g. `Vadodara`). |
| The same jobs keep coming back | The seen-jobs cache isn't being restored. Check the *Restore seen jobs* step log. Dry runs never save. |

---

## License

MIT
