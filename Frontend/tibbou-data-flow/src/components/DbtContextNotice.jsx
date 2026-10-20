import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getLatestDbtManifestIngestionSummary } from "@/api/tibbou";
import { useOrganization } from "@/contexts/OrganizationContext";

export default function DbtContextNotice() {
  const { organization } = useOrganization();
  const organizationId = organization?.id;
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (organizationId) getLatestDbtManifestIngestionSummary()
      .then((run) => active && setResult({ organizationId, missing: run.status !== "success", hasRun: true, error: "" }))
      .catch((error) => active && setResult({ organizationId, missing: error.status === 404,
        error: error.status === 404 ? "" : "Could not check dbt context. Try again." }));
    return () => { active = false; };
  }, [organizationId, retry]);
  if (!organizationId || result?.organizationId !== organizationId) return null;
  if (result.error) return <div role="alert" className="text-sm text-red-300">{result.error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>;
  if (!result.missing) return null;
  return <p role="status" className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-sm">
    {result.hasRun ? "The latest dbt manifest has not been successfully processed." : "No dbt manifest has been successfully processed for this workspace."} Snowflake usage sync is available,
    but dataset-level allocation and dbt lineage may be incomplete. Upload a manifest from <Link className="underline" to="/lineage">Lineage</Link>. {result.hasRun ? <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Check processing status</button> : null}
  </p>;
}
