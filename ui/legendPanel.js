/**
 * ui/legendPanel.js
 * 
 * Responsabilidad: Gestionar el ciclo de vida del Web Component <arcgis-legend>.
 * Se integra con el Action Bar mediante el EventBus para reaccionar a cambios de vista.
 */

import { on } from "../utils/eventBus.js";

let _legendEl = null; // Instancia única del Web Component de leyenda

/**
 * Inicializa la leyenda en el contenedor flotante.
 * @param {string} initialViewId - ID del componente de vista activo al arrancar (por defecto map-view).
 */
export function initLegendPanel(initialViewId = "map-view") {
  const container = document.getElementById("legend-container");
  
  if (!container) {
    console.warn("[legendPanel] No se encontró el ancla #legend-container en el DOM.");
    return;
  }

  // Crear el Web Component nativo de ArcGIS Maps SDK v5.
  // Este componente es reactivo por diseño: se vincula a una vista mediante 'reference-element'.
  _legendEl = document.createElement("arcgis-legend");
  _legendEl.setAttribute("reference-element", initialViewId);
  
  // Solo mostrar capas que tienen visibilidad actual en el mapa (leyenda limpia).
  _legendEl.setAttribute("hide-layers-not-in-view", "");

  container.appendChild(_legendEl);
  
  _registrarListeners();
  
  console.info(`[legendPanel] Inicializado y vinculado a #${initialViewId}`);
}

/**
 * Actualiza la referencia del componente de leyenda.
 * Permite que la leyenda "salte" entre el mapa 2D y la escena 3D.
 * @param {string} elementId - "map-view" | "scene-view"
 */
export function actualizarReferencia(elementId) {
  if (!_legendEl) return;
  _legendEl.setAttribute("reference-element", elementId);
}

// ─── Métodos Privados ───────────────────────────────────────────────────────

function _registrarListeners() {
  /**
   * Escucha el cambio de vista (2D/3D) emitido por el orquestador de la UI (Action Bar/Toolbar).
   * Esto garantiza que la leyenda siempre muestre el contenido de la vista activa.
   */
  on("vista-cambiada", ({ modo }) => {
    const targetId = (modo === "3D") ? "scene-view" : "map-view";
    actualizarReferencia(targetId);
  });

  // Hook para el cambio de municipio (opcional: para limpiar estados si fuera necesario)
  on("municipio-cargado", () => {
    console.debug("[legendPanel] Municipio cambiado: la leyenda se actualizará automáticamente.");
  });
}