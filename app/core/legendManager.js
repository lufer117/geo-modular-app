// core/legendManager.js
// ============================================================
// ÚNICA RESPONSABILIDAD: construir y mantener la leyenda
// dinámica para cualquier tipo de capa.
//
// Por qué un módulo separado y no arcgis-legend Web Component:
//   arcgis-legend no procesa correctamente las sublayers WMS
//   de servicios públicos españoles (IGN, Catastro, IDEE).
//   Este módulo lee legendUrl directamente del GetCapabilities
//   ya procesado por el SDK, y escucha cambios de visibilidad
//   para actualizarse sin intervención de main.js.
//
// Extensión futura:
//   Añadir un handler por tipo en LEGEND_BUILDERS.
//   main.js y el DOM no cambian.
// ============================================================

// ── Registro de constructores de leyenda por tipo de capa ──
// Mismo patrón que REGISTRO_TIPOS en layerFactory.
// Para añadir un tipo nuevo: solo una entrada aquí.
const LEGEND_BUILDERS = {

  wms:     buildWMSLegend,
  wmts:    buildGenericLegend,
  feature: buildGenericLegend,
  geojson: buildGenericLegend,
  "map-image": buildGenericLegend,
  group:   null   // los grupos se procesan recursivamente, no tienen leyenda propia
};

// ── API pública ─────────────────────────────────────────────
// Inicializa la leyenda sobre el contenedor DOM recibido.
// Recorre el árbol de capas del mapa y construye una entrada
// por cada capa. Escucha cambios de visibilidad en tiempo real.
export async function initLegend(container, mapView) {
  container.innerHTML = "";

  // Construir leyenda inicial con las capas actuales
  const capas = mapView.map.layers.toArray();
  for (const capa of capas) {
    await procesarCapa(container, capa);
  }

  // Escuchar capas que se añadan en el futuro (configEngine)
  mapView.map.layers.on("change", async ({ added }) => {
    for (const capa of added) {
      await procesarCapa(container, capa);
    }
  });
}

// ── Procesado recursivo del árbol de capas ──────────────────
async function procesarCapa(container, capa) {
  // Grupos: procesar sus hijos sin crear entrada de leyenda propia
  if (capa.type === "group") {
    for (const hijo of capa.layers.toArray()) {
      await procesarCapa(container, hijo);
    }

    // Si se añaden capas al grupo en el futuro, procesarlas también
    capa.layers.on("change", async ({ added }) => {
      for (const hijo of added) {
        await procesarCapa(container, hijo);
      }
    });
    return;
  }

  const builder = LEGEND_BUILDERS[capa.type];

  // Tipo sin leyenda definida: aviso en consola, no rompe la app
  if (!builder) {
    console.warn(`[legendManager] Sin leyenda para tipo: "${capa.type}"`);
    return;
  }

  await builder(container, capa);
}

// ── WMS: lee legendUrl de cada sublayer tras GetCapabilities ─
// sublayer.legendUrl ya está disponible después de layer.load().
// Se escucha visibilidad de la capa Y de cada sublayer por separado.

async function buildWMSLegend(container, capa) {
  try {
    await capa.load();
  } catch {
    console.warn(`[legendManager] No se pudo cargar la capa WMS: "${capa.title}"`);
    return;
  }

  const wrapper = crearWrapper(capa.id);

  // ── Función central de refresco ─────────────────────────
  function actualizarVisibilidadWrapper() {

    // sublayers visibles reales
    const visibles = capa.sublayers.some(s => s.visible);

    // mostrar wrapper SOLO si:
    // 1. capa padre visible
    // 2. existe al menos una sublayer visible
    wrapper.style.display =
      (capa.visible && visibles)
        ? "block"
        : "none";
  }

  // ── Escuchar capa padre ────────────────────────────────
  capa.watch("visible", actualizarVisibilidadWrapper);

  // ── Crear items por sublayer ───────────────────────────
  capa.sublayers.forEach(sublayer => {

    const item = crearItemLeyenda(
      sublayer.title ?? sublayer.name
    );

    // visibilidad inicial
    item.style.display =
      sublayer.visible ? "flex" : "none";

    // escuchar cambios individuales
    sublayer.watch("visible", visible => {

      item.style.display =
        visible ? "flex" : "none";

      actualizarVisibilidadWrapper();
    });

    if (sublayer.legendUrl) {

      const img = document.createElement("img");

      img.src = sublayer.legendUrl;
      img.alt = sublayer.title ?? sublayer.name;
      img.className = "legend-img";

      item.appendChild(img);
    }

    wrapper.appendChild(item);
  });

  // estado inicial
  actualizarVisibilidadWrapper();

  container.appendChild(wrapper);
}

// async function buildWMSLegend(container, capa) {
//   try {
//     await capa.load();
//   } catch {
//     console.warn(`[legendManager] No se pudo cargar la capa WMS: "${capa.title}"`);
//     return;
//   }

//   // Wrapper de la capa completa (se muestra/oculta con la capa)
//   const wrapper = crearWrapper(capa.id);


//   wrapper.style.display = capa.visible ? "block" : "none";

//   // Escuchar visibilidad de la capa padre
//   capa.watch("visible", visible => {
//     wrapper.style.display = visible ? "block" : "none";
//   });

//   // Una entrada por sublayer con su propia legendUrl
//   capa.sublayers.forEach(sublayer => {
//     const item = crearItemLeyenda(sublayer.title ?? sublayer.name);
//     item.style.display = sublayer.visible ? "flex" : "none";

//     // Escuchar visibilidad de la sublayer individualmente
//     sublayer.watch("visible", visible => {
//       item.style.display = visible ? "flex" : "none";
//     });

//     if (sublayer.legendUrl) {
//       const img = document.createElement("img");
//       img.src     = sublayer.legendUrl;
//       img.alt     = sublayer.title ?? sublayer.name;
//       img.className = "legend-img";
//       item.appendChild(img);
//     }

//     wrapper.appendChild(item);
//   });

//   container.appendChild(wrapper);
// }

// ── Otros tipos: placeholder hasta implementar por renderer ─
// FeatureLayer y GeoJSON tienen renderer con símbolos propios.
// En una fase posterior se leerá layer.renderer para construir
// la leyenda sin depender de servicios externos.
function buildGenericLegend(container, capa) {
  const wrapper = crearWrapper(capa.id);
  wrapper.style.display = capa.visible ? "block" : "none";

  capa.watch("visible", visible => {
    wrapper.style.display = visible ? "block" : "none";
  });

  const item = crearItemLeyenda(capa.title);
  item.classList.add("legend-pending");
  item.title = "Leyenda disponible en próxima fase";
  wrapper.appendChild(item);

  container.appendChild(wrapper);
}

// ── Helpers de DOM ──────────────────────────────────────────
function crearWrapper(id) {
  const div = document.createElement("div");
  div.className        = "legend-layer-wrapper";
  div.dataset.layerId  = id;
  return div;
}

function crearItemLeyenda(titulo) {
  const item = document.createElement("div");
  item.className = "legend-item";

  const span = document.createElement("span");
  span.className   = "legend-title";
  span.textContent = titulo;

  item.appendChild(span);
  return item;
}