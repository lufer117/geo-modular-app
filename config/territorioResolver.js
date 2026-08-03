/**
 * config/territorioResolver.js
 *
 * Motor de resolución territorial: dado un deployment (config/deployment.js),
 * determina qué municipios están disponibles y qué polígono usar como
 * máscara inicial, según el ámbito geográfico de esa instancia de cliente.
 *
 * ── POR QUÉ EXISTE ESTE MÓDULO (no vive dentro de configEngine.js) ────────
 * configEngine.js resuelve "qué capas corresponden a un municipio dado" —
 * una responsabilidad distinta a "qué municipios/territorio corresponden
 * a este deployment". Aunque ambos usan el mismo patrón Repository y el
 * mismo LocalJsonAdapter, mezclar las dos responsabilidades en un solo
 * archivo rompería SRP (mismo criterio ya aplicado para separar
 * layerFactory de layerInitializer, o wfsCapabilitiesParser de layerTree).
 *
 * ── PATRÓN REPOSITORY (mismo que configEngine.js) ──────────────────────────
 * Este módulo no sabe CÓMO se obtienen municipios/provincias/ccaa — eso lo
 * resuelve LocalJsonAdapter. Este módulo solo sabe QUÉ hacer con esos datos
 * una vez obtenidos: cruzarlos contra deployment.ambitoTerritorial y
 * deployment.codigoEntidad para devolver el recorte que corresponde.
 *
 * ── CASOS DE ÁMBITO SOPORTADOS ─────────────────────────────────────────────
 *   "municipio"  → cliente tipo ayuntamiento único o lista corta.
 *                  Sin máscara territorial propia — el flujo existente de
 *                  selección de municipio (municipioSelector.js) ya cubre
 *                  este caso sin cambios. mascaraInicial: null.
 *   "provincia"  → cliente tipo diputación. Máscara inicial = polígono de
 *                  la provincia completa. municipiosDisponibles = todos los
 *                  municipios de esa provincia (para el buscador).
 *   "ccaa"       → cliente tipo gobierno regional. Igual que provincia,
 *                  a nivel autonómico.
 *   "comarca"    → sin geometría oficial IGN (no todas las CCAA tienen
 *                  comarcalización oficial, ej. Navarra). Trabajo futuro:
 *                  unión de polígonos municipales vía geometryEngine.union().
 *                  No implementado en este prototipo.
 *   "espana"     → sin caso de uso real previsto (ningún cliente pide
 *                  cobertura nacional completa). No implementado.
 *
 * ── DATASETS CONSUMIDOS ─────────────────────────────────────────────────
 *   data/municipios.json  { codigo_ine, nombre, provincia_code, ccaa_code, bbox, polygon }
 *   data/provincias.json  { tipo:"provincia", provincia_code, ccaa_code, nombre, bbox, polygon }
 *   data/ccaa.json        { tipo:"ccaa", ccaa_code, nombre, bbox, polygon }
 *   (generados por tools/generar_geografia.py — ver ese script para el
 *   detalle de cómo se derivan ccaa_code/provincia_code desde NATCODE)
 */

import { LocalJsonAdapter } from "./adapters/LocalJsonAdapter.js";

// ─── Adaptadores propios de este módulo ────────────────────────────────────
// Instancias separadas de las que use configEngine.js — dataset distinto
// (territorios, no capas), aunque la clase adaptadora sea la misma.
// Rutas relativas desde config/ (mismo nivel que catalogo-capas.json en data/).

const _adapterMunicipios = new LocalJsonAdapter("../data/municipios.json");
const _adapterProvincias = new LocalJsonAdapter("../data/provincias.json");
const _adapterCcaa       = new LocalJsonAdapter("../data/ccaa.json");

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Resuelve el ámbito territorial de un deployment.
 *
 * @param {Object} deployment - DEPLOYMENT de config/deployment.js
 *   Campos relevantes:
 *     ambitoTerritorial: "municipio" | "provincia" | "ccaa" | "comarca" | "espana"
 *     codigoEntidad:     código INE de la entidad (provincia_code o ccaa_code).
 *                        No se usa cuando ambitoTerritorial === "municipio".
 *     municipios:        string[] de codigo_ine — usado tal cual cuando
 *                        ambitoTerritorial === "municipio" (comportamiento
 *                        ya existente, sin cambios).
 *
 * @returns {Promise<{ municipiosDisponibles: Object[], mascaraInicial: Object|null }>}
 *   municipiosDisponibles: array de municipios (mismo shape que municipios.json)
 *   mascaraInicial: { bbox, polygon } del territorio, o null si no aplica
 *                    (caso "municipio" — el flujo existente ya gestiona
 *                    la máscara municipal cuando el usuario selecciona uno)
 */
