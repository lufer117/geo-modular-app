/**
 * utils/wfsCapabilitiesParser.js
 *
 * Utilidad de protocolo OGC: obtiene y parsea el GetCapabilities de un
 * servicio WFS y devuelve su lista de FeatureTypes.
 *
 * ── POR QUÉ ESTÁ AQUÍ Y NO EN layerInitializer ────────────────────────────
 * layerInitializer tiene responsabilidad única: configurar capas ya creadas
 * para un municipio (filtros, bbox, definitionExpression...).
 * Parsear XML de protocolo OGC es una responsabilidad distinta: interpretar
 * la autodescripción de un servicio. Separarla aquí permite reutilizarla
 * desde configEngine, layerInitializer, o cualquier módulo futuro sin
 * arrastrar dependencias del SDK ArcGIS.
 *
 * ── COMPATIBILIDAD DE VERSIONES ────────────────────────────────────────────
 * WFS 1.0.0 → FeatureType/Name + FeatureType/Title
 * WFS 1.1.0 → FeatureType/Name + FeatureType/Title (igual, mismo espacio de nombres)
 * WFS 2.0.0 → FeatureType/Name + FeatureType/Title (mismo elemento, distinto namespace)
 *
 * El parser es agnóstico a la versión: busca el elemento <Name> dentro de
 * cada <FeatureType> sin importar el namespace declarado. Esto cubre los tres
 * estándares con un único selector de XPath via querySelector.
 *
 * ── CORS ──────────────────────────────────────────────────────────────────
 * Los servicios públicos OGC (IGN, Catastro, MITECO…) deben tener CORS
 * habilitado para que el navegador acepte la respuesta. Si no lo tienen,
 * el fetch lanzará un TypeError de red. fetchFeatureTypes() propaga el error
 * para que el llamador lo gestione (por ejemplo, mostrando un placeholder
 * en el árbol de capas en lugar de romper la app).
 */

// ─── Constantes ────────────────────────────────────────────────────────────

/**
 * Parámetros mínimos para solicitar el Capabilities.
 * No incluimos VERSION aquí para que el servidor negocie su versión máxima.
 * Algunos servidores antiguos rechazan versiones que no soportan si se
 * indica explícitamente; sin VERSION el servidor responde con la que prefiera.
 */
const CAPABILITIES_PARAMS = new URLSearchParams({
  SERVICE: "WFS",
  REQUEST: "GetCapabilities",
});

/**
 * Tiempo máximo de espera por el Capabilities (ms).
 * Los servicios públicos españoles pueden ser lentos; 15 s es un umbral
 * razonable antes de considerar el servicio no disponible.
 */
const FETCH_TIMEOUT_MS = 15_000;

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Obtiene la lista de FeatureTypes de un servicio WFS.
 *
 * @param {string} serviceUrl - URL base del servicio WFS (sin parámetros OGC)
 * @returns {Promise<FeatureTypeInfo[]>} Lista de tipos disponibles (puede ser vacía)
 * @throws {Error} Si el fetch falla o el XML no es parseable
 *
 * @typedef {Object} FeatureTypeInfo
 * @property {string}      name     - Nombre técnico del FeatureType (ej: "mdt:CurvasNivel")
 * @property {string}      title    - Título legible del FeatureType (ej: "Curvas de nivel")
 * @property {string|null} abstract - Descripción del tipo (puede ser null)
 * @property {string|null} crs      - CRS por defecto declarado (ej: "EPSG:4258")
 */
export async function fetchFeatureTypes(serviceUrl) {
  const url = _buildCapabilitiesUrl(serviceUrl);

  const xml = await _fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  const doc = _parseXml(xml);

  return _extractFeatureTypes(doc);
}

/**
 * Devuelve true si una URL de catálogo parece ser un servicio WFS.
 * Útil en layerTree para decidir si un nodo necesita expansión lazy.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isWfsUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  // Un servicio WFS siempre responde a SERVICE=WFS o tiene /wfs en la ruta
  return lower.includes("service=wfs") || lower.includes("/wfs");
}

// ─── Construcción de URL ──────────────────────────────────────────────────

/**
 * Construye la URL de GetCapabilities eliminando primero cualquier parámetro
 * OGC residual que pudiera haber en la URL base del catálogo
 * (algunos catálogos almacenan la URL con ?SERVICE=WFS&... ya incluido).
 *
 * @param {string} serviceUrl
 * @returns {string}
 */
