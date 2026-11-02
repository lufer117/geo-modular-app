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
 *   "municipio"  → cliente tipo ayuntamiento único (lista de varios municipios solo con mode "demo")
 *                  (puede cruzar varias provincias, ej. el deployment demo:
 *                  Bilbao + Pamplona + Logroño + Burgos...). Usa el archivo
 *                  único data/territorio/municipios.json — NO se migra al patrón por
 *                  provincia/CCAA de abajo, porque cargar el JSON completo
 *                  de 6 provincias para quedarse con 10 municipios sería
 *                  peor que el problema que resolvemos con ellos.
 *                  mascaraInicial: null.
 *   "provincia"  → cliente tipo diputación. Máscara inicial = polígono de
 *                  la provincia completa (data/territorio/provincias.json).
 *                  municipiosDisponibles = TODOS los municipios de esa
 *                  provincia, leídos de su propio archivo
 *                  data/territorio/municipios_<provincia_code>.json — generado por
 *                  tools/generar_geografia.py --municipios-de-provincia.
 *   "ccaa"       → cliente tipo gobierno regional. Máscara inicial =
 *                  polígono de la CCAA completa (data/territorio/ccaa.json).
 *                  municipiosDisponibles = TODOS los municipios de esa
 *                  CCAA (sin importar cuántas provincias la compongan),
 *                  leídos de su propio archivo
 *                  data/territorio/municipios_ccaa_<ccaa_code>.json — generado por
 *                  tools/generar_geografia.py --municipios-de-ccaa. Ese
 *                  archivo ya viene armado desde el shapefile municipal
 *                  filtrando directo por ccaa_code (el NATCODE de cada
 *                  municipio ya trae su ccaa_code propio) — este resolver
 *                  NO fusiona archivos de provincias en runtime, todo el
 *                  trabajo de agrupar ya se hizo una vez en build time.
 *   "comarca"    → sin geometría oficial IGN (no todas las CCAA tienen
 *                  comarcalización oficial, ej. Navarra). Trabajo futuro:
 *                  unión de polígonos municipales vía geometryEngine.union().
 *                  No implementado en este prototipo.
 *   "espana"     → sin caso de uso real previsto (ningún cliente pide
 *                  cobertura nacional completa). No implementado.
 *
 * ── DATASETS POR PROVINCIA/CCAA (archivos separados, no un municipios.json global) ──
 * Antes, "provincia" y "ccaa" cargaban TODOS los municipios de España
 * desde un único data/territorio/municipios.json y filtraban en JavaScript. Con
 * cientos de municipios por provincia, eso significa que el cliente
 * Navarra descargaría también los municipios de Bizkaia, Madrid, etc.
 * — datos que nunca va a usar.
 *
 * Ahora existen dos generadores nuevos en tools/generar_geografia.py:
 *   --municipios-de-provincia → data/territorio/municipios_<provincia_code>.json
 *   --municipios-de-ccaa      → data/territorio/municipios_ccaa_<ccaa_code>.json
 * Ambos nombrados por código INE (no por texto), para que este módulo
 * construya la ruta con una simple interpolación de string a partir de
 * deployment.codigoEntidad, sin necesitar ningún mapeo código→nombre
 * adicional en el frontend (mismo criterio que ya se aplicó al eliminar
 * la tabla PROVINCIA_A_CCAA basada en NATCODE). Cada municipio dentro de
 * esos archivos SÍ incluye "provincia_nombre" o "ccaa_nombre" — pero es
 * solo para que un humano pueda hacer `git grep "Pamplona"` o abrir el
 * JSON y entender de qué territorio es; el runtime nunca lee ese campo.
 *
 * ── DATASETS CONSUMIDOS ─────────────────────────────────────────────────
 *   data/territorio/municipios.json              { codigo_ine, nombre, provincia_code, ccaa_code, bbox, polygon }
 *                                       — usado SOLO por el caso "municipio".
 *   data/territorio/municipios_<code>.json        Mismo shape + "provincia_nombre". Uno
 *                                       por provincia — usado por "provincia".
 *   data/territorio/municipios_ccaa_<code>.json   Mismo shape + "ccaa_nombre". Uno por
 *                                       CCAA — usado por "ccaa".
 *   data/territorio/provincias.json               { tipo:"provincia", provincia_code, ccaa_code, nombre, bbox, polygon }
 *   data/territorio/ccaa.json                     { tipo:"ccaa", ccaa_code, nombre, bbox, polygon }
 *   (generados por tools/generar_geografia.py — ver ese script para el
 *   detalle de cómo se derivan ccaa_code/provincia_code desde NATCODE)
 */

