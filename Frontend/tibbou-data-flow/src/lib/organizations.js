// Client-side mirrors of small, stable backend rules -- purely for instant UX
// feedback (a slug preview, a "you can't claim gmail.com" hint, an instant
// dbt resource count on file select). None of these are security boundaries;
// the backend re-derives and enforces the real values independently
// (Backend/app/services/organizations.py, Backend/app/services/ingestion.py).

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
]);

// Mirrors Backend/app/services/ingestion.py's DBT_RESOURCE_TYPES.
const DBT_RESOURCE_TYPES = new Set(["model", "source", "seed", "snapshot"]);

export function emailDomain(email) {
  if (!email || !email.includes("@")) return null;
  const domain = email.trim().toLowerCase().split("@").pop();
  return domain || null;
}

export function isFreeEmailDomain(domain) {
  return domain ? FREE_EMAIL_DOMAINS.has(domain) : false;
}

export function slugPreview(name) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "organization";
}

export function countDbtResources(manifest) {
  let count = 0;
  for (const collection of ["nodes", "sources"]) {
    const entries = manifest?.[collection];
    if (!entries || typeof entries !== "object") continue;
    for (const node of Object.values(entries)) {
      if (node && DBT_RESOURCE_TYPES.has(node.resource_type) && node.name) {
        count += 1;
      }
    }
  }
  return count;
}

export function leastPrivilegeSql({ roleName, warehouseName, databaseName }) {
  const role = roleName || "TIBBOU_READER";
  const warehouse = warehouseName || "<your_warehouse>";
  const database = databaseName || "<your_database>";
  return `-- Run as ACCOUNTADMIN or SECURITYADMIN
create role if not exists ${role};

grant usage on warehouse ${warehouse} to role ${role};
grant imported privileges on database snowflake to role ${role}; -- query history

grant usage on database ${database} to role ${role};
grant usage on all schemas in database ${database} to role ${role};
grant select on all tables in database ${database} to role ${role};
grant select on future tables in database ${database} to role ${role};

-- Key-pair auth is preferred over password. Generate a keypair, then:
create user if not exists tibbou_svc default_role = ${role};
-- Separate ALTER so re-running this after regenerating keys actually
-- replaces the key ("create ... if not exists" skips existing users).
alter user tibbou_svc set rsa_public_key = '<paste the PUBLIC key here, PEM body only, no headers>';

grant role ${role} to user tibbou_svc;`;
}