function _buildCapabilitiesUrl(serviceUrl) {
  // Separar base y query string para limpiar parámetros OGC previos
  const [base] = serviceUrl.split("?");

  // Reconstruir con solo los parámetros mínimos necesarios
  return `${base}?${CAPABILITIES_PARAMS.toString()}`;
}

// ─── Fetch con timeout ────────────────────────────────────────────────────

/**
 * fetch() envuelto en AbortController para respetar el timeout configurado.
 * Sin timeout, un servicio que no responde bloquea el árbol indefinidamente.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<string>} Texto XML de la respuesta
 */
async function _fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timerId    = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(
        `[wfsCapabilitiesParser] HTTP ${response.status} al obtener Capabilities de: ${url}`
      );
    }

    return await response.text();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `[wfsCapabilitiesParser] Timeout (${timeoutMs}ms) al obtener Capabilities de: ${url}`
      );
    }
    throw err;
  } finally {
    // Limpiar el timer siempre, tanto en éxito como en error
    clearTimeout(timerId);
  }
}

// ─── Parseo XML ───────────────────────────────────────────────────────────

/**
 * Convierte el texto XML a Document DOM.
 * DOMParser está disponible en todos los navegadores modernos sin dependencias.
 *
 * @param {string} xmlText
 * @returns {Document}
 */
function _parseXml(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, "application/xml");

  // DOMParser no lanza excepciones; indica errores con un elemento <parsererror>
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error(
      `[wfsCapabilitiesParser] XML inválido: ${parseError.textContent.slice(0, 200)}`
    );
  }

  return doc;
}

// ─── Extracción de FeatureTypes ───────────────────────────────────────────

/**
 * Extrae la lista de FeatureTypes del Document XML.
 *
 * ── POR QUÉ querySelectorAll("FeatureType") SIN NAMESPACE ─────────────────
 * querySelector/querySelectorAll en modo XML ignora los prefijos de namespace
 * en los selectores CSS. Por eso "FeatureType" localiza el elemento
 * independientemente de si está declarado como:
 *   <FeatureType>          (WFS 1.0.0 sin namespace explícito)
 *   <wfs:FeatureType>      (WFS 1.1.0 / 2.0.0 con prefijo wfs:)
 *
 * Los elementos hijo (Name, Title, Abstract, DefaultSRS/DefaultCRS) también
 * se buscan por nombre local → agnóstico a la versión.
 *
 * @param {Document} doc
 * @returns {FeatureTypeInfo[]}
 */
function _extractFeatureTypes(doc) {
  // Localizar todos los elementos <FeatureType> del documento
  const featureTypeEls = doc.querySelectorAll("FeatureType");

  if (featureTypeEls.length === 0) {
    console.warn(
      "[wfsCapabilitiesParser] No se encontraron FeatureType en el Capabilities. " +
      "¿Es realmente un servicio WFS?"
    );
    return [];
  }

  const result = [];

  featureTypeEls.forEach(ftEl => {
    const name = _textContent(ftEl, "Name");

    // Un FeatureType sin Name es inválido según el estándar OGC → ignorar
    if (!name) {
      console.warn("[wfsCapabilitiesParser] FeatureType sin elemento Name — ignorado");
      return;
    }

    result.push({
      name,
      // Title: legible para el usuario. Si no existe, usar el Name como fallback.
      title: _textContent(ftEl, "Title") ?? name,
      // Abstract: descripción opcional. null si no existe.
      abstract: _textContent(ftEl, "Abstract"),
      // CRS por defecto:
      //   WFS 1.x → DefaultSRS
      //   WFS 2.0 → DefaultCRS
      // Se prueba ambos para cubrir todas las versiones.
      crs: _textContent(ftEl, "DefaultCRS") ?? _textContent(ftEl, "DefaultSRS"),
    });
  });

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Obtiene el textContent del primer hijo con ese nombre local dentro de un
 * elemento padre. Devuelve null si el elemento no existe o está vacío.
 *
 * querySelector con nombre local funciona sin prefijo de namespace en
 * DOMParser("application/xml"), lo que cubre WFS 1.0, 1.1 y 2.0.
 *
 * @param {Element} parentEl
 * @param {string}  localName
 * @returns {string|null}
 */
function _textContent(parentEl, localName) {
  const el = parentEl.querySelector(localName);
  if (!el) return null;
  const text = el.textContent.trim();
  return text.length > 0 ? text : null;
}