import { LocalJsonAdapter } from "./adapters/LocalJsonAdapter.js";

// ─── Adaptadores fijos (datasets que siguen siendo un archivo único) ───────
// Rutas relativas desde config/ (mismo nivel que catalogo-capas.json en data/territorio/).

const _adapterMunicipiosDemo = new LocalJsonAdapter("../data/territorio/municipios.json");
const _adapterProvincias     = new LocalJsonAdapter("../data/territorio/provincias.json");
const _adapterCcaa           = new LocalJsonAdapter("../data/territorio/ccaa.json");

// ─── Adaptadores dinámicos por provincia/CCAA (creados bajo demanda) ──────
// A diferencia de los adaptadores fijos de arriba, aquí NO sabemos de
// antemano qué provincias o CCAA se van a pedir — depende del deployment
// que se cargue en cada instancia de la app. Se usan dos Maps como caché:
// la primera vez que se pide un código se crea su adaptador y se guarda;
// las siguientes veces se reutiliza (mismo espíritu de caché que ya tiene
// LocalJsonAdapter internamente para el fetch, pero aquí a nivel de "qué
// adaptador instanciar", no "qué dato cachear").
const _adaptadoresMunicipiosPorProvincia = new Map();
const _adaptadoresMunicipiosPorCcaa      = new Map();

/**
 * Devuelve (creando si hace falta) el adaptador de municipios de una
 * provincia concreta, a partir de su código INE.
 * @param {string} provinciaCode - ej. "31"
 * @returns {LocalJsonAdapter}
 */
function _getAdapterMunicipiosDeProvincia(provinciaCode) {
  if (!_adaptadoresMunicipiosPorProvincia.has(provinciaCode)) {
    _adaptadoresMunicipiosPorProvincia.set(
      provinciaCode,
      new LocalJsonAdapter(`../data/territorio/municipios_${provinciaCode}.json`)
    );
  }
  return _adaptadoresMunicipiosPorProvincia.get(provinciaCode);
}

/**
 * Devuelve (creando si hace falta) el adaptador de municipios de una
 * CCAA concreta, a partir de su código INE.
 * @param {string} ccaaCode - ej. "15"
 * @returns {LocalJsonAdapter}
 */
function _getAdapterMunicipiosDeCcaa(ccaaCode) {
  if (!_adaptadoresMunicipiosPorCcaa.has(ccaaCode)) {
    _adaptadoresMunicipiosPorCcaa.set(
      ccaaCode,
      new LocalJsonAdapter(`../data/territorio/municipios_ccaa_${ccaaCode}.json`)
    );
  }
  return _adaptadoresMunicipiosPorCcaa.get(ccaaCode);
}

/**
 * Carga un dataset y, si falla, lanza un error que dice QUÉ archivo falta y
 * CÓMO generarlo (M-01, pieza 2). Sin esto, el banner de main.js mostraba
 * solo "HTTP 404 Not Found — ../data/...", sin pista de la solución.
 * La comprobación vive aquí y no en validarDeployment.js porque exige red,
 * y el validador es síncrono y puro a propósito.
 *
 * @param {LocalJsonAdapter} adaptador
 * @param {string} archivo - ruta legible para el mensaje
 * @param {string} comando - comando que genera el archivo
 * @returns {Promise<Array>}
 */
