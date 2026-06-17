import nodemailer from "nodemailer";
import crypto from "node:crypto";

const DEFAULT_KEYWORDS = [
  "Java Developer",
  "Backend Developer",
  "Spring Boot Developer",
  "Software Engineer",
  "Associate Software Engineer",
  "Graduate Engineer Trainee",
  "Trainee Software Engineer",
  "Java Full Stack Developer",
  "Node.js Developer"
];

const DEFAULT_LOCATIONS = ["Ahmedabad", "Gandhinagar", "Remote India"];

const config = {
  keywords: readList("SEARCH_KEYWORDS", DEFAULT_KEYWORDS),
  locations: readList("SEARCH_LOCATIONS", DEFAULT_LOCATIONS),
  maxResults: Number.parseInt(process.env.MAX_RESULTS || "50", 10),
  freshHours: Number.parseInt(process.env.FRESH_HOURS || "36", 10),
  includeUnknownDates: parseBoolean(process.env.INCLUDE_UNKNOWN_DATES, false),
  dryRun: parseBoolean(process.env.DRY_RUN, false),
  email: {
    to: process.env.EMAIL_TO,
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    host: process.env.SMTP_HOST,
    port: Number.parseInt(process.env.SMTP_PORT || "465", 10),
    secure: parseBoolean(process.env.SMTP_SECURE, true),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  providers: {
    serpApiKey: process.env.SERPAPI_API_KEY,
    adzunaAppId: process.env.ADZUNA_APP_ID,
    adzunaAppKey: process.env.ADZUNA_APP_KEY,
    joobleApiKey: process.env.JOOBLE_API_KEY
  }
};

const cutoff = new Date(Date.now() - config.freshHours * 60 * 60 * 1000);

async function main() {
  validateEmailConfig();

  const searches = [];
  for (const keyword of config.keywords) {
    for (const location of config.locations) {
      searches.push({ keyword, location });
    }
  }

  const providerCalls = [
    searchArbeitnow(),
    ...config.keywords.map((keyword) => searchRemotive(keyword)),
    ...searches.flatMap(({ keyword, location }) => [
      searchAdzuna(keyword, location),
      searchJooble(keyword, location),
      searchSerpApiGoogleJobs(keyword, location)
    ])
  ];

  const settled = await Promise.allSettled(providerCalls);
  const jobs = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failures = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || String(result.reason));

  const freshJobs = jobs
    .filter(isRelevantJob)
    .filter(isFreshJob)
    .sort(sortByNewest)
    .slice(0, config.maxResults);

  const uniqueJobs = dedupeJobs(freshJobs).slice(0, config.maxResults);

  await sendEmail(uniqueJobs, failures);

  console.log(config.dryRun
    ? `Dry run completed with ${uniqueJobs.length} matching jobs.`
    : `Sent ${uniqueJobs.length} jobs to ${config.email.to}.`);
  if (failures.length) {
    console.log(`Provider warnings: ${failures.join(" | ")}`);
  }
}

async function searchRemotive(keyword) {
  const url = new URL("https://remotive.com/api/remote-jobs");
  url.searchParams.set("search", keyword);
  url.searchParams.set("limit", "25");

  const data = await fetchJson(url);
  return (data.jobs || [])
    .filter((job) => matchesConfiguredLocation(job.candidate_required_location || "", job.description || "", true))
    .map((job) => ({
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location || "Remote",
      url: job.url,
      source: "Remotive",
      postedAt: parseDate(job.publication_date),
      salary: job.salary || "",
      description: stripHtml(job.description || "").slice(0, 240)
    }));
}

async function searchArbeitnow() {
  const data = await fetchJson("https://www.arbeitnow.com/api/job-board-api");

  return (data.data || [])
    .filter((job) => config.keywords.some((keyword) => matchesTokens(`${job.title} ${job.description}`, tokenize(keyword))))
    .filter((job) => matchesConfiguredLocation(job.location || "", job.description || "", Boolean(job.remote)))
    .slice(0, 25)
    .map((job) => ({
      title: job.title,
      company: job.company_name,
      location: job.location || "Not specified",
      url: job.url,
      source: "Arbeitnow",
      postedAt: job.created_at ? new Date(job.created_at * 1000) : null,
      salary: "",
      description: stripHtml(job.description || "").slice(0, 240)
    }));
}

