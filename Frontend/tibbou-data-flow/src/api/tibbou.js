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
  if (!response.ok) throw new Error(errorMessage(response.status, body));
  return body;
}

function errorMessage(status, body) {
  const detail = body?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail.map((item) => item.msg).join(" ");
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "That item couldn't be found. It may have been removed.";
  if (status === 413) return "That file is too large.";
  if (status >= 500) return "Something went wrong on our side. Please try again in a moment.";
  return "That didn't work. Please try again.";
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

export function joinOrganizationByDomain() {
  return apiRequest("/api/v1/organizations/domain-join", { method: "POST" });
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
  return apiRequest(organizationPath("/datasets?limit=2000"));
}

export function getLineageEdges() {
  return apiRequest(organizationPath("/lineage?limit=2000"));
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
