// main.js
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
import { initLegend }   from "./core/legendManager.js"; 


// ── REFERENCIAS DOM ─────────────────────────────────────
const mapEl = document.getElementById("my-map");
const sceneEl = document.getElementById("my-scene");
const btnToggle = document.getElementById("btn-toggle");
const layerListEl = document.getElementById("layer-list");
const legendEl = document.getElementById("legend");

// ── ESPERAR QUE AMBAS VISTAS ESTÉN LISTAS─────────────────────────────

await mapEl.viewOnReady();
await sceneEl.viewOnReady();



// ── CREAR CAPAS ─────────────────────────────

const capas2D = [];
const capas3D = [];


CAPAS_CONFIG.forEach((cfg) => {

  const capa2D = crearCapa(cfg);

  if (!capa2D) return;

  // ── TODAS LAS CAPAS VAN AL 2D ─────────────────────────
  capas2D.push(capa2D);

  // ── SOLO ALGUNAS VAN AL 3D ────────────────────────────
  // compatibleCon3D será parte futura de la config.
  // false por defecto para evitar problemas con WMS.
  const compatibleCon3D = cfg.compatibleCon3D ?? false;

  if (compatibleCon3D) {

    // Nunca compartir misma instancia entre vistas.
    const capa3D = capa2D.clone();

    capas3D.push(capa3D);
  }
});

// ── AÑADIR CAPAS A CADA MAPA ───────────────────────────
mapEl.view.map.addMany(capas2D);

sceneEl.view.map.addMany(capas3D);

// ── LEYENDA DINÁMICA ────────────────────────────────────────
// legendManager escucha cambios de visibilidad por sí solo.
// main.js no necesita saber cómo se dibuja la leyenda.
await initLegend(legendEl, mapEl.view);

// ── CORRECCIÓN DE ESCALA WEB MERCATOR ───────────────────
// MapView usa proyección Web Mercator (EPSG:3857) que distorsiona
// la escala en función de la latitud. .
const getScaleFactor = (viewpoint) =>
  Math.cos((viewpoint.targetGeometry.latitude * Math.PI) / 180);

// ── 5. SHOW/HIDE CON CSS TRANSITION ────────────────────────
// CSS maneja la transición (opacity + visibility en styles.css).
const mostrarVista = (mostrar, ocultar) => {
  mostrar.classList.add("visible");
  ocultar.classList.remove("visible");
};

// ── 6. ESTADO ──────────────────────────────────────────────
let is2D = true;

// ── 7. TOGGLE 2D / 3D ──────────────────────────────────────
btnToggle.addEventListener("click", () => {

  // Clonar el viewpoint de la vista activa antes de modificarlo.
  const viewpoint = is2D
    ? mapEl.viewpoint.clone()
    : sceneEl.viewpoint.clone();

  const factor = getScaleFactor(viewpoint);

  if (is2D) {
    // ── 2D → 3D ──────────────────────────────────────────
    // Reducir escala para compensar la distorsión Mercator.
    // (zoom in hasta reflejar la distancia real en el terreno)
    viewpoint.scale *= factor;

    // Asignación directa: instantánea y precisa (no animada).
    sceneEl.viewpoint = viewpoint;

    mostrarVista(sceneEl, mapEl);

    // Redirigir widgets a la escena 3D
    // layerListEl.setAttribute("reference-element", "my-scene");
    // legendEl.setAttribute("reference-element", "my-scene");

    btnToggle.textContent = "2D";

  } else {
    // ── 3D → 2D ──────────────────────────────────────────
    // Aumentar escala para compensar la distorsión inversa.
    viewpoint.scale /= factor;

    mapEl.viewpoint = viewpoint;

    mostrarVista(mapEl, sceneEl);

    // Redirigir widgets al mapa 2D
    layerListEl.setAttribute("reference-element", "my-map");
    legendEl.setAttribute("reference-element", "my-map");

    btnToggle.textContent = "3D";
  }

  is2D = !is2D;
});

