// // layerFactory.js
// // ============================================================
// // ÚNICA RESPONSABILIDAD: decidir qué clase de Esri instanciar.
// // main.js nunca importa clases de capa directamente.
// // Para añadir un tipo nuevo: solo añadir una entrada al registro.
// // ============================================================
// // Añadido:
// //   - Tipo "GRUPO" → GroupLayer (árbol desplegable en LayerList)
// //   - sublayers null → WMSLayer carga todas desde GetCapabilities
// //   - legendEnabled aplicado también a sublayers de WMS
// // ============================================================

// // ── Importaciones con el formato de v5 ───────────────
// const [
//   WMSLayer,//servicios WMS (OGC)
//   WMTSLayer, //tiles de mapas pre-renderizados
//   FeatureLayer,//capas vectoriales (features)
//   MapImageLayer,//servicios ArcGIS REST raster/vector dinámico
//   GeoJSONLayer, //datos GeoJSON desde URL
//   GroupLayer
// ] = await $arcgis.import([ //Carga modulos de Esri de forma dinámica, solo los que se necesitan
//   "@arcgis/core/layers/WMSLayer.js",
//   "@arcgis/core/layers/WMTSLayer.js",
//   "@arcgis/core/layers/FeatureLayer.js",
//   "@arcgis/core/layers/MapImageLayer.js",
//   "@arcgis/core/layers/GeoJSONLayer.js",
//   "@arcgis/core/layers/GroupLayer.js"
// ]);

// // ── Registro de tipos ───────────────────────────────────────
// // Diccionario de constructores de capas, clave = "tipo" en la configuración.
// //Cada valor es una función que:
// // 1. recibe la cfg (configuración de la capa) WMS, WMTS...
// // 2. Crea la clase correcta de Arcgis
// // 3. devuelve una instancia de capa de Esri configurada según esa cfg

//   const REGISTRO_TIPOS = {
//   GRUPO: (cfg) => {
//     const groupLayer = new GroupLayer({
//       id:      cfg.id,
//       title:   cfg.title,
//       visible: true,  // SIEMPRE visible para mantener el árbol visible
//       visibilityMode: cfg.visibilityMode ?? "independent",
//       layers:  cfg.capas.map(crearCapa).filter(Boolean)
//     });
//   },
   

//   // ── WMS ──────────────────────────────────────────────────
//   // sublayers: null → el SDK carga todas desde GetCapabilities.
//   // sublayers: [{ name: "..." }] → solo las especificadas.
//   // El spread condicional evita pasar undefined a la clase.
//   WMS: (cfg) => new WMSLayer({
//     id:            cfg.id,
//     title:         cfg.title,
//     url:           cfg.url,
//     visible:       cfg.visible ?? false,
//     legendEnabled: cfg.legendEnabled ?? true,
//     ...(cfg.sublayers && { sublayers: cfg.sublayers }),
//     ...(cfg.description && { description: cfg.description })
//   }),

//   WMTS: (cfg) => new WMTSLayer({
//     id:            cfg.id,
//     title:         cfg.title,
//     url:           cfg.url,
//     activeLayer:   cfg.activeLayer,
//     visible:       cfg.visible ?? false,
//     legendEnabled: cfg.legendEnabled ?? true,
//     ...(cfg.description && { description: cfg.description })
//   }),

//   // WFS se consume en Esri como FeatureLayer apuntando al endpoint OGC
//   WFS: (cfg) => new FeatureLayer({
//     id:            cfg.id,
//     title:         cfg.title,
//     url:           cfg.url,
//     visible:       cfg.visible ?? false,
//     legendEnabled: cfg.legendEnabled ?? true,
//     ...(cfg.description && { description: cfg.description })
//   }),

//   GEOJSON: (cfg) => new GeoJSONLayer({
//     id:            cfg.id,
//     title:         cfg.title,
//     url:           cfg.url,
//     visible:       cfg.visible ?? false,
//     legendEnabled: cfg.legendEnabled ?? true,
//     ...(cfg.description && { description: cfg.description })
//   }),

//   ArcGIS_REST: (cfg) => new MapImageLayer({
//     id:            cfg.id,
//     title:         cfg.title,
//     url:           cfg.url,
//     visible:       cfg.visible ?? false,
//     legendEnabled: cfg.legendEnabled ?? true,
//     ...(cfg.description && { description: cfg.description })
//   })

// };

