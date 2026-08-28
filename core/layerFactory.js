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
 * Definida en layerFactory.js
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

// Ejecutada por municipioSelector.js
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
    const layer      = new LayerClass(params); // Crea la capa en memoria, lista para añadir al mapa
    
    // Popup genérico automático (sin curación editorial todavía — fase de
    // validación). Cubre WFS/FEATURE (atributos cliente) y WMS atómico
    // (GetFeatureInfo a nivel de servicio completo). WMS con sublayers ya
    // recibió su popupTemplate por sublayer dentro de _buildParams.
    _aplicarPopupGenerico(layer, config);

    

    return layer;

  } catch (err) {
    console.error(`[layerFactory] Error al crear capa "${config.id}":`, err);
    return null;
  }
}

/**
 * Crea una instancia WFSLayer para un FeatureType hijo descubierto
 * dinámicamente vía GetCapabilities.
 * 
 * Definida en layerFactory.js
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

//Ejecutada por: layerTree.js
// POR QUÉ UNA FUNCIÓN SEPARADA Y NO REUTILIZAR crearCapa ───────────────
// crearCapa() espera un config completo del catálogo (con id, bloque_tematico,
// disponibilidad_municipal…). Pero un FeatureType hijo viene del parser de
// Capabilities y solo tiene name, title, abstract y crs — no tiene registro 
// en el catálogo. 
// 
// Esta función deriva un config mínimo a partir del padre (que sí está en el
// catálogo) y el FeatureType descubierto en el parser de capabilities, manteniendo la trazabilidad con el
// servicio original sin contaminar el catálogo con entradas sintéticas.
export async function crearCapaWfsHija(featureType, configPadre) {
  try {
    const WFSLayer = await $arcgis.import("esri/layers/WFSLayer");

    // El id del hijo combina el id del padre con el nombre del FeatureType.
    // Esto garantiza unicidad incluso si dos servicios WFS declaran un tipo
    // con el mismo nombre (ej: dos servidores con "municipios:Municipios").
    // El separador "::" es suficientemente raro en los nombres OGC para evitar colisiones.
    const hijoId = `${configPadre.id}::${featureType.name}`; //IGN::Municipios Catastro::Municipios. Si usa solo : los servicios OGC también lo usan y puede haber colisión

    const layer = new WFSLayer({
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

    // Mismo helper que el flujo estándar — las capas WFS hijas también
    // tienen atributos cliente reales, mismo mecanismo fieldInfos.
    _aplicarPopupGenerico(layer, { tipo: "WFS" });

    return layer;

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


function _buildParams(config) { //config es json
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

    // featureInfoFormat a nivel de WMSLayer (no de Sublayer).
    // El SDK usa este valor para construir la petición GetFeatureInfo automática
    // al hacer clic sobre la capa. "text/html" produce popups enriquecidos;
    // "text/plain" es el fallback seguro para servidores que no soportan HTML.
    // Se declara aquí (capa padre) porque afecta a todas las sublayers por igual.
    featureInfoFormat: config.featureInfoFormat ?? "text/html",

    // sublayers: mapea las sublayers curadas del catálogo al formato que WMSLayer espera.
    //
    // PATRÓN DE CURACIÓN EDITORIAL (30.06.26 — 3DECISIONS.md):
    // A diferencia de WFS (donde el discovery automático es seguro porque cualquier
    // FeatureType expuesto es útil), los servicios WMS mezclan capas de geometría
    // con elementos de renderizado puro (labels, grids). El catálogo decide qué
    // sublayers se exponen y con qué título — el servidor no manda.
    //
    // Sin sublayers en catálogo → capa atómica (comportamiento legacy sin cambios).
    // Con sublayers en catálogo → se mapean aquí individualmente.
    ...(config.sublayers?.length
      ? {
          sublayers: config.sublayers.map(sl => {
            // Objeto base de la sublayer con propiedades siempre presentes.
            // name es el identificador técnico que el servidor WMS reconoce
            // en el parámetro LAYERS de la petición GetMap/GetFeatureInfo.
            // title es el nombre editorial del catálogo, no el del servidor.
            const sublayerObj = {
              name:  sl.id,
              title: sl.title,

              // CRÍTICO: visible se fuerza desde el catálogo (sl.visible ?? false).
              // Sin esto, WMSLayer hereda el visible del GetCapabilities del servidor,
              // que casi siempre es `true` por defecto → bug "sublayers entran con check".
              // El catálogo manda, no el proveedor externo.
              visible: sl.visible ?? false,

              // queryable: habilita GetFeatureInfo para esta sublayer.
              // Se declara explícitamente porque algunos servidores lo exponen como
              // queryable="0" en Capabilities aunque realmente lo soporten.
              // El catálogo asume que si la incluimos, es consultable.
              queryable: sl.queryable ?? true,

              // popupEnabled: condición necesaria (además de queryable y featureInfoFormat)
              // para que el SDK abra el popup al hacer clic. No se hereda del servidor
              // ni se infiere desde queryable — debe declararse explícitamente.
              // Sin esta propiedad, queryable y featureInfoFormat son condición necesaria
              // pero no suficiente (01.07.26 — 3DECISIONS.md).
              popupEnabled: sl.popupEnabled ?? true,

              // popupTemplate vacío declarado en construcción (no post-load).
              // Sublayer acepta popupTemplate como propiedad del constructor, igual que
              // name/title/visible. El SDK rellenará el contenido con la respuesta
              // GetFeatureInfo al hacer clic. content:[] es el placeholder que indica
              // "sin template propio → usar la respuesta del servidor directamente".
              popupTemplate: {
                title:   sl.title,
                content: []
              }
            };

            // LEYENDA — lógica de tres casos
            //
            // CASO A: catálogo declara legendUrl como string → URL válida conocida.
            //   Se pasa al SDK directamente. Útil para servicios con URL de leyenda
            //   no estándar o que el catálogo quiere sobreescribir.
            //
            // CASO B: catálogo declara legendUrl como null → el servidor no soporta
            //   GetLegendGraphic (ej. Catastro OVC). NO se añade la propiedad al
            //   objeto sublayer. El SDK intentará leer <LegendURL> del Capabilities,
            //   que en Catastro está anidada bajo la layer padre como simbolos.png.
            //
            // CASO C: legendUrl ausente en catálogo (undefined) → comportamiento por defecto.
            //   _construirLegendUrl() genera la URL estándar de GetLegendGraphic.
            //   Funciona para servicios conformes al estándar OGC (IGN, GeoServer, IDENA...).
            //
            // NUNCA se pasa legendUrl: null al objeto Esri. El SDK interpreta null como
            // "sin leyenda" y muestra "no legend". undefined (propiedad ausente) activa
            // el mecanismo automático de lectura desde Capabilities.
            if (typeof sl.legendUrl === "string") {
              // Caso A: URL explícita en catálogo
              sublayerObj.legendUrl = sl.legendUrl;
            } else if (sl.legendUrl === undefined) {
              // Caso C: no declarada → generar URL estándar GetLegendGraphic
              const generada = _construirLegendUrl(config.url, sl.id);
              if (generada) sublayerObj.legendUrl = generada;
            }
            // Caso B: sl.legendUrl === null → no añadir propiedad → SDK lee Capabilities

            return sublayerObj;
          })
        }
      : {}  // Sin sublayers en catálogo → WMSLayer atómica, SDK gestiona todo
    )
  };

    case "WMTS":
      return {
      ...base,
      url: config.url,
      // CAMBIO (01.07.26): config.sublayers[0] ya no es un string plano, es un
      // objeto { id, title, visible } — mismo formato unificado que WMS (ver caso
      // "WMS" arriba). WMTS solo soporta una capa activa a la vez (activeLayer),
      // a diferencia de WMS que admite varias sublayers simultáneas — por eso aquí
      // seguimos tomando solo el primer elemento del array, pero leyendo .id en
      // vez de tratarlo como string.
      ...(config.sublayers?.[0]
        ? { activeLayer: { id: config.sublayers[0].id } }
        : {})
    }

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
 * Normaliza/Convierte un CRS OGC (EPSG:4326, urn:ogc:def:crs:EPSG::4258, etc.)
 * al WKID numérico que espera el SDK de ArcGIS.
 * 
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

// Ejecutada por crearCapaWfsHija() → return new WFSLayer más arriba ↑

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

// ─── Constructor URL de GetLegendGraphic ───────────────────────────────────────────
/**
 * Construye la URL de GetLegendGraphic para una sublayer WMS individual,
 * siguiendo el estándar OGC soportado por GeoServer, MapServer y ArcGIS Server.
 *
 * Por qué se construye aquí y no se declara en el catálogo: la URL es 100%
 * derivable de (url base del servicio + nombre técnico de la sublayer) — no
 * es información editorial, es mecánica. Guardarla en el catálogo duplicaría
 * datos que ya están ahí (config.url + sl.id) sin ganar nada, violando DRY.
 *
 * @param {string} serviceUrl - URL base del servicio WMS (config.url)
 * @param {string} sublayerName - Nombre técnico LAYERS de la sublayer
 * @returns {string} URL completa de GetLegendGraphic
 */
