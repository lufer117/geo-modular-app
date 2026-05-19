/**
 * main.js
 *
 * Punto de entrada y orquestador de la aplicación GIS Municipal.
 *
 * ── RESPONSABILIDAD ÚNICA ────────────────────────────────────────────────
 * Arrancar la app en el orden correcto:
 *   1. Registrar el adaptador de datos (Repository Pattern)
 *   2. Inicializar el mapa
 *   3. Montar los módulos de UI
 * Sin lógica de negocio propia. Todo está delegado a los módulos especializados.
 *
 * ── LA ÚNICA DECISIÓN QUE TOMA main.js ───────────────────────────────────
 * Qué adaptador usar. Para cambiar de fuente de datos solo hay que cambiar
 * esta línea:
 *   setAdaptador(new LocalJsonAdapter(...))
 *    →  setAdaptador(new RestApiAdapter("https://api.ejemplo.com/capas"))
 *    →  setAdaptador(new PostGISAdapter(config))
 * Ningún otro archivo cambia.
 */

// ── Config ──────────────────────────────────────────────────────────────
import { LocalJsonAdapter }        from "../config/adapters/LocalJsonAdapter.js";
import { setAdaptador }            from "../config/configEngine.js";

// ── Core ─────────────────────────────────────────────────────────────────
import { initMap }                 from "../core/mapManager.js";

// ── UI ────────────────────────────────────────────────────────────────────
import { renderMunicipioSelector } from "../ui/municipioSelector.js";
import { initLayerTree }           from "../ui/layerTree.js";
import { initLegendPanel }         from "../ui/legendPanel.js";
import { renderBasemapSelector }   from "../ui/basemapSelector.js";
import { initToolbar }             from "../ui/toolbar.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────

/**
 * Espera a que el SDK de ArcGIS esté disponible (window.$arcgis).
 *
 * POR QUÉ es necesario:
 * Aunque el SDK se carga con type="module" (lo que garantiza que su script
 * termina antes de que main.js ejecute), el SDK puede hacer dynamic imports
 * internos asincrónicos para registrar $arcgis. En ese caso $arcgis todavía
 * no está disponible al inicio de main().
 *
 * Este guard sondea cada 50ms hasta 5 segundos. En condiciones normales
 * resuelve en el primer o segundo intento (<100ms). Si supera el timeout,
 * lanza un error descriptivo en lugar del críptico "is not defined".
 *
 * @param {number} maxWaitMs
 * @returns {Promise<void>}
 */
async function waitForArcGISSDK(maxWaitMs = 5000) {
  if (window.$arcgis) return; // Camino rápido: ya está disponible
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (window.$arcgis) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > maxWaitMs) {
        clearInterval(interval);
        reject(new Error(
          "ArcGIS SDK no disponible tras 5s. " +
          "Verifica que el <script type=\"module\" src=\"https://js.arcgis.com/5.0/\"> " +
          "está en el <head> antes de main.js."
        ));
      }
    }, 50);
  });
}
 

async function main() {
  try {
    console.info("=== GIS Municipal — Arrancando... ===");

    // 1. Registrar adaptador de datos antes de cualquier operación de catálogo
    setAdaptador(new LocalJsonAdapter("../data/catalogo-capas-ne.json"));

    // 2. Inicializar el Map único con sus dos vistas (2D y 3D)
    await initMap({
      mapContainerId:   "map-view",
      sceneContainerId: "scene-view"
    });

    // 3. Montar UI
    // El orden importa: la toolbar y el selector están en la cabecera (visibles de entrada).
    // El árbol y la leyenda se construyen cuando "municipio-cargado" se emite.
    renderMunicipioSelector("#municipio-selector-container");
    renderBasemapSelector("#basemap-selector-container");
    initLayerTree("#layer-tree-container");
    initLegendPanel("#legend-container", "map-view");  // referencia inicial: 2D
    initToolbar("#toolbar-container");

    console.info("=== GIS Municipal — Listo ===");

  } catch (err) {
    console.error("[main] Error fatal al inicializar:", err);

    const errEl = document.getElementById("app-error");
    if (errEl) {
      errEl.textContent = `Error al inicializar: ${err.message}`;
      errEl.classList.remove("hidden");
    }
  }
}

// Garantizar que el DOM está listo antes de acceder a los elementos
document.addEventListener("DOMContentLoaded", main);