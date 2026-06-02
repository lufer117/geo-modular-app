/**
 * core/layerFactory.js
 *
 * Fábrica de capas: transforma un objeto de configuración del catálogo
 * en una instancia de capa Esri lista para añadir al Map.
 *
 * Config JSON → layerFactory → instancia Esri → map.add(layer): 
 * Catalogo-capas.json define las capas de forma abstracta: usas strings como "WMS", "WFS" o "GEOJSON". 
 * El SDK de ArcGIS necesita clases específicas como WMSLayer o WFSLayer.
 * 
 * Objetivo: evitar alto uso de if (tipo === "WMS") ...else if (tipo === "WMTS") ...else if ...
 * Dado un config.tipo → import módulo arcgis dinámicamente (cuando se necesita) 
 *
 * 
 * ── RESPONSABILIDAD ÚNICA ────────────────────────────────────────────────
 * Solo instancia. No aplica filtros runtime (eso es layerInitializer).
 * No toca el DOM. No conoce el municipio seleccionado.
 *
 * ── TIPOS SOPORTADOS ─────────────────────────────────────────────────────
 *   WMS         → WMSLayer       (servicios OGC WMS)
 *   WMTS        → WMTSLayer      (servicios OGC WMTS, teselas)
 *   WFS         → WFSLayer       (servicios OGC WFS, vectores)
 *   GEOJSON     → GeoJSONLayer   (archivos/endpoints GeoJSON)
 *   ArcGIS_REST → MapImageLayer  (servicios REST Esri, dinámicos)
 *   FEATURE     → FeatureLayer   (servicios Feature de ArcGIS Online/Server)
 */

// Registro tipo → módulo Esri.
// Mantenerlo aquí centraliza el mapa de dependencias del SDK.
// Ej: si arcgis cambia esri/layers/WFSLayer, solo se cambiaría esa línea

const _TIPO_MAP = {
  "WMS":         "esri/layers/WMSLayer",
  "WMTS":        "esri/layers/WMTSLayer",
  "WFS":         "esri/layers/WFSLayer",
  "GEOJSON":     "esri/layers/GeoJSONLayer",
  "ArcGIS_REST": "esri/layers/MapImageLayer",
  "FEATURE":     "esri/layers/FeatureLayer"
};


// ─── API PÚBLICA CREAR CAPA ──────────────────────────────────────────────────────────

/**
 * Crea una instancia de capa Esri a partir de la configuración del catálogo.
 * 
 * Ejecutada por: municipioSelector.js 
 * 
 * @param {Object} config - Objeto de configuración proveniente de catalogo-capas.json
 * @returns {Promise<Layer|null>} Instancia de capa, o null si el tipo es desconocido
 * 
 * 
 * 1. El objeto config llega en municipioSelector.js a través de:
 * 2. configEngine.fetchCapas(municipioData) → devuelve un ARRAY de objetos config
 * 3. configs.map(config => crearCapa(config)) → cada elemento se pasa como parámetro
 *
 * @example
 * {
 *   id: "catastro",
 *   tipo: "wms",        // ← determina qué clase cargar
 *   url: "https://...",
 *   title: "Catastro"
 * }
 *
 *  // Flujo interno:
 *  1. config.tipo // resuelve el módulo (ej. "wms" → "./layers/WMSLayer.js")
 *  2. $arcgis.import() // carga la clase dinámicamente (ej. WMSLayer)
 *  3. _buildParams(config) // construye parámetros (url, id, title, etc.)
 *  4. new ClaseCargada(params) // instancia la capa viva en el mapa
 * 
 */


export async function crearCapa(config) {
  const modulePath = _TIPO_MAP[config.tipo]; // busca el tipo "WMS" y devuelve "esri/layers/WMSLayer" = modulePath

  if (!modulePath) { // muestra en consola error si no encuentra tipo 
    console.warn(
      `[layerFactory] Tipo desconocido: "${config.tipo}" (id: "${config.id}"). ` +
      `Tipos soportados: ${getTiposImplementados().join(", ")}`
    );
    return null; // si la capa es invalida, la ignora y la app sigue viva
  }

  try { // para que la capa mala ↑ if!modulePath no rompa la app
    const LayerClass = await $arcgis.import(modulePath); // se carga el módulo que se necesita "WMSLayer". LayerClass lo guarda como plantilla de una layer que se instanciará más adelante. Ej, "new LayerClass(...) = new WMSLayer(...)""
    const params     = _buildParams(config); //Traduce las propiedades de nuestro JSON (como url o title) al formato exacto que espera el constructor de ArcGIS
    return new LayerClass(params); // Si el tipo es "WMS" → "new WMSLayer(...)". La capa ya es creada en memoria para ser añadida cuando layerInitializer la procese  

  } catch (err) {
    console.error(`[layerFactory] Error al crear capa "${config.id}":`, err);
    return null;
  }
}

/**
 * Crea una instancia WFSLayer para un FeatureType hijo descubierto
 * dinámicamente vía GetCapabilities.
 * 
 * Ejecutada por: layerTree.js
 *
 * ── POR QUÉ UNA FUNCIÓN SEPARADA Y NO REUTILIZAR crearCapa ───────────────
 * crearCapa() espera un config completo del catálogo (con id, bloque_tematico,
 * disponibilidad_municipal…). Pero un FeatureType hijo viene del parser de
 * Capabilities y solo tiene name, title, abstract y crs — no tiene registro 
 * en el catálogo. 
 *
 * Esta función deriva un config mínimo a partir del padre (que sí está en el
 * catálogo) y el FeatureType descubierto en el parser de capabilities, manteniendo la trazabilidad con el
 * servicio original sin contaminar el catálogo con entradas sintéticas.
 *
 * @param {import('../utils/wfsCapabilitiesParser.js').FeatureTypeInfo} featureType
 *   Objeto devuelto por fetchFeatureTypes(): { name, title, abstract, crs }
 * @param {Object} configPadre
 *   Config del catálogo del servicio WFS padre (tiene url, srsname, etc.)
 * @returns {Promise<WFSLayer|null>}
 */


