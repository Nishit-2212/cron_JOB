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

// Returns the configured city a job location mentions, e.g. "Ahmedabad, Gujarat" -> Ahmedabad.
export function findCity(location, cities) {
  const text = normalizeText(location);
  return cities.find((city) => text.includes(normalizeText(city.place)));
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

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#039;": "'" };

export function stripHtml(value, maxLength = 240) {
  const text = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[#a-z0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export function formatSalary(min, max, currency = "", period = "") {
  if (!min && !max) {
    return "";
  }
  const format = (amount) => Math.round(amount).toLocaleString("en-IN");
  const symbol = currency === "INR" ? "₹" : currency ? `${currency} ` : "";
  const range = min && max && min !== max ? `${symbol}${format(min)} – ${symbol}${format(max)}` : `${symbol}${format(min || max)}`;
  return period ? `${range} / ${period}` : range;
}
