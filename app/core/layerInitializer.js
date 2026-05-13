// core/layerInitializer.js
// ============================================================
// RESPONSABILIDAD:
// Aplicar comportamiento runtime a capas ya creadas.
// layerInitializer  → configura estado dinámico (load, sublayers, etc.)
// ============================================================

const INITIALIZERS = {
  WMS: inicializarWMS,
  WMTS: null,
  WFS: null,
  GEOJSON: null,
  ArcGIS_REST: null,
  GRUPO: inicializarGrupo
};

// ───────────────────────────────────────────────────────────
// API pública
// ───────────────────────────────────────────────────────────
export async function inicializarCapa(layer, config) {

  const initializer = INITIALIZERS[config.tipo];

  // Si no hay inicializador, no hacemos nada
  if (!initializer) return;

  await initializer(layer, config);

  // Importante: si es grupo, inicializar hijos recursivamente
  if (config.tipo === "GRUPO") {
    await inicializarHijosGrupo(layer, config);
  }
}

// ───────────────────────────────────────────────────────────
// WMS
// ───────────────────────────────────────────────────────────
async function inicializarWMS(layer, config) {

  try {
    await layer.load();
  } catch (err) {
    console.warn(
      `[layerInitializer] Error cargando WMS "${config.id}"`,
      err
    );
    return;
  }

  // Apagar sublayers si así está definido en config
  if (config.subLayersVisible === false) {

    layer.sublayers.forEach((sublayer) => {
      sublayer.visible = false;
    });
  }
}

// ───────────────────────────────────────────────────────────
// GRUPO (opcional lógica futura del grupo en sí)
// ───────────────────────────────────────────────────────────
async function inicializarGrupo(layer, config) {
  // actualmente no necesita lógica propia
  // reservado para futuras reglas (ej: expand/collapse, filtros globales)
}

// ───────────────────────────────────────────────────────────
// Inicialización recursiva de hijos en grupos
// ───────────────────────────────────────────────────────────
async function inicializarHijosGrupo(groupLayer, config) {

  if (!groupLayer?.layers || !config?.capas) return;

  for (let i = 0; i < config.capas.length; i++) {

    const childConfig = config.capas[i];
    const childLayer  = groupLayer.layers.getItemAt(i);

    if (!childLayer) continue;

    await inicializarCapa(childLayer, childConfig);
  }
}