// // ── Función pública ─────────────────────────────────────────
// export function crearCapa(config) {
//   const constructor = REGISTRO_TIPOS[config.tipo];

//   if (!constructor) {
//     console.warn(
//       `[layerFactory] Tipo desconocido: "${config.tipo}" ` +
//       `en capa "${config.id}". Se omite.`
//     );
//     return null;
//   }

//   return constructor(config);
// }


// layerFactory.js
// ============================================================
// ÚNICA RESPONSABILIDAD: decidir qué clase de Esri instanciar.
// main.js nunca importa clases de capa directamente.
// Para añadir un tipo nuevo: solo añadir una entrada al registro.
// ============================================================
// Añadido:
//   - Tipo "GRUPO" → GroupLayer (árbol desplegable en LayerList)
//   - sublayers null → WMSLayer carga todas desde GetCapabilities
//   - legendEnabled aplicado también a sublayers de WMS
// ============================================================

// ── Importaciones con el formato de v5 ───────────────
const [
  WMSLayer,//servicios WMS (OGC)
  WMTSLayer, //tiles de mapas pre-renderizados
  FeatureLayer,//capas vectoriales (features)
  MapImageLayer,//servicios ArcGIS REST raster/vector dinámico
  GeoJSONLayer, //datos GeoJSON desde URL
  GroupLayer
] = await $arcgis.import([ //Carga modulos de Esri de forma dinámica, solo los que se necesitan
  "@arcgis/core/layers/WMSLayer.js",
  "@arcgis/core/layers/WMTSLayer.js",
  "@arcgis/core/layers/FeatureLayer.js",
  "@arcgis/core/layers/MapImageLayer.js",
  "@arcgis/core/layers/GeoJSONLayer.js",
  "@arcgis/core/layers/GroupLayer.js"
]);

// ── Registro de tipos ───────────────────────────────────────
// Diccionario de constructores de capas, clave = "tipo" en la configuración.
//Cada valor es una función que:
// 1. recibe la cfg (configuración de la capa) WMS, WMTS...
// 2. Crea la clase correcta de Arcgis
// 3. devuelve una instancia de capa de Esri configurada según esa cfg
const REGISTRO_TIPOS = {
  GRUPO: (cfg) => new GroupLayer({
    id:      cfg.id,
    title:   cfg.title,
    visible: cfg.visible ?? true,
    visibilityMode: cfg.visibilityMode ?? "independent",
    layers:  cfg.capas.map(crearCapa).filter(Boolean)
  }),

  // ── WMS ──────────────────────────────────────────────────
  // sublayers: null → el SDK carga todas desde GetCapabilities.
  // sublayers: [{ name: "..." }] → solo las especificadas.
  // El spread condicional evita pasar undefined a la clase.
  WMS: (cfg) => new WMSLayer({
    id:            cfg.id,
    title:         cfg.title,
    url:           cfg.url,
    visible:       cfg.visible,
    legendEnabled: cfg.legendEnabled ?? true,
    ...(cfg.sublayers && { sublayers: cfg.sublayers }),
    ...(cfg.description && { description: cfg.description })
  }),

  WMTS: (cfg) => new WMTSLayer({
    id:            cfg.id,
    title:         cfg.title,
    url:           cfg.url,
    activeLayer:   cfg.activeLayer,
    visible:       cfg.visible,
    legendEnabled: cfg.legendEnabled ?? true,
    ...(cfg.description && { description: cfg.description })
  }),

  // WFS se consume en Esri como FeatureLayer apuntando al endpoint OGC
  WFS: (cfg) => new FeatureLayer({
    id:            cfg.id,
    title:         cfg.title,
    url:           cfg.url,
    visible:       cfg.visible,
    legendEnabled: cfg.legendEnabled ?? true,
    ...(cfg.description && { description: cfg.description })
  }),

  GEOJSON: (cfg) => new GeoJSONLayer({
    id:            cfg.id,
    title:         cfg.title,
    url:           cfg.url,
    visible:       cfg.visible,
    legendEnabled: cfg.legendEnabled ?? true,
    ...(cfg.description && { description: cfg.description })
  }),

  ArcGIS_REST: (cfg) => new MapImageLayer({
    id:            cfg.id,
    title:         cfg.title,
    url:           cfg.url,
    visible:       cfg.visible,
    legendEnabled: cfg.legendEnabled ?? true,
    ...(cfg.description && { description: cfg.description })
  })

};

// ── Función pública ─────────────────────────────────────────
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