async function _cargarDataset(adaptador, archivo, comando) {
  try {
    return await adaptador.getData();
  } catch (err) {
    throw new Error(
      `[territorioResolver] No se pudo cargar ${archivo} (${err.message}). ` +
      `Si falta, genéralo con: ${comando}`
    );
  }
}

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
 * Caso "municipio" — sin máscara territorial propia. Sigue usando el
 * archivo único data/territorio/municipios.json (lista curada a mano, puede cruzar
 * varias provincias — ver nota al inicio del archivo).
 * El filtro por deployment.municipios (que antes vivía en
 * municipioSelector.js, acoplado al import estático de municipios.js)
 * se resuelve aquí, contra data/territorio/municipios.json vía LocalJsonAdapter.
 */
async function _resolverAmbitoMunicipio(deployment) {
  const todos = await _cargarDataset(
    _adapterMunicipiosDemo,
    "data/territorio/municipios.json",
    "python tools/generar_geografia.py --municipios <códigos separados por coma>"
  );
  const codigosPermitidos = new Set(deployment.municipios ?? []);

  const municipiosDisponibles = codigosPermitidos.size > 0
    ? todos.filter(m => codigosPermitidos.has(m.codigo_ine))
    : todos; // demo: sin filtro, todos los municipios del dataset

  // ── Códigos que no existen en los datos (M-01, pieza 3) ────────────────
  // validarDeployment.js ya comprobó el formato y que en producción haya
  // exactamente uno; lo que solo se puede saber aquí, con el JSON cargado,
  // es si cada código existe. En producción es error: un código mal escrito
  // dejaría la app sin municipio. En demo solo se avisa.
  const encontrados = new Set(municipiosDisponibles.map(m => m.codigo_ine));
  const ausentes    = [...codigosPermitidos].filter(c => !encontrados.has(c));
  if (ausentes.length > 0) {
    const detalle =
      `Código(s) INE ${JSON.stringify(ausentes)} de deployment.municipios no ` +
      `están en data/territorio/municipios.json. Revisa el código o regenera ` +
      `el archivo con tools/generar_geografia.py --municipios.`;
    if (deployment.mode === "demo") {
      console.warn(`[territorioResolver] ${detalle}`);
    } else {
      throw new Error(`[territorioResolver] ${detalle}`);
    }
  }

  if (deployment.mode === "demo") {
    console.info(`[territorioResolver] Modo demo: ${municipiosDisponibles.length} municipios disponibles`);
  }

  return {
    municipiosDisponibles,
    mascaraInicial: null,
  };
}

/**
 * Caso "provincia" — máscara sobre la provincia completa, buscador
 * poblado con todos los municipios de esa provincia.
 *
 * Ya NO filtra sobre un municipios.json global: pide directamente el
 * archivo data/territorio/municipios_<provincia_code>.json, que ya viene recortado
 * a esa provincia desde el propio proceso de generación. El filtro por
 * provincia_code se mantiene igual como salvaguarda barata (por si el
 * archivo llegara a contener algo inesperado), no porque haga falta para
 * el caso normal.
 */
