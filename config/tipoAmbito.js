/**
 * config/tipoAmbito.js
 *
 * Único punto de la app que interpreta deployment.ambitoTerritorial y lo
 * traduce a un tipo de ámbito: monomunicipal o supramunicipal.
 *
 * ── POR QUÉ EXISTE ───────────────────────────────────────────────────────
 * Antes cada módulo interpretaba el campo a su manera: unos preguntaban "¿existe
 * el campo?" y otros "¿qué valor tiene?". Con ambitoTerritorial: "municipio"
 * escrito de forma explícita, main.js lo trataba como supramunicipal y el resto
 * como monomunicipal, y el logo de la entidad desaparecía sin ningún error.
 * Centralizar la decisión (DRY, fuente única de verdad) hace imposible esa
 * discrepancia: todos los módulos consultan la misma función.
 *
 * ── TIPOS ────────────────────────────────────────────────────────────────
 *   monomunicipal  → "municipio" o campo ausente (retrocompatible). Sirve un
 *                    único municipio, sin base territorial: elegirlo reemplaza
 *                    todo el conjunto de capas.
 *   supramunicipal → "provincia" | "ccaa" | "comarca" | "espana". Base
 *                    territorial más capas municipales superpuestas de forma
 *                    incremental.
 *
 * Que "comarca" y "espana" figuren aquí NO significa que estén implementados:
 * territorioResolver los rechaza con su propio mensaje. Este módulo solo
 * clasifica; no valida disponibilidad.
 *
 * ── FALLA RÁPIDO ─────────────────────────────────────────────────────────
 * Un valor desconocido (por ejemplo un error de tipeo como "provinica") lanza
 * un error con mensaje claro en vez de caer en un valor por defecto. Caer en
 * "monomunicipal" en silencio entregaría al cliente una app mal configurada
 * sin ningún aviso; es preferible que falle al arrancar.
 */

export const TIPO_AMBITO = Object.freeze({
  MONOMUNICIPAL:  "monomunicipal",
  SUPRAMUNICIPAL: "supramunicipal",
});

const AMBITOS_SUPRAMUNICIPALES = new Set(["provincia", "ccaa", "comarca", "espana"]);

/**
 * @param {Object} deployment - DEPLOYMENT de config/deployment.js
 * @returns {"monomunicipal"|"supramunicipal"}
 * @throws {Error} si ambitoTerritorial tiene un valor no reconocido
 */
export function resolverTipoAmbito(deployment) {
  // Ausencia del campo = "municipio": deployments existentes (pamplona, bilbao,
  // logrono, demo) nunca lo definieron y deben seguir funcionando igual.
  const ambito = deployment?.ambitoTerritorial ?? "municipio";

  if (ambito === "municipio") return TIPO_AMBITO.MONOMUNICIPAL;
  if (AMBITOS_SUPRAMUNICIPALES.has(ambito)) return TIPO_AMBITO.SUPRAMUNICIPAL;

  throw new Error(
    `[tipoAmbito] ambitoTerritorial desconocido: "${ambito}". ` +
    `Valores válidos: "municipio", "provincia", "ccaa", "comarca", "espana" ` +
    `(o ausente, equivalente a "municipio").`
  );
}

/** Atajo para los módulos que solo necesitan saber si hay base territorial. */
export function esSupramunicipal(deployment) {
  return resolverTipoAmbito(deployment) === TIPO_AMBITO.SUPRAMUNICIPAL;
}