/**
 * D8 (live 2026-10-03): the sizes the page shows a person — the tiles
 * ("Download ≈154 MB"), Prepare's progress, the storage meter, the boot
 * banner's byte counts, the level pane's environment note — in DECIMAL
 * units, as the docs, the catalog and the browser's own download UI count
 * them: MB = 10^6 bytes, GB = 10^9.
 * The tiles used to divide by 2^20 and say "MB" (RAG's 282.0 MB transfer
 * read "≈269 MB"), while the storage meter beside them already used 10^9.
 * Internal arithmetic (memory policy, logs) keeps its binary units.
 */

/** Whole decimal megabytes ("154" for 154,373,030 bytes). */
export const wholeMB = (bytes: number): number => Math.round(bytes / 1e6);

/** Decimal gigabytes to one decimal place ("1.4" for 1,420,000,000 bytes). */
export const tenthsGB = (bytes: number): string => (bytes / 1e9).toFixed(1);
