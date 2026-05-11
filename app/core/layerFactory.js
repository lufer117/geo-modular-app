// layerFactory.js
// ============================================================
// ÚNICA RESPONSABILIDAD: decidir qué clase de Esri instanciar.
// app.js nunca importa clases de capa directamente.
// Para añadir un tipo nuevo: solo añadir una entrada al registro.
// ============================================================

// ── Importaciones con el formato de v5 ───────────────
const [
  WMSLayer,//servicios WMS (OGC)
  WMTSLayer, //tiles de mapas pre-renderizados
  FeatureLayer,//capas vectoriales (features)
  MapImageLayer,//servicios ArcGIS REST raster/vector dinámico
  GeoJSONLayer //datos GeoJSON desde URL
] = await $arcgis.import([ //Carga modulos de Esri de forma dinámica, solo los que se necesitan
  "@arcgis/core/layers/WMSLayer.js",
  "@arcgis/core/layers/WMTSLayer.js",
  "@arcgis/core/layers/FeatureLayer.js",
  "@arcgis/core/layers/MapImageLayer.js",
  "@arcgis/core/layers/GeoJSONLayer.js"
]);

// ── Registro de tipos ───────────────────────────────────────
// Diccionario de constructores de capas, clave = "tipo" en la configuración.
//Cada valor es una función que:
// 1. recibe la cfg (configuración de la capa) WMS, WMTS...
// 2. Crea la clase correcta de Arcgis
// 3. devuelve una instancia de capa de Esri configurada según esa cfg
const REGISTRO_TIPOS = {

  WMS: (cfg) => new WMSLayer({
    id:        cfg.id,
    title:     cfg.title,
    url:       cfg.url,
    sublayers: cfg.sublayers,
    visible:   cfg.visible
  }),

  WMTS: (cfg) => new WMTSLayer({
    id:          cfg.id,
    title:       cfg.title,
    url:         cfg.url,
    activeLayer: cfg.activeLayer,
    visible:     cfg.visible
  }),

  // WFS en Esri se consume como FeatureLayer apuntando al endpoint OGC
  WFS: (cfg) => new FeatureLayer({
    id:      cfg.id,
    title:   cfg.title,
    url:     cfg.url,
    visible: cfg.visible
  }),

  GEOJSON: (cfg) => new GeoJSONLayer({
    id:      cfg.id,
    title:   cfg.title,
    url:     cfg.url,
    visible: cfg.visible
  }),

  ArcGIS_REST: (cfg) => new MapImageLayer({
    id:      cfg.id,
    title:   cfg.title,
    url:     cfg.url,
    visible: cfg.visible
  })

};

// ── Función pública: CREAR CAPA ─────────────────────────────────────────
// Devuelve null si el tipo no existe → app.js lo filtra con .filter(Boolean)
// La app no explota si llega un tipo desconocido desde la configuración.
// 1. Busca el constructor en el registro según el tipo de la cfg
// 2. Si no existe, avisa por consola y devuelve null
// 3. Si existe, lo llama con la cfg
// 4. devuelve la capa creada
export function crearCapa(config) {
  const constructor = REGISTRO_TIPOS[config.tipo];

  if (!constructor) {
    console.warn(
      `[layerFactory] Tipo desconocido: "${config.tipo}" ` +
      `en capa "${config.id}". Se omite.`
    );
    return null;
  }

  return constructor(config);
}