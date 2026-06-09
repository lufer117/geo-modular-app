/**
 * utils/wfsCapabilitiesParser.js
 *
 * Responsabilidad única: comunicarse con servicios WFS a nivel de protocolo OGC.
 *   - fetchFeatureTypes   → parsea GetCapabilities → lista de FeatureTypes
 *   - checkFeaturesInBbox → verifica disponibilidad espacial de un FeatureType
 *   - isWfsUrl            → heurística rápida de tipo de servicio
 *
 * Sin dependencias del SDK ArcGIS. Sin DOM. Reutilizable desde cualquier módulo.
 *
 * Compatibilidad de versiones WFS:
 *   querySelectorAll("FeatureType") sin prefijo de namespace localiza el elemento
 *   independientemente del prefijo declarado (<FeatureType> o <wfs:FeatureType>).
 *   Cubre WFS 1.0.0, 1.1.0 y 2.0.0 con un único selector.
 *
 * ── POR QUÉ ESTÁ AQUÍ Y NO EN layerInitializer ────────────────────────────
 * layerInitializer tiene responsabilidad única: configurar capas ya creadas
 * para un municipio (filtros, bbox, definitionExpression...).
 * Parsear XML de protocolo OGC es una responsabilidad distinta: interpretar
 * la autodescripción de un servicio. Separarla aquí permite reutilizarla
 * desde configEngine, layerInitializer, o cualquier módulo futuro sin
 * arrastrar dependencias del SDK ArcGIS.
 *
 * ── DETECCIÓN DE outputFormat JSON ────────────────────────────────────────
 * Los servidores WFS declaran los formatos de salida soportados en Capabilities.
 * El valor para JSON varía por implementación:
 *   - GeoServer estándar:  "application/json"
 *   - ArcGIS Server:       "GEOJSON", "ESRIGEOJSON"
 *   - Otros:               cualquier valor que contenga "json"
 *
 * fetchFeatureTypes detecta el formato JSON soportado al parsear Capabilities
 * y lo almacena en _outputFormatCache (Map<urlLimpia, string|null>).
 * checkFeaturesInBbox consulta ese caché para usar el formato correcto,
 * sin que layerTree necesite conocer ni pasar ese detalle de protocolo.
 * Si no hay ningún formato JSON disponible, devuelve true (degradación segura):
 * es preferible mostrar un nodo activable que deshabilitar una capa con datos.
 *
 * ── DETECCIÓN DE ORDEN DE EJES (ArcGIS Server LongLat) ───────────────────
 * ArcGIS Server publicado en modo WFS puede declarar en Capabilities el keyword
 * "ESRI(LongLat)", indicando que espera el bbox en orden ymin,xmin,ymax,xmax
 * en lugar del orden estándar OGC xmin,ymin,xmax,ymax.
 * Enviar el orden estándar a estos servidores devuelve siempre features:[]
 * aunque haya datos reales en el municipio — confirmado empíricamente con SIOSE.
 * fetchFeatureTypes detecta el keyword y almacena el orden en _axisOrderCache.
 * checkFeaturesInBbox construye el string BBOX con el orden correcto para
 * cada servidor sin que ningún módulo externo necesite conocer este detalle.
 *
 * ── TYPENAME con namespace ────────────────────────────────────────────────
 * URLSearchParams codifica ":" como "%3A". ArcGIS Server no reconoce el
 * FeatureType con el namespace codificado y devuelve features:[] sin error.
 * La query string se construye manualmente para preservar ":" literal.
 *
 * ── CORS ──────────────────────────────────────────────────────────────────
 * Captura interna: se utiliza bloque try/catch que envuelve tanto la petición
 * de GetCapabilities como checkFeaturesInBbox. En lugar de lanzar un error
 * que pueda romper la ejecución de otros módulos, captura el error de red
 * (provocado por CORS o caída del servidor), lo registra en consola y devuelve
 * un array vacío [] o false. Esto evita que el árbol de capas se quede
 * bloqueado o incompleto.
 */

// Activar para diagnóstico de servicios WFS con comportamiento no estándar.
// false en producción — no genera ruido en consola cuando todo funciona bien.
// Muestra: outputFormats disponibles en Capabilities, URL exacta del GetFeature,
// y resultado del check (typeName + número de features devueltos).
const DEBUG = false;

/** @param {...any} args */
function _log(...args) {
  if (DEBUG) console.log('[wfsCapabilitiesParser:debug]', ...args);
}

