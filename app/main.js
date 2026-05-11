// app.js — v5 con $arcgis.import() y Web Components
import { CAPAS_CONFIG } from "./core/layers.js";
import { crearCapa }    from "./core/layerFactory.js";

// ── Referencias a los elementos del DOM ────────────────────
const mapEl    = document.getElementById("my-map");
const sceneEl  = document.getElementById("my-scene");
const btnToggle = document.getElementById("btn-toggle-view");
const layerList = document.getElementById("layer-list"); //componente arcgis
const legend    = document.getElementById("legend"); //componente arcgis

VOY ACÁ EN LA ULTIMA CONVERSACION CON CLAUDE (NO HE COPIADO MÁS CODIGO)


let vistaActual = "2D"; // Estado global para controlar la vista actual (2D o 3D)
let capasCreadas = false; // Previene que se añadan capas varias veces al cambiar de vista

// ── $arcgis.import() sustituye al require() de v4 ──────────
const [WMSLayer, SceneView] = await $arcgis.import([
  "@arcgis/core/layers/WMSLayer.js",
  "@arcgis/core/views/SceneView.js"
]);

// ── Esperar a que el Web Component esté listo ───────────────
const mapElement = document.getElementById("my-map");

mapElement.addEventListener("arcgisViewReadyChange", async (event) => {
  const view = mapElement.view; // ← propiedad del Web Component
  if (!view) return;            // ← guardia por si llega en estado intermedio

//   // ── Cargar capas desde la configuración ──────────────────
//   const capas = CAPAS_CONFIG.map(crearCapa).filter(Boolean);
//   view.map.addMany(capas);

  // ── Alternar 2D / 3D ─────────────────────────────────────
  let vistaActual = "2D";

  document.getElementById("btn-toggle-view").addEventListener("click", async () => {
    const viewDiv = document.getElementById("my-map");

    if (vistaActual === "2D") {
      // Crear SceneView compartiendo el mismo mapa
      const scene = new SceneView({
        container: viewDiv,
        map: view.map,
        camera: {
          position: { longitude: -1.6457, latitude: 42.4, z: 50000 },
          tilt: 75
        }
      });
      vistaActual = "3D";
      document.getElementById("btn-toggle-view").textContent = "Cambiar a 2D";
    } else {
      // Volver a MapView
      view.container = viewDiv;
      vistaActual = "2D";
      document.getElementById("btn-toggle-view").textContent = "Cambiar a 3D";
    }
  });
});