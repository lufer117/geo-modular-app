// core/layerInitializer.js
// ============================================================
// RESPONSABILIDAD:
// Aplicar comportamiento runtime tras crear las capas.
//
// layerFactory → crea instancias
// layerInitializer → aplica lógica dinámica/runtime
// ============================================================

const INITIALIZERS = {

  WMS: inicializarWMS,

  WMTS: null,
  WFS: null,
  GEOJSON: null,
  ArcGIS_REST: null,
  GRUPO: null
};

// ── API pública ───────────────────────────────────────────
export async function inicializarCapa(layer, config) {

  const initializer = INITIALIZERS[config.tipo];

  if (!initializer) return;

  await initializer(layer, config);
}

// ── WMS ───────────────────────────────────────────────────
async function inicializarWMS(layer, config) {

  try {

    await layer.load();

  } catch {

    console.warn(
      `[layerInitializer] No se pudo cargar WMS "${config.id}"`
    );

    return;
  }

  // ── Sublayers apagadas al inicio ───────────────────────
  if (config.subLayersVisible === false) {

    layer.sublayers.forEach(sublayer => {

      sublayer.visible = false;

    });
  }
}