function _construirLegendUrl(serviceUrl, sublayerName) {
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetLegendGraphic",
    format: "image/png",
    width: "20",
    height: "20",
    layer: sublayerName
  });
  return `${serviceUrl}?${params.toString()}`;
}

// ─── Popup generico ───────────────────────────────────────────
/**
 * Aplica un popupTemplate genérico automático a capas que NO tienen
 * curación editorial de popup en el catálogo (fase de validación rápida,
 * previa a la Opción C — popup curado por campo `popup` en catalogo-capas.json).
 *
 * ── POR QUÉ DOS MECANISMOS DISTINTOS SEGÚN TIPO ──────────────────────────
 * WFS/FEATURE cargan geometría + atributos en cliente → el SDK puede
 * introspeccionar campos reales (fieldInfos: [] = autodetección total).
 * WMS es imagen renderizada, no hay tabla de atributos en cliente → el
 * popup dispara GetFeatureInfo contra el servidor (protocolo OGC distinto).
 * "{*}" como content le dice al SDK que renderice la respuesta cruda del
 * servidor para esa consulta puntual.
 *
 * ── POR QUÉ WMS-CON-SUBLAYERS NO SE TOCA AQUÍ ────────────────────────────
 * Si config.sublayers existe, el popup ya se asignó por sublayer dentro de
 * _buildParams (más preciso: aísla la respuesta a la sublayer clickeada).
 * Aplicar aquí también pisaría esa configuración más fina con un popup a
 * nivel de capa completa — la granularidad del popup espeja la granularidad
 * de curación del catálogo, mismo principio que sublayers (30/06/26).
 *
 * @param {Layer} layer - Instancia ya creada (WFSLayer, FeatureLayer, WMSLayer)
 * @param {Object} config - Config original del catálogo (o config mínimo
 *   { tipo } cuando se invoca desde crearCapaWfsHija, que no tiene catálogo)
 */
function _aplicarPopupGenerico(layer, config) {
  if (config.tipo === "WFS" || config.tipo === "FEATURE") {
    layer.popupTemplate = {
      title: layer.title || "Información",
      content: [{ type: "fields"}]
    };
  } else if (config.tipo === "WMS") {

    // El SDK v5 busca popupTemplate en la sublayer clickeada, no en la capa madre.
    // Necesitamos recorrer las sublayers que el SDK ya cargó (que pueden ser más
    // que las declaradas en el catálogo — el servidor puede tener capas adicionales).
    if (!config.sublayers?.length) { 
      // WMS atómico — popup a nivel de capa
      layer.popupTemplate = {
        title: layer.title || "Información",
        content: "{*}"
        };
      } 
  // GEOJSON, WMTS, ArcGIS_REST: sin popup automático todavía —
  // fuera del alcance acordado en esta iteración.
  }
}





// ─── REFERENCES ──────────────────────────────────

// FeatureLayer https://developers.arcgis.com/javascript/latest/references/core/layers/FeatureLayer/
// WFSLayer https://developers.arcgis.com/javascript/latest/references/core/layers/WFSLayer/