async function searchAdzuna(keyword, location) {
  const { adzunaAppId, adzunaAppKey } = config.providers;
  if (!adzunaAppId || !adzunaAppKey) {
    return [];
  }

  const url = new URL("https://api.adzuna.com/v1/api/jobs/in/search/1");
  url.searchParams.set("app_id", adzunaAppId);
  url.searchParams.set("app_key", adzunaAppKey);
  url.searchParams.set("what", keyword);
  url.searchParams.set("where", location.replace("Remote India", "India"));
  url.searchParams.set("sort_by", "date");
  url.searchParams.set("results_per_page", "25");

  const data = await fetchJson(url);
  return (data.results || []).map((job) => ({
    title: job.title,
    company: job.company?.display_name || "Not specified",
    location: job.location?.display_name || location,
    url: job.redirect_url,
    source: "Adzuna",
    postedAt: parseDate(job.created),
    salary: formatSalary(job),
    description: stripHtml(job.description || "").slice(0, 240)
  }));
}

async function searchJooble(keyword, location) {
  const { joobleApiKey } = config.providers;
  if (!joobleApiKey) {
    return [];
  }

  const data = await fetchJson(`https://jooble.org/api/${joobleApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      keywords: keyword,
      location: location.replace("Remote India", "India"),
      page: 1
    })
  });

  return (data.jobs || []).map((job) => ({
    title: job.title,
    company: job.company || "Not specified",
    location: job.location || location,
    url: job.link,
    source: "Jooble",
    postedAt: parseDate(job.updated || job.date),
    salary: job.salary || "",
    description: stripHtml(job.snippet || "").slice(0, 240)
  }));
}

async function searchSerpApiGoogleJobs(keyword, location) {
  const { serpApiKey } = config.providers;
  if (!serpApiKey) {
    return [];
  }

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_jobs");
  url.searchParams.set("q", keyword);
  url.searchParams.set("location", location.replace("Remote India", "India"));
  url.searchParams.set("hl", "en");
  url.searchParams.set("api_key", serpApiKey);

  const data = await fetchJson(url);
  return (data.jobs_results || []).map((job) => {
    const applyUrl = job.apply_options?.[0]?.link || job.share_link || "";
    return {
      title: job.title,
      company: job.company_name || "Not specified",
      location: job.location || location,
      url: applyUrl,
      source: `Google Jobs${job.detected_extensions?.via ? ` via ${job.detected_extensions.via}` : ""}`,
      postedAt: parseRelativeDate(job.detected_extensions?.posted_at) || parseDate(job.detected_extensions?.posted_at),
      salary: job.detected_extensions?.salary || "",
      description: stripHtml(job.description || "").slice(0, 240)
    };
  });
}

async function sendEmail(jobs, failures) {
  if (config.dryRun) {
    console.log(renderTextEmail(jobs, failures));
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass
    }
  });

  const subject = jobs.length
    ? `Daily job digest: ${jobs.length} fresh role${jobs.length === 1 ? "" : "s"}`
    : "Daily job digest: no fresh roles found";

  await transporter.sendMail({
    from: config.email.from,
    to: config.email.to,
    subject,
    text: renderTextEmail(jobs, failures),
    html: renderHtmlEmail(jobs, failures)
  });
}

function renderTextEmail(jobs, failures) {
  if (!jobs.length) {
    return [
      `No fresh jobs found in the last ${config.freshHours} hours.`,
      "",
      "Searches:",
      ...config.keywords.map((keyword) => `- ${keyword}`),
      "",
      `Locations: ${config.locations.join(", ")}`,
      renderWarnings(failures)
    ].filter(Boolean).join("\n");
  }

  return [
    `Fresh jobs found in the last ${config.freshHours} hours: ${jobs.length}`,
    "",
    ...jobs.map((job, index) => [
      `${index + 1}. ${job.title}`,
      `Company: ${job.company}`,
      `Location: ${job.location}`,
      `Source: ${job.source}`,
      `Posted: ${job.postedAt ? job.postedAt.toISOString().slice(0, 10) : "Unknown"}`,
      job.salary ? `Salary: ${job.salary}` : "",
      job.url ? `Apply: ${job.url}` : "",
      job.description ? `Summary: ${job.description}` : ""
    ].filter(Boolean).join("\n")),
    renderWarnings(failures)
  ].filter(Boolean).join("\n\n");
}

function renderHtmlEmail(jobs, failures) {
  const content = jobs.length
    ? jobs.map((job) => `
      <tr>
        <td style="padding:16px;border-bottom:1px solid #e5e7eb;">
          <h2 style="margin:0 0 6px;font-size:18px;">${escapeHtml(job.title)}</h2>
          <p style="margin:0 0 8px;color:#374151;">
            ${escapeHtml(job.company)} · ${escapeHtml(job.location)} · ${escapeHtml(job.source)}
          </p>
          <p style="margin:0 0 8px;color:#4b5563;">Posted: ${escapeHtml(job.postedAt ? job.postedAt.toDateString() : "Unknown")}</p>
          ${job.salary ? `<p style="margin:0 0 8px;color:#4b5563;">${escapeHtml(job.salary)}</p>` : ""}
          ${job.description ? `<p style="margin:0 0 12px;color:#111827;">${escapeHtml(job.description)}</p>` : ""}
          ${job.url ? `<a href="${escapeHtml(job.url)}" style="color:#2563eb;">Open job</a>` : ""}
        </td>
      </tr>`).join("")
    : `<tr><td style="padding:16px;">No fresh jobs found in the last ${config.freshHours} hours.</td></tr>`;

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
      <h1 style="font-size:22px;">Daily job digest</h1>
      <p>Search window: last ${config.freshHours} hours</p>
      <p>Locations: ${escapeHtml(config.locations.join(", "))}</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${content}</table>
      ${renderWarningsHtml(failures)}
    </div>`;
}

function dedupeJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = job.url || `${job.title}|${job.company}|${job.location}`;
    const hash = crypto.createHash("sha256").update(key.toLowerCase()).digest("hex");
    if (seen.has(hash)) {
      return false;
    }
    seen.add(hash);
    return true;
  });
}