// Timeouts diferenciados: Capabilities puede ser más lento (XML pesado).
// El check BBOX es una petición mínima (1 feature), no justifica 15 s.
const CAPABILITIES_TIMEOUT_MS = 15_000;
const BBOX_CHECK_TIMEOUT_MS   = 10_000;

// ─── cachés de comportamiento por servicio ────────────────────────────────────
//
// Ambos Maps usan la URL limpia (_cleanUrl) como clave para identificar
// unívocamente el servicio independientemente de parámetros OGC residuales.
// fetchFeatureTypes siempre se ejecuta antes que checkFeaturesInBbox en el
// flujo de discovery, garantizando que los cachés están poblados cuando se
// necesitan. layerTree no necesita conocer ninguno de estos detalles (SRP).

/** outputFormat JSON a usar en GetFeature. null = sin JSON disponible. */
const _outputFormatCache = new Map();

/** Orden de ejes del bbox. 'xy' = estándar OGC. 'yx' = ArcGIS Server LongLat. */
const _axisOrderCache = new Map();

// ─── helpers privados ────────────────────────────────────────────────────────

/**
 * Elimina parámetros OGC residuales de la URL base antes de construir
 * la query string propia. Evita duplicados como "SERVICE=WFS&SERVICE=WFS".
 * También elimina la query string vacía ("?") para URLs limpias.
 *
 * @param {string} url
 * @returns {string}
 */
function _cleanUrl(url) {
  const parsed = new URL(url, location.href);
  [
    'SERVICE', 'REQUEST', 'VERSION',
    'TYPENAME', 'TYPENAMES',
    'BBOX', 'COUNT', 'MAXFEATURES', 'OUTPUTFORMAT',
  ].forEach(p => {
    parsed.searchParams.delete(p);
    parsed.searchParams.delete(p.toLowerCase());
  });
  return parsed.toString().replace(/\?$/, '');
}

/**
 * Determina si un valor de outputFormat declarado en Capabilities es JSON.
 * Detección por substring "json" (case-insensitive) para cubrir todas las
 * variantes sin enumerar cada una explícitamente.
 *
 * @param {string} valor
 * @returns {boolean}
 */
function _esFormatoJson(valor) {
  return valor.toLowerCase().includes('json');
}

/**
 * Selecciona el mejor outputFormat JSON entre los declarados por el servidor.
 *
 * Por qué prioridad y no el primero disponible: el orden en Capabilities es
 * arbitrario según implementación. La prioridad garantiza que se usa el formato
 * más interoperable disponible.
 *
 * Por qué geojson antes que esrigeojson: ESRIGEOJSON es formato propietario
 * cuya estructura puede diferir del GeoJSON estándar que espera el check de
 * features (data.features.length). GEOJSON estándar es más seguro como primer
 * candidato cuando ambos están disponibles.
 *
 * Se compara en minúsculas pero se devuelve el valor original del servidor
 * para enviarlo literalmente en la petición (case-sensitive en ArcGIS Server).
 *
 * @param {string[]} valoresPermitidos
 * @returns {string|null} Valor original del formato seleccionado, o null si no hay JSON
 */
function _seleccionarOutputFormat(valoresPermitidos) {
  const candidatos = valoresPermitidos.filter(_esFormatoJson);
  if (candidatos.length === 0) return null;

  const prioridad = [
    'application/json',   // GeoServer estándar
    'application/geo+json',
    'geojson',            // ArcGIS Server — estándar preferido sobre propietario
    'esrigeojson',        // ArcGIS Server — fallback si no hay geojson estándar
  ];

  for (const preferido of prioridad) {
    const encontrado = candidatos.find(c => c.toLowerCase() === preferido);
    if (encontrado) return encontrado;
  }

  // JSON disponible pero no reconocido en la lista → usar el primero
  return candidatos[0];
}

/**
 * Construye el string BBOX respetando el orden de ejes del servidor.
 *
 * OGC estándar ('xy'): xmin,ymin,xmax,ymax,CRS
 * ArcGIS Server LongLat ('yx'): ymin,xmin,ymax,xmax,CRS
 *
 * Por qué no se reproyecta aquí: los servicios españoles que usan este parser
 * sirven sus datos en EPSG:4326 independientemente del DefaultCRS declarado
 * en Capabilities (confirmado empíricamente con SIOSE/Fomento). La reproyección
 * a otros CRS queda fuera del alcance de este módulo sin dependencias externas.
 *
 * @param {number[]} bbox      - [xmin, ymin, xmax, ymax] en WGS84
 * @param {'xy'|'yx'} axisOrder
 * @returns {string}
 */
