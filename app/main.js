// app.js
// ============================================================
// ARQUITECTURA: Dos mapas completamente independientes.
//
//   map2D ──► arcgis-map   (MapView)   → capas WMS + basemap
//   map3D ──► arcgis-scene (SceneView) → solo basemap + elevación
//
// Por qué dos mapas separados:
//   WMSLayer no es compatible con SceneView en muchos servicios
//   públicos. Compartir el mismo Map propaga ese fallo a la vista 3D.
//   Con mapas independientes cada vista es estable por sí sola.
// ============================================================

import { CAPAS_CONFIG } from "./core/layers.js";
import { crearCapa }    from "./core/layerFactory.js";


// ── REFERENCIAS DOM ─────────────────────────────────────
const mapEl = document.getElementById("my-map");
const sceneEl = document.getElementById("my-scene");
const btnToggle = document.getElementById("btn-toggle-view");
const layerListEl = document.getElementById("layer-list");
const legendEl = document.getElementById("legend");

// ── ESTADO DE LA APLICACIÓN ─────────────────────────────
let vistaActual  = "2D";
// let capasCreadas = false;    // puede dar problemas 

// ── MAPA 2D: con capas WMS ──────────────────────────────
// El Web Component arcgis-map crea su Map interno al inicializarse.
// Esperamos al evento para acceder a él y añadir las capas.
mapEl.addEventListener("arcgisViewReadyChange", () => {
  const mapView = mapEl.view;

  // Guardia doble: vista nula (evento de destrucción) o ya inicializado
  if (!mapView) return;

  const capas = CAPAS_CONFIG.map(crearCapa).filter(Boolean);
  mapView.map.addMany(capas);
  // capasCreadas = true;

  console.log("[app] Mapa 2D listo. Capas cargadas:", capas.length);
});

// ── MAPA 3D: solo basemap + elevación ───────────────────
// No se añaden capas WMS aquí intencionalmente.
// La elevación (ground="world-elevation") viene del atributo HTML.
sceneEl.addEventListener("arcgisViewReadyChange", () => {
  const sceneView = sceneEl.view;
  if (!sceneView) return;

  console.log("[app] Escena 3D lista. Solo basemap activo.");
});

// ── BOTÓN TOGGLE 2D / 3D ────────────────────────────────
// CRÍTICO: el callback DEBE ser async para poder usar await dentro.
// Sin async, cualquier await lanza: "Unexpected reserved word".
btnToggle.addEventListener("click", async () => {

  const mapView   = mapEl.view;
  const sceneView = sceneEl.view;

  // Guardia: no hacer nada si alguna vista no está lista
  if (!mapView || !sceneView) {
    console.warn("[app] Vistas no listas todavía.");
    return;
  }

  if (vistaActual === "2D") {
    await cambiarA3D(mapView, sceneView);
  } else {
    await cambiarA2D(mapView, sceneView);
  }
});

// ── FUNCIÓN: 2D → 3D ────────────────────────────────────
async function cambiarA3D(mapView, sceneView) {

  // Leer el viewpoint actual del mapa 2D
  // viewpoint encapsula centro + escala + rotación en un solo objeto.
  // Es más preciso que leer center + zoom por separado.
  const viewpoint = mapView.viewpoint;

  // Ocultar mapa 2D, mostrar escena 3D
  mapEl.style.display   = "none";
  sceneEl.style.display = "block";

  // Esperar a que SceneView termine de renderizar
  await sceneView.when(); 
  await sceneView.ready;

  // Navegar a la misma posición pero con tilt para efecto 3D.
  // No pasamos el viewpoint directamente porque viene con tilt=0 (2D),
  // lo que daría una vista cenital sin profundidad.
  await sceneView.goTo({
    target:  viewpoint.targetGeometry,  // mismo centro geográfico
    scale:   viewpoint.scale,           // mismo nivel de zoom
    tilt:    60,                        // ángulo que da el efecto de volumen
    heading: 0                          // norte arriba
  });

  // Redirigir widgets a la escena 3D
  layerListEl.setAttribute("reference-element", "my-scene");
  legendEl.setAttribute("reference-element", "my-scene");

  btnToggle.textContent = "Ver en 2D";
  vistaActual = "3D";
}

// ── FUNCIÓN: 3D → 2D ────────────────────────────────────
async function cambiarA2D(mapView, sceneView) {

  // Leer viewpoint de la escena 3D
  const viewpoint = sceneView.viewpoint;

  // Ocultar escena 3D, mostrar mapa 2D
  sceneEl.style.display = "none";
  mapEl.style.display   = "block";

  // goTo acepta un Viewpoint directamente en MapView.
  // Ignora el tilt automáticamente (2D no tiene tilt).
  await mapView.goTo(viewpoint);

  // Redirigir widgets al mapa 2D
  layerListEl.setAttribute("reference-element", "my-map");
  legendEl.setAttribute("reference-element", "my-map");

  btnToggle.textContent = "Ver en 3D";
  vistaActual = "2D";
}