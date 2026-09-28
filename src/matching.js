const ROLE_WORDS = ["developer", "engineer", "programmer", "sde", "dev"];
const REMOTE_PATTERN = /\b(remote|work from home|wfh|anywhere|distributed|home based)\b/i;
const OPEN_REGIONS = ["anywhere", "worldwide", "global", "apac", "asia"];

// Lowercase and unify common spellings so "Node JS", "node.js" and "NodeJS" compare equal.
export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/node[\s.-]*js/g, "nodejs")
    .replace(/spring[\s-]*boot/g, "springboot")
    .replace(/back[\s-]*end/g, "backend")
    .replace(/front[\s-]*end/g, "frontend")
    .replace(/full[\s-]*stack/g, "fullstack")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalizeText(value).split(" ").filter(Boolean));
}

/**
 * A title matches a keyword when it contains every non-role word of the keyword
 * ("Java", "Spring Boot", ...) plus any role word. So "Java Developer" also matches
 * "Java Backend Engineer", but "AI Researcher" never matches "Software Engineer".
 */
export function createTitleMatcher(keywords, excludeKeywords = []) {
  const patterns = keywords.map((keyword) => {
    const words = [...tokens(keyword)];
    return {
      required: words.filter((word) => !ROLE_WORDS.includes(word)),
      needsRole: words.some((word) => ROLE_WORDS.includes(word))
    };
  });
  const excludes = excludeKeywords.map((keyword) => [...tokens(keyword)]).filter((words) => words.length);

  return (title) => {
    const words = tokens(title);
    if (excludes.some((exclude) => exclude.every((word) => words.has(word)))) {
      return false;
    }
    const hasRole = ROLE_WORDS.some((word) => words.has(word));
    return patterns.some(({ required, needsRole }) =>
      required.every((word) => words.has(word)) && (!needsRole || hasRole));
  };
}

export function mentionsRemote(...values) {
  return REMOTE_PATTERN.test(values.join(" "));
}

// Region restrictions such as ["India"], "Anywhere" or "APAC, EMEA". Empty means no restriction.
export function isOpenToCountry(regions, country) {
  const list = (Array.isArray(regions) ? regions : String(regions ?? "").split(/[,/|]+/))
    .map((region) => region.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) {
    return true;
  }
  const wanted = country.toLowerCase();
  return list.some((region) => region.includes(wanted) || OPEN_REGIONS.some((open) => region.includes(open)));
}

// Returns the configured city a job location mentions, e.g. "Ahmadabad, Gujarat" -> Ahmedabad.
export function findCity(location, cities) {
  const text = ` ${normalizeText(location)} `;
  return cities.find((city) => city.aliases.some((alias) => text.includes(` ${normalizeText(alias)} `)));
}

// Words in a title that mean the role is above fresher / junior level.
const SENIOR_TITLE_WORDS = ["senior", "sr", "staff", "principal", "lead", "manager", "architect", "director", "head", "vp", "chief", "founding", "ii", "iii", "iv"];
const SENIOR_LEVELS = /senior|manager|director|executive|principal|staff|lead/i;

const YEARS = String.raw`(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)`;
const EXPERIENCE_PATTERNS = [
  new RegExp(String.raw`${YEARS}[^.\n]{0,40}?\b(?:experience|exp)\b`, "i"), // "3+ years of Java experience"
  new RegExp(String.raw`\bexperience\b[^.\n\d]{0,25}${YEARS}`, "i") // "Experience: 2-4 years"
];

// Minimum years of experience a posting asks for (first mention wins), or null if it doesn't say.
export function requiredYears(text) {
  const hits = EXPERIENCE_PATTERNS
    .map((pattern) => pattern.exec(text ?? ""))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
  return hits.length ? Number.parseInt(hits[0][1], 10) : null;
}

/**
 * Keeps jobs a fresher/junior can apply to: no senior words in the title, no senior level
 * from the job board, and no more than `maxYears` of required experience. null disables it.
 */
export function createSeniorityFilter(maxYears) {
  if (maxYears === null) {
    return () => true;
  }
  return (job) => {
    const words = tokens(job.title);
    if (SENIOR_TITLE_WORDS.some((word) => words.has(word))) {
      return false;
    }
    if ((job.levels || []).some((level) => SENIOR_LEVELS.test(level))) {
      return false;
    }
    return job.experienceYears === null || job.experienceYears <= maxYears;
  };
}

export function parseDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

const UNIT_MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000
};

// Parses Google Jobs style dates: "Just posted", "Today", "an hour ago", "3 days ago", "30+ days ago".
export function parseRelativeDate(value) {
  if (!value) {
    return null;
  }
  const text = value.toLowerCase();
  if (/just|today|now/.test(text)) {
    return new Date();
  }
  if (text.includes("yesterday")) {
    return new Date(Date.now() - UNIT_MS.day);
  }
  const match = text.match(/(\d+|an?)\+?\s*(minute|hour|day|week|month)s?\s+ago/);
  if (!match) {
    return null;
  }
  const amount = /^\d+$/.test(match[1]) ? Number.parseInt(match[1], 10) : 1;
  return new Date(Date.now() - amount * UNIT_MS[match[2]]);
}

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&ndash;": "–", "&mdash;": "—", "&rsquo;": "'", "&lsquo;": "'", "&hellip;": "…" };

function decodeEntity(entity, code) {
  if (code.startsWith("#")) {
    const point = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isNaN(point) ? " " : String.fromCodePoint(point);
  }
  return ENTITIES[entity.toLowerCase()] ?? " ";
}

export function stripHtml(value, maxLength = Infinity) {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
  return truncate(text, maxLength);
}

export function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

const PERIODS = { annual: "year", annually: "year", yearly: "year", monthly: "month", weekly: "week", daily: "day", hourly: "hour" };

export function formatSalary(min, max, currency = "", period = "") {
  if (!min && !max) {
    return "";
  }
  const inr = !currency || currency === "INR";
  const format = (amount) => Math.round(amount).toLocaleString(inr ? "en-IN" : "en-US");
  const prefix = inr ? "₹" : `${currency} `;
  const range = min && max && min !== max ? `${prefix}${format(min)} – ${format(max)}` : `${prefix}${format(min || max)}`;
  const unit = PERIODS[String(period).toLowerCase()] ?? period;
  return unit ? `${range} / ${unit}` : range;
}
