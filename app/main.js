// main.js - Orquestador de la aplicación GIS Municipal
// ============================================================
//  Responsabilidad ÚNICA: importar módulos y conectarlos.
//  Sin lógica propia de mapa, capas ni DOM.
//  
//  Principio arquitectónico: este archivo debe poder leerse
//  como un índice de lo que hace la app, no como implementación.
//
//  Sigue patrón de esperar primero lo crítico y 
//  luego inicializar el resto en paralelo.
//  ============================================================

// funciones app
import { initMap }             from './core/mapManager.js';
import { CAPAS_CONFIG }        from './config/municipio.js';
import { renderToolbar }       from './ui/toolbar.js'; 
import { renderBasemapSelector } from './ui/basemapSelector.js'; 
import { renderLayerTree }     from './ui/layerTree.js'; 
import { initLegend }          from './ui/legendPanel.js'; 



//  Función principal async.
//  asincronica, que inicializa un mapa 2D y una escena 3D, asegurando que todo esté listo antes de continuar.
//  Usamos top-level async/await en un ES Module para claridad.
//  El catch garantiza que los errores de arranque sean visibles.
 
async function main() {
  try {
    // ── 1. MAPA ────────────────────────────────────────────────────────
    // initMap devuelve una promesa que resuelve cuando el mapa 2D
    // está listo, las capas están cargadas y el Map está compartido
    // con la SceneView 3D. Todo lo demás puede arrancar después.
    await initMap({
      mapElementId:   'my-map',
      sceneElementId: 'my-scene',
      capasConfig:    CAPAS_CONFIG,
    });

    // ── 2. UI ──────────────────────────────────────────────────────────
    // Cada módulo de UI recibe solo el contenedor que le corresponde.
    // No saben nada del mapa directamente — se comunican vía eventBus.


    //Renderiza botones como: zoom, medir, dibujar, seleccionar, etc
    //No recibe el mapa → usará eventos para interactuar con él
    renderToolbar(document.getElementById('toolbar-actions')); 

    //Renderiza un selector para cambiar el fondo del mapa (callejero, satélite, topográfico, etc.)
    //Al hacer clic en una opción, emitirá un evento: 'basemap:change'c
    renderBasemapSelector(document.getElementById('basemap-selector-container'));


    // Renderiza una estructura jerárquica de capas 
    //Permite: activar/desactivar capas, cambiar orden, ver legend, etc.
    renderLayerTree(
      document.getElementById('layer-tree-container'),
      CAPAS_CONFIG,
    );

    initLegend(document.getElementById('legend-container'));

    console.info('[App] Visor GIS iniciado correctamente.');

  } catch (error) {
    console.error('[App] Error crítico al iniciar:', error);
    // TODO: mostrar mensaje de error al usuario (calcite-notice)
  }
}

main();




// // ── REFERENCIAS DOM ─────────────────────────────────────
// const mapEl = document.getElementById("my-map");
// const sceneEl = document.getElementById("my-scene");
// const btnToggle = document.getElementById("btn-toggle");
// const layerListEl = document.getElementById("layer-list");
// const legendEl = document.getElementById("legend");

// // ── ESPERAR QUE AMBAS VISTAS ESTÉN LISTAS─────────────────────────────

// await mapEl.viewOnReady();
// await sceneEl.viewOnReady();



// // ── CREAR CAPAS ─────────────────────────────

// const capas2D = [];
// const capas3D = [];


// for (const cfg of CAPAS_CONFIG) {

//   const capa2D = crearCapa(cfg);

//   if (!capa2D) continue;

//   // ── Inicialización runtime ───────────────────────────
//   await inicializarCapa(capa2D, cfg);

//   // ── Añadir a colección 2D ────────────────────────────
//   capas2D.push(capa2D);

//   // ── Capas compatibles con 3D ─────────────────────────
//   const compatibleCon3D = cfg.compatibleCon3D ?? false;

//   if (compatibleCon3D) {

//     // nunca compartir instancia entre vistas
//     const capa3D = capa2D.clone();

//     await inicializarCapa(capa3D, cfg);

//     capas3D.push(capa3D);
//   }
// }

// // ── AÑADIR CAPAS A CADA MAPA ───────────────────────────
// mapEl.view.map.addMany(capas2D);

// sceneEl.view.map.addMany(capas3D);

// // ── LEYENDA DINÁMICA ────────────────────────────────────────
// // legendManager escucha cambios de visibilidad por sí solo.
// // main.js no necesita saber cómo se dibuja la leyenda.
// await initLegend(legendEl, mapEl.view);

// // ── CORRECCIÓN DE ESCALA WEB MERCATOR ───────────────────
// // MapView usa proyección Web Mercator (EPSG:3857) que distorsiona
// // la escala en función de la latitud. .
// const getScaleFactor = (viewpoint) =>
//   Math.cos((viewpoint.targetGeometry.latitude * Math.PI) / 180);

// // ── 5. SHOW/HIDE CON CSS TRANSITION ────────────────────────
// // CSS maneja la transición (opacity + visibility en styles.css).
// const mostrarVista = (mostrar, ocultar) => {
//   mostrar.classList.add("visible");
//   ocultar.classList.remove("visible");
// };

// // ── 6. ESTADO ──────────────────────────────────────────────
// let is2D = true;

// // ── 7. TOGGLE 2D / 3D ──────────────────────────────────────
// btnToggle.addEventListener("click", () => {

//   // Clonar el viewpoint de la vista activa antes de modificarlo.
//   const viewpoint = is2D
//     ? mapEl.viewpoint.clone()
//     : sceneEl.viewpoint.clone();

//   const factor = getScaleFactor(viewpoint);

//   if (is2D) {
//     // ── 2D → 3D ──────────────────────────────────────────
//     // Reducir escala para compensar la distorsión Mercator.
//     // (zoom in hasta reflejar la distancia real en el terreno)
//     viewpoint.scale *= factor;

//     // Asignación directa: instantánea y precisa (no animada).
//     sceneEl.viewpoint = viewpoint;

//     mostrarVista(sceneEl, mapEl);

//     // Redirigir widgets a la escena 3D
//     // layerListEl.setAttribute("reference-element", "my-scene");
//     // legendEl.setAttribute("reference-element", "my-scene");

//     btnToggle.textContent = "2D";

//   } else {
//     // ── 3D → 2D ──────────────────────────────────────────
//     // Aumentar escala para compensar la distorsión inversa.
//     viewpoint.scale /= factor;

//     mapEl.viewpoint = viewpoint;

//     mostrarVista(mapEl, sceneEl);

//     // Redirigir widgets al mapa 2D
//     layerListEl.setAttribute("reference-element", "my-map");
//     legendEl.setAttribute("reference-element", "my-map");

//     btnToggle.textContent = "3D";
//   }

//   is2D = !is2D;
// });