function isRelevantJob(job) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  return config.keywords.some((keyword) => matchesTokens(text, tokenize(keyword)));
}

function isFreshJob(job) {
  if (!job.postedAt || Number.isNaN(job.postedAt.valueOf())) {
    return config.includeUnknownDates;
  }
  return job.postedAt >= cutoff;
}

function sortByNewest(a, b) {
  return (b.postedAt?.getTime() || 0) - (a.postedAt?.getTime() || 0);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "daily-job-mailer/1.0",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${new URL(url).hostname}`);
  }

  return response.json();
}

function validateEmailConfig() {
  if (config.dryRun) {
    return;
  }

  const missing = Object.entries({
    EMAIL_TO: config.email.to,
    SMTP_HOST: config.email.host,
    SMTP_USER: config.email.user,
    SMTP_PASS: config.email.pass
  }).filter(([, value]) => !value);

  if (missing.length) {
    throw new Error(`Missing required email settings: ${missing.map(([key]) => key).join(", ")}`);
  }
}

function readList(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  return raw.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function tokenize(value) {
  return value.toLowerCase().split(/[^a-z0-9.+#]+/).filter((token) => token.length > 1);
}

function matchesTokens(value, tokens) {
  const haystack = value.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function matchesConfiguredLocation(location, description = "", remote = false) {
  const haystack = `${location} ${description}`.toLowerCase();

  return config.locations.some((configuredLocation) => {
    const normalizedLocation = configuredLocation.toLowerCase();

    if (normalizedLocation === "remote india") {
      const saysRemote = remote || haystack.includes("remote");
      const saysIndia = ["india", "worldwide", "anywhere", "global"].some((token) => haystack.includes(token));
      return saysRemote && saysIndia;
    }

    return haystack.includes(normalizedLocation);
  });
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function parseRelativeDate(value) {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (normalized.includes("today") || normalized.includes("just")) {
    return new Date();
  }

  const match = normalized.match(/(\d+)\s+(minute|hour|day|week|month)s?\s+ago/);
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000
  };

  return new Date(Date.now() - amount * multipliers[unit]);
}

function formatSalary(job) {
  if (job.salary_min && job.salary_max) {
    return `${Math.round(job.salary_min)}-${Math.round(job.salary_max)} ${job.salary_is_predicted ? "(estimated)" : ""}`.trim();
  }
  return "";
}

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function renderWarnings(failures) {
  if (!failures.length) {
    return "";
  }
  return `Warnings:\n${failures.slice(0, 5).map((warning) => `- ${warning}`).join("\n")}`;
}

function renderWarningsHtml(failures) {
  if (!failures.length) {
    return "";
  }
  return `<h2 style="font-size:16px;">Warnings</h2><ul>${failures.slice(0, 5).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
