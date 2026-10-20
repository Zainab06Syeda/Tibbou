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
  if (!response.ok) {
    const detail = Array.isArray(body?.detail)
      ? body.detail.map((item) => item.msg).join("; ") : body?.detail;
    throw Object.assign(new Error(detail || "Request failed. Please try again."), { status: response.status });
  }
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

export function getDomainMatch() {
  return apiRequest("/api/v1/organizations/domain-match");
}

export function createOrganization(payload) {
  return apiRequest("/api/v1/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function requestToJoinByDomain() {
  return apiRequest("/api/v1/organizations/domain-join-requests", { method: "POST" });
}

export function getInvitations() {
  return apiRequest("/api/v1/invitations");
}

export function acceptInvitation(invitationId) {
  return apiRequest(`/api/v1/invitations/${encodeURIComponent(invitationId)}/accept`, {
    method: "POST",
  });
}

export function createInvitation(payload) {
  return apiRequest(organizationPath("/invitations"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteInvitation(invitationId) {
  return apiRequest(organizationPath(`/invitations/${encodeURIComponent(invitationId)}`), {
    method: "DELETE",
  });
}

export function resendInvitation(invitationId) {
  return apiRequest(organizationPath(`/invitations/${encodeURIComponent(invitationId)}/resend`), {
    method: "POST",
  });
}

export function getAdminDashboard() {
  return apiRequest(organizationPath("/admin"));
}

export function updateMemberRole(userId, role) {
  return apiRequest(organizationPath(`/memberships/${encodeURIComponent(userId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export function removeMember(userId) {
  return apiRequest(organizationPath(`/memberships/${encodeURIComponent(userId)}`), {
    method: "DELETE",
  });
}

export function transferOwnership(userId) {
  return apiRequest(
    organizationPath(`/memberships/${encodeURIComponent(userId)}/transfer-ownership`),
    { method: "POST" }
  );
}

export function listJoinRequests() {
  return apiRequest(organizationPath("/join-requests"));
}

export function approveJoinRequest(requestId) {
  return apiRequest(organizationPath(`/join-requests/${encodeURIComponent(requestId)}/approve`), {
    method: "POST",
  });
}

export function denyJoinRequest(requestId) {
  return apiRequest(organizationPath(`/join-requests/${encodeURIComponent(requestId)}/deny`), {
    method: "POST",
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

export function listConnections() {
  return apiRequest(organizationPath("/snowflake-connections"));
}

export function createConnection(payload) {
  return apiRequest(organizationPath("/snowflake-connections"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function updateConnection(connectionId, payload) {
  return apiRequest(organizationPath(`/snowflake-connections/${encodeURIComponent(connectionId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function validateConnection(connectionId) {
  return apiRequest(
    organizationPath(`/snowflake-connections/${encodeURIComponent(connectionId)}/validate`),
    { method: "POST" }
  );
}

export function disableConnection(connectionId) {
  return apiRequest(organizationPath(`/snowflake-connections/${encodeURIComponent(connectionId)}`), {
    method: "DELETE",
  });
}

export function syncSnowflake(connectionId) {
  return apiRequest(organizationPath("/ingestion/snowflake/query-usage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connection_id: connectionId }),
  });
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
