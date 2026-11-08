// Helpers for the Members page. Pure functions, tested in
// test/members.test.js.

export const ROLES = ["owner", "admin", "operator", "viewer"];

export const ROLE_INFO = {
  owner: { label: "Owner", description: "Everything, including workspace settings and making other owners." },
  admin: { label: "Admin", description: "Manages people, invitations and the Snowflake connection." },
  operator: { label: "Operator", description: "Uploads dbt manifests and runs syncs, but can't manage people." },
  viewer: { label: "Viewer", description: "Read-only access to lineage, datasets and costs." },
};

// Friendly names for the capabilities in Database/permissions.json, in the
// order the role guide lists them.
export const CAPABILITY_LABELS = {
  view_data: "View lineage, datasets and costs",
  upload_dbt_manifest: "Upload dbt manifests",
  trigger_sync: "Run a Snowflake sync",
  manage_connection: "Set up the Snowflake connection",
  manage_invitations: "Invite people",
  manage_members: "Change roles and remove members",
  transfer_ownership: "Make someone an owner",
  manage_organization: "Manage workspace settings",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Splits pasted text into unique, lower-cased emails, keeping anything that
// doesn't look like an email aside so it can be reported.
export function parseEmails(text) {
  const valid = [];
  const invalid = [];
  for (const part of (text || "").split(/[\s,;]+/)) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (!EMAIL_PATTERN.test(value)) invalid.push(part.trim());
    else if (!valid.includes(value)) valid.push(value);
  }
  return { valid, invalid };
}

export function initials(name, email) {
  const source = (name || "").trim() || (email || "").split("@")[0] || "?";
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

// A stable colour index (0-4) per person, so their avatar keeps its colour.
export function avatarIndex(key) {
  let hash = 0;
  for (const char of String(key || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 5;
}

const UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

// "3 days ago", "in 5 days", "just now".
export function relativeTime(value, now = new Date()) {
  if (!value) return "—";
  const seconds = (new Date(value).getTime() - now.getTime()) / 1000;
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

export function filterMembers(memberships, { search = "", role = "all" } = {}) {
  const term = search.trim().toLowerCase();
  return memberships.filter((membership) => {
    if (role !== "all" && membership.role !== role) return false;
    if (!term) return true;
    return [membership.display_name, membership.email].some((value) => value && value.toLowerCase().includes(term));
  });
}

// Owners first, then admins, operators, viewers; by name within a role.
export function sortMembers(memberships) {
  const name = (membership) => (membership.display_name || membership.email || "").toLowerCase();
  return [...memberships].sort(
    (left, right) => ROLES.indexOf(left.role) - ROLES.indexOf(right.role) || name(left).localeCompare(name(right))
  );
}
