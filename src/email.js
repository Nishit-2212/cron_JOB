import nodemailer from "nodemailer";
import { config } from "./config.js";

export async function sendDigest(digest) {
  const subject = buildSubject(digest);

  if (config.dryRun) {
    console.log(`Subject: ${subject}\n\n${renderText(digest)}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass }
  });

  await transporter.sendMail({
    from: config.email.from,
    to: config.email.to,
    subject,
    text: renderText(digest),
    html: renderHtml(digest)
  });
}

function buildSubject({ jobs, groups }) {
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  if (!jobs.length) {
    return `Job digest ${date}: no new roles`;
  }
  const breakdown = groups.map(({ label, jobs: groupJobs }) => `${label} ${groupJobs.length}`).join(" · ");
  return `Job digest ${date}: ${jobs.length} new role${jobs.length === 1 ? "" : "s"} (${breakdown})`;
}

function postedLabel(date) {
  if (!date) {
    return "Date unknown";
  }
  const hours = Math.max(0, Math.round((Date.now() - date.getTime()) / 3_600_000));
  if (hours < 1) {
    return "Just now";
  }
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function renderText({ jobs, groups, notices }) {
  const lines = [];
  if (!jobs.length) {
    lines.push(`No new jobs found in the last ${config.freshHours} hours.`, "", `Keywords: ${config.keywords.join(", ")}`);
  }

  let index = 0;
  for (const group of groups) {
    lines.push("", `== ${group.label} (${group.jobs.length}) ==`);
    for (const job of group.jobs) {
      index += 1;
      lines.push(
        "",
        `${index}. ${job.title}`,
        `   ${job.company} · ${job.location}`,
        `   ${postedLabel(job.postedAt)} · ${job.source}${job.salary ? ` · ${job.salary}` : ""}`,
        job.url ? `   ${job.url}` : ""
      );
    }
  }

  if (notices.length) {
    lines.push("", "Notes:", ...notices.map((notice) => `- ${notice}`));
  }
  return lines.filter((line, i) => line !== "" || lines[i - 1] !== "").join("\n").trim();
}

function renderHtml({ jobs, groups, notices }) {
  const sections = groups.map((group) => `
    <h2 style="margin:28px 0 8px;font-size:16px;color:#111827;border-bottom:2px solid #2563eb;padding-bottom:4px;">
      ${escapeHtml(group.label)} <span style="color:#6b7280;font-weight:normal;">(${group.jobs.length})</span>
    </h2>
    ${group.jobs.map(renderJobHtml).join("")}`).join("");

  const empty = jobs.length
    ? ""
    : `<p style="color:#374151;">No new jobs found in the last ${config.freshHours} hours for ${escapeHtml(config.keywords.join(", "))}.</p>`;

  const notesHtml = notices.length
    ? `<div style="margin-top:28px;padding:12px 14px;background:#fef3c7;border-radius:6px;font-size:13px;color:#78350f;">
        <strong>Notes</strong><ul style="margin:6px 0 0;padding-left:18px;">${notices.map((notice) => `<li>${escapeHtml(notice)}</li>`).join("")}</ul>
      </div>`
    : "";

  return `
    <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;line-height:1.45;color:#111827;max-width:680px;margin:0 auto;">
      <h1 style="font-size:20px;margin:0 0 4px;">Daily job digest</h1>
      <p style="margin:0;color:#6b7280;font-size:13px;">
        ${jobs.length} new role${jobs.length === 1 ? "" : "s"} · last ${config.freshHours}h · ${escapeHtml(config.locations.map((location) => location.label).join(", "))}
      </p>
      ${empty}${sections}${notesHtml}
    </div>`;
}

function renderJobHtml(job) {
  const url = safeUrl(job.url);
  const title = url
    ? `<a href="${escapeHtml(url)}" style="color:#1d4ed8;text-decoration:none;">${escapeHtml(job.title)}</a>`
    : escapeHtml(job.title);
  const meta = [postedLabel(job.postedAt), job.source, job.salary].filter(Boolean).map(escapeHtml).join(" · ");

  return `
    <div style="padding:10px 0;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:15px;font-weight:600;">${title}</div>
      <div style="font-size:13px;color:#374151;">${escapeHtml(job.company)} · ${escapeHtml(job.location)}</div>
      <div style="font-size:12px;color:#6b7280;">${meta}</div>
      ${job.description ? `<div style="font-size:13px;color:#4b5563;margin-top:4px;">${escapeHtml(job.description)}</div>` : ""}
    </div>`;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