export async function resolverAmbitoTerritorial(deployment) {
  // Ausencia del campo = retrocompatibilidad, no error: los deployments
  // existentes (pamplona, bilbao, bizkaia, navarra, logrono, demo) nunca
  // definieron ambitoTerritorial y deben seguir funcionando exactamente
  // igual que antes de introducir este módulo — caso "municipio" por defecto.
  const ambito = deployment?.ambitoTerritorial ?? "municipio";

  switch (ambito) {
    case "municipio":
      return _resolverAmbitoMunicipio(deployment);

    case "provincia":
      return _resolverAmbitoProvincia(deployment);

    case "ccaa":
      return _resolverAmbitoCcaa(deployment);

    case "comarca":
      throw new Error(
        "[territorioResolver] ambitoTerritorial 'comarca' no implementado todavía. " +
        "Requiere unión de polígonos municipales (geometryEngine.union()) — " +
        "ver 3DECISIONS.md, pendiente de validación empírica."
      );

    case "espana":
      throw new Error(
        "[territorioResolver] ambitoTerritorial 'espana' no implementado. " +
        "Sin caso de uso real previsto en el alcance actual del proyecto."
      );

    default:
      throw new Error(
        `[territorioResolver] ambitoTerritorial desconocido: "${ambito}"`
      );
  }
}

// ─── Resolución por nivel ───────────────────────────────────────────────────

/**
 * Caso "municipio" — sin máscara territorial propia.
 * El filtro por deployment.municipios (que antes vivía en
 * municipioSelector.js, acoplado al import estático de municipios.js)
 * ahora se resuelve aquí, contra data/municipios.json vía LocalJsonAdapter.
 * Este resolver solo homogeniza el shape de retorno para que main.js
 * llame siempre la misma función sin importar el ámbito del deployment.
 */
async function _resolverAmbitoMunicipio(deployment) {
  const todos = await _adapterMunicipios.getData();
  const codigosPermitidos = new Set(deployment.municipios ?? []);

  const municipiosDisponibles = codigosPermitidos.size > 0
    ? todos.filter(m => codigosPermitidos.has(m.codigo_ine))
    : todos; // demo/TFM: sin filtro, todos los municipios del dataset

  return {
    municipiosDisponibles,
    mascaraInicial: null,
  };
}

/**
 * Caso "provincia" — máscara sobre la provincia completa, buscador
 * poblado con todos los municipios de esa provincia.
 */
async function _resolverAmbitoProvincia(deployment) {
  const codigoProvincia = deployment.codigoEntidad;

  if (!codigoProvincia) {
    throw new Error(
      "[territorioResolver] ambitoTerritorial 'provincia' requiere deployment.codigoEntidad"
    );
  }

  const [provincias, municipios] = await Promise.all([
    _adapterProvincias.getData(),
    _adapterMunicipios.getData(),
  ]);

  const provincia = provincias.find(p => p.provincia_code === codigoProvincia);

  if (!provincia) {
    throw new Error(
      `[territorioResolver] Provincia con código "${codigoProvincia}" no encontrada en provincias.json. ` +
      `¿Se generó con tools/generar_geografia.py --provincias ${codigoProvincia}?`
    );
  }

  const municipiosDisponibles = municipios.filter(
    m => m.provincia_code === codigoProvincia
  );

  console.info(
    `[territorioResolver] Ámbito provincia "${provincia.nombre}": ` +
    `${municipiosDisponibles.length} municipios disponibles`
  );

  return {
    municipiosDisponibles,
    mascaraInicial: { bbox: provincia.bbox, polygon: provincia.polygon },
  };
}

/**
 * Caso "ccaa" — máscara sobre la comunidad autónoma completa, buscador
 * poblado con todos los municipios de esa CCAA (cruzando por ccaa_code,
 * sin importar a qué provincia interna pertenezcan).
 */
async function _resolverAmbitoCcaa(deployment) {
  const codigoCcaa = deployment.codigoEntidad;

  if (!codigoCcaa) {
    throw new Error(
      "[territorioResolver] ambitoTerritorial 'ccaa' requiere deployment.codigoEntidad"
    );
  }

  const [ccaas, municipios] = await Promise.all([
    _adapterCcaa.getData(),
    _adapterMunicipios.getData(),
  ]);

  const ccaa = ccaas.find(c => c.ccaa_code === codigoCcaa);

  if (!ccaa) {
    throw new Error(
      `[territorioResolver] CCAA con código "${codigoCcaa}" no encontrada en ccaa.json. ` +
      `¿Se generó con tools/generar_geografia.py --ccaa ${codigoCcaa}?`
    );
  }

  const municipiosDisponibles = municipios.filter(
    m => m.ccaa_code === codigoCcaa
  );

  console.info(
    `[territorioResolver] Ámbito CCAA "${ccaa.nombre}": ` +
    `${municipiosDisponibles.length} municipios disponibles`
  );

  return {
    municipiosDisponibles,
    mascaraInicial: { bbox: ccaa.bbox, polygon: ccaa.polygon },
  };
}