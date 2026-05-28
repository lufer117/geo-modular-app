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
 *
 * ── POR QUÉ ESTÁ AQUÍ Y NO EN layerInitializer ────────────────────────────
 * layerInitializer tiene responsabilidad única: configurar capas ya creadas
 * para un municipio (filtros, bbox, definitionExpression...).
 * Parsear XML de protocolo OGC es una responsabilidad distinta: interpretar
 * la autodescripción de un servicio. Separarla aquí permite reutilizarla
 * desde configEngine, layerInitializer, o cualquier módulo futuro sin
 * arrastrar dependencias del SDK ArcGIS.
 *
 *
 * ── CORS ──────────────────────────────────────────────────────────────────
 *Captura interna: se utiliza bloque try/catch que envuelve tanto la petición de GetCapabilities como la nueva función checkFeaturesInBbox.
 * En lugar de lanzar un error que pueda "romper" la ejecución de otros módulos, captura el error de red (provocado por CORS o caída del servidor), 
 * lo registra en la consola (console.error) y devuelve un array vacío [] o false 
 * Esto evita que el árbol de capas se quede bloqueado o incompleto. 
 * Si un servicio falla por CORS, simplemente no se mostrarán FeatureTypes para ese servicio, 
 * cumpliendo con la directiva de que la app no debe dar error por capas inexistentes o no disponibles.

 */

// Timeouts diferenciados: Capabilities puede ser más lento (XML pesado).
// El check BBOX es una petición mínima (1 feature), no justifica 15 s.
const CAPABILITIES_TIMEOUT_MS = 15_000;
const BBOX_CHECK_TIMEOUT_MS   = 10_000;

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
 * Por qué sin VERSION explícita en la petición: al omitirla el servidor negocia
 * la versión más alta que soporta, evitando hardcodear la versión por servicio.
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
      .filter(ft => ft.name); // descartar entradas sin nombre (malformed XML)

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
 * Se envían ambos parámetros simultáneamente para cubrir WFS 1.x y 2.0
 * sin negociar la versión del servidor.
 *
 * Por qué aquí y no en layerTree:
 *   Consultar disponibilidad espacial vía protocolo OGC es responsabilidad
 *   del parser de WFS (SRP). layerTree solo consume el booleano resultante.
 *
 * Degradación: ante cualquier error de red, timeout o JSON inválido devuelve
 * false para no bloquear el árbol ni mostrar capas vacías.
 *
 * @param {string}   serviceUrl - URL base del servicio WFS
 * @param {string}   typeName   - Nombre del FeatureType (campo name de FeatureTypeInfo)
 * @param {number[]} bbox       - [xmin, ymin, xmax, ymax] en WGS84
 * @returns {Promise<boolean>}  true si existen features en el bbox
 */
async function checkFeaturesInBbox(serviceUrl, typeName, bbox) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BBOX_CHECK_TIMEOUT_MS);

  try {
    // Formato BBOX OGC estándar: xmin,ymin,xmax,ymax,CRS
    const bboxStr = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]},EPSG:4326`;

    const params = new URLSearchParams({
      SERVICE:      'WFS',
      REQUEST:      'GetFeature',
      TYPENAME:     typeName,
      BBOX:         bboxStr,
      COUNT:        '1', // WFS 2.0
      maxFeatures:  '1', // WFS 1.0 / 1.1
      outputFormat: 'application/json',
    });

    const response = await fetch(`${_cleanUrl(serviceUrl)}?${params}`, {
      signal: controller.signal,
    });

    if (!response.ok) return false;

    const data = await response.json();
    // GeoJSON FeatureCollection estándar: { type: "FeatureCollection", features: [...] }
    return Array.isArray(data?.features) && data.features.length > 0;

  } catch {
    // AbortError (timeout), NetworkError o JSON malformado → sin datos
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Heurística rápida: ¿la URL parece apuntar a un servicio WFS?
 * Útil para validar entradas antes de lanzar peticiones de red.
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
