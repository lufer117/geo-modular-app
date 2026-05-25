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
 * Sin lógica propia. Todo está delegado a los módulos especializados.
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
import { setAdaptador }            from "../config/configEngine.js"; // le dice al sistema qué fuente de datos usar

// ── Core ─────────────────────────────────────────────────────────────────
// Main no crea el mapa directamente, lo inicializa 
import { initMap }                 from "../core/mapManager.js";

// ── UI ────────────────────────────────────────────────────────────────────
// Cada función importada monta una parte visual
import { renderMunicipioSelector } from "../ui/municipioSelector.js";
import { renderBasemapSelector }   from "../ui/basemapSelector.js";
import { initLayerTree }           from "../ui/layerTree.js";
import { initLegendPanel }         from "../ui/legendPanel.js";
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

// ── CARGA DE $ARCGIS ────────────────────────────────────────────────────────────────────
async function waitForArcGISSDK(maxWaitMs = 5000) {
  if (window.$arcgis) return; // Comprueba si ya está disponible y sale inmediatamente

  // si $arcgis no existe, empieza un intervalo, cada 50 ms revisa if (window.$arcgis)
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {  
      if (window.$arcgis) {
        clearInterval(interval);
        resolve(); // cuando $arcgis aparece detiene el polling y resuelve la promesa
      } else if (Date.now() - start > maxWaitMs) { // evita esperar infinitamente, después de 5segundos muestra el error
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


// ── ARRANQUE ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    console.info("=== GIS Municipal — Arrancando... ===");

    // 1. Registrar adaptador de datos antes de cualquier operación de catálogo
    setAdaptador(new LocalJsonAdapter("../data/catalogo-capas.json"));

    // 2. Inicializar el Map único con sus dos vistas (2D y 3D)
    // await porque crear el mapa es asíncono
    // espera que las acciones de initMap esten ok antes de renderizar otro componente de la interfaz
    await initMap({
      mapContainerId:   "map-view", //conecta con index <div id="map-view"> y usado como parametro en initMap en mapManager.js
      sceneContainerId: "scene-view" // contacta con index <div id="scene-view"> y usado como parametro en initMap en mapManager.js
    });

    // 3. Montar UI
    // El orden importa: la toolbar y el selector están en la cabecera (visibles de entrada).
    // El árbol y la leyenda se construyen cuando "municipio-cargado" se emite con EVENTBUS
    renderMunicipioSelector("#municipio-selector-container"); // styles & eventBus.emit("municipio-cargado")
    renderBasemapSelector("#basemap-selector-container"); // conecta con styles
    initLayerTree("#layer-tree-container"); // conecta con styles 
    initLegendPanel("#legend-container", "map-view");  // conecta con styles, index (mapa inicia en 2d)
    initToolbar("#toolbar-container"); // conecta con styles

    console.info("=== GIS Municipal — Listo ===");

  // SI TODO FALLA
  } catch (err) {

    //error en consola
    console.error("[main] Error fatal al inicializar:", err); // error en consola

    // muestra error al usuario en el navegador
    const errEl = document.getElementById("app-error"); // conecta con index
    if (errEl) {
      errEl.textContent = `Error al inicializar: ${err.message}`;
      errEl.classList.remove("hidden");
    }
  }
}

// Garantizar que el DOM está listo antes de acceder a los elementos
// el evento garantiza que el Index HTML este completamente parseado 
// los elementos existen y luego si ejecuta main
document.addEventListener("DOMContentLoaded", main);


// ── FLUJO MENTAL ────────────────────────────────────────────────────────────────────

// index.html carga
// ↓
// ArcGIS SDK empieza a cargar
// ↓
// DOMContentLoaded
// ↓
// main()
// ↓
// waitForArcGISSDK()
// ↓
// registrar adaptador
// ↓
// crear mapa/vistas
// ↓
// montar UI
// ↓
// usuario selecciona municipio
// ↓
// configEngine resuelve capas
// ↓
// layerFactory crea capas
// ↓
// mapManager las añade
// ↓
// eventBus notifica
// ↓
// layerTree y legend reaccionan //