function _buildBboxString(bbox, axisOrder) {
  const [xmin, ymin, xmax, ymax] = bbox;
  if (axisOrder === 'yx') {
    // ymin,xmin,ymax,xmax — orden que espera ArcGIS Server con ESRI(LongLat)
    return `${ymin},${xmin},${ymax},${xmax},EPSG:4326`;
  }
  return `${xmin},${ymin},${xmax},${ymax},EPSG:4326`;
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FeatureTypeInfo
 * @property {string}      name     - Nombre interno del FeatureType (para TYPENAME)
 * @property {string}      title    - Título legible para mostrar en UI
 * @property {string}      abstract - Descripción del servicio
 * @property {string|null} crs      - CRS en formato OGC (EPSG:4326, URN, URI HTTP).
 *                                    layerFactory._crsToWkid normaliza los tres formatos.
 */

/**
 * Obtiene y parsea el GetCapabilities de un servicio WFS.
 *
 * Además de los FeatureTypes, detecta dos características del servidor que
 * checkFeaturesInBbox necesita para construir peticiones correctas:
 *   1. outputFormat JSON soportado → _outputFormatCache
 *   2. Orden de ejes del bbox → _axisOrderCache
 *
 * Ambos cachés se pueblan aquí porque fetchFeatureTypes siempre se ejecuta
 * antes que checkFeaturesInBbox en el flujo de discovery. Así checkFeaturesInBbox
 * tiene todo lo necesario sin recibir parámetros adicionales de layerTree.
 *
 * Por qué sin VERSION explícita: al omitirla el servidor negocia la versión
 * más alta que soporta, evitando hardcodear la versión por servicio.
 *
 * @param {string} serviceUrl - URL base del servicio WFS
 * @returns {Promise<FeatureTypeInfo[]>}
 */
async function fetchFeatureTypes(serviceUrl) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CAPABILITIES_TIMEOUT_MS);

  try {
    const url = `${_cleanUrl(serviceUrl)}?SERVICE=WFS&REQUEST=GetCapabilities`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`GetCapabilities falló: HTTP ${response.status}`);
    }

    const text = await response.text();
    const xml  = new DOMParser().parseFromString(text, 'application/xml');

    const cleanedUrl = _cleanUrl(serviceUrl);

    // ── 1. Detectar outputFormat JSON ──────────────────────────────────────
    //
    // Se busca dentro de <Operation name="GetFeature"> específicamente,
    // no en el primer <Parameter name="outputFormat"> del documento.
    // El primer bloque corresponde a DescribeFeatureType (sin JSON);
    // solo GetFeature declara los formatos relevantes para nuestro check.
    const getFeatureOp =
      xml.querySelector('Operation[name="GetFeature"]') ??
      xml.querySelector('Operation[name="getFeature"]');

    const paramNode = getFeatureOp
      ? (getFeatureOp.querySelector('Parameter[name="outputFormat"]') ??
         getFeatureOp.querySelector('Parameter[name="OutputFormat"]'))
      : null;

    const valoresPermitidos = paramNode
      ? Array.from(paramNode.querySelectorAll('Value')).map(v => v.textContent.trim())
      : [];

    _log('outputFormats disponibles en Capabilities:', valoresPermitidos);

    const formatoJson = _seleccionarOutputFormat(valoresPermitidos);
    _outputFormatCache.set(cleanedUrl, formatoJson);

    if (formatoJson) {
      console.info(`[wfsCapabilitiesParser] outputFormat: "${formatoJson}" — ${serviceUrl}`);
    } else {
      console.warn(`[wfsCapabilitiesParser] Sin outputFormat JSON — ${serviceUrl} — checkFeaturesInBbox asumirá disponible`);
    }

    // ── 2. Detectar orden de ejes ───────────────────────────────────────────
    //
    // ArcGIS Server publicado con WFS declara "ESRI(LongLat)" en los keywords
    // del ServiceIdentification cuando espera bbox en orden ymin,xmin,ymax,xmax.
    // Enviar el orden estándar OGC (xmin,ymin,xmax,ymax) a estos servidores
    // devuelve siempre features:[] aunque haya datos reales — confirmado con SIOSE.
    const keywords = Array.from(xml.querySelectorAll('Keyword'))
      .map(k => k.textContent.trim());
    const axisOrder = keywords.some(k => k.includes('LongLat')) ? 'yx' : 'xy';
    _axisOrderCache.set(cleanedUrl, axisOrder);

    if (axisOrder === 'yx') {
      console.info(`[wfsCapabilitiesParser] Orden de ejes invertido detectado (ESRI LongLat) — ${serviceUrl}`);
    }

    // ── 3. Parsear FeatureTypes ─────────────────────────────────────────────
    //
    // querySelectorAll sin prefijo: cubre <FeatureType> y <wfs:FeatureType>
    const nodes = xml.querySelectorAll('FeatureType');

    return Array.from(nodes)
      .map(node => ({
        name:     node.querySelector('Name')?.textContent?.trim()     ?? '',
        title:    node.querySelector('Title')?.textContent?.trim()    ?? '',
        abstract: node.querySelector('Abstract')?.textContent?.trim() ?? '',
        // DefaultCRS (WFS 2.0), DefaultSRS (WFS 1.1), SRS (WFS 1.0)
        crs: node.querySelector('DefaultCRS, DefaultSRS, SRS')
               ?.textContent?.trim() ?? null,
      }))
      .filter(ft => ft.name);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[wfsCapabilitiesParser] Timeout en GetCapabilities: ${serviceUrl}`);
    } else {
      console.error(`[wfsCapabilitiesParser] Error en GetCapabilities:`, err);
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Comprueba si un FeatureType tiene geometrías dentro del bbox del municipio.
 *
 * Estrategia: GetFeature mínimo (COUNT=1 / maxFeatures=1) con filtro BBOX.
 * Se envían ambos parámetros para cubrir WFS 1.x y 2.0 sin negociar versión.
 *
 * El outputFormat y el orden de ejes del bbox se obtienen de los cachés
 * poblados por fetchFeatureTypes — checkFeaturesInBbox no necesita recibirlos
 * como parámetros ni layerTree necesita conocerlos (SRP).
 *
 * Degradación segura:
 *   - Sin outputFormat JSON en caché → return true (nodo activable)
 *   - Error de red, timeout, JSON inválido → return false
 * Es preferible un nodo activable con posibles features vacías que deshabilitar
 * una capa con datos reales por un fallo de protocolo.
 *
 * Por qué query string manual y no URLSearchParams:
 *   URLSearchParams codifica ":" como "%3A". ArcGIS Server no reconoce el
 *   FeatureType con el namespace codificado y devuelve features:[] sin error.
 *
 * @param {string}   serviceUrl - URL base del servicio WFS
 * @param {string}   typeName   - Nombre del FeatureType (campo name de FeatureTypeInfo)
 * @param {number[]} bbox       - [xmin, ymin, xmax, ymax] en WGS84
 * @returns {Promise<boolean>}  true si existen features en el bbox
 */
async function checkFeaturesInBbox(serviceUrl, typeName, bbox) {
  const cleanedUrl   = _cleanUrl(serviceUrl);
  const outputFormat = _outputFormatCache.get(cleanedUrl) ?? null;

  if (outputFormat === null) {
    console.warn(`[wfsCapabilitiesParser] Sin outputFormat JSON para ${serviceUrl} — asumiendo disponible`);
    return true;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BBOX_CHECK_TIMEOUT_MS);

  try {
    const axisOrder = _axisOrderCache.get(cleanedUrl) ?? 'xy';
    const bboxStr   = _buildBboxString(bbox, axisOrder);

    // Query manual: preserva ":" literal en TYPENAME (namespace de ArcGIS Server).
    // URLSearchParams lo codifica como "%3A" → el servidor no reconoce el tipo.
    const queryString = [
      'SERVICE=WFS',
      'REQUEST=GetFeature',
      `TYPENAME=${typeName}`,
      `BBOX=${bboxStr}`,
      'COUNT=1',
      'maxFeatures=1',
      `outputFormat=${outputFormat}`,
    ].join('&');

    _log('GetFeature URL:', `${cleanedUrl}?${queryString}`);

    const response = await fetch(`${cleanedUrl}?${queryString}`, {
      signal: controller.signal,
    });

    if (!response.ok) return false;

    const data = await response.json();
    const count = data?.features?.length ?? 0;
    _log('Resultado bbox check:', typeName, '→ features:', count);
    return Array.isArray(data?.features) && count > 0;

  } catch {
    // AbortError, NetworkError o JSON malformado → no penalizar la capa
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Heurística rápida: ¿la URL parece apuntar a un servicio WFS?
 *
 * @param {string} url
 * @returns {boolean}
 */
function isWfsUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes('wfs') || lower.includes('service=wfs');
}

export { fetchFeatureTypes, checkFeaturesInBbox, isWfsUrl };