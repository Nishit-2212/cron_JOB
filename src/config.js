// Load a local .env when present (GitHub Actions passes real env vars instead).
try {
  process.loadEnvFile();
} catch {
  // No .env file - that's fine.
}

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

// Other spellings job boards use for the same city (e.g. "Ahmadabad", the official romanisation).
const CITY_ALIASES = {
  ahmedabad: ["Ahmedabad", "Ahmadabad", "Amdavad"],
  gandhinagar: ["Gandhinagar", "GIFT City", "Gift City Gandhinagar"],
  bangalore: ["Bangalore", "Bengaluru"],
  bengaluru: ["Bengaluru", "Bangalore"],
  gurgaon: ["Gurgaon", "Gurugram"],
  gurugram: ["Gurugram", "Gurgaon"],
  mumbai: ["Mumbai", "Bombay"],
  vadodara: ["Vadodara", "Baroda"]
};

const env = process.env;
const smtpPort = readInt("SMTP_PORT", 465);
const keywords = readList("SEARCH_KEYWORDS", DEFAULT_KEYWORDS);

export const config = {
  keywords,
  excludeKeywords: readList("EXCLUDE_KEYWORDS", []),
  maxExperienceYears: readMaxExperience(),
  locations: readList("SEARCH_LOCATIONS", DEFAULT_LOCATIONS).map(parseLocation),
  maxResults: readInt("MAX_RESULTS", 50),
  freshHours: readInt("FRESH_HOURS", 48),
  includeUnknownDates: readBoolean("INCLUDE_UNKNOWN_DATES", false),
  dryRun: process.argv.includes("--dry-run") || readBoolean("DRY_RUN", false),
  // Email even when nothing new was found, so a quiet day still shows the job ran.
  sendEmptyDigest: readBoolean("SEND_EMPTY_DIGEST", true),
  seenJobsFile: env.SEEN_JOBS_FILE || ".cache/seen-jobs.json",
  seenJobsDays: readInt("SEEN_JOBS_DAYS", 30),
  email: {
    to: env.EMAIL_TO,
    from: env.EMAIL_FROM || env.SMTP_USER,
    host: env.SMTP_HOST,
    port: smtpPort,
    // Port 465 uses implicit TLS; 587/25 use STARTTLS (secure=false).
    secure: readBoolean("SMTP_SECURE", smtpPort === 465),
    user: env.SMTP_USER,
    pass: env.SMTP_PASS
  },
  providers: {
    serpApiKey: env.SERPAPI_API_KEY,
    serpApiKeywords: readList("SERPAPI_KEYWORDS", keywords),
    // 0 = automatic: the monthly quota / 31, so a daily run never runs out before the plan renews.
    serpApiDailySearches: readInt("SERPAPI_DAILY_SEARCHES", 0),
    adzunaAppId: env.ADZUNA_APP_ID,
    adzunaAppKey: env.ADZUNA_APP_KEY,
    joobleApiKey: env.JOOBLE_API_KEY
  }
};

export const cities = config.locations.filter((location) => !location.remote);

// Fresher drives from offcampusjobs4u.com get their own section (OFFCAMPUS_JOBS=false turns it off).
export const drivesTarget = readBoolean("OFFCAMPUS_JOBS", true)
  ? { label: "Off-campus fresher drives", remote: false, place: "India", aliases: [], drives: true }
  : null;

export function validateEmailConfig() {
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

// "Remote India" -> { label, remote: true, place: "India" }; "Ahmedabad" -> { remote: false, place: "Ahmedabad", aliases }
function parseLocation(label) {
  const remote = /\bremote\b/i.test(label);
  const place = remote ? label.replace(/\bremote\b/i, "").trim() || "India" : label;
  return { label, remote, place, aliases: CITY_ALIASES[place.toLowerCase()] ?? [place] };
}

// "any" (or "none"/"off") disables the seniority filter; otherwise a whole number of years.
function readMaxExperience() {
  const raw = (env.MAX_EXPERIENCE_YEARS ?? "").trim().toLowerCase();
  if (["any", "none", "off"].includes(raw)) {
    return null;
  }
  const years = Number.parseInt(raw, 10);
  return Number.isNaN(years) || years < 0 ? 2 : years;
}

function readList(name, fallback) {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  return raw.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function readInt(name, fallback) {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isNaN(value) || value <= 0 ? fallback : value;
}

function readBoolean(name, fallback) {
  const value = env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