async function _resolverAmbitoProvincia(deployment) {
  const codigoProvincia = deployment.codigoEntidad;

  if (!codigoProvincia) {
    throw new Error(
      "[territorioResolver] ambitoTerritorial 'provincia' requiere deployment.codigoEntidad"
    );
  }

  const [provincias, municipios] = await Promise.all([
    _cargarDataset(
      _adapterProvincias,
      "data/territorio/provincias.json",
      `python tools/generar_geografia.py --provincias ${codigoProvincia}`
    ),
    _cargarDataset(
      _getAdapterMunicipiosDeProvincia(codigoProvincia),
      `data/territorio/municipios_${codigoProvincia}.json`,
      `python tools/generar_geografia.py --municipios-de-provincia ${codigoProvincia}`
    ),
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
    // provincia_code/ccaa_code se exponen sueltos, no solo dentro de
    // mascaraInicial — main.js los necesita para armar territorioData
    // completo (bbox + polygon + códigos), sin tener que desempaquetar
    // dos niveles de objeto. ccaa_code viene del propio registro de
    // provincia.json (heredado del NATCODE al generar el dataset).
    mascaraInicial: {
      bbox:           provincia.bbox,
      polygon:        provincia.polygon,
      provincia_code: provincia.provincia_code,
      ccaa_code:      provincia.ccaa_code,
      codigo_ine:     null, // explícito: a nivel territorio no hay municipio
    },
  };
}

/**
 * Caso "ccaa" — máscara sobre la comunidad autónoma completa, buscador
 * poblado con todos los municipios de esa CCAA.
 *
 * A diferencia de un diseño anterior descartado (que fusionaba en
 * runtime los archivos de cada provincia de la CCAA), aquí se pide
 * directamente el archivo data/territorio/municipios_ccaa_<ccaa_code>.json — ya
 * viene armado desde build time por
 * tools/generar_geografia.py --municipios-de-ccaa, que filtra el
 * shapefile municipal directo por ccaa_code del NATCODE (cada municipio
 * ya trae su propio ccaa_code, sin pasar por el shapefile provincial).
 * Esto simplifica este resolver a exactamente el mismo patrón que
 * _resolverAmbitoProvincia: un solo fetch, sin Promise.all de múltiples
 * provincias ni .flat() para fusionar — mismo comportamiento tanto para
 * una CCAA uniprovincial (Navarra) como multiprovincial (País Vasco).
 */
async function _resolverAmbitoCcaa(deployment) {
  const codigoCcaa = deployment.codigoEntidad;

  if (!codigoCcaa) {
    throw new Error(
      "[territorioResolver] ambitoTerritorial 'ccaa' requiere deployment.codigoEntidad"
    );
  }

  const [ccaas, municipios] = await Promise.all([
    _cargarDataset(
      _adapterCcaa,
      "data/territorio/ccaa.json",
      `python tools/generar_geografia.py --ccaa ${codigoCcaa}`
    ),
    _cargarDataset(
      _getAdapterMunicipiosDeCcaa(codigoCcaa),
      `data/territorio/municipios_ccaa_${codigoCcaa}.json`,
      `python tools/generar_geografia.py --municipios-de-ccaa ${codigoCcaa}`
    ),
  ]);

  const ccaa = ccaas.find(c => c.ccaa_code === codigoCcaa);

  if (!ccaa) {
    throw new Error(
      `[territorioResolver] CCAA con código "${codigoCcaa}" no encontrada en ccaa.json. ` +
      `¿Se generó con tools/generar_geografia.py --ccaa ${codigoCcaa}?`
    );
  }

  // El filtro por ccaa_code se mantiene como salvaguarda barata, igual
  // que en _resolverAmbitoProvincia — el archivo ya viene recortado a
  // esta CCAA desde el generador, no debería hacer falta, pero es una
  // línea de defensa gratuita si el archivo llegara a contener algo
  // inesperado.
  const municipiosDisponibles = municipios.filter(
    m => m.ccaa_code === codigoCcaa
  );

  console.info(
    `[territorioResolver] Ámbito CCAA "${ccaa.nombre}": ` +
    `${municipiosDisponibles.length} municipios disponibles`
  );

  return {
    municipiosDisponibles,
    // provincia_code = null: una CCAA no pertenece a una única provincia.
    // Las capas cobertura.tipo === "provincial" simplemente no aplicarán
    // aquí (configEngine ya maneja undefined/null de forma segura).
    mascaraInicial: {
      bbox:           ccaa.bbox,
      polygon:        ccaa.polygon,
      provincia_code: null,
      ccaa_code:      ccaa.ccaa_code,
      codigo_ine:     null,
    },
  };
}