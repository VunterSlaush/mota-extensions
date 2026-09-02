/**
 * The README's catalog table, rendered from registry.json.
 *
 * The index is the source of truth and the table is a view of it, so the
 * two cannot drift: `scripts/build-readme.mjs` writes it and
 * `scripts/validate.mjs` fails the build when what is committed differs.
 */

export const CATALOG_START = "<!-- catalog:start -->";
export const CATALOG_END = "<!-- catalog:end -->";

const escapePipes = (text) => String(text).replaceAll("|", "\\|");

/** What an entry contributes, in the words a user browsing would use. */
function contributions(entry) {
  const parts = [];
  for (const command of entry.commands ?? []) parts.push(`\`/${command}\``);
  const panels = (entry.panels ?? []).length;
  if (panels > 0) parts.push(panels === 1 ? "a sidebar panel" : `${panels} sidebar panels`);
  return parts.length > 0 ? parts.join(", ") : "—";
}

function link(entry) {
  const target = entry.source?.kind === "path" ? entry.source.path : entry.source?.url;
  return target ? `[${escapePipes(entry.displayName)}](${target})` : escapePipes(entry.displayName);
}

export function renderCatalog(registry) {
  const rows = registry.extensions.map((entry) => {
    const permissions = (entry.permissions ?? []).map((p) => `\`${p}\``).join(" ") || "none";
    const description = escapePipes(entry.description) + (entry.setup ? " *(setup required)*" : "");
    return `| ${link(entry)} | ${description} | ${contributions(entry)} | ${permissions} |`;
  });

  return [
    CATALOG_START,
    "",
    "| Extension | What it does | Adds | Permissions |",
    "|---|---|---|---|",
    ...rows,
    "",
    CATALOG_END,
  ].join("\n");
}

/** Replace the catalog block in a README, or throw if the markers are gone. */
export function withCatalog(readme, registry) {
  const start = readme.indexOf(CATALOG_START);
  const end = readme.indexOf(CATALOG_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md must contain the ${CATALOG_START} / ${CATALOG_END} markers`);
  }
  return readme.slice(0, start) + renderCatalog(registry) + readme.slice(end + CATALOG_END.length);
}
