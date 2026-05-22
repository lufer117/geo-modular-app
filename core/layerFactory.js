/**
 * core/layerFactory.js
 *
 * Fábrica de capas: transforma un objeto de configuración del catálogo
 * en una instancia de capa Esri lista para añadir al Map.
 *
 * ── RESPONSABILIDAD ÚNICA ────────────────────────────────────────────────
 * Solo instancia. No aplica filtros runtime (eso es layerInitializer).
 * No toca el DOM. No conoce el municipio seleccionado.
 *
 * ── EXTENSIÓN ────────────────────────────────────────────────────────────
 * Añadir soporte a un nuevo tipo:
 *   1. Añadir entrada en _TIPO_MAP: "TIPO": "esri/layers/XLayer"
 *   2. Añadir case en _buildParams() si necesita parámetros especiales
 * El resto del código no cambia.
 *
 * ── TIPOS SOPORTADOS ─────────────────────────────────────────────────────
 *   WMS         → WMSLayer       (servicios OGC WMS)
 *   WMTS        → WMTSLayer      (servicios OGC WMTS, teselas)
 *   WFS         → WFSLayer       (servicios OGC WFS, vectores)
 *   GEOJSON     → GeoJSONLayer   (archivos/endpoints GeoJSON)
 *   ArcGIS_REST → MapImageLayer  (servicios REST Esri, dinámicos)
 *   FEATURE     → FeatureLayer   (servicios Feature de ArcGIS Online/Server)
 */

// Registro tipo → módulo Esri
// Mantenerlo aquí centraliza el mapa de dependencias del SDK.
const _TIPO_MAP = {
  "WMS":         "esri/layers/WMSLayer",
  "WMTS":        "esri/layers/WMTSLayer",
  "WFS":         "esri/layers/WFSLayer",
  "GEOJSON":     "esri/layers/GeoJSONLayer",
  "ArcGIS_REST": "esri/layers/MapImageLayer",
  "FEATURE":     "esri/layers/FeatureLayer"
};

/**
 * Crea una instancia de capa Esri a partir de la configuración del catálogo.
 *
 * @param {Object} config - Objeto de catalogo-capas.json
 * @returns {Promise<Layer|null>} Instancia de capa, o null si el tipo es desconocido
 */
export async function crearCapa(config) {
  const modulePath = _TIPO_MAP[config.tipo];

  if (!modulePath) {
    console.warn(
      `[layerFactory] Tipo desconocido: "${config.tipo}" (id: "${config.id}"). ` +
      `Tipos soportados: ${getTiposImplementados().join(", ")}`
    );
    return null;
  }

  try {
    const LayerClass = await $arcgis.import(modulePath);
    const params     = _buildParams(config);
    return new LayerClass(params);

  } catch (err) {
    console.error(`[layerFactory] Error al crear capa "${config.id}":`, err);
    return null;
  }
}

// ─── Construcción de parámetros por tipo ──────────────────────────────────

/**
 * Construye el objeto de parámetros para el constructor Esri.
 * Separa la lógica de parametrización por tipo para facilitar
 * el mantenimiento cuando evolucionen los tipos.
 *
 * @param {Object} config
 * @returns {Object}
 */
function _buildParams(config) {
  // Parámetros comunes a todos los tipos
  const base = {
    id:      config.id,
    title:   config.title,
    visible: config.visible ?? false  // Las capas arrancan ocultas; el usuario las activa
  };

  switch (config.tipo) {

    case "WMS":
      return {
        ...base,
        url: config.url,
        // sublayers: mapea los nombres de capa del catálogo al formato que WMSLayer espera.
        // Si el catálogo no define sublayers, WMSLayer usa todas las que declare el servicio.
        ...(config.sublayers?.length
          ? { sublayers: config.sublayers.map(name => ({ name })) }
          : {})
      };

    case "WMTS":
      return {
        ...base,
        url: config.url,
        ...(config.sublayers?.[0]
          ? { activeLayer: { id: config.sublayers[0] } }
          : {})
      };

    case "WFS":
      return {
        ...base,
        url:    config.url,
        // WFSLayer en SDK v5 consume el servicio WFS nativamente
        // El formato interno es GeoJSON; no hace falta especificarlo

        // ─── LÍMITE TEMPORAL DE PRUEBA ───────────────────────────────────
        // WFSLayer sin filtro espacial descarga el servicio completo.
        // 2.5M features → warning + fallo. Limitamos a 500 para verificar
        // que la capa carga, renderiza y responde correctamente antes de
        // implementar el filtro real por municipio (siguiente paso).
        // Cuando el filtro espacial esté activo, este valor se elimina.
        // maxRecordCount: 500
        
        // ─── FEATURE TYPE CONCRETO DEL SERVICIO ───────────────────────────────────
        // name: selecciona un feature type concreto del servicio WFS.
        // Sin este parámetro el SDK coge el primero del GetCapabilities
        // → puede ser un servicio con millones de features.
        // El catálogo declara qué feature type es relevante para este municipio.
        ...(config.name ? { name: config.name } : {})
      };

    case "GEOJSON":
      return {
        ...base,
        url: config.url
      };

    case "ArcGIS_REST":
      return {
        ...base,
        url: config.url,
        ...(config.sublayers?.length
          ? { sublayers: config.sublayers.map(name => ({ name })) }
          : {})
      };

    case "FEATURE":
      return {
        ...base,
        url: config.url
      };

    default:
      // Fallback genérico: solo url + propiedades base
      return { ...base, url: config.url };
  }
}

/**
 * Devuelve la lista de tipos de capa implementados.
 * Útil para logging y validación en desarrollo.
 * @returns {string[]}
 */
export function getTiposImplementados() {
  return Object.keys(_TIPO_MAP);
}