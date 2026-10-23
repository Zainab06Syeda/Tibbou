import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, Database, Search } from "lucide-react";

import { getDatasets } from "@/api/tibbou";
import { navItemsFor } from "@/components/navigation";
import { useOrganization } from "@/contexts/OrganizationContext";
import { cn } from "@/lib/utils";

const MAX_DATASETS = 8;

function matches(text, term) {
  return text.toLowerCase().includes(term);
}

// Ctrl/⌘ K search: jump to a page, or to any dataset (opens its details on
// the Datasets page). Datasets are fetched when it first opens for a
// workspace and kept until the workspace changes.
export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const { organization } = useOrganization();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [datasets, setDatasets] = useState({ organizationId: null, rows: null, failed: false });
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    if (organization?.id && datasets.organizationId !== organization.id) {
      setDatasets({ organizationId: organization.id, rows: null, failed: false });
      getDatasets()
        .then((rows) => setDatasets({ organizationId: organization.id, rows, failed: false }))
        .catch(() => setDatasets({ organizationId: organization.id, rows: [], failed: true }));
    }
  }, [open, organization?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    const pages = navItemsFor(organization?.role)
      .filter((item) => !term || matches(`${item.label} ${item.keywords}`, term))
      .map((item) => ({ type: "page", key: item.path, label: item.label, hint: item.section, icon: item.icon, to: item.path }));
    const datasetRows = (datasets.rows || [])
      .filter((row) => term && matches(`${row.name} ${row.namespace || ""}`, term))
      .slice(0, MAX_DATASETS)
      .map((row) => ({
        type: "dataset",
        key: row.id,
        label: row.name,
        hint: row.namespace || row.system,
        icon: Database,
        to: `/datasets?dataset=${encodeURIComponent(row.id)}`,
      }));
    return [...pages, ...datasetRows];
  }, [query, datasets.rows, organization?.role]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function go(result) {
    if (!result) return;
    onClose();
    navigate(result.to);
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  const term = query.trim();
  const pageCount = results.filter((result) => result.type === "page").length;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/60 duration-150 animate-in fade-in" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl duration-200 animate-in fade-in zoom-in-95 slide-in-from-top-2"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages and datasets…"
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={results[active] ? `command-${results[active].key}` : undefined}
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <ul ref={listRef} id="command-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {results.map((result, index) => (
            <li key={`${result.type}-${result.key}`}>
              {index === 0 && pageCount ? (
                <p className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Pages</p>
              ) : null}
              {index === pageCount ? (
                <p className="px-2 pb-1 pt-3 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Datasets</p>
              ) : null}
              <button
                type="button"
                id={`command-${result.key}`}
                role="option"
                aria-selected={index === active}
                data-index={index}
                onMouseMove={() => setActive(index)}
                onClick={() => go(result)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                  index === active ? "bg-secondary/60 text-foreground" : "text-muted-foreground"
                )}
              >
                <result.icon className={cn("h-4 w-4 shrink-0", index === active && "text-primary")} />
                <span className="min-w-0 flex-1 truncate text-foreground">{result.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{result.hint}</span>
                {index === active ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
              </button>
            </li>
          ))}
          {term && datasets.rows === null ? (
            <li className="px-2 py-3 text-xs text-muted-foreground">Searching datasets…</li>
          ) : null}
          {term && datasets.rows !== null && results.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">
              {datasets.failed ? "Couldn't load datasets." : `Nothing matches “${term}”.`}
            </li>
          ) : null}
        </ul>
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>
            <kbd className="font-mono">↑↓</kbd> to move
          </span>
          <span>
            <kbd className="font-mono">Enter</kbd> to open
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
