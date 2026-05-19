/**
 * ui/legendPanel.js
 *
 * Panel de leyenda dinámica.
 *
 * ── IMPLEMENTACIÓN ───────────────────────────────────────────────────────
 * Usa el Web Component <arcgis-legend> de ArcGIS Maps SDK v5.
 * Este componente es reactivo: se sincroniza automáticamente con la vista
 * a la que apunta (reference-element). Cuando las capas visibles cambian,
 * la leyenda se actualiza sola sin intervención de este módulo.
 *
 * ── INTEGRACIÓN CON EL TOGGLE 2D/3D ─────────────────────────────────────
 * Al alternar vistas, toolbar.js llama a actualizarReferencia() para
 * que <arcgis-legend> apunte al elemento de vista correcto.
 * Si no se actualiza, la leyenda seguiría mostrando la vista anterior.
 *
 * ── EVENTOS DE eventBus ──────────────────────────────────────────────────
 * "capa-activada"   → hook disponible para extensiones (badge de capas activas, etc.)
 * "capa-desactivada" → ídem
 * "municipio-cargado" → log informativo (la leyenda se actualiza sola)
 */

import { on } from "../utils/eventBus.js";

let _legendEl     = null;
let _containerEl  = null;

// ─── Inicialización ───────────────────────────────────────────────────────

/**
 * Inicializa el panel de leyenda.
 *
 * @param {HTMLElement|string} container   - Contenedor del panel
 * @param {string}             mapElementId - id del <arcgis-map> activo al inicio
 */
export function initLegendPanel(container, mapElementId) {
  _containerEl = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!_containerEl) {
    console.error("[legendPanel] Contenedor no encontrado:", container);
    return;
  }

  // Crear el Web Component de leyenda.
  // reference-element: apunta al id del <arcgis-map> o <arcgis-scene>.
  // El componente obtiene su vista desde ese elemento automáticamente.
  _legendEl = document.createElement("arcgis-legend");
  _legendEl.setAttribute("reference-element", mapElementId);

  // hide-layers-not-in-view: oculta capas que están en el Map pero no visibles
  // Mantiene la leyenda limpia: solo muestra lo que el usuario ve en pantalla
  _legendEl.setAttribute("hide-layers-not-in-view", "");

  _containerEl.appendChild(_legendEl);

  // Suscripciones a eventBus para hooks futuros (badge, contador...)
  on("capa-activada",    ({ config }) => _onCapaToggle(config, true));
  on("capa-desactivada", ({ config }) => _onCapaToggle(config, false));
  on("municipio-cargado", () => {
    console.info("[legendPanel] Nuevo municipio → leyenda reactiva actualizada");
  });

  console.info(`[legendPanel] Inicializado → referencia: #${mapElementId}`);
}

// ─── API pública ──────────────────────────────────────────────────────────

/**
 * Actualiza el reference-element al cambiar entre 2D y 3D.
 * Llamado desde toolbar.js tras el toggle.
 * @param {string} elementId - id del <arcgis-map> o <arcgis-scene> activo
 */
export function actualizarReferencia(elementId) {
  if (!_legendEl) return;
  _legendEl.setAttribute("reference-element", elementId);
  console.info(`[legendPanel] Referencia actualizada → #${elementId}`);
}

// ─── Privado ──────────────────────────────────────────────────────────────

function _onCapaToggle(config, visible) {
  // Hook para extensiones futuras:
  // - Mostrar badge con número de capas activas
  // - Destacar en la leyenda la última capa activada
  // - Emitir analytics de uso
  const total = _containerEl?.querySelectorAll("calcite-checkbox[checked]").length ?? 0;
  console.info(
    `[legendPanel] Capa "${config?.id}" ${visible ? "activada" : "desactivada"}`
  );
}