import { supabase } from "@/lib/supabase";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const ORGANIZATION_STORAGE_KEY = "tibbou.organizationId";

async function apiRequest(path, options = {}, { publicRequest = false } = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (!publicRequest) {
    const { data } = (await supabase?.auth.getSession()) || { data: null };
    if (!data?.session?.access_token) throw new Error("Your session has expired. Please sign in again.");
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.detail || `Request failed for ${path}.`);
  return body;
}
function organizationPath(path) {
  const organizationId = localStorage.getItem(ORGANIZATION_STORAGE_KEY);
  if (!organizationId) throw new Error("Select an organization before loading data.");
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}${path}`;
}

export function getHealth() {
  return apiRequest("/health", {}, { publicRequest: true });
}

export function getOrganizations() {
  return apiRequest("/api/v1/organizations");
}

export function createOrganization(payload) {
  return apiRequest("/api/v1/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function getDatasets() {
  return apiRequest(organizationPath("/datasets"));
}

export function getLineageEdges() {
  return apiRequest(organizationPath("/lineage"));
}

export function getCostSnapshots() {
  return apiRequest(organizationPath("/costs"));
}

export function getLatestSnowflakeDatasetCreditSummaries() {
  return apiRequest(organizationPath("/ingestion/snowflake/dataset-credit-summaries/latest"));
}

export function getLatestDbtManifestIngestionSummary() {
  return apiRequest(organizationPath("/ingestion/dbt/manifest/latest"));
}

export function ingestDbtManifest(payload) {
  return apiRequest(organizationPath("/ingestion/dbt/manifest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getDashboardData() {
  const [health, datasets, lineage, costs] = await Promise.all([
    getHealth(), getDatasets(), getLineageEdges(), getCostSnapshots(),
  ]);
  return { health, datasets, lineage, costs };
}