export async function crearCapaWfsHija(featureType, configPadre) {
  try {
    const WFSLayer = await $arcgis.import("esri/layers/WFSLayer");

    // El id del hijo combina el id del padre con el nombre del FeatureType.
    // Esto garantiza unicidad incluso si dos servicios WFS declaran un tipo
    // con el mismo nombre (ej: dos servidores con "municipios:Municipios").
    // El separador "::" es suficientemente raro en los nombres OGC para evitar colisiones.
    const hijoId = `${configPadre.id}::${featureType.name}`; //IGN::Municipios Catastro::Municipios. Si usa solo : los servicios OGC también lo usan y puede haber colisión

    return new WFSLayer({
      id:      hijoId,
      title:   featureType.title,
      url:     configPadre.url,
      name:    featureType.name,
      // Heredar el CRS del padre si el hijo no declara uno.
      // El estándar OGC obliga a declarar DefaultCRS en cada FeatureType,
      // pero algunos servidores no cumplen el estándar; el fallback evita errores.
      ...(featureType.crs
        ? { spatialReference: { wkid: _crsToWkid(featureType.crs) } }
        : configPadre.srsname
          ? { spatialReference: { wkid: _crsToWkid(configPadre.srsname) } }
          : {}
      ),
      // Arrancan ocultas; el usuario las activa desde el árbol de capas.
      visible: false
    });

  } catch (err) {
    console.error(
      `[layerFactory] Error al crear capa WFS hija "${featureType.name}":`, err
    );
    return null;
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

// ─── CONSTRUCCIÓN DE PARÁMETROS POR TIPO  ──────────────────────────────────

/**
 * Construye el objeto de parámetros para el constructor Esri.
 * Separa la lógica de parametrización por tipo para facilitar
 * el mantenimiento cuando evolucionen los tipos.
 * 
 * Transforma un objeto de configuración plano (proveniente del catalogo-capas.json) en un objeto de propiedades que el SDK pueda entender para instanciar cada tipo de capa.
 * 
 *
 * @param {Object} config
 * @returns {Object}
 */


function _buildParams(config) {
  // Parámetros comunes a todos los tipos
  const base = {
    id:      config.id, //lo usará layerTree.js
    title:   config.title, // lo usa layerTree.js
    visible: config.visible ?? false  // Las capas arrancan ocultas; el usuario las activa
  };

  switch (config.tipo) { // la función adapta el JSON del catalogo a los requisitos del SDK según el servicio

    case "WMS":
      return {
        ...base,
        url: config.url,
        // sublayers: mapea los nombres de capa del catálogo al formato que WMSLayer espera.
        // Si el catálogo no define sublayers, WMSLayer usa todas las que declare el servicio.
        ...(config.sublayers?.length
          ? { sublayers: config.sublayers.map(name => ({ name })) } // Arcgis espera [{ name: "Catastro" },{ name: "Parcelas" }]
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
        ...base, // "..." copia todos los objetos de base 
        url: config.url,
        // name: selecciona un FeatureType concreto del servicio WFS.
        // Si no está en el catálogo, el SDK coge el primero del GetCapabilities
        // → puede ser un servicio con millones de features.
        // Las entradas WFS sin name son servicios "padre" que se expandirán
        // dinámicamente en layerTree via GetCapabilities (discovery mode).
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

// ─── HELPERS PRIVADOS ─────────────────────────────────────────────────────

/**
 * Convierte un CRS OGC (EPSG:4326, urn:ogc:def:crs:EPSG::4258, etc.)
 * al WKID numérico que espera el SDK de ArcGIS.
 *
 * ── FORMATOS CONOCIDOS ────────────────────────────────────────────────────
 * Los servidores WFS españoles usan tres variantes del mismo estándar:
 *   "EPSG:4326"                        → WFS 1.x, formato corto
 *   "urn:ogc:def:crs:EPSG::4326"       → WFS 2.0, URN largo
 *   "http://www.opengis.net/def/crs/EPSG/0/4326"  → WFS 2.0, URI HTTP
 *
 * En todos los casos, el número al final es el WKID.
 * Si el formato no coincide con ningún patrón conocido, devuelve 4326
 * como fallback seguro (WGS84, el más común en servicios públicos españoles).
 *
 * @param {string} crs - Identificador CRS del Capabilities
 * @returns {number} WKID numérico
 */


function _crsToWkid(crs) {
  if (!crs) return 4326;

  // Extraer el número final de cualquier formato conocido
  // Ejemplos: "EPSG:4326" → "4326", "urn:ogc:def:crs:EPSG::25830" → "25830"
  const match = crs.match(/(\d+)$/);
  if (match) {
    const wkid = parseInt(match[1], 10);
    // Validación básica: WKID válidos están en rango razonable
    if (wkid > 0 && wkid < 1_000_000) return wkid;
  }

  console.warn(
    `[layerFactory] CRS no reconocido: "${crs}" → usando EPSG:4326 como fallback`
  );
  return 4326;
}



// ─── REFERENCES ──────────────────────────────────

// FeatureLayer https://developers.arcgis.com/javascript/latest/references/core/layers/FeatureLayer/
// WFSLayer https://developers.arcgis.com/javascript/latest/references/core/layers/WFSLayer/